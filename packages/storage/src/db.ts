/**
 * 数据库打开与迁移执行（R1）
 *
 * 实测约束（来自 R0 spike，见《M0+M1 详细设计》§11.5）：
 *   - C-1：若需要 sqlite-vec 等扩展，**必须在建库时** `{ allowExtension: true }`；
 *          事后调 enableLoadExtension() 会报 "disabled at database creation"。
 *   - C-2：node:sqlite 把所有 JS number 绑定为 REAL；vec0 主键必须用 BigInt。
 *          （R1 尚未用向量表，但 DAO 层已按此约定处理整数主键。）
 */

import type { StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, type Migration } from "./migrations.generated.js";

/**
 * 打开数据库的选项。
 *
 * ⚠️ `allowExtension` 必须在**建库时**给出（约束 C-1）：事后调
 * `enableLoadExtension()` 会报 "disabled at database creation"，
 * 这是 R0 spike 实测踩到的坑。
 */
export interface OpenDbOptions {
  /** 库文件路径；`:memory:` 用于测试 */
  file: string;
  /** 是否在建库时开启扩展加载（C-1：必需在建库时给） */
  allowExtension?: boolean;
  /** 加载 sqlite-vec 等扩展（需 allowExtension=true） */
  loadExtension?: string;
  /** 忙等超时（毫秒），默认 5000 */
  busyTimeoutMs?: number;
}

/** 数据库句柄；对外只暴露必要能力，避免调用方绕过事务封装 */
export interface Db {
  readonly raw: DatabaseSync;
  /** 执行 DDL / 多条语句 */
  exec(sql: string): void;
  /** 预编译语句 */
  prepare(sql: string): StatementSync;
  /** 事务包装：抛错自动回滚 */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * 打开数据库并设置运行期 PRAGMA。
 *
 * 设置内容：WAL（提升并发读写，`:memory:` 下会失败并忽略）、外键约束开启、
 * busy_timeout（多连接竞争时不立即失败）、synchronous=NORMAL（WAL 下的性能/安全折中）。
 */
export function openDb(opts: OpenDbOptions): Db {
  const db = new DatabaseSync(opts.file, {
    allowExtension: opts.allowExtension === true,
  });

  // WAL 提升并发读写；memory 库不支持 WAL，不报错即可
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    /* :memory: 下会失败，忽略 */
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5_000}`);
  db.exec("PRAGMA synchronous = NORMAL");

  if (opts.allowExtension && opts.loadExtension) {
    db.enableLoadExtension(true);
    db.loadExtension(opts.loadExtension);
  }

  const handle: Db = {
    raw: db,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* 回滚失败时保留原始错误 */
        }
        throw err;
      }
    },
    close: () => db.close(),
  };
  return handle;
}

// ── 迁移 ────────────────────────────────────────────────────────────────

/** 已应用迁移的记录；`checksum` 用于检测已发布迁移是否被改动 */
export interface MigrationRecord {
  id: number;
  name: string;
  checksum: string;
  appliedAt: number;
}

/** 一次迁移执行的结果 */
export interface MigrateResult {
  /** 本次实际应用的迁移 id */
  applied: number[];
  /** 已经是应用状态的迁移 id（本次跳过） */
  skipped: number[];
}

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migration (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);
`;

/** 读取已应用的迁移列表（会确保迁移表存在） */
export function listApplied(db: Db): MigrationRecord[] {
  db.exec(MIGRATION_TABLE_SQL);
  const rows = db
    .prepare("SELECT id, name, checksum, applied_at FROM schema_migration ORDER BY id")
    .all() as Array<{ id: number; name: string; checksum: string; applied_at: number }>;
  return rows.map((r) => ({ id: r.id, name: r.name, checksum: r.checksum, appliedAt: r.applied_at }));
}

/**
 * 迁移失败。
 *
 * 三种触发条件：SQL 执行失败；已发布迁移的 checksum 与库中记录不符；
 * 库中存在当前代码未知的迁移（说明在运行旧版本代码）。
 */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * 应用未执行的迁移。
 *
 * 行为保证：
 *   - 每个迁移在**独立事务**内应用（失败即回滚，不会留下半截结构）
 *   - 已应用的迁移会**校验 checksum**：与库中记录不符则报错（防止已发布迁移被改动）
 *   - 迁移 id 必须与库中记录**前缀一致**（不允许跳号或重排）
 */
export function migrate(
  db: Db,
  now: () => number = Date.now,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrateResult {
  const applied = listApplied(db);
  const appliedById = new Map(applied.map((m) => [m.id, m]));
  const result: MigrateResult = { applied: [], skipped: [] };

  for (const m of migrations) {
    const prev = appliedById.get(m.id);
    if (prev) {
      if (prev.checksum !== m.checksum) {
        throw new MigrationError(
          `迁移 ${m.id} (${m.name}) 的 checksum 与库中记录不一致：` +
            `库中=${prev.checksum.slice(0, 12)}… 当前=${m.checksum.slice(0, 12)}…。` +
            "已发布的迁移不可修改，请新增迁移文件。",
        );
      }
      result.skipped.push(m.id);
      continue;
    }

    try {
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migration (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(
          m.id,
          m.name,
          m.checksum,
          now(),
        );
      });
    } catch (err) {
      throw new MigrationError(`应用迁移 ${m.id} (${m.name}) 失败：${String(err)}`);
    }
    result.applied.push(m.id);
  }

  // 库中已有的迁移若不在当前代码的列表里 → 说明代码比库旧
  const knownIds = new Set(migrations.map((m) => m.id));
  const unknown = applied.filter((a) => !knownIds.has(a.id));
  if (unknown.length > 0) {
    throw new MigrationError(
      `数据库包含当前代码未知的迁移：${unknown.map((u) => `${u.id}(${u.name})`).join(", ")}。` +
        "可能你在运行旧版本代码，请升级。",
    );
  }

  return result;
}
