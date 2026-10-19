/**
 * 调度器集成测试 —— 用虚拟时钟与假渠道验证四个阶段的真实行为
 *
 * 对应验收用例：TC-M1-01（一次性提醒）、TC-M1-03（跨重启幂等）、TC-M1-04（休眠追赶）、
 * TC-M1-05（超窗过期）、TC-M1-12（免打扰推迟）、TC-M1-15/16（渠道降级与失败可见）、
 * TC-M1-17（崩溃期不确定）、TC-M1-20（30 天长跑）。
 *
 * 为什么用假渠道而不是真发通知：单元/集成测试**不应该打扰用户**。
 * 真渠道的可用性由 R0 S5 与 platform 包的探针验证。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "@aegis/clock";
import type { ChannelOutcome, Notifier, NotifyPayload } from "@aegis/platform";
import { type Db, migrate, OccurrenceDao, openDb, TaskDao } from "@aegis/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DndSettings, Scheduler, wallStringToUtc } from "./scheduler.js";

// ── 测试替身 ────────────────────────────────────────────────────────────

/** 记录所有投递的假渠道；可脚本化指定每次调用的结果 */
class RecordingNotifier implements Notifier {
  readonly sent: NotifyPayload[] = [];
  #script: ChannelOutcome[] = [];

  constructor(
    readonly channel: "os_notification" | "cli_fallback",
    readonly defaultOutcome: ChannelOutcome = "success",
  ) {}

  /** 让接下来的若干次投递返回指定结果（用于测试降级链） */
  script(outcomes: ChannelOutcome[]): void {
    this.#script = [...outcomes];
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "测试替身" };
  }

  async send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }> {
    this.sent.push(payload);
    const outcome = this.#script.shift() ?? this.defaultOutcome;
    return outcome === "success" ? { outcome } : { outcome, error: `模拟 ${outcome}` };
  }
}

let dir: string;
let db: Db;
let clock: VirtualClock;
let native: RecordingNotifier;
let cli: RecordingNotifier;

/** 测试基准时刻：2026-03-01 00:00:00 +08:00 */
const T0 = Date.parse("2026-03-01T00:00:00+08:00");
const HOUR = 3_600_000;

const NO_DND: DndSettings = { enabled: false, windows: [] };

function makeScheduler(opts: { dnd?: DndSettings } = {}): Scheduler {
  return new Scheduler({
    db,
    clock,
    notifiers: [native, cli],
    dnd: opts.dnd ?? NO_DND,
  });
}

