import type { Db } from "./db.js";
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
/**
 * 指数退避策略。
 *
 * 设计取舍：**退避要快于真实时钟的直觉**——提醒类产品的用户预期是"几秒内看到"，
 * 因此基数取 2 秒、上限 5 分钟。超过 5 次仍失败视为该渠道不可用，交给降级链。
 */
export declare const OUTBOX_BACKOFF_BASE_MS = 2000;
/** 退避上限（5 分钟）；超过最大尝试次数后标记为 dead 并上报告警 */
export declare const OUTBOX_BACKOFF_MAX_MS = 300000;
/** 最大尝试次数；超出后标记为 dead 并生成失败告知 */
export declare const OUTBOX_MAX_ATTEMPTS = 5;
/** 计算第 n 次失败后的退避毫秒数（n 从 1 开始） */
export declare function backoffMs(attempt: number): number;
/** Outbox 读写：入队、原子领取、退避重试与陈旧 inflight 回收（详见文件头状态机） */
export declare class OutboxDao {
    #private;
    constructor(db: Db, now?: () => number);
    /** 入队一条副作用意图（可选传入已有的 db 事务上下文） */
    enqueue(topic: OutboxTopic, payload: unknown, notBeforeMs?: number): number;
    /** 取到点可消费的记录 */
    listReady(now: number, limit?: number): OutboxEntry[];
    /**
     * 原子领取（pending → inflight）。
     *
     * ⚠️ 与其它 claim 一样用**影响行数**裁决：返回 false 表示已被别的循环领走。
     */
    claim(id: number): boolean;
    /**
     * 标记成功。
     *
     * 同时发放一个**投递尝试号**供调用方写入 `delivery_attempt`，
     * 保证审计与 outbox 的尝试计数一致。
     */
    markDone(id: number): boolean;
    /**
     * 记录一次**可重试**失败：回到 pending 并安排退避。
     *
     * @returns 是否仍会重试（false 表示已达上限、被标记为 dead）
     */
    failTransient(id: number, error: string, maxAttempts?: number): boolean;
    /** 记录一次**不可重试**失败（如永久性权限错误）：直接 dead */
    failPermanent(id: number, error: string): boolean;
    /**
     * 重置陈旧的 inflight 记录（进程在消费途中崩溃）。
     *
     * 这是崩溃恢复的关键一步：若不重置，那些记录会永远卡在 inflight，
     * 对应的通知就再也不会被投递 —— 一种典型的"静默漏报"。
     */
    resetStaleInflight(olderThanMs: number): number;
    getById(id: number): OutboxEntry | null;
    /** 按状态统计（诊断与"零静默失败"核对用） */
    countByState(): Record<string, number>;
    /** 清理已完成的记录（保留期由调用方决定） */
    purgeDone(olderThanMs: number): number;
}
/** 便于测试与诊断：生成一个稳定的 outbox 关联 id */
export declare function newOutboxCorrelationId(): string;
//# sourceMappingURL=outbox-dao.d.ts.map