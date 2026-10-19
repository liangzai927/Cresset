/**
 * `@aegis/scheduler` —— M1 调度引擎
 *
 * 把"重复规则 + 时间"变成"该发的通知"，并保证三件事：
 *   - **不重复**：派发权由数据库的影响行数裁决（不依赖内存状态）
 *   - **不遗漏**：休眠/关机期间错过的实例在补偿窗口内会被补发
 *   - **不静默**：投递失败必然产生一条用户可见的失败告知
 *
 * 分层：
 *   - `policy`：**纯函数**的调度判断（补偿窗口 / 免打扰 / 批量合并 / 降级时机）
 *   - `scheduler`：四个阶段（materialize / dispatch / deliver / reconcile）的编排
 */
export * from "./policy.js";
export * from "./scheduler.js";
