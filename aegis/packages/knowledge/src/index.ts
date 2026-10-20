/**
 * @aegis/knowledge —— M3 本地知识库地基
 *
 * 只做：文档入库、分块、CJK 友好的 FTS5 检索、引用元数据。
 * 不做：LLM 问答、embedding、重排、知识冲突裁决（M4/M7）。
 *
 * 安全约定：知识内容只存本地；检索结果送给模型前仍必须经过脱敏网关。
 */

import { createHash, randomUUID } from "node:crypto";
import type { DataClass } from "@aegis/contracts";
import { type Db, rowOf, rowsOf } from "@aegis/storage";

/** 一个已入库文档 */
export interface KnowledgeDocument {
  id: string;
  title: string;
  sourcePath: string;
  dataClass: DataClass;
  contentHash: string;
  chunkCount: number;
  updatedAt: number;
}

/** 入库参数 */
export interface IngestInput {
  sourcePath: string;
  title?: string;
  content: string;
  dataClass?: DataClass;
}

/** 一条检索命中；`sourcePath` + 偏移即可生成可点击引用 */
export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  title: string;
  sourcePath: string;
  dataClass: DataClass;
  ordinal: number;
  text: string;
  startOffset: number;
  endOffset: number;
  score: number;
}

/** 分块大小与重叠（字符数） */
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

/** 汉字范围（含扩展 A 与兼容区）；逐字切分才能支持中文子串检索（README F3） */
const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * 把文本切成 FTS 词序列：汉字逐字、拉丁词按词。
 * 查询必须使用同一函数，否则索引与查询分词不一致。
 */
export function tokenizeForFts(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = [];
  for (const ch of normalized) if (HAN_RE.test(ch)) tokens.push(ch);
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
    if (word.length >= 2) tokens.push(word);
  }
  return tokens;
}

/** 把文档切成有重叠的块；优先在段落/换行处断开 */
function chunkText(text: string): Array<{ text: string; start: number; end: number }> {
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const window = text.slice(start + Math.floor(CHUNK_SIZE / 2), end);
      const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
      if (breakAt >= 0) end = start + Math.floor(CHUNK_SIZE / 2) + breakAt;
    }
    const slice = text.slice(start, end);
    if (slice.trim()) chunks.push({ text: slice, start, end });
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

interface DocumentRow {
  id: string;
  title: string;
  source_path: string;
  data_class: string;
  content_hash: string;
  updated_at: number;
}

/** 知识库服务 */
export class KnowledgeBase {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(options: { db: Db; now: () => number }) {
    this.#db = options.db;
    this.#now = options.now;
  }

  /** 入库/更新；同一 sourcePath 重入库会替换旧分块 */
  ingest(input: IngestInput): KnowledgeDocument {
    const content = input.content.replace(/\r\n/g, "\n");
    if (!content.trim()) throw new Error("文档内容为空");
    if (content.length > 2_000_000) throw new Error("文档超过 2MB 限制");

    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const existing = rowOf<DocumentRow>(
      this.#db.prepare(
        "SELECT id, title, source_path, data_class, content_hash, updated_at FROM knowledge_document WHERE source_path = ?",
      ),
      input.sourcePath,
    );

    if (existing && existing.content_hash === hash) {
      return this.#view(existing);
    }

    const now = this.#now();
    const docId = existing?.id ?? randomUUID();
    const title = input.title?.trim() || input.sourcePath.split("/").pop() || "未命名文档";
    const dataClass = input.dataClass ?? "L2";

    this.#db.transaction(() => {
      if (existing) {
        const oldChunks = rowsOf<{ id: string }>(
          this.#db.prepare("SELECT id FROM knowledge_chunk WHERE document_id = ?"),
          docId,
        );
        for (const c of oldChunks) {
          this.#db.prepare("DELETE FROM knowledge_fts WHERE chunk_id = ?").run(c.id);
        }
        this.#db.prepare("DELETE FROM knowledge_chunk WHERE document_id = ?").run(docId);
        this.#db
          .prepare(
            "UPDATE knowledge_document SET title = ?, data_class = ?, content_hash = ?, updated_at = ? WHERE id = ?",
          )
          .run(title, dataClass, hash, now, docId);
      } else {
        this.#db
          .prepare(
            `INSERT INTO knowledge_document
               (id, title, source_path, source_kind, data_class, content_hash, created_at, updated_at)
             VALUES (?, ?, ?, 'file', ?, ?, ?, ?)`,
          )
          .run(docId, title, input.sourcePath, dataClass, hash, now, now);
      }

