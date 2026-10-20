/**
 * 极简 ICS 日历解析（M3）
 *
 * 只解析本地导出的 .ics：VEVENT + DTSTART/DTEND/SUMMARY，足够早报展示"今天有什么会"。
 * 不实现 RRULE、VALARM、 attendee、时区数据库；重复事件由导出的日历展开后再导入。
 *
 * 为什么手写：ICS 是纯文本、格式稳定；本阶段只需要读，不值得引入一个完整日历库。
 */

import { formatWallClock, resolveTimeZone, utcToWall } from "@aegis/recurrence";

/** 一个日历事件；startWall 形如 `2026-10-20T09:00` */
export interface CalendarEvent {
  summary: string;
  startWall: string;
  endWall: string | null;
  allDay: boolean;
}

/** 展开 ICS 的折行：CRLF + 单个空格/制表符是续行 */
function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

/** 反转义 ICS 文本 */
function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/** 把 ICS 日期/时间转成本地墙上时间 */
export function parseIcsDate(value: string, params: string): { wall: string; allDay: boolean } | null {
  const v = value.trim();
  if (/^\d{8}$/.test(v)) {
    return {
      wall: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`,
      allDay: true,
    };
  }
  if (/^\d{8}T\d{6}Z?$/.test(v)) {
    const base = v.replace(/Z$/, "");
    const y = base.slice(0, 4);
    const mo = base.slice(4, 6);
    const d = base.slice(6, 8);
    const h = base.slice(9, 11);
    const mi = base.slice(11, 13);
    if (v.endsWith("Z")) {
      const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
      // 规则禁止业务代码直接 new Date；utcToWall 内部用格式化，不依赖本地 getter。
      const local = utcToWall(ms, resolveTimeZone("system"));
      return { wall: formatWallClock(local), allDay: false };
    }
    return { wall: `${y}-${mo}-${d}T${h}:${mi}`, allDay: false };
  }
  // 兼容带 TZID 的本地时间；参数已剥离，值本身仍是墙上时间
  if (params.includes("TZID")) return null;
  return null;
}

/** 解析 ICS 文本中的 VEVENT */
export function parseIcs(text: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let current: Partial<CalendarEvent> | null = null;
  let startParams = "";

  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      startParams = "";
      continue;
    }
    if (line === "END:VEVENT") {
      if (current?.summary && current.startWall) {
        events.push({
          summary: current.summary,
          startWall: current.startWall,
          endWall: current.endWall ?? null,
          allDay: current.allDay ?? false,
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const name = head.split(";")[0];
    if (name === "SUMMARY") current.summary = unescapeIcs(value).trim();
    if (name === "DTSTART") {
      const parsed = parseIcsDate(value, head);
      if (parsed) {
        current.startWall = parsed.wall;
        current.allDay = parsed.allDay;
        startParams = head;
      }
    }
    if (name === "DTEND") {
      const parsed = parseIcsDate(value, `${head};${startParams}`);
      if (parsed) current.endWall = parsed.wall;
    }
  }
  return events.sort((a, b) => a.startWall.localeCompare(b.startWall));
}

/** 取某一天的事件（按开始日期过滤；全天事件也包含） */
export function eventsOn(events: CalendarEvent[], date: string): CalendarEvent[] {
  return events.filter((e) => e.startWall.slice(0, 10) === date);
}
