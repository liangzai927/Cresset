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
import { isValidTimeZone, parseUntil, parseWallClock, wallBefore } from "./wall-clock.js";

/** 支持的频率 */
export type Freq = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** weekday 简写到 ISO 编号（1=周一 … 7=周日） */
const WEEKDAY_MAP: Record<string, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};

const WEEKDAY_NAMES: Record<number, string> = {
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
};

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
export class RecurrenceParseError extends Error {
  constructor(
    readonly raw: string,
    readonly reason: string,
  ) {
    super(`重复规则无法解析：${reason}（原值：${raw}）`);
    this.name = "RecurrenceParseError";
  }
}

/** 解析 RRULE 字符串；不支持或非法的部分直接报错 */
export function parseRRule(raw: string): ParsedRecurrence {
  const text = raw.trim().toUpperCase();
  if (text === "") throw new RecurrenceParseError(raw, "规则为空");

  const out: ParsedRecurrence = {
    freq: "DAILY",
    interval: 1,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    count: null,
    until: null,
    raw: raw.trim(),
  };

  let sawFreq = false;
  for (const part of text.split(";")) {
    if (part.trim() === "") continue;
    const eq = part.indexOf("=");
    if (eq < 0) throw new RecurrenceParseError(raw, `片段缺少等号：${part}`);
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    switch (key) {
      case "FREQ": {
        const allowed: Freq[] = ["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
        if (!allowed.includes(value as Freq)) {
          throw new RecurrenceParseError(raw, `不支持的 FREQ：${value}`);
        }
        out.freq = value as Freq;
        sawFreq = true;
        break;
      }
      case "INTERVAL": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new RecurrenceParseError(raw, `INTERVAL 必须为正整数：${value}`);
        }
        out.interval = n;
        break;
      }
      case "BYDAY": {
        for (const token of value.split(",")) {
          const t = token.trim();
          // 只支持不带序号的 weekday（如 MO）；MO 之外的 -1FR / 2TU 明确不支持
          if (!/^(MO|TU|WE|TH|FR|SA|SU)$/.test(t)) {
            throw new RecurrenceParseError(raw, `BYDAY 只支持简单星期（MO…SU），不支持序号形式：${t}`);
          }
          out.byDay.push(WEEKDAY_MAP[t] as number);
        }
        out.byDay = [...new Set(out.byDay)].sort((a, b) => a - b);
        break;
      }
      case "BYMONTHDAY": {
        for (const token of value.split(",")) {
          const n = Number(token.trim());
          if (!Number.isInteger(n) || n < 1 || n > 31) {
            throw new RecurrenceParseError(raw, `BYMONTHDAY 只支持 1-31：${token}`);
          }
          out.byMonthDay.push(n);
        }
        out.byMonthDay = [...new Set(out.byMonthDay)].sort((a, b) => a - b);
        break;
      }
      case "BYMONTH": {
        for (const token of value.split(",")) {
          const n = Number(token.trim());
          if (!Number.isInteger(n) || n < 1 || n > 12) {
            throw new RecurrenceParseError(raw, `BYMONTH 只支持 1-12：${token}`);
          }
          out.byMonth.push(n);
        }
        out.byMonth = [...new Set(out.byMonth)].sort((a, b) => a - b);
        break;
      }
      case "COUNT": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new RecurrenceParseError(raw, `COUNT 必须为正整数：${value}`);
        }
        out.count = n;
        break;
      }
      case "UNTIL": {
        const ms = parseUntil(value);
        if (ms === null) throw new RecurrenceParseError(raw, `UNTIL 格式非法：${value}`);
        out.until = ms;
        break;
      }
      // 明确不支持的字段：报错而不是忽略（见文件头说明）
      case "BYSETPOS":
      case "BYWEEKNO":
      case "BYYEARDAY":
      case "BYSECOND":
      case "BYHOUR":
      case "BYMINUTE":
        throw new RecurrenceParseError(raw, `本版本不支持 ${key}（如需该语义请用更简单的规则替代）`);
      case "WKST":
        // WKST 只影响"周起点"的解释；本实现固定以周一为周起点，因此显式接受并忽略
        break;
      default:
        throw new RecurrenceParseError(raw, `未知字段：${key}`);
    }
  }

  if (!sawFreq) throw new RecurrenceParseError(raw, "缺少 FREQ");
  validateCombination(out, raw);
  return out;
}

/**
 * 校验字段组合的合理性。
 *
 * 目的是把"语义不明"的规则挡在写入数据库之前 —— 例如 `FREQ=DAILY;BYDAY=MO`
 * 的 RFC 语义是"每天都算，但按 BYDAY 过滤"，结果等价于"仅周一"，
 * 但用户写这个多半是想表达 `FREQ=WEEKLY`。与其猜测，不如报错。
 */
