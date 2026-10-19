/**
 * 投递尝试 DAO —— 让"通知到底发了没有、走过哪些渠道"可查
 *
 * ## 为什么这个表必须能被读出来
 *
 * NFR-W2 要求"零静默失败"。一条通知失败时，用户与诊断页需要回答三个问题：
 *   1. 试过哪些渠道？（原生失败后有没有走 CLI 兜底）
 *   2. 每次的结果是什么？（瞬时错误 vs 永久错误）
 *   3. 具体错误是什么？
 *
 * 只写不读的审计表等于没有审计 —— 因此这里提供按通知聚合的**摘要**（给 UI）
 * 与**明细**（给诊断）两种读法。
 */
import type { Db } from "./db.js";
/** 一次投递尝试（对应 `delivery_attempt` 表的一行） */
export interface DeliveryAttempt {
    id: string;
    notificationId: string;
    channel: string;
    attemptNo: number;
    outcome: string;
    error: string | null;
    startedAt: number;
    finishedAt: number | null;
}
/** 投递尝试的压缩摘要（通知视图用，避免把全部明细塞给列表接口） */
export interface AttemptSummary {
    channel: string;
    outcome: string;
    error: string | null;
}
/** 投递尝试读写；列表接口应当用 `summaryForMany` 批量取，避免 N+1 查询 */
export declare class DeliveryAttemptDao {
    #private;
    constructor(db: Db);
    /** 某条通知的全部尝试明细（按尝试序号升序，便于看出降级顺序） */
    listByNotification(notificationId: string): DeliveryAttempt[];
    /**
     * 某条通知的尝试摘要（只保留渠道/结果/错误，丢弃时间戳）。
     *
     * 单独提供该方法是因为通知列表可能一次返回上百条，
     * 若每条都附带完整明细会显著放大 IPC 负载。
     */
    summaryFor(notificationId: string): AttemptSummary[];
    /** 批量摘要：一次查询覆盖多条通知（列表接口用，避免 N+1 查询） */
    summaryForMany(notificationIds: string[]): Map<string, AttemptSummary[]>;
    /** 按渠道统计结果（诊断页展示"哪个渠道在失败"） */
    countByChannelOutcome(): Array<{
        channel: string;
        outcome: string;
        count: number;
    }>;
    /** 清理历史尝试记录（保留期由调用方决定） */
    purgeOlderThan(cutoffMs: number): number;
}
//# sourceMappingURL=delivery-attempt-dao.d.ts.map