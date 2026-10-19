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

import {
  type OccurrenceMoment,
  type ParsedRecurrence,
  parseRRule,
  RecurrenceParseError,
  type RecurrenceSpec,
} from "./rrule.js";
import {
  addDays,
  addMinutes,
  addMonths,
  addYears,
  daysInMonth,
  formatWallClock,
  isoWeekday,
  parseWallClock,
  utcToWall,
  type WallClock,
  wallBefore,
  wallToUtc,
} from "./wall-clock.js";

/** 求解上限：周期迭代次数（防止稀疏规则无限向前找） */
export const DEFAULT_MAX_ITERATIONS = 10_000;
/** 求解上限：返回的实例条数 */
export const DEFAULT_CAP = 1_000;

/** 求解异常：规则本身合法，但产生的序列超出安全上限 */
export class RecurrenceLimitError extends Error {
  constructor(
    readonly iterations: number,
    readonly produced: number,
  ) {
    super(`重复规则求解超出上限（迭代 ${iterations} 次，产出 ${produced} 条）：请缩小时间区间或简化规则`);
    this.name = "RecurrenceLimitError";
  }
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
 * 对已按墙钟升序排列的候选做"单调化 + 去重"。
 *
 * 背景见文件头：DST 空洞的映射会与跳变后的合法时刻交错/重合，
 * 这里把结果整理成严格升序且无重复的序列 —— 这是物化的前提。
 * 折叠时**保留最早出现的候选**（它代表"用户意图中最早的那个时刻"）。
 */
function monotonicUnique(moments: OccurrenceMoment[]): OccurrenceMoment[] {
  const out: OccurrenceMoment[] = [];
  for (const m of moments) {
    const last = out[out.length - 1];
    if (last && m.epochMs <= last.epochMs) continue; // 交错或重合 → 折叠
    out.push(m);
  }
  return out;
}

/** 内部：一个"周期"的起止（墙钟域，闭区间） */
interface Period {
  start: WallClock;
  end: WallClock;
}

/** 把墙上时间归一化到当天的 00:00:00（用于日期比较） */
function startOfDay(wall: WallClock): WallClock {
  return { ...wall, hour: 0, minute: 0, second: 0 };
}

/** 求指定日期所在周的周一 */
function mondayOf(wall: WallClock): WallClock {
  const dow = isoWeekday(wall); // 1=周一 … 7=周日
  return startOfDay(addDays(wall, -(dow - 1)));
}

/**
 * 计算第 n 个周期（n 从 0 开始）。
 *
 * 返回 null 表示该周期不存在（如 `FREQ=MONTHLY` 且首日是 31 号时遇到 2 月）——
 * 这是"小月跳过"语义的实现方式，不是错误。
 */
function periodAt(parsed: ParsedRecurrence, dtstart: WallClock, n: number): Period | null {
  const step = n * parsed.interval;

  switch (parsed.freq) {
    case "MINUTELY": {
      const start = addMinutes(dtstart, step);
      return { start, end: start };
    }
    case "HOURLY": {
      // 以"分钟+秒"为步长，保持锚点的分秒（每小时的第 X 分 Y 秒）
      const start = addMinutes(dtstart, step * 60);
      return { start, end: start };
    }
    case "DAILY": {
      const start = addDays(dtstart, step);
      return { start, end: start };
    }
    case "WEEKLY": {
      const start = addDays(mondayOf(dtstart), step * 7);
      return { start, end: addDays(start, 6) };
    }
    case "MONTHLY": {
      const first = addMonths({ ...dtstart, day: 1 }, step);
      if (!first) return null;
      const lastDay = daysInMonth(first.year, first.month);
      return {
        start: { ...first, day: 1, hour: 0, minute: 0, second: 0 },
        end: { ...first, day: lastDay, hour: 0, minute: 0, second: 0 },
      };
    }
    case "YEARLY": {
      const first = addYears({ ...dtstart, month: 1, day: 1 }, step);
      if (!first) return null;
      return {
        start: { ...first, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
        end: { ...first, month: 12, day: 31, hour: 0, minute: 0, second: 0 },
      };
    }
  }
}

/** 周期内按时间排序的候选墙上时间 */
function candidatesIn(parsed: ParsedRecurrence, dtstart: WallClock, period: Period): WallClock[] {
  const time = { hour: dtstart.hour, minute: dtstart.minute, second: dtstart.second };

  switch (parsed.freq) {
    case "MINUTELY":
    case "HOURLY":
    case "DAILY":
      // 这三种频率每个周期恰好一个候选：周期起点本身就是该候选
      return [period.start];
    case "WEEKLY": {
      // 取 BYDAY 与锚点星期的**并集**（见文件头"与 RFC 5545 的差异"）
      const days = new Set<number>(parsed.byDay.length > 0 ? parsed.byDay : [isoWeekday(dtstart)]);
      if (parsed.byDay.length > 0) days.add(isoWeekday(dtstart));
      return [...days]
        .sort((a, b) => a - b)
        .map((d) => {
          // period.start 是周一，因此周内第 d 天是 start + (d-1)
          const day = addDays(period.start, d - 1);
          return { ...day, ...time };
        });
    }
    case "MONTHLY": {
      const days = new Set<number>(parsed.byMonthDay.length > 0 ? parsed.byMonthDay : [dtstart.day]);
      if (parsed.byMonthDay.length > 0) days.add(dtstart.day);
      const lastDay = daysInMonth(period.start.year, period.start.month);
      return [...days]
        .filter((d) => d <= lastDay) // 小月跳过：31 号在 2 月不存在
        .sort((a, b) => a - b)
        .map((d) => ({ ...period.start, day: d, ...time }));
    }
    case "YEARLY": {
      const months = new Set<number>(parsed.byMonth.length > 0 ? parsed.byMonth : [dtstart.month]);
      if (parsed.byMonth.length > 0) months.add(dtstart.month);
      const out: WallClock[] = [];
      for (const m of [...months].sort((a, b) => a - b)) {
        // 2/29 落在平年时跳过
        if (dtstart.day > daysInMonth(period.start.year, m)) continue;
        out.push({ ...period.start, month: m, day: dtstart.day, ...time });
      }
      return out;
    }
  }
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
export function occurrencesBetween(
  spec: RecurrenceSpec,
  fromMs: number,
  toMs: number,
  opts: SolveOptions = {},
): OccurrenceMoment[] {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const cap = opts.cap ?? DEFAULT_CAP;

  const dtstart = parseWallClock(spec.dtstartWall);
  if (!dtstart) {
    throw new RecurrenceParseError(spec.dtstartWall, "首次触发时间格式非法");
  }

  // 规则的结束条件：COUNT 与 UNTIL 取先到者。二者都可能来自 RRULE 或调用方参数。
  let parsed: ParsedRecurrence | null = null;
  if (spec.rrule !== null) {
    parsed = parseRRule(spec.rrule);
  }

  const untilCandidates: number[] = [];
  if (parsed?.until !== null && parsed?.until !== undefined) untilCandidates.push(parsed.until);
  if (spec.untilWall) {
    const w = parseWallClock(spec.untilWall);
    if (w) {
      // 结束日期是墙钟语义（含当日），因此在任务时区里求该日 23:59:59 对应的 UTC
      untilCandidates.push(wallToUtc({ ...w, hour: 23, minute: 59, second: 59 }, spec.tzid).epochMs);
    }
  }
  const untilMs = untilCandidates.length > 0 ? Math.min(...untilCandidates) : null;

  const countLimits = [parsed?.count ?? null, spec.countLimit ?? null].filter(
    (x): x is number => typeof x === "number",
  );
  const countLimit = countLimits.length > 0 ? Math.min(...countLimits) : null;

  const out: OccurrenceMoment[] = [];

  /** 把候选墙上时间转成 UTC 并做区间/结束条件过滤 */
  const push = (wall: WallClock, index: number): boolean => {
    const { epochMs, adjusted } = wallToUtc(wall, spec.tzid);
    if (epochMs < fromMs) return true; // 早于区间：跳过但继续
    if (epochMs > toMs) return false; // 晚于区间：可停止
    if (untilMs !== null && epochMs > untilMs) return false;
    out.push({ epochMs, wall, dstAdjusted: adjusted, index });
    return out.length < cap;
  };

  // ── 一次性任务：只有 DTSTART 本身
  if (parsed === null) {
    push(dtstart, 1);
    return monotonicUnique(out);
  }

  // ── 重复任务
  //
  // 需要先判断"目标区间之前已经发生过多少次"，才能正确实现 COUNT 语义。
  // 做法：从第 0 个周期开始扫，但**跳过**那些明显早于区间的周期以省时间。
  // 由于 COUNT 需要精确计数，这里采用"边扫边计数"的方式：
  // 只有当区间起点之前存在候选时才累加计数（不做近似）。
  let produced = 0; // 从序列开始累计的触发次数（用于 COUNT）
  let iterations = 0;

  // ── 快速跳过：把 n 直接推进到"周期结束时间 ≥ 区间起点"的第一个周期。
  //
  // 为什么需要：物化窗口总是"现在往后 24 小时"，而 DTSTART 可能在很久以前
  // （例如一年前创建的每日任务）。若从第 0 个周期逐个扫描，每天都要空转几百个周期。
  // 这里按倍增找上界，再二分收敛，代价是对数级。
  //
  // ⚠️ 跳过会丢失"被跳过周期的计数"，因此**必须**校验结果与逐个扫描一致：
  //    跳过后的最终计数要么已确定达到 COUNT（提前返回），
  //    要么未达上限（此时少数的周期对结果无影响）。
  const startN = fastForwardStart(parsed, dtstart, spec.tzid, fromMs);
  let producedKnown = false; // 是否已精确知道跳过区间的触发次数
  if (startN > 0) {
    const check = countUpTo(parsed, dtstart, spec.tzid, startN, toMs, countLimit);
    if (check.saturated) {
      // 跳过区间内就已经达到 COUNT 上限 → 区间内不可能再有触发
      return monotonicUnique(out);
    }
    produced = check.count;
    producedKnown = check.exact;
  }
  void producedKnown;

  for (let n = startN; ; n++) {
    if (iterations++ >= maxIterations) {
      throw new RecurrenceLimitError(iterations, out.length);
    }
    const period = periodAt(parsed, dtstart, n);
    if (!period) continue;

    // 周期完全在区间之后：结束
    const periodStartMs = wallToUtc(period.start, spec.tzid).epochMs;
    if (periodStartMs > toMs) break;

    // 周期完全早于区间：只累加计数（COUNT 语义需要）
    const periodEndMs = wallToUtc(period.end, spec.tzid).epochMs;
    const entirelyBefore = periodEndMs < fromMs;

    const candidates = candidatesIn(parsed, dtstart, period);
    if (candidates.length === 0) continue; // 小月跳过等情况

    if (entirelyBefore) {
      for (const wall of candidates) {
        // DTSTART 之前的候选不算触发（RFC：序列从 DTSTART 开始）
        if (wallBefore(wall, dtstart)) continue;
        if (wallToUtc(wall, spec.tzid).epochMs > toMs) break;
        produced += 1;
        if (countLimit !== null && produced >= countLimit) return monotonicUnique(out);
      }
      continue;
    }

    for (const wall of candidates) {
      if (wallBefore(wall, dtstart)) continue; // 不早于 DTSTART
      produced += 1;
      if (countLimit !== null && produced > countLimit) return monotonicUnique(out);
      if (!push(wall, produced)) return monotonicUnique(out);
    }
  }

  return monotonicUnique(out);
}

/**
 * 求第一个"周期结束时间不早于 `fromMs`"的周期序号。
 *
 * 用倍增找上界 + 二分收敛，代价 O(log n)，避免从 DTSTART 逐个空转。
 * 返回 0 表示第 0 个周期就已在区间内（无需跳过）。
 */
function fastForwardStart(
  parsed: ParsedRecurrence,
  dtstart: WallClock,
  tzid: string,
  fromMs: number,
): number {
  const endOf = (n: number): number | null => {
    const p = periodAt(parsed, dtstart, n);
    return p ? wallToUtc(p.end, tzid).epochMs : null;
  };

  // 第 0 个周期已经覆盖区间起点 → 不跳
  const first = endOf(0);
  if (first === null || first >= fromMs) return 0;

  // 倍增找上界
  let lo = 0;
  let hi = 1;
  for (let guard = 0; guard < 64; guard++) {
    const e = endOf(hi);
    if (e === null || e >= fromMs) break;
    lo = hi;
    hi *= 2;
  }

  // 二分收敛到"最后一个 end < fromMs"的位置，再 +1
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const e = endOf(mid);
    if (e === null || e < fromMs) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * 统计"周期区间 [0, upto) 内、且不晚于 toMs"的触发次数。
 *
 * 用于在快速跳过之后校正 COUNT 计数。`saturated` 表示已达 COUNT 上限，
 * 此时区间内不可能再有触发，调用方可直接返回空结果。
 */
function countUpTo(
  parsed: ParsedRecurrence,
  dtstart: WallClock,
  tzid: string,
  upto: number,
  toMs: number,
  countLimit: number | null,
): { count: number; exact: boolean; saturated: boolean } {
  let count = 0;
  for (let n = 0; n < upto; n++) {
    const period = periodAt(parsed, dtstart, n);
    if (!period) continue;
    for (const wall of candidatesIn(parsed, dtstart, period)) {
      if (wallBefore(wall, dtstart)) continue;
      const ms = wallToUtc(wall, tzid).epochMs;
      if (ms > toMs) break;
      count += 1;
      if (countLimit !== null && count >= countLimit) {
        return { count, exact: true, saturated: true };
      }
    }
  }
  return { count, exact: true, saturated: false };
}

/**
 * 求"下一次触发"（严格晚于 `afterMs`）。
 *
 * 这是调度器最常用的查询：给定"现在"，找出下一个该触发的时刻。
 * 通过搜索一个合理的前瞻窗口实现（默认 1 年），避免无限向前扫描。
 *
 * @returns 找不到时返回 null（如规则已结束）
 */
export function nextOccurrenceAfter(
  spec: RecurrenceSpec,
  afterMs: number,
  opts: SolveOptions & { searchWindowMs?: number } = {},
): OccurrenceMoment | null {
  const window = opts.searchWindowMs ?? 366 * 24 * 3600 * 1000;
  // 起点取 afterMs + 1 毫秒，保证"严格晚于"
  const list = occurrencesBetween(spec, afterMs + 1, afterMs + window, opts);
  return list.length > 0 ? (list[0] as OccurrenceMoment) : null;
}

/**
 * 便于测试与诊断：把求解结果转成"墙钟字符串 + UTC"的可读数组。
 * 不参与生产逻辑。
 */
export function describeMoments(moments: OccurrenceMoment[], tzid: string): string[] {
  return moments.map(
    (m) =>
      `${formatWallClock(utcToWall(m.epochMs, tzid))} → ${new Date(m.epochMs).toISOString()}` +
      (m.dstAdjusted ? "（夏令时顺延）" : ""),
  );
}

// 便于调用方只从本模块导入即可拿到求解相关类型
export type { OccurrenceMoment, RecurrenceSpec } from "./rrule.js";