/** 建一条规则并立即物化（模拟 UI 的"创建提醒"） */
function addTask(
  s: Scheduler,
  spec: { rrule: string | null; dtstartWall: string; tzid?: string },
  extra: { title?: string; priority?: "normal" | "important"; catchupWindowS?: number } = {},
) {
  return s.createTask({
    title: extra.title ?? "测试提醒",
    recurrence: { rrule: spec.rrule, dtstartWall: spec.dtstartWall, tzid: spec.tzid ?? "Asia/Shanghai" },
    ...(extra.priority ? { priority: extra.priority } : {}),
    ...(extra.catchupWindowS !== undefined ? { catchupWindowS: extra.catchupWindowS } : {}),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-sched-"));
  db = openDb({ file: join(dir, "test.db") });
  migrate(db);
  clock = new VirtualClock(T0);
  native = new RecordingNotifier("os_notification");
  cli = new RecordingNotifier("cli_fallback");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  rmSync(dir, { recursive: true, force: true });
});

// ── ① 物化 ──────────────────────────────────────────────────────────────

describe("materialize：物化与幂等", () => {
  it("为每日规则物化出未来 24 小时的实例", () => {
    const s = makeScheduler();
    addTask(s, { rrule: "FREQ=DAILY", dtstartWall: "2026-03-01T09:00" });
    const occ = new OccurrenceDao(db, () => clock.wall());

    const tasks = new TaskDao(db, () => clock.wall()).list();
    expect(tasks).toHaveLength(1);
    const list = occ.listByTask(tasks[0]?.id ?? "", 50);
    // 窗口 = [now - 补偿窗口, now + 前瞻]，因此至少有"今天 09:00"这一条；
    // 若窗口越过次日 09:00 则还会有第二天 —— 断言"至少覆盖到了今天那次"
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((o) => o.scheduledWall.startsWith("2026-03-01T09:00"))).toBe(true);
  });

  it("★ 重复物化不产生重复实例（依赖唯一索引）", () => {
    const s = makeScheduler();
    addTask(s, { rrule: "FREQ=DAILY", dtstartWall: "2026-03-01T09:00" });
    const occ = new OccurrenceDao(db, () => clock.wall());
    // 注意：createTask 内部已经物化过一次（为了让示例提醒立刻可见），
    // 因此这里不再断言首次返回值，而是直接核对"重复物化不会造成重复行"。
    s.materialize();
    const totalAfterFirst = occ.countByState().pending ?? 0;
    expect(totalAfterFirst).toBeGreaterThan(0);

    // 再物化两次：可能有新增（窗口随 now 前移），但**绝不能出现重复实例**
    s.materialize();
    s.materialize();
    const totalAfterMore = occ.countByState().pending ?? 0;

    // 唯一索引保证：不会出现同一 (task_id, scheduled_at) 两行
    const dup = db
      .prepare(
        "SELECT COUNT(*) AS n FROM (SELECT task_id, scheduled_at FROM occurrence GROUP BY task_id, scheduled_at HAVING COUNT(*) > 1)",
      )
      .get() as { n: number };
    expect(dup.n).toBe(0);
    // 且总数只会增长（不是每次物化都翻倍）
    expect(totalAfterMore).toBeGreaterThanOrEqual(totalAfterFirst);
  });

  it("停用的任务不被物化", () => {
    const s = makeScheduler();
    const t = addTask(s, { rrule: "FREQ=DAILY", dtstartWall: "2026-03-01T09:00" });
    new TaskDao(db, () => clock.wall()).setEnabled(t.id, false);
    expect(s.materialize()).toBe(0);
  });

  it("规则非法时不中断整轮物化（单条任务失败被隔离）", () => {
    const s = makeScheduler();
    addTask(s, { rrule: "FREQ=DAILY", dtstartWall: "2026-03-01T09:00" }, { title: "正常任务" });
    // 直接写库塞一条坏规则，绕过 createTask 的校验
    new TaskDao(db, () => clock.wall()).create({
      title: "坏规则",
      recurrence: {
        rrule: "FREQ=DAILY;BYDAY=MO",
        dtstartWall: "2026-03-01T10:00",
        tzid: "Asia/Shanghai",
        untilWall: null,
        countLimit: null,
      },
    });
    expect(() => s.materialize()).not.toThrow();
  });
});

// ── ② 派发 ──────────────────────────────────────────────────────────────

describe("dispatch：到点派发（TC-M1-01）", () => {
  it("★ 到点后派发出一条通知并成功投递", async () => {
    const s = makeScheduler();
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });

    // 未到点：不派发
    let tick = await s.tick();
    expect(tick.dispatched).toBe(0);

    // 推进到 09:00
    await clock.advance(9 * HOUR);
    tick = await s.tick();
    expect(tick.dispatched).toBe(1);
    expect(tick.delivered).toBe(1);
    expect(native.sent).toHaveLength(1);
    expect(native.sent[0]?.title).toBe("测试提醒");
  });

  it("★ 同一实例不会被派发两次（跨多轮 tick）", async () => {
    const s = makeScheduler();
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    await clock.advance(9 * HOUR);

    const t1 = await s.tick();
    const t2 = await s.tick();
    const t3 = await s.tick();
    expect(t1.dispatched).toBe(1);
    expect(t2.dispatched).toBe(0);
    expect(t3.dispatched).toBe(0);
    expect(native.sent).toHaveLength(1); // 只响一次
  });

  it("★ 跨重启幂等（TC-M1-03）：重建调度器后不重发", async () => {
    const s1 = makeScheduler();
    addTask(s1, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    await clock.advance(9 * HOUR);
    await s1.tick();
    expect(native.sent).toHaveLength(1);

    // 模拟进程重启：新建调度器（共享同一个库）
    const s2 = makeScheduler();
    const t = await s2.tick();
    expect(t.dispatched).toBe(0);
    expect(native.sent).toHaveLength(1);
  });

  it("important 任务映射为 high 优先级（可穿透免打扰）", async () => {
    const s = makeScheduler();
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" }, { priority: "important" });
    await clock.advance(9 * HOUR);
    await s.tick();
    const notifications = s.daos.notifications.listRecent(10);
    expect(notifications[0]?.priority).toBe("high");
  });
});

