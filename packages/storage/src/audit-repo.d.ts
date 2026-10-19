import type { Db } from "./db.js";
/** 一条外发审计；接口层面无法传入原文（刻意的类型约束，见 NFR-SP5） */
export interface AuditEntry {
    /** 发起方：daemon / user / 未来的 employee id */
    actor: string;
    purpose: string;
    /** 目标：provider/model */
    destination: string;
    /** 数据分级 L0..L3 */
    dataClass: string;
    /** 命中的检测器摘要（类别 + 次数），不含原文 */
    detectorSummary: Array<{
        category: string;
        count: number;
    }>;
    redactionCount: number;
    policyVersion: string;
    /** 载荷哈希（唯一允许保留的"内容身份"） */
    payloadSha256: string;
    outcome: "allowed" | "blocked" | "failed";
}
/** 已落库的审计记录（含生成的 id 与落库时间） */
export interface StoredAuditEntry extends AuditEntry {
    id: string;
    at: number;
}
/** 外发审计读写；只存哈希与检测器摘要，绝不存原文 */
export declare class AuditRepo {
    #private;
    constructor(db: Db);
    /**
     * 写入一条外发审计。
     * 注意：入参没有任何字段可以携带原文 —— 这是刻意的设计约束。
     */
    record(entry: AuditEntry, now?: number): StoredAuditEntry;
    recent(limit?: number): StoredAuditEntry[];
    /** 统计：按结果分组（用于"零绕过/零外泄"指标的日常核对） */
    countByOutcome(): Record<string, number>;
    count(): number;
}
//# sourceMappingURL=audit-repo.d.ts.map