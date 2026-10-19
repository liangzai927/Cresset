/**
 * 通知 DAO —— 派发阶段的落点
 *
 * ## 职责边界
 *
 * 本文件只负责**通知的持久化与状态迁移**，不决定"该不该发"（那是 scheduler 的规则）。
 *
 * ## 三条设计要点
 *
 * 1. **创建与入队必须同事务**：通知落库与 outbox 入队要么都成功、要么都失败。
 *    否则会出现"记了但没发"或"发了但没记"——后者在崩溃后无法对账（详细设计 §4.2 的 outbox 动机）。
 * 2. **系统通知靠 `dedupe_key` 去重**：运行缺口、失败告知这类通知可能被多次生成，
 *    唯一索引保证只出现一次（`uq_notification_dedupe`）。
 * 3. **免打扰不是丢弃而是推迟**：被 DND 抑制的通知保持 `pending`，
 *    只把 `scheduled_for` 推到 DND 结束时刻，由后续 tick 自然捡起。
 */
import { randomUUID } from "node:crypto";
import {
  type Notification,
  type NotificationKind,
  type NotificationPriority,
  NotificationSchema,
  type NotificationState,
} from "@aegis/contracts";
import type { Db } from "./db.js";
import { rowOf, rowsOf } from "./rows.js";

/** 新建通知的入参 */
export interface CreateNotificationInput {
  occurrenceId?: string | null;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  priority?: NotificationPriority;
  /** 计划投递时刻（UTC 毫秒）；DND 会把 `scheduled_for` 推后到这个值之后 */
  scheduledFor: number;
  /** 系统通知去重键；非空时受唯一索引约束 */
  dedupeKey?: string | null;
}

/** 创建结果；`created=false` 表示被 dedupe_key 拦下（已存在同键通知） */
export interface CreateNotificationResult {
  created: boolean;
  id: string;
  notification: Notification | null;
}

interface NotificationRow {
  id: string;
  occurrence_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  priority: string;
  scheduled_for: number;
  state: string;
  dedupe_key: string | null;
  created_at: number;
  updated_at: number;
}

const COLS = `id, occurrence_id, kind, title, body, priority, scheduled_for, state, dedupe_key, created_at, updated_at`;

