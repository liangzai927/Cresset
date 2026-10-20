/**
 * 文件/目录监测器（M2 / PRD FR-B2）
 *
 * 关键设计：
 *   - **轮询式**：不依赖 fs.watch 的跨平台差异，调度器决定扫描周期；
 *   - **稳定期**：新文件/刚变化的文件要连续 stableMs 不变才发事实，避免半截下载；
 *   - **内容指纹**：默认 sha256 文件内容；超大文件退化为 size+mtime，避免读爆内存；
 *   - **基线不刷屏**：首次扫描只建立基线，不把已有文件全部当成"新增"；
 *   - 删除产生事实；同一次扫描里"旧路径消失 + 新路径出现且内容指纹相同"
 *     会配对为 file.renamed，而不是删除+新增两条。
 */

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, matchesGlob, relative, sep } from "node:path";
import { type Clock, SystemClock } from "@aegis/clock";
import type { Monitor, MonitorError, MonitorFact, MonitorScanResult } from "./types.js";

/** 文件监测器配置 */
export interface FileMonitorOptions {
  /** 监测器 id，Skill 里用 trigger.monitor 引用 */
  id: string;
  /** 监测根目录 */
  root: string;
  /** 只关心匹配的 glob（相对 root）；为空表示所有文件 */
  patterns?: string[];
  /** 忽略的 glob（相对 root）；默认额外忽略 .git/node_modules */
  ignore?: string[];
  /** 稳定期（毫秒）；默认 2000 */
  stableMs?: number;
  /** 超过该大小不做内容哈希，退化为 size+mtime；默认 16MB */
  maxHashBytes?: number;
  /** 首次扫描是否把现有文件作为 file.added 返回；默认 false（只建基线） */
  emitInitial?: boolean;
  clock?: Clock;
}

interface ObservedFile {
  fingerprint: string;
  size: number;
  mtimeMs: number;
  status: "stable" | "new" | "modified";
  /** 进入当前状态的时间（用于稳定期判断） */
  stableSince: number;
}

interface CurrentFile {
  fingerprint: string;
  size: number;
  mtimeMs: number;
}

const DEFAULT_IGNORE = [".git/**", "node_modules/**", ".DS_Store"];

/** 文件监测器实现 */
export class FileMonitor implements Monitor {
  readonly id: string;
  readonly permission = "files.read" as const;
  readonly #root: string;
  readonly #patterns: string[];
  readonly #ignore: string[];
  readonly #stableMs: number;
  readonly #maxHashBytes: number;
  readonly #emitInitial: boolean;
  readonly #clock: Clock;
  #observed = new Map<string, ObservedFile>();
  #baselineDone = false;

  constructor(options: FileMonitorOptions) {
    if (options.stableMs !== undefined && options.stableMs < 0) {
      throw new RangeError("stableMs 不能为负数");
    }
    this.id = options.id;
    this.#root = options.root;
    this.#patterns = options.patterns ?? [];
    this.#ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
    this.#stableMs = options.stableMs ?? 2_000;
    this.#maxHashBytes = options.maxHashBytes ?? 16 * 1024 * 1024;
    this.#emitInitial = options.emitInitial ?? false;
    this.#clock = options.clock ?? new SystemClock();
  }

  /** 扫描一次；首次只建立基线 */
  async scan(): Promise<MonitorScanResult> {
    const now = this.#clock.wall();
    const current = new Map<string, CurrentFile>();
    const seen = new Set<string>();
    const errors: MonitorError[] = [];

    const walk = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        errors.push({ path: dir, message: (err as Error).message });
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          // 默认不进入 VCS/依赖目录，避免 .git 的数千个对象拖慢每次扫描
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          walk(path);
          continue;
        }
        if (!entry.isFile()) continue;

