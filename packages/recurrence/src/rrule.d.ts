/**
 * RRULE 解析与校验（RFC 5545 子集）
 *
 * ## 支持的子集（详细设计 §5.2）
 *
 * | 字段 | 支持 | 说明 |
 * | --- | --- | --- |
 * | `FREQ` | MINUTELY / HOURLY / DAILY / WEEKLY / MONTHLY / YEARLY | 覆盖"每 N 分/时/天/周/月/年" |
 * | `INTERVAL` | ✅ | 默认 1 |
 * | `BYDAY` | ✅（WEEKLY） | `MO,TU,WE,TH,FR` 即"工作日" |
 * | `BYMONTHDAY` | ✅（MONTHLY） | 31 号在小月**自动跳过** |
 * | `BYMONTH` | ✅（YEARLY） | |
 * | `COUNT` / `UNTIL` | ✅ | 取先到者 |
 * | `BYSETPOS` / `BYWEEKNO` / `BYYEARDAY` / `WKST` / `BYSECOND` | ❌ **明确不支持** | 解析时报错，不静默忽略 |
 *
 * ## 为什么"不支持就报错"而不是忽略
 *
 * 静默忽略会导致一个危险后果：用户写了 `FREQ=MONTHLY;BYDAY=-1FR`（每月最后一个周五），
 * 若忽略 BYDAY 就变成"每月同一日"—— 一个**看起来在工作、实际提醒错日子**的任务。
 * 对提醒类产品，这比直接拒绝要糟糕得多。
 */
import type { WallClock } from "./wall-clock.js";
/** 支持的频率 */
export type Freq = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
/** 解析后的重复规则 */
export interface ParsedRecurrence {
    freq: Freq;
    interval: number;
    /** 仅 WEEKLY 使用；升序去重 */
    byDay: number[];
    /** 仅 MONTHLY 使用；每项 1-31 */
    byMonthDay: number[];
    /** 仅 YEARLY 使用；每项 1-12 */
    byMonth: number[];
    count: number | null;
    /** UTC 毫秒 */
    until: number | null;
    /** 规则的原始字符串（便于诊断与重放） */
    raw: string;
}
/** 一次具体触发的求解输入 */
export interface RecurrenceSpec {
    /** null 表示一次性任务（不重复） */
    rrule: string | null;
    /** 首次触发的墙上时间 */
    dtstartWall: string;
    /** IANA 时区或 'system' */
    tzid: string;
    /** 可选：重复结束的墙上时间（含） */
    untilWall?: string | null;
    /** 可选：最多触发次数 */
    countLimit?: number | null;
}
/** 求解结果中的一次触发 */
export interface OccurrenceMoment {
    /** UTC 毫秒 */
    epochMs: number;
    /** 该时刻在任务时区的墙上时间（用于展示"原定 HH:MM"） */
    wall: WallClock;
    /** 该墙上时间是否因夏令时跳变被顺延（春令时空洞） */
    dstAdjusted: boolean;
    /** 该实例在序列中的序号（从 1 开始，用于 COUNT 语义） */
    index: number;
}
/** 解析失败时抛出，携带原始规则与具体原因（便于 UI 直接展示给用户） */
export declare class RecurrenceParseError extends Error {
    readonly raw: string;
    readonly reason: string;
    constructor(raw: string, reason: string);
}
/** 解析 RRULE 字符串；不支持或非法的部分直接报错 */
export declare function parseRRule(raw: string): ParsedRecurrence;
/** 生成人类可读的中文描述（用于 UI 的 repeatLabel 与通知文案） */
export declare function describeRecurrence(spec: RecurrenceSpec): string;
/**
 * 校验一条重复规则的整体合法性（时区、墙钟格式、规则语法、组合）。
 * 返回 null 表示合法；否则返回可直接展示给用户的中文原因。
 *
 * 调用时机：**写入数据库之前**（规范要求"输入先校验再落库"）。
 */
export declare function validateRecurrenceSpec(spec: RecurrenceSpec): string | null;
//# sourceMappingURL=rrule.d.ts.map