function fromRow(row: NotificationRow): Notification {
  // 出口一律经 Zod 解码：字段漂移在边界暴露，而不是流到业务逻辑里
  return NotificationSchema.parse({
    id: row.id,
    occurrenceId: row.occurrence_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    priority: row.priority,
    scheduledFor: row.scheduled_for,
    state: row.state,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** 通知读写与状态迁移；创建入口应当用 `createWithOutbox` 以保证与入队的原子性 */
export class NotificationDao {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /**
   * 创建通知（幂等：`dedupeKey` 非空时重复创建会被唯一索引拦下）。
   *
   * ⚠️ 调用方通常应当把它放进 `NotificationDao.createWithOutbox()` 里，
   * 以保证"通知落库 + 入队"的原子性。
   */
  create(input: CreateNotificationInput): CreateNotificationResult {
    const id = randomUUID();
    const at = this.#now();
    const res = this.#db
      .prepare(
        `INSERT INTO notification
           (id, occurrence_id, kind, title, body, priority, scheduled_for, state, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
         -- ⚠️ 必须带索引谓词：uq_notification_dedupe 是**部分唯一索引**
         -- （WHERE dedupe_key IS NOT NULL），普通 ON CONFLICT(dedupe_key) 无法匹配它，
         -- SQLite 会报 "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"。
         -- 这也让 dedupe_key 为 NULL 的行可以插任意多条（普通提醒每次都该响）。
         ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      )
      .run(
        id,
        input.occurrenceId ?? null,
        input.kind,
        input.title,
        input.body ?? null,
        input.priority ?? "normal",
        input.scheduledFor,
        input.dedupeKey ?? null,
        at,
        at,
      );

    if (Number(res.changes) > 0) {
      return { created: true, id, notification: this.getById(id) };
    }

    // 被去重键拦下：取回既有通知，让调用方知道"已存在"而不是当作失败
    const existing = rowOf<{ id: string }>(
      this.#db.prepare("SELECT id FROM notification WHERE dedupe_key = ?"),
      input.dedupeKey ?? null,
    );
    return {
      created: false,
      id: existing?.id ?? id,
      notification: existing ? this.getById(existing.id) : null,
    };
  }

  /**
   * 创建通知并入队投递 —— **两步在同一事务内**。
   *
   * 这是调度器唯一应当使用的创建入口：它保证不会出现"记了没发"或"发了没记"。
   */
  createWithOutbox(input: CreateNotificationInput): CreateNotificationResult {
    return this.#db.transaction(() => {
      const result = this.create(input);
      if (result.created) {
        this.#db
          .prepare(
            `INSERT INTO outbox (topic, payload, state, attempts, next_attempt_at, created_at, updated_at)
             VALUES ('notify.deliver', ?, 'pending', 0, ?, ?, ?)`,
          )
          .run(JSON.stringify({ notificationId: result.id }), input.scheduledFor, this.#now(), this.#now());
      }
      return result;
    });
  }

  getById(id: string): Notification | null {
    const row = rowOf<NotificationRow>(this.#db.prepare(`SELECT ${COLS} FROM notification WHERE id = ?`), id);
    return row ? fromRow(row) : null;
  }

  /**
   * 取"到点该投递"的通知。
   *
   * 判定条件是 `state='pending' AND scheduled_for <= now` ——
   * 因此被 DND 推迟的通知会在推迟时刻到达后自动被捡起（不需要额外的唤醒逻辑）。
   */
  listDue(now: number, limit = 50): Notification[] {
    const rows = rowsOf<NotificationRow>(
      this.#db.prepare(
        `SELECT ${COLS} FROM notification
          WHERE state = 'pending' AND scheduled_for <= ?
          ORDER BY scheduled_for ASC LIMIT ?`,
      ),
      now,
      limit,
    );
    return rows.map(fromRow);
  }

  /**
   * 原子领取通知（防止并发/重复投递）。
   *
   * 与 `OccurrenceDao.claim` 同一套思路：**用影响行数裁决**，不依赖内存状态。
   */
  claim(id: string): boolean {
    const at = this.#now();
    const res = this.#db
      .prepare(
        `UPDATE notification SET state = 'delivering', updated_at = ? WHERE id = ? AND state = 'pending'`,
      )
      .run(at, id);
    return Number(res.changes) > 0;
  }

  /** 标记投递完成 */
  markDelivered(id: string): boolean {
    const at = this.#now();
    const res = this.#db
      .prepare(
        `UPDATE notification SET state = 'delivered', updated_at = ?
          WHERE id = ? AND state IN ('delivering','pending')`,
      )
      .run(at, id);
    return Number(res.changes) > 0;
  }

  /** 标记投递失败（永久失败；临时失败应当重试而不是走到这里） */
  markFailed(id: string): boolean {
    const at = this.#now();
    const res = this.#db
      .prepare(
        `UPDATE notification SET state = 'failed', updated_at = ?
          WHERE id = ? AND state IN ('delivering','pending')`,
      )
      .run(at, id);
    return Number(res.changes) > 0;
  }

  /**
   * 推迟投递（免打扰使用）。
   *
   * ⚠️ 关键区别：**推迟不是抑制**。状态仍是 `pending`，只改 `scheduled_for`，
   * 因此 DND 结束后会被 `listDue` 自然捡起（PRD TC-M1-12 要求"不是丢弃"）。
   */
  defer(id: string, untilMs: number): boolean {
    const at = this.#now();
    const res = this.#db
      .prepare(
        `UPDATE notification SET scheduled_for = ?, updated_at = ?
          WHERE id = ? AND state IN ('pending','delivering')`,
      )
      .run(untilMs, at, id);
    return Number(res.changes) > 0;
  }

  /** 抑制投递（策略明确不许发，如 DND 期间的普通通知且用户要求丢弃） */
  suppress(id: string): boolean {
    const at = this.#now();
    const res = this.#db
      .prepare(
        `UPDATE notification SET state = 'suppressed', updated_at = ?
          WHERE id = ? AND state IN ('pending','delivering')`,
      )
      .run(at, id);
    return Number(res.changes) > 0;
  }

  /**
   * 主动释放领取状态：`delivering` → `pending`。
   *
   * 用途：一次投递尝试失败后，把通知放回可投递状态等待 outbox 退避重试。
   *
   * ⚠️ 这与 `reclaimStaleDelivering` 是**两件不同的事**，不能互相替代：
   *   - 本方法用于"刚刚失败、主动放回"（不看时间）
   *   - `reclaimStaleDelivering` 用于"崩溃遗留、超时回收"（按 updated_at 判定）
   * 曾经用后者兼做前者，结果因"刚刚更新过的行不满足闲置超时"而卡住重试（实测踩到）。
   */
  releaseClaim(id: string): boolean {
    const res = this.#db
      .prepare(
        "UPDATE notification SET state = 'pending', updated_at = ? WHERE id = ? AND state = 'delivering'",
      )
      .run(this.#now(), id);
    return Number(res.changes) > 0;
  }

  /**
   * 回收"投递中但已超时"的通知（进程在投递途中崩溃）。
   *
   * 与 occurrence 的 `unknown` 语义一致：**不自动重发**，而是退回 pending 等待重试队列，
   * 由 outbox 的重试计数决定最终归宿，避免"崩溃即重发"造成的重复打扰。
   */
  reclaimStaleDelivering(olderThanMs: number): number {
    const at = this.#now();
    const res = this.#db
      .prepare(
        `UPDATE notification SET state = 'pending', updated_at = ?
          WHERE state = 'delivering' AND updated_at < ?`,
      )
      .run(at, at - olderThanMs);
    return Number(res.changes);
  }

  /** 历史列表（UI 的「历史」页） */
  listRecent(limit = 100, kind?: NotificationKind): Notification[] {
    const sql = kind
      ? `SELECT ${COLS} FROM notification WHERE kind = ? ORDER BY scheduled_for DESC LIMIT ?`
      : `SELECT ${COLS} FROM notification ORDER BY scheduled_for DESC LIMIT ?`;
    const rows = kind
      ? rowsOf<NotificationRow>(this.#db.prepare(sql), kind, limit)
      : rowsOf<NotificationRow>(this.#db.prepare(sql), limit);
    return rows.map(fromRow);
  }

  /** 按状态统计（诊断用） */
  countByState(): Record<NotificationState | string, number> {
    const rows = rowsOf<{ state: string; n: number }>(
      this.#db.prepare("SELECT state, COUNT(*) AS n FROM notification GROUP BY state"),
    );
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
}
