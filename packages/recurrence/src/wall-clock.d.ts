/**
 * 墙钟时间与时区转换 —— RRULE 求解器的地基
 *
 * ## 为什么需要这一层
 *
 * 本项目的重复规则采用**墙钟语义**（详细设计 §5.1，I1 决策）：
 * 规则的表达是"在某个时区的这个墙上时间"，而不是"固定的 UTC 间隔"。
 *
 * | 场景 | 墙钟语义（采用） | 固定 UTC 语义（否决） |
 * | --- | --- | --- |
 * | "每天 9:00 吃药" 跨夏令时 | 始终本地 9:00 ✓ | 会漂到 8:00 或 10:00 ✗ |
 * | "每周一 10:00 站会" | 在该时区的周一 10:00 ✓ | 出差改时区后语义不明 ✗ |
 *
 * ## 实现方式
 *
 * 只依赖 `Intl.DateTimeFormat`（Node 完整 ICU，R2 开工前已实测可用）：
 *   - 正向：给定 UTC 毫秒 + tzid → 读出该时刻的墙上时间（纯格式化，无误差）
 *   - 反向：给定墙上时间 + tzid → 求对应 UTC 毫秒（**需要搜索**，见下）
 *
 * 反向之所以要搜索：IANA 规则不提供反函数。做法是用一个初猜值试探真实偏移，
 * 再用该偏移修正（DST 边界处两次足够收敛），最后**用正向格式化验证**结果。
 *
 * ## 两个真实存在的边界情况
 *
 * 1. **春令时"不存在的时刻"**：2026-03-08 02:30 在 America/New_York 不存在
 *    （时钟从 02:00 直接跳到 03:00）。约定：**整体向后平移空洞长度**（02:50 → 03:50），
 *    并标记 adjusted。这样能保证"墙上时间递增 ⇒ UTC 严格递增"，不产生回退或重复。
 * 2. **秋令时"重复的时刻"**：2026-11-01 01:30 在 America/New_York 出现两次。
 *    约定：取**第一次**（较早的 UTC 时刻），保证同一墙钟时间只产生一个实例。
 */
/** 墙上时间的字段化表示（不含时区信息，时区由 tzid 单独给出） */
export interface WallClock {
    year: number;
    /** 1-12 */
    month: number;
    /** 1-31 */
    day: number;
    /** 0-23 */
    hour: number;
    /** 0-59 */
    minute: number;
    /** 0-59 */
    second: number;
}
/** UTC 时刻的字段化表示 */
export interface TimeParts extends WallClock {
    /** 0-999 */
    millisecond: number;
}
/** IANA 时区标识；'system' 表示跟随运行环境的本地时区 */
export type Tzid = string;
/** 解析运行时本地时区（依赖完整 ICU；不可用时退化为 UTC） */
export declare function systemTimeZone(): string;
/**
 * 把 tzid 归一化为具体时区名。
 * `'system'` 解析为运行环境的本地时区 —— 这是 I1 决策里的"跟随系统"开关。
 */
export declare function resolveTimeZone(tzid: Tzid): string;
/** 校验是否为运行时认可的 IANA 时区（无效时区应当在写入数据库前就被拒绝） */
export declare function isValidTimeZone(tzid: string): boolean;
/** 给定 UTC 毫秒，读出在指定时区的墙上时间（纯格式化，无近似） */
export declare function utcToWall(epochMs: number, tzid: Tzid): WallClock;
/**
 * 墙钟转换结果。
 *
 * `adjusted` 为 true 表示该墙上时间在此时区**不存在**（春令时跳变导致），
 * 返回值是跳变后的最近合法时刻 —— 调用方可据此决定是否提示用户。
 */
export interface WallToUtcResult {
    epochMs: number;
    adjusted: boolean;
}
/**
 * 把墙上时间解析为该时区的 UTC 毫秒。
 *
 * 算法：
 *   1. 用 UTC 语义构造初猜（把墙上时间当作 UTC 看）
 *   2. 读出初猜时刻在该时区的真实墙上时间，算出偏移并修正
 *   3. 再修正至多 3 轮（DST 边界收敛）
 *   4. **用正向格式化验证**：结果能对得上就是精确解
 *   5. 对不上说明该墙上时间不存在（春令时空洞）→ 向后搜索，
 *      取跳变后的最近时刻并标记 adjusted=true
 */
export declare function wallToUtc(wall: WallClock, tzid: Tzid): WallToUtcResult;
/**
 * 序列化为 `YYYY-MM-DDTHH:mm[:ss]`。
 *
 * 这是 `packages/contracts` 的 `WallClockSchema` 所要求的格式
 * （秒为 0 时省略，保持与人工输入一致的可读性）。
 */
export declare function formatWallClock(wall: WallClock, opts?: {
    seconds?: boolean;
}): string;
/** 解析 `YYYY-MM-DDTHH:mm[:ss]`（契约格式）。格式或取值非法时返回 null */
export declare function parseWallClock(text: string): WallClock | null;
/**
 * 解析 RRULE 的 `UNTIL` 值：`YYYYMMDDTHHMMSSZ`（UTC）或 `YYYYMMDD`（日期）。
 * 按 RFC 5545，UNTIL 是 UTC 时刻；只给日期时视为该日 00:00:00Z。
 */
export declare function parseUntil(text: string): number | null;
/** 序列化为 RFC 5545 的 `YYYYMMDDTHHMMSSZ`（用于 UNTIL） */
export declare function formatUntil(epochMs: number): string;
/** 该年该月有多少天（墙钟域，无需时区；用"下个月第 0 天"避免闰年判断出错） */
export declare function daysInMonth(year: number, month: number): number;
/** 判断墙上时间取值是否合法（如 2026-02-30 与平年 2/29 均非法） */
export declare function isWallClockValid(wall: WallClock): boolean;
/** 星期几：1=周一 … 7=周日（与 RFC 5545 的 BYDAY 编号一致） */
export declare function isoWeekday(wall: Pick<WallClock, "year" | "month" | "day">): number;
/**
 * 比较两个墙钟时间的先后（按日期时间字段，**不是字符串字典序**）。
 *
 * 为什么不能用字符串比较：`YYYY-MM-DD` 与 `YYYY-MM-DDTHH:mm` 长度不同，
 * 字典序会给出错误结论（如 "2026-03-03" > "2026-03-10T09:00"）。
 */
export declare function wallBefore(a: WallClock, b: WallClock): boolean;
/** 判断两个墙钟时间是否相同（到秒） */
export declare function wallEquals(a: WallClock, b: WallClock): boolean;
/** 在墙钟域加减天数（保持时分秒不变，自然处理跨月与跨年） */
export declare function addDays(wall: WallClock, days: number): WallClock;
/**
 * 在墙钟域加减月份。
 *
 * ⚠️ **日超出目标月长度时返回 null** —— 即"每月 31 号"在小月跳过
 * （PRD 已约定的行为，见详细设计 §5.2）。
 */
export declare function addMonths(wall: WallClock, months: number): WallClock | null;
/** 在墙钟域加减年；**2/29 落在平年时返回 null**（跳过） */
export declare function addYears(wall: WallClock, years: number): WallClock | null;
/** 在墙钟域加减分钟（MINUTELY / HOURLY 频率使用；按天回卷保证跨日正确） */
export declare function addMinutes(wall: WallClock, minutes: number): WallClock;
//# sourceMappingURL=wall-clock.d.ts.map