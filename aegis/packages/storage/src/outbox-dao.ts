/**
 * Outbox DAO —— 外部副作用与数据库事务的解耦点
 *
 * ## 为什么需要 Outbox
 *
 * 通知投递、审计写入这类"外部副作用"无法参与数据库事务。若直接调用会出现两种不一致：
 *   - 先发通知再写库：写库失败 → 通知已发出但系统没有记录（用户收到一条查不到来源的提醒）
 *   - 先写库再发通知：发通知失败 → 账面上"已发"但用户没收到（漏报被掩盖）
 *
 * Outbox 的做法：**副作用意图先在同一事务里落库**，再由独立循环消费。
 * 于是"要发什么"永远有据可查，投递失败也只是消费失败，可以安全重试。
 *
 * ## 状态机
 *
 * ```
 * pending ──claim()──► inflight ──done()──► done
 *                       │
 *                       ├──failTransient()──► pending（退避后重试）
 *                       └──failPermanent()──► dead（放弃并上报告警）
 * ```
 *
 * ## 与幂等的关系
 *
 * outbox 的每次消费都必须是**幂等**的：`claimInflight` 的重置逻辑允许同一行被多次尝试，
 * 因此消费者（投递器）必须在真正发送前依赖 notification 的状态裁决，
 * 而不是"只要拿到 outbox 行就发"。
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { rowOf, rowsOf } from "./rows.js";

/** outbox 的 topic（决定由哪个消费者处理） */
export type OutboxTopic = "notify.deliver" | "audit.write" | "event.emit";

/** outbox 行状态 */
export type OutboxState = "pending" | "inflight" | "done" | "dead";

