/**
 * MonitorRuntime 测试：事实 → Skill → 通知，以及持久化冷却。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "@aegis/clock";
import type { Monitor } from "@aegis/monitors";
import { Scheduler } from "@aegis/scheduler";
import { parseSkill } from "@aegis/skills";
import { migrate, openDb } from "@aegis/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MonitorRuntime } from "./monitor-runtime.js";

const SKILL = `name: low-space
version: 1.0.0
description: 剩余空间低
permissions: [system.read]
cooldown: 6h
params:
  threshold: 10
trigger:
  type: threshold
  monitor: system.test
  field: free
  op: "<"
  value: "{{params.threshold}}"
action:
  notify:
    priority: high
    title: "空间不足"
    body: "剩余 {{monitor.free}}"
`;

let dir: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-monitor-runtime-"));
  db = openDb({ file: join(dir, "test.db") });
  migrate(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("MonitorRuntime", () => {
  it("命中 Skill 后生成 monitor 通知，并在 cooldown 内不重复", async () => {
    const clock = new VirtualClock(1_000_000);
    const scheduler = new Scheduler({
      db,
      clock,
      notifiers: [],
      dnd: { enabled: false, windows: [] },
    });
    const monitor: Monitor = {
      id: "system.test",
      permission: "system.read",
      async scan() {
        return {
          facts: [
            {
              monitor: "system.test",
              kind: "system.threshold",
              at: clock.wall(),
              fields: { free: 5, mount: "/" },
            },
          ],
          errors: [],
        };
      },
    };
    const runtime = new MonitorRuntime({
      db,
      clock,
      scheduler,
      bindings: [{ monitor, kind: "system", skills: [parseSkill(SKILL)], intervalMs: 1_000 }],
    });

    expect(await runtime.scanOnce()).toEqual({ notified: 1, errors: 0 });
    expect(await runtime.scanById("missing")).toBeNull();
    expect(runtime.status()).toEqual([
      {
        id: "system.test",
        kind: "system",
        intervalMs: 1_000,
        skills: ["low-space"],
        lastScanAt: 1_000_000,
        lastFacts: 1,
        lastNotified: 1,
        lastErrors: 0,
        error: null,
        running: false,
      },
    ]);
    const rows = db
      .prepare("SELECT kind, title, body, priority FROM notification WHERE kind = 'monitor'")
      .all() as Array<{ kind: string; title: string; body: string; priority: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "monitor", title: "空间不足", body: "剩余 5", priority: "high" });

    // 同一冷却窗口内不再产生新通知
    expect(await runtime.scanOnce()).toEqual({ notified: 0, errors: 0 });

    // 推进超过 6h 后允许再次通知
    await clock.advance(7 * 3_600_000);
    expect(await runtime.scanOnce()).toEqual({ notified: 1, errors: 0 });
    const count = db.prepare("SELECT COUNT(*) AS n FROM notification WHERE kind = 'monitor'").get() as {
      n: number;
    };
    expect(count.n).toBe(2);
  });

  it("judge 可抑制通知；judge 异常回退规则文案", async () => {
    const clock = new VirtualClock(3_000_000);
    const scheduler = new Scheduler({
      db,
      clock,
      notifiers: [],
      dnd: { enabled: false, windows: [] },
    });
    const monitor: Monitor = {
      id: "system.test",
      permission: "system.read",
      async scan() {
        return {
          facts: [
            { monitor: "system.test", kind: "system.threshold", at: clock.wall(), fields: { free: 5 } },
          ],
          errors: [],
        };
      },
    };
    const skill = parseSkill(`name: judged
version: 1.0.0
description: 判断测试
permissions: [system.read]
cooldown: 1h
params: {}
trigger:
  type: change
  monitor: system.test
judge:
  prompt: 判断
action:
  notify:
    priority: normal
    title: 规则标题
    body: 规则正文
`);
    const suppress = new MonitorRuntime({
      db,
      clock,
      scheduler,
      bindings: [{ monitor, kind: "system", skills: [skill], intervalMs: 1_000 }],
      judge: async () => null,
    });
    expect(await suppress.scanOnce()).toEqual({ notified: 0, errors: 0 });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM notification WHERE kind = 'monitor'").get() as { n: number }).n,
    ).toBe(0);

    const fallback = new MonitorRuntime({
      db,
      clock,
      scheduler,
      bindings: [{ monitor, kind: "system", skills: [skill], intervalMs: 1_000 }],
      judge: async () => {
        throw new Error("model down");
      },
    });
    expect(await fallback.scanOnce()).toEqual({ notified: 1, errors: 0 });
    const row = db.prepare("SELECT title FROM notification WHERE kind = 'monitor'").get() as {
      title: string;
    };
    expect(row.title).toBe("规则标题");
  });

  it("连续失败达到阈值才发 failure 通知，并按 30 分钟窗口去重", async () => {
    const clock = new VirtualClock(2_000_000);
    const scheduler = new Scheduler({
      db,
      clock,
      notifiers: [],
      dnd: { enabled: false, windows: [] },
    });
    const failing: Monitor = {
      id: "system.failing",
      permission: "system.read",
      async scan() {
        return { facts: [], errors: [{ path: "/", message: "boom" }] };
      },
    };
    const runtime = new MonitorRuntime({
      db,
      clock,
      scheduler,
      bindings: [{ monitor: failing, kind: "system", skills: [], intervalMs: 1_000 }],
    });

    await runtime.scanOnce();
    await runtime.scanOnce();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM notification WHERE kind = 'failure'").get() as { n: number }).n,
    ).toBe(0);

    await runtime.scanOnce();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM notification WHERE kind = 'failure'").get() as { n: number }).n,
    ).toBe(1);

    // 同一 30 分钟 bucket 内不重复
    await runtime.scanOnce();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM notification WHERE kind = 'failure'").get() as { n: number }).n,
    ).toBe(1);

    await clock.advance(31 * 60_000);
    await runtime.scanOnce();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM notification WHERE kind = 'failure'").get() as { n: number }).n,
    ).toBe(2);
  });
});
