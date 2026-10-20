/**
 * 日历会前提醒 / 冲突提示（M3）
 *
 * 读取本地 ICS 中的非全天事件，为未来 24 小时内的会议创建 `reminder` 通知：
 *   - 提前 N 分钟（默认 10）
 *   - 若与另一个事件时间重叠，在正文里写明冲突对象
 *
 * 通知由 scheduler 统一投递；dedupe_key=calendar:<uid>:<start> 保证只生成一次。
 */

import { readFileSync } from "node:fs";
import type { Clock } from "@aegis/clock";
import { formatWallClock, resolveTimeZone, utcToWall, type WallClock, wallToUtc } from "@aegis/recurrence";
import type { Scheduler } from "@aegis/scheduler";
import { loadConfig } from "./config.js";
import { type CalendarEvent, parseIcs } from "./ics-calendar.js";

/** 解析 YYYY-MM-DDTHH:mm 为 WallClock */
function parseWall(value: string): WallClock {
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(5, 7)),
    day: Number(value.slice(8, 10)),
    hour: Number(value.slice(11, 13)),
    minute: Number(value.slice(14, 16)),
    second: 0,
  };
}

/** 两个事件是否重叠（无结束时间的事件按无冲突处理） */
function conflicts(a: CalendarEvent, b: CalendarEvent): boolean {
  if (!a.endWall || !b.endWall) return false;
  return a.startWall < b.endWall && b.startWall < a.endWall;
}

/** 会前提醒服务 */
export class CalendarReminder {
  readonly #opts: { configFile: string; clock: Clock; scheduler: Scheduler };

  constructor(opts: { configFile: string; clock: Clock; scheduler: Scheduler }) {
    this.#opts = opts;
  }

  /** 每次 tick 调用；返回新建通知数 */
  maybeGenerate(): number {
    const cfg = loadConfig(this.#opts.configFile).config.calendar;
    if (!cfg.icsPath || !cfg.remindersEnabled) return 0;
    let events: CalendarEvent[];
    try {
      events = parseIcs(readFileSync(cfg.icsPath, "utf8"));
    } catch {
      return 0;
    }

    const now = this.#opts.clock.wall();
    const nowWall = formatWallClock(utcToWall(now, resolveTimeZone("system")));
    const leadMs = cfg.reminderMinutes * 60_000;
    let created = 0;

    for (const e of events) {
      if (e.allDay || !e.endWall) continue;
      const startMs = wallToUtc(parseWall(e.startWall), resolveTimeZone("system")).epochMs;
      // 已开始或超过 24 小时的不再生成
      if (startMs < now - 60_000 || startMs > now + 24 * 3_600_000) continue;
      const conflict = events.find((other) => other.uid !== e.uid && conflicts(e, other));
      const scheduledFor = Math.max(now, startMs - leadMs);
      const body = [
        `${e.startWall.slice(11, 16)} 开始${e.endWall ? ` – ${e.endWall.slice(11, 16)}` : ""}`,
        conflict ? `⚠ 与「${conflict.summary}」冲突` : "",
        startMs - now <= leadMs ? "即将开始" : "",
      ]
        .filter(Boolean)
        .join("\n");
      const dedupe = `calendar:${e.uid}:${e.startWall}`;
      const result = this.#opts.scheduler.daos.notifications.createWithOutbox({
        kind: "reminder",
        title: `会议提醒：${e.summary}`,
        body,
        priority: conflict ? "high" : "normal",
        scheduledFor,
        dedupeKey: dedupe,
      });
      if (result.created) created += 1;
    }
    return created;
  }
}
