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

// ── 类型 ────────────────────────────────────────────────────────────────

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

// ── 常量与工具 ──────────────────────────────────────────────────────────

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/** 每个时区一个 formatter，避免重复构造（Intl 构造开销明显） */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** 解析运行时本地时区（依赖完整 ICU；不可用时退化为 UTC） */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * 把 tzid 归一化为具体时区名。
 * `'system'` 解析为运行环境的本地时区 —— 这是 I1 决策里的"跟随系统"开关。
 */
export function resolveTimeZone(tzid: Tzid): string {
  if (!tzid || tzid === "system") return systemTimeZone();
  return tzid;
}

/** 校验是否为运行时认可的 IANA 时区（无效时区应当在写入数据库前就被拒绝） */
export function isValidTimeZone(tzid: string): boolean {
  if (tzid === "system") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

// ── 正向：UTC 毫秒 → 墙上时间 ────────────────────────────────────────────

/** 给定 UTC 毫秒，读出在指定时区的墙上时间（纯格式化，无近似） */
export function utcToWall(epochMs: number, tzid: Tzid): WallClock {
  const parts = wallFormatter(resolveTimeZone(tzid)).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

// ── 反向：墙上时间 → UTC 毫秒（需搜索） ──────────────────────────────────

function wallToUtcGuess(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, 0);
}

function sameWall(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

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
export function wallToUtc(wall: WallClock, tzid: Tzid): WallToUtcResult {
  const zone = resolveTimeZone(tzid);
  let guess = wallToUtcGuess(wall);

  for (let i = 0; i < 3; i++) {
    const seen = utcToWall(guess, zone);
    const offset = wallToUtcGuess(seen) - guess; // 该时刻的真实偏移
    const next = wallToUtcGuess(wall) - offset;
    if (next === guess) break;
    guess = next;
  }

  // 验证：能对得上即为精确解
  if (sameWall(utcToWall(guess, zone), wall)) {
    return { epochMs: guess, adjusted: false };
  }

  // 春令时空洞：把该墙上时间**整体向后平移空洞长度**，即"02:50 → 03:50"。
  //
  // ⚠️ 这里不能简单地"取跳变后的第一个合法时刻"：那会把 02:00…02:50 全部压到
  // 03:00 附近，产生**非单调甚至回退**的序列（实测出现过 -51 分钟的间隔）。
  // 按空洞长度平移可以保证：墙钟递增 ⇒ UTC 严格递增，且不产生重复时刻。
  const targetMs = wallToUtcGuess(wall);
  for (let step = MS_PER_MINUTE; step <= 3 * MS_PER_HOUR; step += MS_PER_MINUTE) {
    const candidate = guess + step;
    if (wallToUtcGuess(utcToWall(candidate, zone)) >= targetMs + step) {
      return { epochMs: candidate, adjusted: true };
    }
  }

  // 理论上不可达；仍返回一个确定值并标记，交由上层记录异常
  return { epochMs: guess + MS_PER_HOUR, adjusted: true };
}

// ── 序列化（数据库与契约使用） ──────────────────────────────────────────

/**
 * 序列化为 `YYYY-MM-DDTHH:mm[:ss]`。
 *
 * 这是 `packages/contracts` 的 `WallClockSchema` 所要求的格式
 * （秒为 0 时省略，保持与人工输入一致的可读性）。
 */
export function formatWallClock(wall: WallClock, opts: { seconds?: boolean } = {}): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const date = `${wall.year}-${p2(wall.month)}-${p2(wall.day)}`;
  const time = `${p2(wall.hour)}:${p2(wall.minute)}`;
  const withSeconds = opts.seconds || wall.second !== 0 ? `:${p2(wall.second)}` : "";
  return `${date}T${time}${withSeconds}`;
}

/** 解析 `YYYY-MM-DDTHH:mm[:ss]`（契约格式）。格式或取值非法时返回 null */
export function parseWallClock(text: string): WallClock | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const wall: WallClock = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] ? Number(m[6]) : 0,
  };
  return isWallClockValid(wall) ? wall : null;
}

/**
 * 解析 RRULE 的 `UNTIL` 值：`YYYYMMDDTHHMMSSZ`（UTC）或 `YYYYMMDD`（日期）。
 * 按 RFC 5545，UNTIL 是 UTC 时刻；只给日期时视为该日 00:00:00Z。
 */
export function parseUntil(text: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(text.trim());
  if (!m) return null;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    m[4] ? Number(m[4]) : 0,
    m[5] ? Number(m[5]) : 0,
    m[6] ? Number(m[6]) : 0,
  );
}

/** 序列化为 RFC 5545 的 `YYYYMMDDTHHMMSSZ`（用于 UNTIL） */
export function formatUntil(epochMs: number): string {
  const d = new Date(epochMs);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`
  );
}

// ── 日历运算（全部在墙上时间域进行） ────────────────────────────────────

/** 该年该月有多少天（墙钟域，无需时区；用"下个月第 0 天"避免闰年判断出错） */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 判断墙上时间取值是否合法（如 2026-02-30 与平年 2/29 均非法） */
export function isWallClockValid(wall: WallClock): boolean {
  if (wall.month < 1 || wall.month > 12) return false;
  if (wall.day < 1 || wall.day > daysInMonth(wall.year, wall.month)) return false;
  if (wall.hour < 0 || wall.hour > 23) return false;
  if (wall.minute < 0 || wall.minute > 59) return false;
  if (wall.second < 0 || wall.second > 59) return false;
  return true;
}

/** 星期几：1=周一 … 7=周日（与 RFC 5545 的 BYDAY 编号一致） */
export function isoWeekday(wall: Pick<WallClock, "year" | "month" | "day">): number {
  const dow = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay(); // 0=周日
  return dow === 0 ? 7 : dow;
}

/**
 * 比较两个墙钟时间的先后（按日期时间字段，**不是字符串字典序**）。
 *
 * 为什么不能用字符串比较：`YYYY-MM-DD` 与 `YYYY-MM-DDTHH:mm` 长度不同，
 * 字典序会给出错误结论（如 "2026-03-03" > "2026-03-10T09:00"）。
 */
export function wallBefore(a: WallClock, b: WallClock): boolean {
  return wallToUtcGuess(a) < wallToUtcGuess(b);
}

/** 判断两个墙钟时间是否相同（到秒） */
export function wallEquals(a: WallClock, b: WallClock): boolean {
  return wallToUtcGuess(a) === wallToUtcGuess(b);
}

/** 在墙钟域加减天数（保持时分秒不变，自然处理跨月与跨年） */
export function addDays(wall: WallClock, days: number): WallClock {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second,
  };
}

/**
 * 在墙钟域加减月份。
 *
 * ⚠️ **日超出目标月长度时返回 null** —— 即"每月 31 号"在小月跳过
 * （PRD 已约定的行为，见详细设计 §5.2）。
 */
export function addMonths(wall: WallClock, months: number): WallClock | null {
  const total = wall.year * 12 + (wall.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  if (wall.day > daysInMonth(year, month)) return null;
  return { ...wall, year, month };
}

/** 在墙钟域加减年；**2/29 落在平年时返回 null**（跳过） */
export function addYears(wall: WallClock, years: number): WallClock | null {
  const year = wall.year + years;
  if (wall.day > daysInMonth(year, wall.month)) return null;
  return { ...wall, year };
}

/** 在墙钟域加减分钟（MINUTELY / HOURLY 频率使用；按天回卷保证跨日正确） */
export function addMinutes(wall: WallClock, minutes: number): WallClock {
  const d = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute + minutes, wall.second),
  );
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}