      for (const [ordinal, chunk] of chunkText(content).entries()) {
        const chunkId = randomUUID();
        this.#db
          .prepare(
            `INSERT INTO knowledge_chunk (id, document_id, ordinal, text, start_offset, end_offset)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(chunkId, docId, ordinal, chunk.text, chunk.start, chunk.end);
        this.#db
          .prepare("INSERT INTO knowledge_fts (chunk_id, tokens) VALUES (?, ?)")
          .run(chunkId, tokenizeForFts(chunk.text).join(" "));
      }
    });

    return this.#view({
      id: docId,
      title,
      source_path: input.sourcePath,
      data_class: dataClass,
      content_hash: hash,
      updated_at: now,
    });
  }

  /** 列出全部文档（含分块数） */
  list(): KnowledgeDocument[] {
    const rows = rowsOf<DocumentRow & { chunk_count: number }>(
      this.#db.prepare(
        `SELECT d.id, d.title, d.source_path, d.data_class, d.content_hash, d.updated_at,
                COUNT(c.id) AS chunk_count
           FROM knowledge_document d
           LEFT JOIN knowledge_chunk c ON c.document_id = d.id
          GROUP BY d.id ORDER BY d.updated_at DESC`,
      ),
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      sourcePath: r.source_path,
      dataClass: r.data_class as DataClass,
      contentHash: r.content_hash,
      chunkCount: r.chunk_count,
      updatedAt: r.updated_at,
    }));
  }

  /** 检索；无命中返回空数组（调用方必须走"没找到"路径，不能编） */
  search(query: string, limit = 10): KnowledgeHit[] {
    const tokens = tokenizeForFts(query);
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
    const rows = rowsOf<{
      chunk_id: string;
      score: number;
      document_id: string;
      title: string;
      source_path: string;
      data_class: string;
      ordinal: number;
      text: string;
      start_offset: number;
      end_offset: number;
    }>(
      this.#db.prepare(
        `SELECT f.chunk_id, bm25(knowledge_fts) AS score,
                c.document_id, c.ordinal, c.text, c.start_offset, c.end_offset,
                d.title, d.source_path, d.data_class
           FROM knowledge_fts f
           JOIN knowledge_chunk c ON c.id = f.chunk_id
           JOIN knowledge_document d ON d.id = c.document_id
          WHERE knowledge_fts MATCH ?
          ORDER BY score ASC LIMIT ?`,
      ),
      ftsQuery,
      limit,
    );
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      title: r.title,
      sourcePath: r.source_path,
      dataClass: r.data_class as DataClass,
      ordinal: r.ordinal,
      text: r.text,
      startOffset: r.start_offset,
      endOffset: r.end_offset,
      score: r.score,
    }));
  }

  /** 删除文档与索引；不存在时抛错，避免 UI 假装成功 */
  remove(id: string): void {
    const chunks = rowsOf<{ id: string }>(
      this.#db.prepare("SELECT id FROM knowledge_chunk WHERE document_id = ?"),
      id,
    );
    if (chunks.length === 0) {
      const doc = rowOf<{ id: string }>(
        this.#db.prepare("SELECT id FROM knowledge_document WHERE id = ?"),
        id,
      );
      if (!doc) throw new Error("知识文档不存在");
    }
    this.#db.transaction(() => {
      for (const c of chunks) this.#db.prepare("DELETE FROM knowledge_fts WHERE chunk_id = ?").run(c.id);
      this.#db.prepare("DELETE FROM knowledge_document WHERE id = ?").run(id);
    });
  }

  #view(row: DocumentRow): KnowledgeDocument {
    const count = rowOf<{ n: number }>(
      this.#db.prepare("SELECT COUNT(*) AS n FROM knowledge_chunk WHERE document_id = ?"),
      row.id,
    );
    return {
      id: row.id,
      title: row.title,
      sourcePath: row.source_path,
      dataClass: row.data_class as DataClass,
      contentHash: row.content_hash,
      chunkCount: count?.n ?? 0,
      updatedAt: row.updated_at,
    };
  }
}