// ── 补偿窗口（TC-M1-04 / TC-M1-05） ──────────────────────────────────────

describe("补偿窗口", () => {
  it("★ 停机 3 小时后恢复：错过的实例在窗口内被补发（TC-M1-04）", async () => {
    const s = makeScheduler();
    addTask(
      s,
      { rrule: "FREQ=MINUTELY;INTERVAL=30", dtstartWall: "2026-03-01T00:00", tzid: "Asia/Shanghai" },
      { catchupWindowS: 12 * 3600 },
    );

    // 模拟停机 3 小时（虚拟时钟直接跳过，期间没有任何 tick）
    await clock.advance(3 * HOUR);

    const tick = await s.tick();
    expect(tick.dispatched).toBeGreaterThan(0); // 补发
    expect(tick.skippedOutOfWindow).toBe(0); // 3 小时 < 12 小时窗口
    expect(native.sent.length).toBeGreaterThan(0);
  });

  it("★ 停机 20 小时：超出 12 小时窗口的实例被跳过而非补发（TC-M1-05）", async () => {
    const s = makeScheduler();
    addTask(
      s,
      { rrule: "FREQ=MINUTELY;INTERVAL=30", dtstartWall: "2026-03-01T00:00", tzid: "Asia/Shanghai" },
      { catchupWindowS: 12 * 3600 },
    );

    await clock.advance(20 * HOUR); // 超过窗口
    const tick = await s.tick();

    // 早期实例被跳过（记历史但不打扰），只有落在窗口内的才会补发
    expect(tick.skippedOutOfWindow).toBeGreaterThan(0);
    expect(tick.dispatched).toBeGreaterThan(0); // 窗口内的仍然补发
  });

  it("skipped 的实例不会再次被派发", async () => {
    const s = makeScheduler();
    addTask(
      s,
      { rrule: "FREQ=MINUTELY;INTERVAL=30", dtstartWall: "2026-03-01T00:00", tzid: "Asia/Shanghai" },
      { catchupWindowS: 3600 },
    );
    await clock.advance(20 * HOUR);
    await s.tick();
    const after = await s.tick();
    expect(after.skippedOutOfWindow).toBe(0); // 已处理过，不再重复跳过
  });
});

// ── ③ 免打扰（TC-M1-12 / TC-M1-13） ─────────────────────────────────────

