/**
 * 每日简报（M3）
 *
 * 只使用本地已有数据：今天物化的提醒、待处理数量、监测器状态。
 * 天气/日历/邮件尚未接入，本服务**不假装**有这些信息。
 *
 * 触发策略：
 *   - 每个 tick 调用 maybeGenerate；
 *   - 到达配置时间且当天未生成过才创建 `kind=digest` 通知；
 *   - 幂等由 notification.dedupe_key 唯一索引裁决，不靠内存日期。
 */

import { readFileSync } from "node:fs";
import type { Clock } from "@aegis/clock";
import { formatWallClock, resolveTimeZone, utcToWall } from "@aegis/recurrence";
import type { Scheduler } from "@aegis/scheduler";
import { type Db, rowsOf } from "@aegis/storage";
import { loadConfig } from "./config.js";
import { eventsOn, parseIcs } from "./ics-calendar.js";

/** 简报时可用的监测器状态 */
export interface BriefingMonitorStatus {
  id: string;
  lastErrors: number;
}

/** 服务选项 */
export interface BriefingServiceOptions {
  configFile: string;
  db: Db;
  clock: Clock;
  scheduler: Scheduler;
  monitorStatus: () => BriefingMonitorStatus[];
  /** 天气缓存读取；没有天气时返回空数组，不阻断简报 */
  weather?: () => Array<{ location: string; minC: number; maxC: number; description: string }>;
}

/** 每日简报服务 */
export class BriefingService {
  readonly #opts: BriefingServiceOptions;

  constructor(opts: BriefingServiceOptions) {
    this.#opts = opts;
  }

  /**
   * 到点则生成；返回是否真的创建了通知。
   * 未到点、未启用、当天已生成都返回 false。
   */
  maybeGenerate(): boolean {
    const cfg = loadConfig(this.#opts.configFile).config;
    if (!cfg.briefing.enabled) return false;

    const now = this.#opts.clock.wall();
    const wall = utcToWall(now, resolveTimeZone("system"));
    const current = `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
    if (current < cfg.briefing.time) return false;

    const date = `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
    const nowWall = formatWallClock(wall);
    const occurrences = rowsOf<{ title: string; scheduled_wall: string; state: string }>(
      this.#opts.db.prepare(
        `SELECT t.title, o.scheduled_wall, o.state
           FROM occurrence o JOIN task t ON t.id = o.task_id
          WHERE o.scheduled_wall LIKE ? AND t.deleted_at IS NULL
          ORDER BY o.scheduled_wall ASC`,
      ),
      `${date}T%`,
    );
    const pending = occurrences.filter((o) => o.state === "pending" || o.state === "unknown").length;
    const monitors = this.#opts.monitorStatus();
    const monitorErrors = monitors.reduce((n, m) => n + m.lastErrors, 0);

    const lines: string[] = [];
    const weather = this.#opts.weather?.() ?? [];
    for (const w of weather) {
      lines.push(`天气（${w.location}）：${w.description} ${w.minC}–${w.maxC}°C`);
    }
    if (occurrences.length === 0) {
      lines.push("今天没有安排。");
    } else {
      lines.push(`今天有 ${occurrences.length} 个提醒：`);
      for (const o of occurrences.slice(0, 20)) {
        lines.push(
          `· ${o.scheduled_wall.slice(11, 16)} ${o.title}${o.state === "pending" ? "" : `（${o.state}）`}`,
        );
      }
      if (occurrences.length > 20) lines.push(`…还有 ${occurrences.length - 20} 个`);
      const overdue = occurrences.filter((o) => o.state === "pending" && o.scheduled_wall < nowWall).length;
      if (pending > 0) lines.push(`待处理：${pending}${overdue > 0 ? `，其中已过期 ${overdue}` : ""}`);
    }
    if (cfg.calendar.icsPath) {
      try {
        const events = eventsOn(parseIcs(readFileSync(cfg.calendar.icsPath, "utf8")), date);
        if (events.length > 0) {
          lines.push("日程：");
          for (const e of events.slice(0, 20)) {
            const time = e.allDay ? "全天" : e.startWall.slice(11, 16);
            lines.push(`· ${time} ${e.summary}`);
          }
        }
      } catch {
        // 日历是可选增强；文件缺失/坏格式不应阻断简报本身
        lines.push("日历：文件不可读或格式不支持");
      }
    }
    if (monitors.length > 0) {
      lines.push(
        `监测器：${monitors.length} 个运行中${monitorErrors > 0 ? `，最近错误 ${monitorErrors}` : ""}`,
      );
    }

    const created = this.#opts.scheduler.daos.notifications.createWithOutbox({
      kind: "digest",
      title: `今日简报（${date}）`,
      body: lines.join("\n"),
      priority: "normal",
      scheduledFor: now,
      dedupeKey: `briefing:${date}`,
    });
    return created.created;
  }
}
