/**
 * 触发实例 DAO —— **幂等性的唯一裁决点**（《M0+M1 详细设计》§6.2–§6.5）
 *
 * 核心设计（对应 PRD FR-A4"绝不重复发送"）：
 *   1. **物化幂等**：`insertIgnore()` 依赖 `uq_occurrence(task_id, scheduled_at)` 唯一索引，
 *      重复运行安全 —— 因此 materialize 可以每秒跑一次而不产生重复。
 *   2. **派发幂等**：`claim()` 用 `UPDATE ... WHERE state='pending'` 的**影响行数**裁决归属。
 *      影响行数为 0 → 别人已领走 / 已发过 → 调用方必须放弃。
 *      ⚠️ 绝不依赖任何内存标志 —— 进程崩溃重启、并发 tick、时钟跳变下都必须成立。
 *   3. **不确定状态**：`claimed` 超时后进入 `unknown`（可能已发也可能没发），
 *      由上层生成一次性询问通知，而不是自动重发或静默丢弃（§6.5 A）。
 */
import { randomUUID } from "node:crypto";
import { type Occurrence, OccurrenceSchema, type OccurrenceState } from "@aegis/contracts";
import type { Db } from "./db.js";
import { rowOf, rowsOf } from "./rows.js";

/** 领取超时（毫秒）：超过则认为"领取后崩溃"，进入 unknown 由 reconciler 处理 */
export const DEFAULT_CLAIM_TTL_MS = 60_000;

/** 物化一个触发实例所需的最小信息 */
export interface InsertOccurrenceInput {
  taskId: string;
  /** UTC 毫秒 */
  scheduledAt: number;
  /** 本地墙钟字符串，用于展示"原定 HH:MM" */
  scheduledWall: string;
}

/** 领取结果；claim=false 表示无需派发（已被别人领走或已发送过），调用方必须跳过 */
export interface ClaimResult {
  /** 是否成功领取（false = 无需派发，调用方必须跳过） */
  claimed: boolean;
  /** 领取成功时的实例快照 */
  occurrence: Occurrence | null;
}