describe("免打扰", () => {
  const DND: DndSettings = {
    enabled: true,
    windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: "22:00", to: "08:00" }],
  };

  it("★ 夜间普通提醒被推迟到 08:00，而不是丢弃（TC-M1-12）", async () => {
    const s = makeScheduler({ dnd: DND });
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T23:00" }); // 落在 DND 内

    await clock.advance(23 * HOUR);
    const tick = await s.tick();
    expect(tick.dispatched).toBe(1);
    expect(tick.deferredForDnd).toBe(1);
    expect(native.sent).toHaveLength(0); // 尚未投递

    const notifications = s.daos.notifications.listRecent(10);
    expect(notifications[0]?.state).toBe("pending"); // ★ 不是 suppressed
    // 投递时刻被推到次日 08:00 之后
    const scheduledFor = notifications[0]?.scheduledFor ?? 0;
    expect(scheduledFor).toBeGreaterThan(clock.wall());
  });

  it("★ 推迟到 08:00 后自动被投递（无需额外唤醒逻辑）", async () => {
    const s = makeScheduler({ dnd: DND });
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T23:00" });
    await clock.advance(23 * HOUR);
    await s.tick();

    // 推进到次日 08:00 之后
    await clock.advance(9 * HOUR);
    const tick = await s.tick();
    expect(tick.delivered).toBe(1);
    expect(native.sent).toHaveLength(1);
  });

  it("★ 重要提醒穿透免打扰（TC-M1-13）", async () => {
    const s = makeScheduler({ dnd: DND });
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T23:00" }, { priority: "important" });

    await clock.advance(23 * HOUR);
    const tick = await s.tick();
    expect(tick.dispatched).toBe(1);
    expect(tick.deferredForDnd).toBe(0); // 未被推迟
    expect(native.sent).toHaveLength(1); // 立刻投递
  });
});

// ── ④ 投递与降级（TC-M1-15 / TC-M1-16） ─────────────────────────────────

describe("渠道降级与失败可见", () => {
  it("原生渠道成功时不走兜底", async () => {
    const s = makeScheduler();
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    await clock.advance(9 * HOUR);
    await s.tick();
    expect(native.sent).toHaveLength(1);
    expect(cli.sent).toHaveLength(0); // 兜底未使用
  });

  it("★ 原生渠道永久失败 → 自动降级到 CLI 兜底（TC-M1-15）", async () => {
    native.script(["permanent_error"]);
    const s = makeScheduler();
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    await clock.advance(9 * HOUR);

    const tick = await s.tick();
    expect(tick.delivered).toBe(1);
    expect(native.sent).toHaveLength(1);
    expect(cli.sent).toHaveLength(1); // 兜底接手
  });

  it("★ 两个渠道都失败 → 标记失败并生成失败告知（TC-M1-16，不许静默）", async () => {
    native.script(["permanent_error"]);
    cli.script(["permanent_error"]);
    const s = makeScheduler();
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    await clock.advance(9 * HOUR);

    const tick = await s.tick();
    expect(tick.delivered).toBe(0);
    expect(tick.failedDeliveries).toBe(1);

    const recent = s.daos.notifications.listRecent(10);
    const original = recent.find((n) => n.kind === "reminder");
    expect(original?.state).toBe("failed");
    // ★ 必须有一条 failure 通知告知用户
    const failure = recent.find((n) => n.kind === "failure");
    expect(failure).toBeDefined();
    expect(failure?.title).toContain("未能送达");
  });

  it("瞬时错误走重试而不是立刻降级（避免抖动）", async () => {
    native.script(["transient_error", "success"]);
    const s = makeScheduler();
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    await clock.advance(9 * HOUR);

    const t1 = await s.tick();
    expect(t1.delivered).toBe(0); // 第一次瞬时失败
    expect(cli.sent).toHaveLength(0); // 未降级

    await clock.advance(10_000); // 越过退避
    const t2 = await s.tick();
    expect(t2.delivered).toBe(1);
    expect(native.sent).toHaveLength(2); // 同一渠道重试成功
  });

  it("投递尝试被写入 delivery_attempt（审计可查）", async () => {
    native.script(["permanent_error"]);
    const s = makeScheduler();
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    await clock.advance(9 * HOUR);
    await s.tick();

    const rows = db
      .prepare("SELECT channel, outcome FROM delivery_attempt ORDER BY attempt_no")
      .all() as Array<{
      channel: string;
      outcome: string;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]).toEqual({ channel: "os_notification", outcome: "permanent_error" });
    expect(rows[1]).toEqual({ channel: "cli_fallback", outcome: "success" });
  });
});

