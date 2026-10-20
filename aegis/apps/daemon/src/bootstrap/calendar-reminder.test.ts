/**
 * 日历提醒测试：会前 N 分钟 + 冲突检测 + 去重。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "@aegis/clock";
import { Scheduler } from "@aegis/scheduler";
import { migrate, openDb } from "@aegis/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarReminder } from "./calendar-reminder.js";

let dir: string;
let db: ReturnType<typeof openDb>;
let scheduler: Scheduler;
let configFile: string;
let ics: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-cal-reminder-"));
  db = openDb({ file: join(dir, "test.db") });
  migrate(db);
  // 本地 08:55（Asia/Shanghai）
  const clock = new VirtualClock(Date.UTC(2026, 9, 20, 0, 55));
  scheduler = new Scheduler({ db, clock, notifiers: [], dnd: { enabled: false, windows: [] } });
  ics = join(dir, "calendar.ics");
  writeFileSync(
    ics,
    [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a",
      "DTSTART:20261020T091000",
      "DTEND:20261020T093000",
      "SUMMARY:周会",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:b",
      "DTSTART:20261020T092000",
      "DTEND:20261020T100000",
      "SUMMARY:客户电话",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );
  configFile = join(dir, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      calendar: { icsPath: ics, remindersEnabled: true, reminderMinutes: 10 },
    }),
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("CalendarReminder", () => {
  it("生成会前提醒，并标记冲突", () => {
    const service = new CalendarReminder({
      configFile,
      clock: new VirtualClock(Date.UTC(2026, 9, 20, 0, 55)),
      scheduler,
    });
    expect(service.maybeGenerate()).toBe(2);
    const rows = db
      .prepare("SELECT title, body, priority FROM notification WHERE kind = 'reminder' ORDER BY title")
      .all() as Array<{ title: string; body: string; priority: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.body.includes("与「客户电话」冲突"))).toBe(true);
    expect(rows.every((r) => r.priority === "high")).toBe(true);
  });

  it("重复调用不重复生成", () => {
    const service = new CalendarReminder({
      configFile,
      clock: new VirtualClock(Date.UTC(2026, 9, 20, 0, 55)),
      scheduler,
    });
    service.maybeGenerate();
    expect(service.maybeGenerate()).toBe(0);
  });
});
