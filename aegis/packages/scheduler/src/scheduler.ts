/**
 * 调度器 —— M1 的核心闭环
 *
 * ## 四个阶段（每轮 tick 按序执行）
 *
 * ```
 * ① materialize  把未来 24 小时该触发的实例补进 occurrence 表（幂等，靠唯一索引）
 * ② dispatch     把到期实例派发成通知（claim 影响行数裁决 + 补偿窗口 + 免打扰推迟）
 * ③ deliver      消费 outbox，按渠道降级链投递（失败可重试、必可见）
 * ④ reconcile    收敛异常态：超时 claimed → unknown、陈旧 inflight 重置、运行缺口检测
 * ```
 *
 * ## 三条不变量（任何改动都不得破坏）
 *
 * 1. **派发权由数据库裁决**：`claim()` 的影响行数为 0 就必须放弃，
 *    绝不依据内存状态继续 —— 这是"绝不重复发送"（FR-A4）的唯一保证。
 * 2. **时间只从注入的 Clock 读取**：否则长跑与 DST 场景无法用虚拟时钟测试。
 * 3. **失败必须可见**：任何阶段抛错都要落日志；投递失败要生成失败告知，
 *    不允许出现"用户以为在跑、实际早就停了"。
 */

import type { Clock } from "@aegis/clock";
import type { Task } from "@aegis/contracts";
import type { ChannelOutcome, Notifier } from "@aegis/platform";
import {
  nextOccurrenceAfter,
  occurrencesBetween,
  type RecurrenceSpec,
  resolveTimeZone,
  utcToWall,
  wallToUtc,
} from "@aegis/recurrence";
import {
  type AuditRepo,
  type Db,
  DeliveryAttemptDao,
  NotificationDao,
  OccurrenceDao,
  OutboxDao,
  TaskDao,
} from "@aegis/storage";
import {
  buildCatchupSummary,
  type DndSettings,
  dndEndsAt,
  isWithinCatchupWindow,
  isWithinDnd,
  shouldDeferForDnd,
  shouldFallbackToNextChannel,
  shouldMergeCatchup,
} from "./policy.js";

// 便于调用方只从 scheduler 模块导入即可拿到配置类型
export type { DndSettings, DndWindow } from "./policy.js";

/** 一阶段日志记录 */
export interface SchedulerLogRecord {
  at: number;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  detail?: Record<string, unknown>;
}

/** 调度器依赖注入项；`notifiers` 的顺序即降级链（原生优先、CLI 兜底） */
export interface SchedulerOptions {
  db: Db;
  clock: Clock;
  /** 渠道列表，**顺序即降级链**（原生优先、CLI 兜底） */
  notifiers: Notifier[];
  /** 免打扰设置 */
  dnd: DndSettings;
  /** 补偿批量的合并阈值（I2） */
  catchupMergeThreshold?: number;
  /** 物化窗口前瞻（毫秒），默认 24 小时 */
  lookaheadMs?: number;
  /** 领取超时（毫秒），超时后进入 unknown */
  claimTtlMs?: number;
  /** 日志回调 */
  onLog?: (record: SchedulerLogRecord) => void;
  /** 审计仓储（可选；投递失败时会写一条审计） */
  audit?: AuditRepo | null;
}

/** 每轮 tick 的执行摘要（供测试断言与诊断页展示） */
export interface TickResult {
  at: number;
  materialized: number;
  dispatched: number;
  /** 因超出补偿窗口被跳过的实例数 */
  skippedOutOfWindow: number;
  /** 因免打扰被推迟的通知数 */
  deferredForDnd: number;
  delivered: number;
  failedDeliveries: number;
  /** 本轮收敛的异常态数量（unknown / 陈旧 inflight） */
  reconciled: number;
  errors: string[];
}

/** 一次投递尝试的明细（写入 delivery_attempt 并可被 UI 展示） */
export interface DeliveryAttemptRecord {
  notificationId: string;
  channel: string;
  attemptNo: number;
  outcome: ChannelOutcome;
  error: string | null;
}

/** 调度器：把重复规则与时间变成"该发的通知"（详见文件头） */
export class Scheduler {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #notifiers: Notifier[];
  #dnd: DndSettings;
  readonly #catchupMergeThreshold: number;
  readonly #lookaheadMs: number;
  readonly #claimTtlMs: number;
  readonly #onLog: (record: SchedulerLogRecord) => void;
  readonly #audit: AuditRepo | null;

