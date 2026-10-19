/**
 * `@aegis/recurrence` —— 重复规则求解
 *
 * 这是 M1 调度引擎的地基，实现为**纯函数**（无 IO、无状态、无当前时间依赖）：
 * 同样的输入永远得到同样的序列。因此它可以被彻底测试 —— 包括"30 天 4320 条实例"
 * 这类用真实时间根本跑不动的场景。
 *
 * 三层结构：
 *   - `wall-clock`：墙钟 ↔ UTC 换算（DST 正确性的唯一来源）
 *   - `rrule`：RRULE 子集解析与校验（不支持的字段**报错而非忽略**）
 *   - `solver`：按周期枚举候选（墙钟域）再转 UTC（时区域）
 */

export * from "./rrule.js";
export * from "./solver.js";
export * from "./wall-clock.js";
