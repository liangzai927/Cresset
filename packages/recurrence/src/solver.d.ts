/**
 * 重复规则求解器 —— R2 的纯函数核心
 *
 * ## 求解模型（这是全项目最需要理解的算法之一）
 *
 * 关键设计：**先把"这个周期里有哪些墙上时间"算出来，再逐个转成 UTC 时刻。**
 * DST 只在最后一步介入，因此跳变、重叠、小月跳过都不会污染枚举逻辑。
 *
 * ```
 * 周期迭代（墙钟域）        候选墙钟时间（墙钟域）      转 UTC（这里才涉及时区）
 * 2026-03 每月的 31 号  →  [2026-03-31T09:00]      →  1774…（精确）
 * 2026-02（不存在 31 号）→  []                      →  （跳过，不报错）
 * ```
 *
 * ## 与 RFC 5545 的一处刻意差异
 *
 * RFC 让 `BYDAY`/`BYMONTHDAY` 等**扩展** DTSTART，本实现取**并集**：
 * 例如 `FREQ=WEEKLY;BYDAY=MO,WE` + DTSTART 落在周五，则解为"周一、周三、周五"。
 * 理由：用户写 BYDAY 时是在"补充日子"，不是"替换锚点"；这比隐藏掉 DTSTART 更符合直觉，
 * 也与 Google Calendar 的实际行为一致。该差异已在此显式记录，避免被当成 bug。
 *
 * ## 输出不变量（物化依赖它）
 *
 * `occurrencesBetween` 保证：**严格升序、无重复**。
 *
 * 这一条需要显式保证，因为 DST 空洞的映射天然会破坏它：
 * 春令时 02:00–02:50 这些"不存在的墙上时间"无论怎么映射，
 * 都会与跳变后（03:00 起）的合法时刻在真实时间轴上交错或重合。
 * 因此求解器在出口做一次单调化 + 去重（保留最早出现的那次），
 * 把"物理上不可能存在多个提醒"的时刻自然折叠为一个。
 *
 * ## 性能与安全阀
 *
 * 求解必须**有界**：规则可能产生极密的序列（如"每 1 分钟"跨 5 年 = 260 万个实例）。
 * 因此有三重限制：`maxIterations`（周期数）、`cap`（返回条数）、以及调用方给定的时间区间。
 */
import { type OccurrenceMoment, type RecurrenceSpec } from "./rrule.js";
/** 求解上限：周期迭代次数（防止稀疏规则无限向前找） */
export declare const DEFAULT_MAX_ITERATIONS = 10000;
/** 求解上限：返回的实例条数 */
export declare const DEFAULT_CAP = 1000;
/** 求解异常：规则本身合法，但产生的序列超出安全上限 */
export declare class RecurrenceLimitError extends Error {
    readonly iterations: number;
    readonly produced: number;
    constructor(iterations: number, produced: number);
}
/**
 * 求解的可选限制。
 *
 * 两者都是**安全阀**而非调优参数：规则的密度由用户决定，
 * 求解器必须保证不会因为一条"每 1 分钟、跨 5 年"的规则而耗尽内存。
 */
export interface SolveOptions {
    /** 周期迭代上限 */
    maxIterations?: number;
    /** 返回条数上限 */
    cap?: number;
}
/**
 * 枚举 `[fromMs, toMs]`（闭区间）内的全部触发时刻，按时间升序。
 *
 * @param spec 重复规则（`rrule` 为 null 时表示一次性任务）
 * @param fromMs 区间起点（UTC 毫秒）
 * @param toMs 区间终点（UTC 毫秒）
 *
 * 行为保证：
 *   - 结果**确定性**：同样的输入永远得到同样的序列（无随机、无当前时间依赖）
 *   - 结果**无重复**：同一 (epochMs) 只会出现一次
 *   - 结果**升序**：可直接用于物化
 * @throws RecurrenceParseError 规则本身非法
 * @throws RecurrenceLimitError 序列超出安全上限
 */
export declare function occurrencesBetween(spec: RecurrenceSpec, fromMs: number, toMs: number, opts?: SolveOptions): OccurrenceMoment[];
/**
 * 求"下一次触发"（严格晚于 `afterMs`）。
 *
 * 这是调度器最常用的查询：给定"现在"，找出下一个该触发的时刻。
 * 通过搜索一个合理的前瞻窗口实现（默认 1 年），避免无限向前扫描。
 *
 * @returns 找不到时返回 null（如规则已结束）
 */
export declare function nextOccurrenceAfter(spec: RecurrenceSpec, afterMs: number, opts?: SolveOptions & {
    searchWindowMs?: number;
}): OccurrenceMoment | null;
/**
 * 便于测试与诊断：把求解结果转成"墙钟字符串 + UTC"的可读数组。
 * 不参与生产逻辑。
 */
export declare function describeMoments(moments: OccurrenceMoment[], tzid: string): string[];
export type { OccurrenceMoment, RecurrenceSpec } from "./rrule.js";
//# sourceMappingURL=solver.d.ts.map