  readonly #tasks: TaskDao;
  readonly #occurrences: OccurrenceDao;
  readonly #notifications: NotificationDao;
  readonly #outbox: OutboxDao;
  readonly #attempts: DeliveryAttemptDao;

  /** 陈旧 inflight 的判定阈值：超过一个 tick 仍未完成即视为崩溃遗留 */
  static readonly STALE_INFLIGHT_MS = 120_000;

  /**
   * 物化的「提前量」：只要已物化到 `now + 该值` 之后，本轮就不再重解窗口。
   *
   * 取物化窗口的 3/4（24 小时窗口 → 18 小时）：既保证永远不会出现
   * "未来没有实例可派发"的空窗，又把求解次数降到每 6 小时一次
   * （每次把窗口补到 24 小时，净推进 6 小时）。
   */
  readonly #materializeHorizonMs: number;

  constructor(opts: SchedulerOptions) {
    this.#db = opts.db;
    this.#clock = opts.clock;
    this.#notifiers = opts.notifiers;
    this.#dnd = opts.dnd;
    this.#catchupMergeThreshold = opts.catchupMergeThreshold ?? 3;
    this.#lookaheadMs = opts.lookaheadMs ?? 24 * 3_600_000;
    this.#materializeHorizonMs = Math.floor((this.#lookaheadMs * 3) / 4);
    this.#claimTtlMs = opts.claimTtlMs ?? 60_000;
    this.#audit = opts.audit ?? null;
    this.#onLog = opts.onLog ?? ((): void => {});

    const now = (): number => this.#clock.wall();
    this.#tasks = new TaskDao(opts.db, now);
    this.#occurrences = new OccurrenceDao(opts.db, now);
    this.#notifications = new NotificationDao(opts.db, now);
    this.#outbox = new OutboxDao(opts.db, now);
    this.#attempts = new DeliveryAttemptDao(opts.db);
  }

  /** 供测试、IPC 层与 UI 读取的只读访问器 */
  get daos(): {
    tasks: TaskDao;
    occurrences: OccurrenceDao;
    notifications: NotificationDao;
    outbox: OutboxDao;
    attempts: DeliveryAttemptDao;
  } {
    return {
      tasks: this.#tasks,
      occurrences: this.#occurrences,
      notifications: this.#notifications,
      outbox: this.#outbox,
      attempts: this.#attempts,
    };
  }

  /**
   * 当前墙钟毫秒。
   *
   * RPC 层构造"从现在起 N 分钟"的稍后提醒时使用；不能用实例的原定时刻，
   * 否则一条延迟投递的提醒会立刻再次到期。
   */
  now(): number {
    return this.#clock.wall();
  }

  /**
   * 当前免打扰设置（只读快照）。
   *
   * R2 只提供读取：免打扰属于"全局设置"，写入经配置文件与设置页完成，
   * 不通过任务接口修改（契约里也确实只有 `dnd.get`，没有 `dnd.set`）。
   */
  get dndSettings(): DndSettings {
    return {
      enabled: this.#dnd.enabled,
      windows: this.#dnd.windows.map((w) => ({ ...w, days: [...w.days] })),
    };
  }