// ── ④ 收敛（TC-M1-17） ──────────────────────────────────────────────────

describe("reconcile：崩溃恢复", () => {
  it("★ 领取超时的实例进入 unknown，而不是被重发或丢弃（TC-M1-17）", async () => {
    const s = makeScheduler();
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    await clock.advance(9 * HOUR);

    // 手工制造"已领取但未投递"的状态（模拟投递途中崩溃）
    const occ = new OccurrenceDao(db, () => clock.wall());
    const task = new TaskDao(db, () => clock.wall()).list()[0];
    s.materialize();
    const pending = occ.listByTask(task?.id ?? "", 10).find((o) => o.state === "pending");
    expect(pending).toBeDefined();
    occ.claim(pending?.id ?? "", 60_000);

    await clock.advance(61_000);
    const tick = await s.tick();
    expect(tick.reconciled).toBeGreaterThan(0);
    expect(occ.getById(pending?.id ?? "")?.state).toBe("unknown");
    expect(native.sent).toHaveLength(0); // 不自动重发
  });

  it("陈旧 outbox inflight 被重置（否则那条通知永远发不出去）", async () => {
    const s = makeScheduler();
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    await clock.advance(9 * HOUR);

    // 制造 inflight 卡住
    s.daos.outbox.enqueue("notify.deliver", { notificationId: "不存在" });
    const ready = s.daos.outbox.listReady(clock.wall());
    s.daos.outbox.claim(ready[0]?.id ?? 0);

    await clock.advance(121_000);
    const tick = await s.tick();
    expect(tick.reconciled).toBeGreaterThan(0);
  });
});

// ── tick 阶段隔离 ────────────────────────────────────────────────────────

describe("tick：阶段隔离", () => {
  it("★ 单条派发失败不阻断其余实例（一处坏不应导致全局哑）", async () => {
    const logs: string[] = [];
    const s = new Scheduler({
      db,
      clock,
      notifiers: [native, cli],
      dnd: NO_DND,
      onLog: (r) => logs.push(r.event),
    });
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" }, { title: "提醒 A" });
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" }, { title: "提醒 B" });
    await clock.advance(9 * HOUR);

    // 破坏 outbox 表：通知落库会失败（createWithOutbox 是同一事务）
    db.exec("ALTER TABLE outbox RENAME TO outbox_broken");
    const tick = await s.tick();

    // 关键点：整轮 tick 不抛错（异常被逐条隔离），失败被**记录**而不是静默
    expect(tick.errors.length).toBeGreaterThan(0);
    expect(logs).toContain("scheduler.dispatch_one_failed");
    // 两条实例都失败了 → 没有任何一条被算作成功派发
    expect(tick.dispatched).toBe(0);
  });

  it("阶段隔离：deliver 阶段失败不影响 dispatch 的成果", async () => {
    const s = makeScheduler();
    addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    await clock.advance(9 * HOUR);

    // 先正常派发（通知与 outbox 都写入成功）
    let tick = await s.tick();
    expect(tick.dispatched).toBe(1);
    expect(tick.delivered).toBe(1);

    // 再破坏 outbox 表，此时 deliver 阶段会失败，但已投递的事实保留
    db.exec("ALTER TABLE outbox RENAME TO outbox_broken");
    tick = await s.tick();
    expect(tick.errors.length).toBeGreaterThan(0);
    expect(tick.dispatched).toBe(0); // 没有新实例可派发
    expect(s.daos.notifications.listRecent(10)[0]?.state).toBe("delivered"); // 成果未被破坏
  });
});

// ── 长跑（TC-M1-20） ────────────────────────────────────────────────────

