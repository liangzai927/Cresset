/**
 * KnowledgeBase 测试：中文检索、引用偏移、重入库去旧、空结果。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "@aegis/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "./index.js";

let dir: string;
let db: ReturnType<typeof openDb>;
let kb: KnowledgeBase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-knowledge-"));
  db = openDb({ file: join(dir, "test.db") });
  migrate(db);
  kb = new KnowledgeBase({ db, now: () => 1_000 });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("KnowledgeBase", () => {
  it("入库中文文档后可检索，并返回可溯源引用", () => {
    const doc = kb.ingest({
      sourcePath: "/tmp/project.md",
      title: "项目说明",
      content: "这是项目的知识库说明。Aegis 会在这里检索项目文档。",
      dataClass: "L1",
    });
    expect(doc.chunkCount).toBeGreaterThan(0);

    const hits = kb.search("知识库");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      title: "项目说明",
      sourcePath: "/tmp/project.md",
      dataClass: "L1",
    });
    expect(hits[0]?.startOffset).toBeGreaterThanOrEqual(0);
    expect(hits[0]?.endOffset).toBeGreaterThan(hits[0]?.startOffset ?? 0);
  });

  it("同路径重入库会替换旧分块，旧词不再命中", () => {
    kb.ingest({ sourcePath: "/tmp/doc.md", content: "旧内容：苹果香蕉", dataClass: "L2" });
    expect(kb.search("苹果").length).toBeGreaterThan(0);

    kb.ingest({ sourcePath: "/tmp/doc.md", content: "新内容：橘子葡萄", dataClass: "L2" });
    expect(kb.search("苹果")).toEqual([]);
    expect(kb.search("橘子").length).toBeGreaterThan(0);
    expect(kb.list()).toHaveLength(1);
  });

  it("内容未变时幂等，不重复插入分块", () => {
    const input = { sourcePath: "/tmp/same.md", content: "稳定的项目说明", dataClass: "L2" as const };
    const first = kb.ingest(input);
    const second = kb.ingest(input);
    expect(second.id).toBe(first.id);
    expect(second.chunkCount).toBe(first.chunkCount);
    expect(kb.list()).toHaveLength(1);
  });

  it("无命中返回空数组，不伪造结果", () => {
    kb.ingest({ sourcePath: "/tmp/a.md", content: "项目说明", dataClass: "L1" });
    expect(kb.search("完全不存在的词")).toEqual([]);
    expect(kb.search("")).toEqual([]);
  });

  it("删除文档同时清理索引", () => {
    const doc = kb.ingest({ sourcePath: "/tmp/x.md", content: "可删除的知识库内容", dataClass: "L1" });
    kb.remove(doc.id);
    expect(kb.list()).toEqual([]);
    expect(kb.search("知识库")).toEqual([]);
  });
});