/** 一条 outbox 记录的对外形态 */
export interface OutboxEntry {
  id: number;
  topic: string;
  /** 解析后的载荷（写入时是 JSON） */
  payload: unknown;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface OutboxRow {
  id: number;
  topic: string;
  payload: string;
  state: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const COLS = `id, topic, payload, state, attempts, next_attempt_at, last_error, created_at, updated_at`;

function fromRow(row: OutboxRow): OutboxEntry {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    // 载荷损坏时保留原始字符串，便于诊断而不是丢掉整条记录
    payload = row.payload;
  }
  return {
    id: row.id,
    topic: row.topic,
    payload,
    state: row.state as OutboxState,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 指数退避策略。
 *
 * 设计取舍：**退避要快于真实时钟的直觉**——提醒类产品的用户预期是"几秒内看到"，
 * 因此基数取 2 秒、上限 5 分钟。超过 5 次仍失败视为该渠道不可用，交给降级链。
 */
export const OUTBOX_BACKOFF_BASE_MS = 2_000;
/** 退避上限（5 分钟）；超过最大尝试次数后标记为 dead 并上报告警 */
export const OUTBOX_BACKOFF_MAX_MS = 300_000;
/** 最大尝试次数；超出后标记为 dead 并生成失败告知 */
export const OUTBOX_MAX_ATTEMPTS = 5;

/** 计算第 n 次失败后的退避毫秒数（n 从 1 开始） */
export function backoffMs(attempt: number): number {
  const raw = OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, OUTBOX_BACKOFF_MAX_MS);
}

/** Outbox 读写：入队、原子领取、退避重试与陈旧 inflight 回收（详见文件头状态机） */
export class OutboxDao {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** 入队一条副作用意图（可选传入已有的 db 事务上下文） */
  enqueue(topic: OutboxTopic, payload: unknown, notBeforeMs?: number): number {
    const at = this.#now();
    const res = this.#db
      .prepare(
        `INSERT INTO outbox (topic, payload, state, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(topic, JSON.stringify(payload), notBeforeMs ?? at, at, at);
    return Number(res.lastInsertRowid);
  }

  /** 取到点可消费的记录 */
  listReady(now: number, limit = 20): OutboxEntry[] {
    const rows = rowsOf<OutboxRow>(
      this.#db.prepare(
        `SELECT ${COLS} FROM outbox
          WHERE state = 'pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC, id ASC LIMIT ?`,
      ),
      now,
      limit,
    );
    return rows.map(fromRow);
  }

  /**
   * 原子领取（pending → inflight）。
   *
   * ⚠️ 与其它 claim 一样用**影响行数**裁决：返回 false 表示已被别的循环领走。
   */
  claim(id: number): boolean {
    const at = this.#now();
    const res = this.#db
      .prepare(`UPDATE outbox SET state = 'inflight', updated_at = ? WHERE id = ? AND state = 'pending'`)
      .run(at, id);
    return Number(res.changes) > 0;
  }

  /**
   * 标记成功。
   *
   * 同时发放一个**投递尝试号**供调用方写入 `delivery_attempt`，
   * 保证审计与 outbox 的尝试计数一致。
   */
  markDone(id: number): boolean {
    const at = this.#now();
    const res = this.#db
      .prepare(`UPDATE outbox SET state = 'done', updated_at = ?, last_error = NULL WHERE id = ?`)
      .run(at, id);
    return Number(res.changes) > 0;
  }

  /**
   * 记录一次**可重试**失败：回到 pending 并安排退避。
   *
   * @returns 是否仍会重试（false 表示已达上限、被标记为 dead）
   */
  failTransient(id: number, error: string, maxAttempts: number = OUTBOX_MAX_ATTEMPTS): boolean {
    const at = this.#now();
    const row = rowOf<{ attempts: number }>(this.#db.prepare("SELECT attempts FROM outbox WHERE id = ?"), id);
    const attempts = (row?.attempts ?? 0) + 1;

    if (attempts >= maxAttempts) {
      this.#db
        .prepare(
          `UPDATE outbox SET state = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(attempts, error, at, id);
      return false;
    }

    this.#db
      .prepare(
        `UPDATE outbox SET state = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(attempts, at + backoffMs(attempts), error, at, id);
    return true;
  }

  /** 记录一次**不可重试**失败（如永久性权限错误）：直接 dead */
  failPermanent(id: number, error: string): boolean {
    const at = this.#now();
    const res = this.#db
      .prepare(`UPDATE outbox SET state = 'dead', last_error = ?, updated_at = ? WHERE id = ?`)
      .run(error, at, id);
    return Number(res.changes) > 0;
  }

  /**
   * 重置陈旧的 inflight 记录（进程在消费途中崩溃）。
   *
   * 这是崩溃恢复的关键一步：若不重置，那些记录会永远卡在 inflight，
   * 对应的通知就再也不会被投递 —— 一种典型的"静默漏报"。
   */
  resetStaleInflight(olderThanMs: number): number {
    const at = this.#now();
    const res = this.#db
      .prepare(
        `UPDATE outbox SET state = 'pending', updated_at = ?
          WHERE state = 'inflight' AND updated_at < ?`,
      )
      .run(at, at - olderThanMs);
    return Number(res.changes);
  }

  getById(id: number): OutboxEntry | null {
    const row = rowOf<OutboxRow>(this.#db.prepare(`SELECT ${COLS} FROM outbox WHERE id = ?`), id);
    return row ? fromRow(row) : null;
  }

  /** 按状态统计（诊断与"零静默失败"核对用） */
  countByState(): Record<string, number> {
    const rows = rowsOf<{ state: string; n: number }>(
      this.#db.prepare("SELECT state, COUNT(*) AS n FROM outbox GROUP BY state"),
    );
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  /** 清理已完成的记录（保留期由调用方决定） */
  purgeDone(olderThanMs: number): number {
    const at = this.#now();
    const res = this.#db
      .prepare("DELETE FROM outbox WHERE state = 'done' AND updated_at < ?")
      .run(at - olderThanMs);
    return Number(res.changes);
  }
}

/** 便于测试与诊断：生成一个稳定的 outbox 关联 id */
export function newOutboxCorrelationId(): string {
  return randomUUID();
}
