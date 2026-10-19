/**
 * 存储层 —— SQLite（node:sqlite，Node 24 内置）
 *
 * 选型依据（R0 S1/S2 实测，见《R0-spike结论报告》F4）：
 *   - `node:sqlite` 随 Node 运行时提供，**零原生依赖、无 Electron ABI 风险**
 *     （better-sqlite3 在 pnpm 下 binding 常缺失，需额外构建配置）。
 *   - sqlite-vec 可用，但**必须在建库时**传 `{ allowExtension: true }`（约束 C-1）。
 *   - 向量表主键必须用 BigInt 绑定（约束 C-2）。
 *
 * 模块划分：db（打开/迁移）· blobs（内容寻址）· task-dao · occurrence-dao ·
 *           notification-dao · outbox-dao · audit-repo
 */

export * from "./audit-repo.js";
export * from "./blobs.js";
export * from "./db.js";
export * from "./delivery-attempt-dao.js";
export { MIGRATIONS, type Migration } from "./migrations.generated.js";
export * from "./notification-dao.js";
export * from "./occurrence-dao.js";
export * from "./outbox-dao.js";
export * from "./rows.js";
export * from "./task-dao.js";