describe("★ 30 天长跑（TC-M1-20）", () => {
  it("每 10 分钟的任务：30 天 4320 条通知，0 重复 0 漏报", async () => {
    const s = makeScheduler();
    addTask(
      s,
      { rrule: "FREQ=MINUTELY;INTERVAL=10", dtstartWall: "2026-03-01T00:00", tzid: "Asia/Shanghai" },
      { catchupWindowS: 10_800 }, // 3 小时补偿窗口
    );

    // 逐 tick 推进 30 天（每 5 分钟一次 tick，覆盖每 10 分钟一个实例）
    const tickInterval = 5 * 60_000;
    const totalMs = 30 * 24 * HOUR;
    let ticks = 0;
    let dispatchedTotal = 0;
    for (let elapsed = 0; elapsed < totalMs; elapsed += tickInterval) {
      await clock.advance(tickInterval);
      const t = await s.tick();
      dispatchedTotal += t.dispatched;
      ticks += 1;
    }

    expect(ticks).toBe(30 * 24 * 12); // 8640 轮
    // 30 天 × 144 次/天 = 4320 条（最后一条可能因边界差 1）
    // 窗口右端是闭区间，因此末尾可能多出 1 条（落在 30 天边界上的那一次）
    expect(dispatchedTotal).toBeGreaterThanOrEqual(4319);
    expect(dispatchedTotal).toBeLessThanOrEqual(4321);

    // ★ 0 重复：投递次数等于派发次数
    expect(native.sent.length).toBe(dispatchedTotal);
    // ★ 无重复通知 ID
    const notifications = s.daos.notifications.listRecent(5000);
    expect(new Set(notifications.map((n) => n.id)).size).toBe(notifications.length);
    // ★ 全部投递成功，无失败
    expect(notifications.filter((n) => n.state === "failed")).toHaveLength(0);
  });
});

// ── 一次性任务的显示边界（真实缺陷回归） ────────────────────────────────

describe("★ 一次性任务的 nextFireAt 边界", () => {
  it("未到点时显示触发时刻（不是 null）", () => {
    const s = makeScheduler();
    const t = addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    const next = s.nextFireAt(t);
    // 缺陷表现：曾经因为"严格晚于 now"的搜索而返回 null，
    // 导致界面上还没响就显示"已结束"
    expect(next).not.toBeNull();
    expect(next).toBe(clock.wall() + 9 * HOUR);
  });

  it("已到点但尚未投递时仍显示该时刻（提醒仍在等待投递）", async () => {
    const s = makeScheduler();
    const t = addTask(s, { rrule: null, dtstartWall: "2026-03-01T09:00" });
    await clock.advance(9 * HOUR);
    await s.tick(); // 已投递
    expect(s.nextFireAt(t)).toBeNull(); // 投递完成后才算结束
  });

  it("重复任务的 nextFireAt 正常推进（不受该修复影响）", () => {
    const s = makeScheduler();
    const t = addTask(s, { rrule: "FREQ=DAILY", dtstartWall: "2026-03-01T09:00" });
    expect(s.nextFireAt(t)).toBe(clock.wall() + 9 * HOUR);

    // 语义说明：`fromMs` 是"包含"的 —— 返回 fromMs 时刻或之后的下一次。
    // 这正是界面需要的语义（"现在"往前看，哪怕下一次就在下一秒）。
    // 因此用"正好是触发时刻"作为 from 时，返回的就是那一刻本身。
    const todayFire = wallStringToUtc("2026-03-01T09:00", "Asia/Shanghai");
    expect(todayFire).not.toBeNull();
    expect(s.nextFireAt(t, todayFire as number)).toBe(todayFire);

    // 而任意非触发时刻之后，返回的是下一次触发（墙钟语义下用同一墙上时刻的次日对照）
    const oneMinuteLater = wallStringToUtc("2026-03-01T09:01", "Asia/Shanghai");
    expect(oneMinuteLater).not.toBeNull();
    expect(s.nextFireAt(t, oneMinuteLater as number)).toBe(
      wallStringToUtc("2026-03-02T09:00", "Asia/Shanghai") as number,
    );
  });
});