interface OccurrenceRow {
  id: string;
  task_id: string;
  scheduled_at: number;
  scheduled_wall: string;
  state: string;
  claim_token: string | null;
  claim_expires_at: number | null;
  attempt_count: number;
  delivered_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const COLS = `id, task_id, scheduled_at, scheduled_wall, state, claim_token,
  claim_expires_at, attempt_count, delivered_at, last_error, created_at, updated_at`;

function fromRow(row: OccurrenceRow): Occurrence {
  return OccurrenceSchema.parse({
    id: row.id,
    taskId: row.task_id,
    scheduledAt: row.scheduled_at,
    scheduledWall: row.scheduled_wall,
    state: row.state,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    attemptCount: row.attempt_count,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * 触发实例 DAO —— **幂等性的唯一裁决点**。
 *
 * 三道闸（对应 PRD FR-A4"绝不重复发送"）：
 *   1. 物化幂等：`insertIgnore` 依赖唯一索引 `uq_occurrence(task_id, scheduled_at)`
 *   2. 派发幂等：`claim` 用 `UPDATE ... WHERE state='pending'` 的**影响行数**裁决
 *   3. 收敛：`reconcileStaleClaims` 把领取超时的实例置为 `unknown`（不重发也不丢弃）
 *
 * ⚠️ 绝不依赖任何内存标志 —— 进程崩溃重启、并发 tick、时钟跳变下都必须成立。
 */
export class OccurrenceDao {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /**
   * 物化一个实例（幂等）。
   * @returns 是否新建（false = 该 (task, scheduledAt) 已存在，无需处理）
   */
  insertIgnore(input: InsertOccurrenceInput): { created: boolean; id: string } {
    const id = randomUUID();
    const at = this.#now();
    // ON CONFLICT DO NOTHING + 唯一索引 = 幂等的第一道闸
    const res = this.#db
      .prepare(
        `INSERT INTO occurrence
           (id, task_id, scheduled_at, scheduled_wall, state, claim_token, claim_expires_at,
            attempt_count, delivered_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, NULL, 0, NULL, NULL, ?, ?)
         ON CONFLICT(task_id, scheduled_at) DO NOTHING`,
      )
      .run(id, input.taskId, input.scheduledAt, input.scheduledWall, at, at);
    const created = Number(res.changes) > 0;
    if (created) return { created: true, id };

    // 已存在：取回既有 id，调用方无需关心
    const existing = rowOf<{ id: string }>(
      this.#db.prepare("SELECT id FROM occurrence WHERE task_id = ? AND scheduled_at = ?"),
      input.taskId,
      input.scheduledAt,
    );
    return { created: false, id: existing?.id ?? id };
  }

  getById(id: string): Occurrence | null {
    const row = rowOf<OccurrenceRow>(this.#db.prepare(`SELECT ${COLS} FROM occurrence WHERE id = ?`), id);
    return row ? fromRow(row) : null;
  }

  /** 取到期可派发的实例（按优先级、时间排序） */
  listDue(now: number, limit = 50): Occurrence[] {
    const rows = rowsOf<OccurrenceRow>(
      this.#db.prepare(
        `SELECT o.id, o.task_id, o.scheduled_at, o.scheduled_wall, o.state, o.claim_token,
                o.claim_expires_at, o.attempt_count, o.delivered_at, o.last_error,
                o.created_at, o.updated_at
           FROM occurrence o
           JOIN task t ON t.id = o.task_id
          WHERE o.state = 'pending' AND o.scheduled_at <= ?
            AND t.enabled = 1 AND t.deleted_at IS NULL
          ORDER BY (CASE t.priority WHEN 'important' THEN 0 ELSE 1 END), o.scheduled_at ASC
          LIMIT ?`,
      ),
      now,
      limit,
    );
    return rows.map(fromRow);
  }

  /**
   * 原子领取实例（幂等的第二道闸）。
   *
   * ⚠️ 只有把 state 从 'pending' 改成 'claimed' 成功者才拥有派发权；
   *    影响行数为 0 时必须放弃，**不得**依据内存状态继续派发。
   */
  claim(id: string, ttlMs: number = DEFAULT_CLAIM_TTL_MS): ClaimResult {
    const token = randomUUID();
    const at = this.#now();
    const res = this.#db
      .prepare(
        `UPDATE occurrence
            SET state = 'claimed', claim_token = ?, claim_expires_at = ?,
                attempt_count = attempt_count + 1, updated_at = ?
          WHERE id = ? AND state = 'pending'`,
      )
      .run(token, at + ttlMs, at, id);
    if (Number(res.changes) === 0) return { claimed: false, occurrence: null };
    return { claimed: true, occurrence: this.getById(id) };
  }

  /** 标记已投递 */
  markDelivered(id: string, at: number = this.#now()): boolean {
    const res = this.#db
      .prepare(
        `UPDATE occurrence SET state = 'delivered', delivered_at = ?, last_error = NULL,
                claim_token = NULL, claim_expires_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'claimed'`,
      )
      .run(at, at, id);
    return Number(res.changes) > 0;
  }

  /** 标记投递失败（永久失败；可重试的仍留在 claimed 由上层续期） */
  markFailed(id: string, error: string, at: number = this.#now()): boolean {
    const res = this.#db
      .prepare(
        `UPDATE occurrence SET state = 'failed', last_error = ?, claim_token = NULL,
                claim_expires_at = NULL, updated_at = ?
          WHERE id = ? AND state IN ('claimed','pending')`,
      )
      .run(error, at, id);
    return Number(res.changes) > 0;
  }

  /** 超出补偿窗口：记历史但不发通知（PRD FR-A3） */
  /**
   * 用户主动"完成"该实例（标记为已投递并停止补偿）。
   *
   * 语义区别：`markDelivered` 是系统投递成功；本方法是**用户确认已处理**。
   * 两者最终状态相同（delivered），因为对调度器而言"这条不需要再管了"是一致的。
   */
  markCompleted(id: string, at: number = this.#now()): boolean {
    const res = this.#db
      .prepare(
        `UPDATE occurrence SET state = 'delivered', delivered_at = ?, updated_at = ?
          WHERE id = ? AND state IN ('pending','claimed','unknown')`,
      )
      .run(at, at, id);
    return Number(res.changes) > 0;
  }

  /** 该任务最近一次**成功投递**的时刻（供 UI 显示"上次提醒"） */
  lastDeliveredAt(taskId: string): number | null {
    const row = rowOf<{ t: number | null }>(
      this.#db.prepare(
        "SELECT MAX(delivered_at) AS t FROM occurrence WHERE task_id = ? AND state = 'delivered'",
      ),
      taskId,
    );
    return row?.t ?? null;
  }

  markSkipped(id: string, reason: string, at: number = this.#now()): boolean {
    const res = this.#db
      .prepare(
        `UPDATE occurrence SET state = 'skipped', last_error = ?, claim_token = NULL,
                claim_expires_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'pending'`,
      )
      .run(reason, at, id);
    return Number(res.changes) > 0;
  }

  /**
   * 找出领取超时的实例（领取后进程崩溃）并置为 `unknown`。
   * 返回被标记的实例 —— 上层需要为它们生成**一次性询问通知**（§6.5 A）。
   */
  reconcileStaleClaims(now: number): Occurrence[] {
    const stale = rowsOf<OccurrenceRow>(
      this.#db.prepare(`SELECT ${COLS} FROM occurrence WHERE state = 'claimed' AND claim_expires_at < ?`),
      now,
    );

    const marked: Occurrence[] = [];
    for (const row of stale) {
      const res = this.#db
        .prepare(
          `UPDATE occurrence SET state = 'unknown', last_error = 'crashed_while_delivering',
                  claim_token = NULL, claim_expires_at = NULL, updated_at = ?
            WHERE id = ? AND state = 'claimed'`,
        )
        .run(now, row.id);
      if (Number(res.changes) > 0) {
        const updated = this.getById(row.id);
        if (updated) marked.push(updated);
      }
    }
    return marked;
  }

  /** 供 UI 展示：某任务的未来实例 */
  listByTask(taskId: string, limit = 20): Occurrence[] {
    const rows = rowsOf<OccurrenceRow>(
      this.#db.prepare(`SELECT ${COLS} FROM occurrence WHERE task_id = ? ORDER BY scheduled_at DESC LIMIT ?`),
      taskId,
      limit,
    );
    return rows.map(fromRow);
  }

  /**
   * 批量物化（**单事务**）。
   *
   * 为什么需要：物化窗口可能产生数百条实例（如"每 10 分钟"的 24 小时窗口 = 144 条），
   * 逐条自动提交会产生同等数量的 WAL 提交与 fsync。放进一个事务后
   * 实测把 30 天长跑中的物化耗时从 3.4 秒量级降到可忽略。
   *
   * @returns 实际新建的条数（已存在的会被唯一索引忽略，不计入）
   */
  insertManyIgnore(inputs: InsertOccurrenceInput[]): number {
    if (inputs.length === 0) return 0;
    // 注意：本项目的 Db.transaction 签名是"直接执行"而不是 better-sqlite3 的
    // "返回可调用函数"，因此这里直接把逻辑放进回调。
    return this.#db.transaction(() => {
      let created = 0;
      for (const input of inputs) {
        if (this.insertIgnore(input).created) created += 1;
      }
      return created;
    });
  }

  /**
   * 该任务已物化的**最远**实例时刻（无上限，返回真实最大值）。
   *
   * 用途：物化的「提前量」判断 —— 只要已物化到足够远，本轮就不必重解整个窗口。
   * 返回 null 表示该任务尚无任何实例。
   *
   * ⚠️ 刻意**不**接受上限参数：若加上 `scheduled_at <= limit`，查询就只会看到
   * limit 以内的行，于是永远返回一个小于 limit 的值 —— 判断"是否已覆盖到 limit"必然失败。
   * 这个缺陷实际导致过"每个 tick 都全量重解窗口"的性能问题（30 天长跑从 9 秒退化到 2 分钟以上）。
   */
  maxScheduledAt(taskId: string): number | null {
    const row = rowOf<{ m: number | null }>(
      this.#db.prepare("SELECT MAX(scheduled_at) AS m FROM occurrence WHERE task_id = ?"),
      taskId,
    );
    return row?.m ?? null;
  }

  countByState(): Record<string, number> {
    const rows = rowsOf<{ state: OccurrenceState; n: number }>(
      this.#db.prepare("SELECT state, COUNT(*) AS n FROM occurrence GROUP BY state"),
    );
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
}
