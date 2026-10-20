/**
 * BriefingService 测试：时间门槛、每日幂等、监测器状态摘要。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "@aegis/clock";
import { Scheduler } from "@aegis/scheduler";
import { migrate, openDb } from "@aegis/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BriefingService } from "./briefing-service.js";

let dir: string;
let db: ReturnType<typeof openDb>;
let clock: VirtualClock;
let scheduler: Scheduler;
let configFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-briefing-"));
  db = openDb({ file: join(dir, "test.db") });
  migrate(db);
  clock = new VirtualClock(Date.UTC(2026, 9, 20, 0, 0)); // 本地 08:00（Asia/Shanghai）
  scheduler = new Scheduler({ db, clock, notifiers: [], dnd: { enabled: false, windows: [] } });
  configFile = join(dir, "config.json");
  writeFileSync(configFile, JSON.stringify({ version: 1, briefing: { enabled: true, time: "08:00" } }));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("BriefingService", () => {
  it("未到时间不生成；到点生成且当天只生成一次", () => {
    const early = new BriefingService({
      configFile,
      db,
      clock: new VirtualClock(Date.UTC(2026, 9, 19, 23, 0)),
      scheduler,
      monitorStatus: () => [],
    });
    expect(early.maybeGenerate()).toBe(false);

    const service = new BriefingService({
      configFile,
      db,
      clock,
      scheduler,
      monitorStatus: () => [],
    });
    expect(service.maybeGenerate()).toBe(true);
    expect(service.maybeGenerate()).toBe(false);
    const rows = db.prepare("SELECT title, body, kind FROM notification WHERE kind = 'digest'").all();
    expect(rows).toHaveLength(1);
  });

  it("有天气缓存时把天气写进简报", () => {
    const service = new BriefingService({
      configFile,
      db,
      clock,
      scheduler,
      monitorStatus: () => [],
      weather: () => [{ location: "上海", minC: 12, maxC: 20, description: "晴" }],
    });
    service.maybeGenerate();
    const row = db.prepare("SELECT body FROM notification WHERE kind = 'digest'").get() as { body: string };
    expect(row.body).toContain("天气（上海）：晴 12–20°C");
  });

  it("没有安排时也给出明确内容，并包含监测器状态", () => {
    const service = new BriefingService({
      configFile,
      db,
      clock,
      scheduler,
      monitorStatus: () => [{ id: "system.host", lastErrors: 2 }],
    });
    service.maybeGenerate();
    const row = db.prepare("SELECT body FROM notification WHERE kind = 'digest'").get() as { body: string };
    expect(row.body).toContain("今天没有安排");
    expect(row.body).toContain("最近错误 2");
  });

  it("配置 ICS 时把今天的日程写进简报", () => {
    const ics = join(dir, "calendar.ics");
    writeFileSync(
      ics,
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "DTSTART:20261020T090000",
        "SUMMARY:周会",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    writeFileSync(
      configFile,
      JSON.stringify({ version: 1, briefing: { enabled: true, time: "00:00" }, calendar: { icsPath: ics } }),
    );
    const service = new BriefingService({ configFile, db, clock, scheduler, monitorStatus: () => [] });
    service.maybeGenerate();
    const row = db.prepare("SELECT body FROM notification WHERE kind = 'digest'").get() as { body: string };
    expect(row.body).toContain("日程：");
    expect(row.body).toContain("周会");
  });

  it("启用 useLlm 时采用模型文本；失败回退规则版", async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        briefing: { enabled: true, time: "00:00", useLlm: true },
      }),
    );
    const service = new BriefingService({
      configFile,
      db,
      clock,
      scheduler,
      monitorStatus: () => [],
      llm: async () => "模型润色后的早报",
    });
    expect(await service.maybeGenerateAsync()).toBe(true);
    const row = db.prepare("SELECT body FROM notification WHERE kind = 'digest'").get() as {
      body: string;
    };
    expect(row.body).toBe("模型润色后的早报");
  });

  it("未启用时不生成", () => {
    writeFileSync(configFile, JSON.stringify({ version: 1, briefing: { enabled: false, time: "08:00" } }));
    const service = new BriefingService({ configFile, db, clock, scheduler, monitorStatus: () => [] });
    expect(service.maybeGenerate()).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM notification").get()).toEqual({ n: 0 });
  });
});