        const rel = relative(this.#root, path).split(sep).join("/");
        if (!this.#matches(rel)) continue;
        seen.add(rel);
        try {
          const st = statSync(path);
          current.set(rel, {
            fingerprint: this.#fingerprint(path, st.size, st.mtimeMs),
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch (err) {
          // 采集失败必须出现在 errors 里；seen 已记录，避免误判为删除
          errors.push({ path: rel, message: (err as Error).message });
        }
      }
    };

    walk(this.#root);

    if (!this.#baselineDone) {
      this.#observed = new Map(
        [...current].map(([rel, file]) => [rel, { ...file, status: "stable" as const, stableSince: now }]),
      );
      this.#baselineDone = true;
      const facts = this.#emitInitial
        ? [...current].map(([rel, file]) => ({
            monitor: this.id,
            kind: "file.added" as const,
            at: now,
            fields: {
              path: rel,
              fingerprint: file.fingerprint,
              size: file.size,
              mtime_ms: file.mtimeMs,
            },
          }))
        : [];
      return { facts, errors };
    }

    const facts: MonitorFact[] = [];
    // 先收集"看不见了"的旧文件，等新增文件处理后配对重命名；
    // 未配对的才作为删除发出，避免 rename 被拆成 deleted + added 两条。
    const deleted = [...this.#observed.entries()].filter(([rel]) => !seen.has(rel));
    const consumedDeleted = new Set<string>();

    for (const [rel, file] of current) {
      const old = this.#observed.get(rel);
      if (!old) {
        // 重命名配对：同一轮里删掉的旧文件与新文件指纹相同
        const renamedFrom = deleted.find(
          ([from, oldFile]) => !consumedDeleted.has(from) && oldFile.fingerprint === file.fingerprint,
        );
        if (renamedFrom) {
          consumedDeleted.add(renamedFrom[0]);
          this.#observed.delete(renamedFrom[0]);
          this.#observed.set(rel, { ...file, status: "stable", stableSince: now });
          facts.push({
            monitor: this.id,
            kind: "file.renamed",
            at: now,
            fields: {
              path: rel,
              from: renamedFrom[0],
              fingerprint: file.fingerprint,
              size: file.size,
              mtime_ms: file.mtimeMs,
            },
          });
          continue;
        }

        // 新出现：先进入 new，稳定期后才发 added
        if (this.#stableMs === 0) {
          facts.push({
            monitor: this.id,
            kind: "file.added",
            at: now,
            fields: { path: rel, fingerprint: file.fingerprint, size: file.size, mtime_ms: file.mtimeMs },
          });
          this.#observed.set(rel, { ...file, status: "stable", stableSince: now });
        } else {
          this.#observed.set(rel, { ...file, status: "new", stableSince: now });
        }
        continue;
      }

      if (old.fingerprint !== file.fingerprint) {
        // 内容变化：重置稳定计时
        this.#observed.set(rel, { ...file, status: "modified", stableSince: now });
        continue;
      }

      if (old.status !== "stable" && now - old.stableSince >= this.#stableMs) {
        facts.push({
          monitor: this.id,
          kind: old.status === "new" ? "file.added" : "file.modified",
          at: now,
          fields: { path: rel, fingerprint: file.fingerprint, size: file.size, mtime_ms: file.mtimeMs },
        });
        this.#observed.set(rel, { ...file, status: "stable", stableSince: now });
      }
    }

    // 没有配对成重命名的旧文件，才是真正的删除
    for (const [rel, old] of deleted) {
      if (consumedDeleted.has(rel)) continue;
      this.#observed.delete(rel);
      facts.push({
        monitor: this.id,
        kind: "file.deleted",
        at: now,
        fields: { path: rel, fingerprint: old.fingerprint, size: old.size },
      });
    }

    return { facts, errors };
  }

  /** 当前是否匹配 patterns/ignore */
  #matches(rel: string): boolean {
    if (this.#ignore.some((pattern) => matchesGlob(rel, pattern) || matchesGlob(basename(rel), pattern))) {
      return false;
    }
    if (this.#patterns.length === 0) return true;
    return this.#patterns.some((pattern) => matchesGlob(rel, pattern) || matchesGlob(basename(rel), pattern));
  }

  /** 优先内容指纹；超大文件退化为元数据指纹，避免把大文件读进内存 */
  #fingerprint(path: string, size: number, mtimeMs: number): string {
    if (size > this.#maxHashBytes) return `meta:${size}:${Math.round(mtimeMs)}`;
    const hash = createHash("sha256");
    hash.update(readFileSync(path));
    return `sha256:${hash.digest("hex")}`;
  }
}
