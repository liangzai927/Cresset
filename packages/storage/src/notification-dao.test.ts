/**
 * 通知与 Outbox DAO 测试
 *
 * 重点验证三件事（对应详细设计 §4.2 / §6.4）：
 *   1. 通知入库与入队是**同一事务**（不会出现"记了没发"或"发了没记"）
 *   2. 系统通知靠 `dedupe_key` 幂等（重复生成不会重复打扰）
 *   3. 崩溃恢复路径：陈旧 inflight 能被重置，卡住的通知不会变成静默漏报
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, migrate, openDb } from "./db.js";
import { NotificationDao } from "./notification-dao.js";
import { backoffMs, OUTBOX_MAX_ATTEMPTS, OutboxDao } from "./outbox-dao.js";

let dir: string;
let db: Db;
let clock: { now: () => number; advance: (ms: number) => void };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-notify-"));
  db = openDb({ file: join(dir, "test.db") });
  migrate(db);
  let t = 1_700_000_000_000;
  clock = { now: () => t, advance: (ms) => (t += ms) };
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("NotificationDao：创建与原子入队", () => {
  it("createWithOutbox 同时产生通知与 outbox 行（同一事务）", () => {
    const dao = new NotificationDao(db, clock.now);
    const outbox = new OutboxDao(db, clock.now);
    const r = dao.createWithOutbox({ kind: "reminder", title: "交周报", scheduledFor: clock.now() });

    expect(r.created).toBe(true);
    expect(dao.getById(r.id)?.state).toBe("pending");
    const ready = outbox.listReady(clock.now());
    expect(ready).toHaveLength(1);
    expect(ready[0]?.topic).toBe("notify.deliver");
    expect(ready[0]?.payload).toEqual({ notificationId: r.id });
  });

  it("★ 事务原子性：入队失败时通知也不应残留", () => {
    const dao = new NotificationDao(db, clock.now);
    // 制造 outbox 写入失败：把表改名（模拟结构异常）
    db.exec("ALTER TABLE outbox RENAME TO outbox_broken");
    expect(() =>
      dao.createWithOutbox({ kind: "reminder", title: "会被回滚", scheduledFor: clock.now() }),
    ).toThrow();
    // 通知不应残留（事务回滚）
    expect(dao.listRecent(10)).toHaveLength(0);
  });

  it("★ dedupeKey 幂等：同一键只创建一次", () => {
    const dao = new NotificationDao(db, clock.now);
    const input = {
      kind: "system_gap" as const,
      title: "我在 03:00–05:00 期间没有运行",
      scheduledFor: clock.now(),
      dedupeKey: "gap:2026-03-01T03:00",
    };
    const first = dao.createWithOutbox(input);
    const second = dao.createWithOutbox(input);
    const third = dao.createWithOutbox(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(dao.listRecent(10)).toHaveLength(1);

    const outbox = new OutboxDao(db, clock.now);
    expect(outbox.listReady(clock.now())).toHaveLength(1); // 只入队一次
  });

  it("无 dedupeKey 时每次都创建（普通提醒每次都该响）", () => {
    const dao = new NotificationDao(db, clock.now);
    dao.createWithOutbox({ kind: "reminder", title: "吃药", scheduledFor: clock.now() });
    dao.createWithOutbox({ kind: "reminder", title: "吃药", scheduledFor: clock.now() });
    expect(dao.listRecent(10)).toHaveLength(2);
  });

  it("字段经 Zod 解码（状态与类型正确）", () => {
    const dao = new NotificationDao(db, clock.now);
    const r = dao.createWithOutbox({
      kind: "reminder",
      title: "测试",
      body: "正文",
      priority: "high",
      scheduledFor: clock.now(),
    });
    const n = dao.getById(r.id);
    expect(n?.priority).toBe("high");
    expect(n?.state).toBe("pending");
    expect(n?.dedupeKey).toBeNull();
  });
});

describe("NotificationDao：投递状态机", () => {
  it("claim 只有第一次成功（并发裁决）", () => {
    const dao = new NotificationDao(db, clock.now);
    const r = dao.createWithOutbox({ kind: "reminder", title: "A", scheduledFor: clock.now() });
    expect(dao.claim(r.id)).toBe(true);
    expect(dao.claim(r.id)).toBe(false); // 已 delivering
    expect(dao.getById(r.id)?.state).toBe("delivering");
  });

  it("已投递的通知不能被再次 claim（绝不重复发送）", () => {
    const dao = new NotificationDao(db, clock.now);
    const r = dao.createWithOutbox({ kind: "reminder", title: "A", scheduledFor: clock.now() });
    dao.claim(r.id);
    dao.markDelivered(r.id);
    expect(dao.claim(r.id)).toBe(false);
    expect(dao.getById(r.id)?.state).toBe("delivered");
  });

  it("markFailed 只对 pending/delivering 生效", () => {
    const dao = new NotificationDao(db, clock.now);
    const r = dao.createWithOutbox({ kind: "reminder", title: "A", scheduledFor: clock.now() });
    dao.claim(r.id);
    dao.markDelivered(r.id);
    expect(dao.markFailed(r.id)).toBe(false); // 已投递，不该被改成失败
    expect(dao.getById(r.id)?.state).toBe("delivered");
  });
});

describe("NotificationDao：免打扰是「推迟」而不是「丢弃」（TC-M1-12）", () => {
  it("defer 把 scheduled_for 推后，状态仍为 pending，到点后会被 listDue 捡起", () => {
    const dao = new NotificationDao(db, clock.now);
    const r = dao.createWithOutbox({ kind: "reminder", title: "夜间提醒", scheduledFor: clock.now() });

    // 此刻是 DND 期间 → 推迟到 8 小时后
    const dndEnd = clock.now() + 8 * 3_600_000;
    expect(dao.defer(r.id, dndEnd)).toBe(true);
    expect(dao.getById(r.id)?.state).toBe("pending"); // ★ 不是 suppressed
    expect(dao.listDue(clock.now())).toHaveLength(0); // 推迟期间取不到

    clock.advance(8 * 3_600_000 + 1);
    const due = dao.listDue(clock.now());
    expect(due).toHaveLength(1); // 到点后自然被捡起
    expect(due[0]?.id).toBe(r.id);
  });

  it("suppress 才是真正抑制（状态变更，不再被捡起）", () => {
    const dao = new NotificationDao(db, clock.now);
    const r = dao.createWithOutbox({ kind: "reminder", title: "A", scheduledFor: clock.now() });
    expect(dao.suppress(r.id)).toBe(true);
    expect(dao.getById(r.id)?.state).toBe("suppressed");
    clock.advance(3_600_000);
    expect(dao.listDue(clock.now())).toHaveLength(0);
  });
});

describe("NotificationDao：崩溃恢复", () => {
  it("★ 陈旧 delivering 被回收为 pending（否则会静默漏报）", () => {
    const dao = new NotificationDao(db, clock.now);
    const r = dao.createWithOutbox({ kind: "reminder", title: "A", scheduledFor: clock.now() });
    dao.claim(r.id); // 进程在此刻崩溃

    expect(dao.reclaimStaleDelivering(120_000)).toBe(0); // 尚未超时
    clock.advance(121_000);
    expect(dao.reclaimStaleDelivering(120_000)).toBe(1);
    expect(dao.getById(r.id)?.state).toBe("pending"); // 回到可投递状态
    expect(dao.listDue(clock.now())).toHaveLength(1);
  });
});

describe("OutboxDao：状态机与退避", () => {
  it("enqueue → claim → done", () => {
    const outbox = new OutboxDao(db, clock.now);
    const id = outbox.enqueue("notify.deliver", { notificationId: "n1" });
    expect(outbox.countByState()).toEqual({ pending: 1 });
    expect(outbox.claim(id)).toBe(true);
    expect(outbox.countByState()).toEqual({ inflight: 1 });
    expect(outbox.markDone(id)).toBe(true);
    expect(outbox.countByState()).toEqual({ done: 1 });
  });

  it("claim 只有第一次成功", () => {
    const outbox = new OutboxDao(db, clock.now);
    const id = outbox.enqueue("notify.deliver", {});
    expect(outbox.claim(id)).toBe(true);
    expect(outbox.claim(id)).toBe(false);
  });

  it("★ 可重试失败按指数退避重排，且退避封顶", () => {
    const outbox = new OutboxDao(db, clock.now);
    const id = outbox.enqueue("notify.deliver", {});
    outbox.claim(id);
    expect(outbox.failTransient(id, "网络超时")).toBe(true); // 还会重试

    const e = outbox.getById(id);
    expect(e?.state).toBe("pending");
    expect(e?.attempts).toBe(1);
    expect(e?.nextAttemptAt).toBe(clock.now() + backoffMs(1));
    expect(outbox.listReady(clock.now())).toHaveLength(0); // 退避期内取不到

    clock.advance(backoffMs(1));
    expect(outbox.listReady(clock.now())).toHaveLength(1);
  });

  it("退避封顶（不会无限增长）", () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(2)).toBe(4_000);
    expect(backoffMs(10)).toBe(300_000); // 封顶 5 分钟
  });

  it("达到最大尝试次数后标记 dead（不再无限重试）", () => {
    const outbox = new OutboxDao(db, clock.now);
    const id = outbox.enqueue("notify.deliver", {});
    let willRetry = true;
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      outbox.claim(id);
      willRetry = outbox.failTransient(id, `第 ${i + 1} 次失败`);
    }
    expect(willRetry).toBe(false);
    expect(outbox.getById(id)?.state).toBe("dead");
  });

  it("永久失败直接 dead", () => {
    const outbox = new OutboxDao(db, clock.now);
    const id = outbox.enqueue("notify.deliver", {});
    outbox.claim(id);
    expect(outbox.failPermanent(id, "权限被拒")).toBe(true);
    expect(outbox.getById(id)?.state).toBe("dead");
  });

  it("★ 陈旧 inflight 被重置（崩溃恢复的关键一步）", () => {
    const outbox = new OutboxDao(db, clock.now);
    const id = outbox.enqueue("notify.deliver", {});
    outbox.claim(id); // 消费途中崩溃

    expect(outbox.resetStaleInflight(120_000)).toBe(0);
    clock.advance(121_000);
    expect(outbox.resetStaleInflight(120_000)).toBe(1);
    expect(outbox.getById(id)?.state).toBe("pending");
    expect(outbox.listReady(clock.now())).toHaveLength(1);
  });

  it("notBeforeMs 可安排延迟投递（不早于指定时刻）", () => {
    const outbox = new OutboxDao(db, clock.now);
    outbox.enqueue("notify.deliver", {}, clock.now() + 60_000);
    expect(outbox.listReady(clock.now())).toHaveLength(0);
    clock.advance(60_001);
    expect(outbox.listReady(clock.now())).toHaveLength(1);
  });

  it("purgeDone 只清理完成的记录", () => {
    const outbox = new OutboxDao(db, clock.now);
    const a = outbox.enqueue("notify.deliver", {});
    const b = outbox.enqueue("notify.deliver", {});
    outbox.claim(a);
    outbox.markDone(a);
    void b;

    expect(outbox.purgeDone(1_000)).toBe(0); // 还没到保留期
    clock.advance(2_000);
    expect(outbox.purgeDone(1_000)).toBe(1);
    expect(outbox.countByState()).toEqual({ pending: 1 });
  });

  it("载荷损坏时保留原始字符串（便于诊断而不是丢记录）", () => {
    const outbox = new OutboxDao(db, clock.now);
    const id = outbox.enqueue("notify.deliver", { ok: true });
    db.prepare("UPDATE outbox SET payload = ? WHERE id = ?").run("{ 损坏的 JSON", id);
    expect(outbox.getById(id)?.payload).toBe("{ 损坏的 JSON");
  });
});
