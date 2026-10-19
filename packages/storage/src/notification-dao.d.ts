import { type Notification, type NotificationKind, type NotificationPriority, type NotificationState } from "@aegis/contracts";
import type { Db } from "./db.js";
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
/** 通知读写与状态迁移；创建入口应当用 `createWithOutbox` 以保证与入队的原子性 */
export declare class NotificationDao {
    #private;
    constructor(db: Db, now?: () => number);
    /**
     * 创建通知（幂等：`dedupeKey` 非空时重复创建会被唯一索引拦下）。
     *
     * ⚠️ 调用方通常应当把它放进 `NotificationDao.createWithOutbox()` 里，
     * 以保证"通知落库 + 入队"的原子性。
     */
    create(input: CreateNotificationInput): CreateNotificationResult;
    /**
     * 创建通知并入队投递 —— **两步在同一事务内**。
     *
     * 这是调度器唯一应当使用的创建入口：它保证不会出现"记了没发"或"发了没记"。
     */
    createWithOutbox(input: CreateNotificationInput): CreateNotificationResult;
    getById(id: string): Notification | null;
    /**
     * 取"到点该投递"的通知。
     *
     * 判定条件是 `state='pending' AND scheduled_for <= now` ——
     * 因此被 DND 推迟的通知会在推迟时刻到达后自动被捡起（不需要额外的唤醒逻辑）。
     */
    listDue(now: number, limit?: number): Notification[];
    /**
     * 原子领取通知（防止并发/重复投递）。
     *
     * 与 `OccurrenceDao.claim` 同一套思路：**用影响行数裁决**，不依赖内存状态。
     */
    claim(id: string): boolean;
    /** 标记投递完成 */
    markDelivered(id: string): boolean;
    /** 标记投递失败（永久失败；临时失败应当重试而不是走到这里） */
    markFailed(id: string): boolean;
    /**
     * 推迟投递（免打扰使用）。
     *
     * ⚠️ 关键区别：**推迟不是抑制**。状态仍是 `pending`，只改 `scheduled_for`，
     * 因此 DND 结束后会被 `listDue` 自然捡起（PRD TC-M1-12 要求"不是丢弃"）。
     */
    defer(id: string, untilMs: number): boolean;
    /** 抑制投递（策略明确不许发，如 DND 期间的普通通知且用户要求丢弃） */
    suppress(id: string): boolean;
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
    releaseClaim(id: string): boolean;
    /**
     * 回收"投递中但已超时"的通知（进程在投递途中崩溃）。
     *
     * 与 occurrence 的 `unknown` 语义一致：**不自动重发**，而是退回 pending 等待重试队列，
     * 由 outbox 的重试计数决定最终归宿，避免"崩溃即重发"造成的重复打扰。
     */
    reclaimStaleDelivering(olderThanMs: number): number;
    /** 历史列表（UI 的「历史」页） */
    listRecent(limit?: number, kind?: NotificationKind): Notification[];
    /** 按状态统计（诊断用） */
    countByState(): Record<NotificationState | string, number>;
}
//# sourceMappingURL=notification-dao.d.ts.map