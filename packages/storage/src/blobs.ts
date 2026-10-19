/**
 * 内容寻址 Blob 存储（《M0+M1 详细设计》§4.1）
 *
 * 设计要点：**原文是唯一真相源，索引可重建**（PRD FR-G103）。
 *   - 路径：blobs/<sha256 前 2 位>/<sha256>
 *   - 相同内容天然去重（同一哈希只存一份）
 *   - 写入用"临时文件 + 原子 rename"，避免半截文件被当成有效内容
 *   - 提供 GC：按"最后访问时间 + 是否被引用"清理（R1 只实现按 age 的保守清理）
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** 一个已落盘的内容引用；`sha256` 即内容身份，相同内容天然去重 */
export interface BlobRef {
  /** 内容 sha256（十六进制） */
  readonly sha256: string;
  /** 字节数 */
  readonly bytes: number;
  /** 绝对路径 */
  readonly path: string;
}

/**
 * 内容寻址存储。
 *
 * 设计依据：**原文是唯一真相源，索引可重建**（PRD FR-G103）。
 * 写入用"临时文件 + 原子 rename"，避免进程崩溃留下半截文件被当成有效内容。
 */
export class BlobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
    mkdirSync(root, { recursive: true });
  }

  get root(): string {
    return this.#root;
  }

  /** 计算内容的 sha256（十六进制小写） */
  static hash(data: string | Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
  }

  #pathFor(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`非法 sha256：${sha256}`);
    }
    return join(this.#root, sha256.slice(0, 2), sha256);
  }

  has(sha256: string): boolean {
    return existsSync(this.#pathFor(sha256));
  }

  /**
   * 写入内容；若已存在则直接复用（去重）。
   * 采用"临时文件 + rename"保证原子性。
   */
  put(data: string | Uint8Array): BlobRef {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    const sha256 = BlobStore.hash(buf);
    const target = this.#pathFor(sha256);

    if (existsSync(target)) {
      const st = statSync(target);
      return { sha256, bytes: st.size, path: target };
    }

    const dir = join(this.#root, sha256.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.tmp-${process.pid}-${randomUUID()}`);
    writeFileSync(tmp, buf);
    renameSync(tmp, target); // 原子替换

    return { sha256, bytes: buf.byteLength, path: target };
  }

  /** 读取内容；不存在返回 null（不抛错，便于"引用已失效"的降级处理） */
  get(sha256: string): Buffer | null {
    const p = this.#pathFor(sha256);
    if (!existsSync(p)) return null;
    return readFileSync(p);
  }

  getText(sha256: string): string | null {
    const buf = this.get(sha256);
    return buf === null ? null : buf.toString("utf8");
  }

  /** 删除一个 blob；返回是否真的删除了 */
  delete(sha256: string): boolean {
    const p = this.#pathFor(sha256);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  }

  /** 统计（容量与数量），用于 NFR-P7 的磁盘占用监控 */
  stats(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const prefix of readdirSync(this.#root)) {
      const dir = join(this.#root, prefix);
      if (prefix.length !== 2 || !existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".tmp-")) continue;
        count += 1;
        bytes += statSync(join(dir, name)).size;
      }
    }
    return { count, bytes };
  }

  /**
   * 保守 GC：删除 `olderThanMs` 未被写入/访问过的 blob。
   * 由于 blobs 是内容寻址的，删除后若仍被引用会导致"引用已失效"——
   * 因此 R1 只提供按时间的保守清理，**调用方需自行确认无引用**。
   */
  gc(olderThanMs: number, now: number = Date.now()): { removed: number; bytes: number } {
    let removed = 0;
    let bytes = 0;
    for (const prefix of readdirSync(this.#root)) {
      const dir = join(this.#root, prefix);
      if (prefix.length !== 2 || !existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".tmp-")) {
          // 清理上次崩溃遗留的临时文件
          const p = join(dir, name);
          try {
            const st = statSync(p);
            if (now - st.mtimeMs > olderThanMs) {
              unlinkSync(p);
              removed += 1;
            }
          } catch {
            /* 忽略 */
          }
          continue;
        }
        const p = join(dir, name);
        try {
          const st = statSync(p);
          if (now - st.mtimeMs > olderThanMs) {
            bytes += st.size;
            unlinkSync(p);
            removed += 1;
          }
        } catch {
          /* 忽略 */
        }
      }
    }
    return { removed, bytes };
  }
}