  /**
   * 运行时替换免打扰设置。
   *
   * 下一次 dispatch 起生效；已经因旧 DND 被推迟的通知仍按原 `scheduled_for`
   * 等待（不在这里提前唤醒，避免 UI 改设置把历史通知一次性全放出来）。
   */
  setDndSettings(settings: DndSettings): void {
    this.#dnd = {
      enabled: settings.enabled,
      windows: settings.windows.map((w) => ({ days: [...w.days], from: w.from, to: w.to })),
    };
  }

  #log(level: SchedulerLogRecord["level"], event: string, detail?: Record<string, unknown>): void {
    this.#onLog({ at: this.#clock.wall(), level, event, ...(detail ? { detail } : {}) });
  }

  /** 把任务的重复规则转为求解器输入 */
  #specOf(task: Task): RecurrenceSpec {
    return {
      rrule: task.recurrence.rrule,
      dtstartWall: task.recurrence.dtstartWall,
      tzid: task.recurrence.tzid,
      untilWall: task.recurrence.untilWall,
      countLimit: task.recurrence.countLimit,
    };
  }

  // ── ① 物化 ──────────────────────────────────────────────────────────────

  /**
   * 把 `[now - 最大补偿窗口, now + 前瞻]` 内该触发的实例补进 occurrence 表。
   *
   * **可以安全地重复运行**：`insertIgnore` 依赖唯一索引 `uq_occurrence(task_id, scheduled_at)`，
   * 重复物化只会得到 `created=false`。因此本方法可以每个 tick 都跑。
   *
   * 区间左端取"最大补偿窗口"而不是"now"，是为了让**关机/休眠期间错过的实例**
   * 有机会被补进来 —— 是否真的补发由 dispatch 阶段的窗口判定决定。
   *
   * @returns 新建的实例数
   */
  materialize(): number {
    const now = this.#clock.wall();
    const tasks = this.#tasks.list({ onlyEnabled: true });
    let created = 0;

    for (const task of tasks) {
      // 回看范围取任务自己的补偿窗口；前瞻取配置的物化窗口
      const from = now - task.catchupWindowS * 1_000;
      const to = now + this.#lookaheadMs;

      // ── 提前量检查：窗口内已物化足够多的实例就跳过本轮。
      //
      // 为什么必须有：求解整个窗口是 O(窗口内条数) 的，若每个 tick 都全量重解，
      // 高密度规则（"每 10 分钟"）会让 30 天长跑变成 O(n²)（实测 8640 轮 tick 需 2 分钟以上）。
      // 判据用**时间提前量**而不是实例条数：条数判据对稀疏规则（每年一次）会失效。
      const horizon = now + this.#materializeHorizonMs;
      const furthest = this.#occurrences.maxScheduledAt(task.id);
      // 已物化到 horizon 之后 → 本轮无需重解窗口
      if (furthest !== null && furthest >= horizon) continue;

      try {
        // ⚠️ 性能要点：**一次求解整个窗口**，而不是"求下一次 → 再求下一次"地循环。
        // 后者每次都从区间起点重新求解，复杂度退化为 O(n²) ——
        // 对"每 10 分钟"这类高密度规则（30 天 4320 条）会慢到不可接受（实测如此）。
        const moments = occurrencesBetween(this.#specOf(task), from, to, {
          // 上限要覆盖窗口内可能的最大条数；超出会抛 RecurrenceLimitError 并被下面的 catch 记录
          cap: 5_000,
          maxIterations: 20_000,
        });

        // 批量插入走**单事务**：逐条提交会让上百条实例产生上百次 WAL 提交
        created += this.#occurrences.insertManyIgnore(
          moments.map((m) => ({
            taskId: task.id,
            scheduledAt: m.epochMs,
            scheduledWall: this.#wallStringOf(task, m.epochMs),
          })),
        );
      } catch (err) {
        // 单条任务规则异常不应中断整轮物化（否则一次坏规则会让所有提醒失效）
        this.#log("warn", "scheduler.materialize_failed", {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (created > 0) this.#log("debug", "scheduler.materialized", { created });
    return created;
  }

  /** 该时刻在任务时区的墙上时间字符串（用于展示"原定 HH:MM"） */
  #wallStringOf(task: Task, epochMs: number): string {
    const wall = utcToWall(epochMs, task.recurrence.tzid);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    return `${wall.year}-${p2(wall.month)}-${p2(wall.day)}T${p2(wall.hour)}:${p2(wall.minute)}`;
  }

  // ── ② 派发 ──────────────────────────────────────────────────────────────

  /**
   * 把到期实例派发成通知。
   *
   * 三个决策点都走 `policy.ts` 的纯函数，便于精确断言：
   *   1. 超出补偿窗口 → 标记 skipped（记历史但不打扰）
   *   2. 处于免打扰 → 不丢弃，只把通知的 `scheduled_for` 推后
   *   3. 其余 → 立即创建通知并入队（**同一事务**，不会"记了没发"）
   */
  dispatch(): { dispatched: number; skippedOutOfWindow: number; deferredForDnd: number } {
    const now = this.#clock.wall();
    const due = this.#occurrences.listDue(now, 200);

    let dispatched = 0;
    let skippedOutOfWindow = 0;
    let deferredForDnd = 0;

    for (const occ of due) {
      const task = this.#tasks.getById(occ.taskId);
      if (!task || task.deletedAt !== null || !task.enabled) continue;

      // ★ 幂等裁决：只有把 pending 改成 claimed 成功者才拥有派发权
      const claim = this.#occurrences.claim(occ.id, this.#claimTtlMs);
      if (!claim.claimed) continue; // 已被别的 tick 领走 / 已发送过

      // 决策 1：超出补偿窗口 → 记历史但不打扰
      if (!isWithinCatchupWindow(occ.scheduledAt, now, task.catchupWindowS)) {
        this.#occurrences.markSkipped(occ.id, "beyond_catchup_window", now);
        skippedOutOfWindow += 1;
        continue;
      }

      // 决策 2：免打扰 → 推迟而不是丢弃
      const scheduledFor = this.#resolveDeliveryTime(task, occ.scheduledAt, now);
      const deferred = scheduledFor > now;

      // ⚠️ 逐条隔离：单条实例派发失败不得中断整轮派发。
      // 否则一个异常就会让**其余所有提醒**都发不出去 —— 典型的"一处坏、全局哑"。
      // 失败时该实例保持 claimed 状态，由 reconcile 的领取超时逻辑收敛为 unknown
      // （即"可能发过也可能没发"，交给上层询问用户，而不是静默重试或丢弃）。
      try {
        const created = this.#notifications.createWithOutbox({
          occurrenceId: occ.id,
          kind: "reminder",
          title: task.title,
          body: task.notes,
          // 任务优先级映射到通知优先级：important → high（可穿透 DND）
          priority: task.priority === "important" ? "high" : "normal",
          scheduledFor,
        });

        if (!created.created) {
          // 通知已被去重（理论上普通提醒没有 dedupeKey，这里只作防御）
          this.#log("warn", "scheduler.duplicate_notification", { occurrenceId: occ.id });
        }

        // 通知已经落库并入队 → 实例标记为已派发（不等于用户已看到，但派发责任已转移）
        this.#occurrences.markDelivered(occ.id, now);
        this.#tasks.incrementFiredCount(task.id, 1);
        dispatched += 1;
        if (deferred) deferredForDnd += 1;
      } catch (err) {
        this.#log("error", "scheduler.dispatch_one_failed", {
          occurrenceId: occ.id,
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { dispatched, skippedOutOfWindow, deferredForDnd };
  }

  /**
   * 计算实际投递时刻：若落在免打扰内则推迟到 DND 结束。
   *
   * ⚠️ 这里刻意**不**修改 `occurrence.scheduled_at` —— 实例代表"原定时刻"，
   * 推迟只影响通知的投递时间，这样历史记录仍能显示"原定 23:00，实际 08:00 送达"。
   */
  #resolveDeliveryTime(task: Task, scheduledAt: number, now: number): number {
    const tzid = task.recurrence.tzid;
    const toWall = (ms: number): { hour: number; minute: number; isoWeekday: number } => {
      const w = utcToWall(ms, tzid);
      const dow = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
      return { hour: w.hour, minute: w.minute, isoWeekday: dow === 0 ? 7 : dow };
    };

    const wallNow = toWall(scheduledAt);
    const inDnd = isWithinDnd(wallNow, wallNow.isoWeekday, this.#dnd);
    const priority = task.priority === "important" ? "high" : "normal";

    if (!shouldDeferForDnd({ priority, dndOverride: task.dndOverride, inDnd })) {
      return scheduledAt;
    }

    const end = dndEndsAt(scheduledAt, this.#dnd, toWall);
    if (end === null) return scheduledAt;
    this.#log("debug", "scheduler.deferred_for_dnd", {
      taskId: task.id,
      scheduledAt,
      until: end,
    });
    return Math.max(end, now);
  }

  // ── ③ 投递 ──────────────────────────────────────────────────────────────

  /**
   * 消费 outbox，按渠道降级链投递。
   *
   * 降级策略（`policy.shouldFallbackToNextChannel`）：
   *   - 渠道返回 `permanent_error` / `timeout` → 立刻换下一个渠道
   *   - `transient_error` → 交给 outbox 退避重试（不换渠道，避免抖动）
   *   - 全部渠道失败 → 标记通知失败 + 生成一条"失败告知"（**失败必须可见**）
   */
  async deliver(): Promise<{ delivered: number; failed: number }> {
    const now = this.#clock.wall();
    const ready = this.#outbox.listReady(now, 20);
    let delivered = 0;
    let failed = 0;

    for (const entry of ready) {
      if (entry.topic !== "notify.deliver") continue;
      if (!this.#outbox.claim(entry.id)) continue;

      const notificationId = (entry.payload as { notificationId?: string } | null)?.notificationId;
      if (!notificationId) {
        this.#outbox.failPermanent(entry.id, "载荷缺少 notificationId");
        continue;
      }

      const notification = this.#notifications.getById(notificationId);
      if (!notification) {
        this.#outbox.failPermanent(entry.id, `通知不存在：${notificationId}`);
        continue;
      }
      // 已被处理过（投递成功或已抑制）→ 直接完成，不重复打扰
      if (notification.state === "delivered" || notification.state === "suppressed") {
        this.#outbox.markDone(entry.id);
        continue;
      }

      // ★ 领取通知：与 occurrence 同一套"影响行数裁决"
      if (!this.#notifications.claim(notificationId)) {
        this.#outbox.markDone(entry.id);
        continue;
      }

      const result = await this.#tryChannels(
        notificationId,
        notification.occurrenceId,
        notification.title,
        notification.body,
        entry.attempts,
        notification.priority,
      );
      if (result.ok) {
        this.#notifications.markDelivered(notificationId);
        this.#outbox.markDone(entry.id);
        delivered += 1;
      } else if (result.retryable) {
        const willRetry = this.#outbox.failTransient(entry.id, result.error ?? "投递失败");
        // 主动放回可投递状态，等 outbox 退避后重试（不是"回收陈旧"，故用 releaseClaim）
        this.#notifications.releaseClaim(notificationId);
        if (!willRetry) {
          await this.#handlePermanentFailure(notificationId, result.error ?? "重试次数已用尽");
          failed += 1;
        }
      } else {
        this.#outbox.failPermanent(entry.id, result.error ?? "投递失败");
        await this.#handlePermanentFailure(notificationId, result.error ?? "全部渠道均失败");
        failed += 1;
      }
    }

    return { delivered, failed };
  }

  /** 依次尝试渠道，返回是否有渠道成功 / 是否值得重试 */
  async #tryChannels(
    notificationId: string,
    occurrenceId: string | null,
    title: string,
    body: string | null,
    priorAttempts: number,
    priority: string,
  ): Promise<{ ok: boolean; retryable: boolean; error?: string }> {
    let attemptNo = priorAttempts + 1;
    let lastError: string | undefined;

    for (const [index, notifier] of this.#notifiers.entries()) {
      // 注意：exactOptionalPropertyTypes 下**不能**显式传 undefined，必须用条件展开
      const r = await notifier.send({
        title,
        sound: true,
        ...(body ? { body } : {}),
        ...(occurrenceId ? { occurrenceId } : {}),
        priority: priority === "low" || priority === "high" ? priority : "normal",
      });
      this.#recordAttempt({
        notificationId,
        channel: notifier.channel,
        attemptNo,
        outcome: r.outcome,
        error: r.error ?? null,
      });
      attemptNo += 1;

      if (r.outcome === "success") return { ok: true, retryable: false };

      lastError = `${notifier.channel}: ${r.error ?? r.outcome}`;
      this.#log("warn", "scheduler.channel_failed", {
        channel: notifier.channel,
        outcome: r.outcome,
        error: r.error,
      });

      if (!shouldFallbackToNextChannel(r.outcome)) {
        // 瞬时错误：值得用同一渠道重试
        return { ok: false, retryable: true, ...(lastError ? { error: lastError } : {}) };
      }
      // 永久错误/超时：继续尝试下一个渠道（降级链）
      if (index === this.#notifiers.length - 1) {
        return { ok: false, retryable: false, ...(lastError ? { error: lastError } : {}) };
      }
    }

    return { ok: false, retryable: false, ...(lastError ? { error: lastError } : {}) };
  }

  #recordAttempt(rec: DeliveryAttemptRecord): void {
    this.#db
      .prepare(
        `INSERT INTO delivery_attempt (id, notification_id, channel, attempt_no, outcome, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        rec.notificationId,
        rec.channel,
        rec.attemptNo,
        rec.outcome,
        rec.error,
        this.#clock.wall(),
        this.#clock.wall(),
      );
  }

  /**
   * 处理"永久失败"：标记通知失败 + 生成一条**用户可见的失败告知**。
   *
   * 这是"零静默失败"（NFR-W2）的落点：用户必须知道有一条提醒没能送达，
   * 否则他会以为提醒系统在正常工作。
   */
  async #handlePermanentFailure(notificationId: string, error: string): Promise<void> {
    const notification = this.#notifications.getById(notificationId);
    this.#notifications.markFailed(notificationId);
    this.#log("error", "scheduler.delivery_failed", { notificationId, error });

    this.#audit?.record({
      actor: "daemon",
      purpose: "notify-delivery-failed",
      destination: "local",
      dataClass: "L0",
      detectorSummary: [],
      redactionCount: 0,
      policyVersion: "m0-v1",
      payloadSha256: "",
      outcome: "failed",
    });

    if (!notification) return;
    // 失败告知本身用 dedupe_key 去重，避免"失败通知也失败"时反复重试
    this.#notifications.createWithOutbox({
      kind: "failure",
      title: `提醒未能送达：${notification.title}`,
      body: `原因：${error}\n请检查系统通知权限与渠道配置。`,
      priority: "high",
      scheduledFor: this.#clock.wall(),
      dedupeKey: `delivery-failed:${notificationId}`,
    });
  }

  // ── ④ 收敛 ──────────────────────────────────────────────────────────────

  /**
   * 收敛异常态。这一步是"崩溃后不留烂摊子"的保障：
   *
   *   - 领取超时的实例 → `unknown`（可能已发也可能没发，由上层询问用户）
   *   - 陈旧的 outbox inflight → 重置为 pending（否则那条通知永远发不出去）
   *   - 陈旧的 notification delivering → 回到 pending
   */
  reconcile(): { unknownOccurrences: number; resetOutbox: number; reclaimedNotifications: number } {
    const now = this.#clock.wall();
    const unknown = this.#occurrences.reconcileStaleClaims(now);
    for (const occ of unknown) {
      this.#log("warn", "scheduler.unknown_occurrence", { occurrenceId: occ.id, taskId: occ.taskId });
    }
    const resetOutbox = this.#outbox.resetStaleInflight(Scheduler.STALE_INFLIGHT_MS);
    const reclaimed = this.#notifications.reclaimStaleDelivering(Scheduler.STALE_INFLIGHT_MS);
    return { unknownOccurrences: unknown.length, resetOutbox, reclaimedNotifications: reclaimed };
  }

  // ── tick 编排 ───────────────────────────────────────────────────────────

  /**
   * 执行一轮完整调度。任一阶段失败都不影响其它阶段（失败被收集到 `errors`）。
   *
   * 这个"阶段隔离"是刻意的：物化失败不应阻止已到期实例的投递，
   * 否则一次规则解析异常就会导致**所有提醒失效**。
   */
  async tick(): Promise<TickResult> {
    const result: TickResult = {
      at: this.#clock.wall(),
      materialized: 0,
      dispatched: 0,
      skippedOutOfWindow: 0,
      deferredForDnd: 0,
      delivered: 0,
      failedDeliveries: 0,
      reconciled: 0,
      errors: [],
    };

    try {
      result.materialized = this.materialize();
    } catch (err) {
      result.errors.push(`materialize: ${String(err)}`);
      this.#log("error", "scheduler.materialize_error", { error: String(err) });
    }

    try {
      const d = this.dispatch();
      result.dispatched = d.dispatched;
      result.skippedOutOfWindow = d.skippedOutOfWindow;
      result.deferredForDnd = d.deferredForDnd;
    } catch (err) {
      result.errors.push(`dispatch: ${String(err)}`);
      this.#log("error", "scheduler.dispatch_error", { error: String(err) });
    }

    try {
      const dl = await this.deliver();
      result.delivered = dl.delivered;
      result.failedDeliveries = dl.failed;
    } catch (err) {
      result.errors.push(`deliver: ${String(err)}`);
      this.#log("error", "scheduler.deliver_error", { error: String(err) });
    }

    try {
      const r = this.reconcile();
      result.reconciled = r.unknownOccurrences + r.resetOutbox + r.reclaimedNotifications;
    } catch (err) {
      result.errors.push(`reconcile: ${String(err)}`);
      this.#log("error", "scheduler.reconcile_error", { error: String(err) });
    }

    return result;
  }

  /** 创建一条提醒（供 UI / CLI 使用；会做规则校验并立即物化） */
  createTask(input: {
    title: string;
    notes?: string | null;
    priority?: "normal" | "important";
    recurrence: RecurrenceSpec;
    catchupWindowS?: number;
  }): Task {
    const task = this.#tasks.create({
      title: input.title,
      notes: input.notes ?? null,
      priority: input.priority ?? "normal",
      recurrence: {
        rrule: input.recurrence.rrule,
        dtstartWall: input.recurrence.dtstartWall,
        tzid: normalizeTzid(input.recurrence.tzid),
        untilWall: input.recurrence.untilWall ?? null,
        countLimit: input.recurrence.countLimit ?? null,
      },
      ...(input.catchupWindowS !== undefined ? { catchupWindowS: input.catchupWindowS } : {}),
    });
    // 立刻物化一次，让"1 分钟后"的示例提醒无需等下一轮 tick
    this.materialize();
    return task;
  }

  /**
   * 计算某任务的下一次触发时刻（供 UI 展示倒计时）。
   *
   * 语义：返回 `fromMs`（默认"现在"）**时刻或之后**的下一次触发。
   * 该边界是刻意的 —— 界面需要"现在往前看"，哪怕下一次就在眼前（如每天 9:00 的任务在 8:59 查询）。
   *
   * @returns null 表示规则已结束（一次性任务已投递完成，或重复规则已达 COUNT/UNTIL）
   */
  nextFireAt(task: Task, fromMs?: number): number | null {
    const from = fromMs ?? this.#clock.wall();
    const spec = this.#specOf(task);

    // ★ 一次性任务必须单独处理。
    //
    // 若直接走"严格晚于 from"的搜索，会漏掉**恰好等于 dtstart** 的那一次：
    // 物化会在 dtstart 时刻插一条实例，而 `nextOccurrenceAfter(dtstart - 1)` 从
    // dtstart + 1 毫秒开始找，于是返回 null —— 表现为界面上"还没响就显示已结束"。
    if (task.recurrence.rrule === null) {
      const dtstart = wallStringToUtc(task.recurrence.dtstartWall, task.recurrence.tzid);
      if (dtstart === null) return null;
      // 未到点 → 就是它
      if (dtstart > from) return dtstart;
      // 已到点：只有"确实已经投递过"才算结束（否则这条提醒仍在等待投递）
      const delivered = this.#occurrences.lastDeliveredAt(task.id);
      return delivered === null ? dtstart : null;
    }

    const next = nextOccurrenceAfter(spec, from - 1, {
      // 搜索窗口给足：稀疏规则（如每年一次）也需要能找到下一次
      searchWindowMs: 400 * 24 * 3_600_000,
    });
    return next?.epochMs ?? null;
  }

  /**
   * 把一批错过的实例合并成一条摘要通知（I2 决策）。
   *
   * 由上层在检测到"一次补出多条"时调用；本方法只负责拼装与入队。
   */
  createCatchupSummary(items: Array<{ scheduledWall: string; title: string }>): {
    created: boolean;
    id: string;
  } {
    const now = this.#clock.wall();
    const merged = shouldMergeCatchup(items.length, this.#catchupMergeThreshold);
    const title = merged ? `错过的 ${items.length} 条提醒` : (items[0]?.title ?? "错过的提醒");
    const body = buildCatchupSummary(items);
    const r = this.#notifications.createWithOutbox({
      kind: "catchup_batch",
      title,
      body,
      priority: "normal",
      scheduledFor: now,
      dedupeKey: `catchup:${now}`,
    });
    return { created: r.created, id: r.id };
  }
}

/** 归一化 tzid：空值或 'system' 都解析为当前系统时区（避免把 'system' 写进库后误解析） */
function normalizeTzid(tzid: string): string {
  return tzid === "system" || tzid === "" ? resolveTimeZone("system") : tzid;
}

/** 便于测试：把墙钟字符串解析为该时区的 UTC 毫秒 */
export function wallStringToUtc(wall: string, tzid: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) return null;
  return wallToUtc(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: 0,
    },
    tzid,
  ).epochMs;
}
