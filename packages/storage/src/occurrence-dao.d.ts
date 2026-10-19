import { type Occurrence } from "@aegis/contracts";
import type { Db } from "./db.js";
/** 领取超时（毫秒）：超过则认为"领取后崩溃"，进入 unknown 由 reconciler 处理 */
export declare const DEFAULT_CLAIM_TTL_MS = 60000;
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
export declare class OccurrenceDao {
    #private;
    constructor(db: Db, now?: () => number);
    /**
     * 物化一个实例（幂等）。
     * @returns 是否新建（false = 该 (task, scheduledAt) 已存在，无需处理）
     */
    insertIgnore(input: InsertOccurrenceInput): {
        created: boolean;
        id: string;
    };
    getById(id: string): Occurrence | null;
    /** 取到期可派发的实例（按优先级、时间排序） */
    listDue(now: number, limit?: number): Occurrence[];
    /**
     * 原子领取实例（幂等的第二道闸）。
     *
     * ⚠️ 只有把 state 从 'pending' 改成 'claimed' 成功者才拥有派发权；
     *    影响行数为 0 时必须放弃，**不得**依据内存状态继续派发。
     */
    claim(id: string, ttlMs?: number): ClaimResult;
    /** 标记已投递 */
    markDelivered(id: string, at?: number): boolean;
    /** 标记投递失败（永久失败；可重试的仍留在 claimed 由上层续期） */
    markFailed(id: string, error: string, at?: number): boolean;
    /** 超出补偿窗口：记历史但不发通知（PRD FR-A3） */
    /**
     * 用户主动"完成"该实例（标记为已投递并停止补偿）。
     *
     * 语义区别：`markDelivered` 是系统投递成功；本方法是**用户确认已处理**。
     * 两者最终状态相同（delivered），因为对调度器而言"这条不需要再管了"是一致的。
     */
    markCompleted(id: string, at?: number): boolean;
    /** 该任务最近一次**成功投递**的时刻（供 UI 显示"上次提醒"） */
    lastDeliveredAt(taskId: string): number | null;
    markSkipped(id: string, reason: string, at?: number): boolean;
    /**
     * 找出领取超时的实例（领取后进程崩溃）并置为 `unknown`。
     * 返回被标记的实例 —— 上层需要为它们生成**一次性询问通知**（§6.5 A）。
     */
    reconcileStaleClaims(now: number): Occurrence[];
    /** 供 UI 展示：某任务的未来实例 */
    listByTask(taskId: string, limit?: number): Occurrence[];
    /**
     * 批量物化（**单事务**）。
     *
     * 为什么需要：物化窗口可能产生数百条实例（如"每 10 分钟"的 24 小时窗口 = 144 条），
     * 逐条自动提交会产生同等数量的 WAL 提交与 fsync。放进一个事务后
     * 实测把 30 天长跑中的物化耗时从 3.4 秒量级降到可忽略。
     *
     * @returns 实际新建的条数（已存在的会被唯一索引忽略，不计入）
     */
    insertManyIgnore(inputs: InsertOccurrenceInput[]): number;
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
    maxScheduledAt(taskId: string): number | null;
    countByState(): Record<string, number>;
}
//# sourceMappingURL=occurrence-dao.d.ts.map