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
import { type Migration } from "./migrations.generated.js";
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
export declare function openDb(opts: OpenDbOptions): Db;
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
/** 读取已应用的迁移列表（会确保迁移表存在） */
export declare function listApplied(db: Db): MigrationRecord[];
/**
 * 迁移失败。
 *
 * 三种触发条件：SQL 执行失败；已发布迁移的 checksum 与库中记录不符；
 * 库中存在当前代码未知的迁移（说明在运行旧版本代码）。
 */
export declare class MigrationError extends Error {
    constructor(message: string);
}
/**
 * 应用未执行的迁移。
 *
 * 行为保证：
 *   - 每个迁移在**独立事务**内应用（失败即回滚，不会留下半截结构）
 *   - 已应用的迁移会**校验 checksum**：与库中记录不符则报错（防止已发布迁移被改动）
 *   - 迁移 id 必须与库中记录**前缀一致**（不允许跳号或重排）
 */
export declare function migrate(db: Db, now?: () => number, migrations?: readonly Migration[]): MigrateResult;
//# sourceMappingURL=db.d.ts.map