function validateCombination(parsed: ParsedRecurrence, raw: string): void {
  const { freq, byDay, byMonthDay, byMonth } = parsed;

  if (byDay.length > 0 && freq !== "WEEKLY") {
    throw new RecurrenceParseError(
      raw,
      `BYDAY 仅支持与 FREQ=WEEKLY 搭配（当前 FREQ=${freq}）；若要"每月某日"请用 BYMONTHDAY`,
    );
  }
  if (byMonthDay.length > 0 && freq !== "MONTHLY") {
    throw new RecurrenceParseError(raw, `BYMONTHDAY 仅支持与 FREQ=MONTHLY 搭配（当前 FREQ=${freq}）`);
  }
  if (byMonth.length > 0 && freq !== "YEARLY") {
    throw new RecurrenceParseError(raw, `BYMONTH 仅支持与 FREQ=YEARLY 搭配（当前 FREQ=${freq}）`);
  }
}

/** 生成人类可读的中文描述（用于 UI 的 repeatLabel 与通知文案） */
export function describeRecurrence(spec: RecurrenceSpec): string {
  const start = parseWallClock(spec.dtstartWall);
  if (!start) return "时间格式非法";

  if (!spec.rrule) {
    // 一次性任务的描述要**面向人**，而不是把 ISO 串直接抛给界面。
    // （曾经输出 "2026-10-19T10:51 一次性"，在列表里显得像调试信息。）
    const p2n = (n: number): string => String(n).padStart(2, "0");
    return `一次性 · ${p2n(start.month)}-${p2n(start.day)} ${p2n(start.hour)}:${p2n(start.minute)}`;
  }

  let parsed: ParsedRecurrence;
  try {
    parsed = parseRRule(spec.rrule);
  } catch {
    return "自定义重复";
  }

  const every = parsed.interval > 1 ? `每 ${parsed.interval} ` : "每";
  const at = `${String(start.hour).padStart(2, "0")}:${String(start.minute).padStart(2, "0")}`;

  switch (parsed.freq) {
    case "MINUTELY":
      return parsed.interval === 1 ? "每分钟" : `每 ${parsed.interval} 分钟`;
    case "HOURLY":
      return parsed.interval === 1 ? "每小时" : `每 ${parsed.interval} 小时`;
    case "DAILY":
      return parsed.interval === 1 ? `每天 ${at}` : `每 ${parsed.interval} 天 ${at}`;
    case "WEEKLY": {
      const days = parsed.byDay.length > 0 ? parsed.byDay : [weekdayOf(start)];
      const label = days.map((d) => WEEKDAY_NAMES[d] ?? `周${d}`).join("、");
      // 工作日是最常见的特例，单独给出更自然的说法
      if (parsed.byDay.length === 5 && parsed.byDay.join(",") === "1,2,3,4,5" && parsed.interval === 1) {
        return `工作日 ${at}`;
      }
      return `${every}周 ${label} ${at}`;
    }
    case "MONTHLY": {
      const days = parsed.byMonthDay.length > 0 ? parsed.byMonthDay : [start.day];
      return `${every}月 ${days.map((d) => `${d} 号`).join("、")} ${at}`;
    }
    case "YEARLY": {
      const months = parsed.byMonth.length > 0 ? parsed.byMonth : [start.month];
      const label = months.map((m) => `${m} 月 ${start.day} 日`).join("、");
      return parsed.interval === 1 ? `每年 ${label} ${at}` : `每 ${parsed.interval} 年 ${label} ${at}`;
    }
  }
}

function weekdayOf(wall: WallClock): number {
  const dow = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/**
 * 校验一条重复规则的整体合法性（时区、墙钟格式、规则语法、组合）。
 * 返回 null 表示合法；否则返回可直接展示给用户的中文原因。
 *
 * 调用时机：**写入数据库之前**（规范要求"输入先校验再落库"）。
 */
export function validateRecurrenceSpec(spec: RecurrenceSpec): string | null {
  if (!isValidTimeZone(spec.tzid)) return `时区无效：${spec.tzid}`;

  const start = parseWallClock(spec.dtstartWall);
  if (!start) return `首次触发时间格式非法：${spec.dtstartWall}`;

  if (spec.untilWall) {
    const untilWall = parseWallClock(spec.untilWall);
    if (!untilWall) return `结束日期格式非法：${spec.untilWall}`;
    // ⚠️ 必须按解析后的字段比较，不能比较原始字符串：
    // "2026-03-03"（10 字符）与 "2026-03-10T09:00"（16 字符）做字典序会得出错误结论。
    if (wallBefore(untilWall, start)) return "结束日期早于首次触发时间";
  }

  if (spec.countLimit !== null && spec.countLimit !== undefined && spec.countLimit < 1) {
    return "次数上限必须为正整数";
  }

  if (spec.rrule !== null) {
    try {
      parseRRule(spec.rrule);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  return null;
}
