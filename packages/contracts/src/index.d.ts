/**
 * 领域契约 —— 单一真相源（Zod → TypeScript 类型 + 运行时校验 + JSON Schema）。
 *
 * 本文件在 R0 只落地 M1 所需的三个核心契约：
 *   Task / RecurrenceRule / Notification
 * 目的是把"格式带版本、变更需同步快照测试"的机制先立起来（详细设计 §10.2）。
 */
import { z } from "zod";
/** 契约版本：Skill/岗位/流程等格式变更时递增，并配套迁移提示 */
export declare const CONTRACT_VERSION = 1;
/** 本地墙钟时间字符串（不带时区），语义 = "在某时区的这个墙上时间" */
export declare const WallClockSchema: z.ZodString;
export type WallClock = z.infer<typeof WallClockSchema>;
/** IANA 时区，如 Asia/Shanghai；'system' 表示跟随系统时区（I1 决策） */
export declare const TzidSchema: z.ZodUnion<[z.ZodLiteral<"system">, z.ZodString]>;
/**
 * 重复规则：墙钟语义 + 时区（详细设计 §5.1）。
 * M1 支持 RRULE 子集：FREQ / INTERVAL / BYDAY / BYMONTHDAY / BYMONTH / COUNT / UNTIL
 */
export declare const RecurrenceRuleSchema: z.ZodObject<{
    /** null = 一次性任务 */
    rrule: z.ZodNullable<z.ZodString>;
    dtstartWall: z.ZodString;
    tzid: z.ZodDefault<z.ZodUnion<[z.ZodLiteral<"system">, z.ZodString]>>;
    untilWall: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    countLimit: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
}, "strict", z.ZodTypeAny, {
    rrule: string | null;
    dtstartWall: string;
    tzid: string;
    untilWall: string | null;
    countLimit: number | null;
}, {
    rrule: string | null;
    dtstartWall: string;
    tzid?: string | undefined;
    untilWall?: string | null | undefined;
    countLimit?: number | null | undefined;
}>;
export type RecurrenceRule = z.infer<typeof RecurrenceRuleSchema>;
/** 提醒优先级：important 可穿透免打扰（FR-A7） */
export declare const PrioritySchema: z.ZodEnum<["normal", "important"]>;
export type Priority = z.infer<typeof PrioritySchema>;
/** 单条任务对全局免打扰的覆盖策略：inherit 继承 / allow 强制放行 / block 强制抑制 */
export declare const DndOverrideSchema: z.ZodEnum<["inherit", "allow", "block"]>;
export type DndOverride = z.infer<typeof DndOverrideSchema>;
/**
 * 提醒任务契约。
 *
 * 注意：`dtstartWall + tzid` 采用**墙钟语义** —— 语义是"在该时区的这个墙上时间"，
 * 因此"每天 9:00"跨夏令时仍固定在本地 9:00（I1 决策），而不是固定 UTC 间隔。
 */
export declare const TaskSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    notes: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    priority: z.ZodDefault<z.ZodEnum<["normal", "important"]>>;
    enabled: z.ZodDefault<z.ZodBoolean>;
    recurrence: z.ZodObject<{
        /** null = 一次性任务 */
        rrule: z.ZodNullable<z.ZodString>;
        dtstartWall: z.ZodString;
        tzid: z.ZodDefault<z.ZodUnion<[z.ZodLiteral<"system">, z.ZodString]>>;
        untilWall: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        countLimit: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    }, "strict", z.ZodTypeAny, {
        rrule: string | null;
        dtstartWall: string;
        tzid: string;
        untilWall: string | null;
        countLimit: number | null;
    }, {
        rrule: string | null;
        dtstartWall: string;
        tzid?: string | undefined;
        untilWall?: string | null | undefined;
        countLimit?: number | null | undefined;
    }>;
    /** 错过补偿窗口（秒）；默认 12h（PRD FR-A3） */
    catchupWindowS: z.ZodDefault<z.ZodNumber>;
    snoozeDefaultS: z.ZodDefault<z.ZodNumber>;
    dndOverride: z.ZodDefault<z.ZodEnum<["inherit", "allow", "block"]>>;
    firedCount: z.ZodDefault<z.ZodNumber>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    deletedAt: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
}, "strict", z.ZodTypeAny, {
    id: string;
    title: string;
    notes: string | null;
    priority: "normal" | "important";
    enabled: boolean;
    recurrence: {
        rrule: string | null;
        dtstartWall: string;
        tzid: string;
        untilWall: string | null;
        countLimit: number | null;
    };
    catchupWindowS: number;
    snoozeDefaultS: number;
    dndOverride: "inherit" | "allow" | "block";
    firedCount: number;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
}, {
    id: string;
    title: string;
    recurrence: {
        rrule: string | null;
        dtstartWall: string;
        tzid?: string | undefined;
        untilWall?: string | null | undefined;
        countLimit?: number | null | undefined;
    };
    createdAt: number;
    updatedAt: number;
    notes?: string | null | undefined;
    priority?: "normal" | "important" | undefined;
    enabled?: boolean | undefined;
    catchupWindowS?: number | undefined;
    snoozeDefaultS?: number | undefined;
    dndOverride?: "inherit" | "allow" | "block" | undefined;
    firedCount?: number | undefined;
    deletedAt?: number | null | undefined;
}>;
export type Task = z.infer<typeof TaskSchema>;
/** 触发实例状态机（详细设计 §6.5） */
export declare const OccurrenceStateSchema: z.ZodEnum<["pending", "claimed", "delivered", "failed", "skipped", "unknown"]>;
export type OccurrenceState = z.infer<typeof OccurrenceStateSchema>;
/**
 * 一次具体的触发实例。
 *
 * `state` 是幂等状态机的核心；`unknown` 表示"已领取但结果未知"（领取后进程崩溃），
 * 上层必须为它生成一次性询问，而不是自动重发或静默丢弃（详细设计 §6.5）。
 */
export declare const OccurrenceSchema: z.ZodObject<{
    id: z.ZodString;
    taskId: z.ZodString;
    scheduledAt: z.ZodNumber;
    scheduledWall: z.ZodString;
    state: z.ZodDefault<z.ZodEnum<["pending", "claimed", "delivered", "failed", "skipped", "unknown"]>>;
    claimToken: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    claimExpiresAt: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    attemptCount: z.ZodDefault<z.ZodNumber>;
    deliveredAt: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    lastError: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    id: string;
    createdAt: number;
    updatedAt: number;
    taskId: string;
    scheduledAt: number;
    scheduledWall: string;
    state: "unknown" | "pending" | "claimed" | "delivered" | "failed" | "skipped";
    claimToken: string | null;
    claimExpiresAt: number | null;
    attemptCount: number;
    deliveredAt: number | null;
    lastError: string | null;
}, {
    id: string;
    createdAt: number;
    updatedAt: number;
    taskId: string;
    scheduledAt: number;
    scheduledWall: string;
    state?: "unknown" | "pending" | "claimed" | "delivered" | "failed" | "skipped" | undefined;
    claimToken?: string | null | undefined;
    claimExpiresAt?: number | null | undefined;
    attemptCount?: number | undefined;
    deliveredAt?: number | null | undefined;
    lastError?: string | null | undefined;
}>;
export type Occurrence = z.infer<typeof OccurrenceSchema>;
/** 通知类型：reminder 正常触发 / catchup_batch 补偿摘要 / system_gap 运行缺口 / failure 失败告知 / digest 汇总 */
export declare const NotificationKindSchema: z.ZodEnum<["reminder", "catchup_batch", "system_gap", "failure", "digest"]>;
export type NotificationKind = z.infer<typeof NotificationKindSchema>;
/** 通知优先级：high/urgent 可穿透免打扰 */
export declare const NotificationPrioritySchema: z.ZodEnum<["low", "normal", "high", "urgent"]>;
export type NotificationPriority = z.infer<typeof NotificationPrioritySchema>;
/** 通知投递状态：suppressed 表示被策略抑制（如免打扰期间的非重要通知） */
export declare const NotificationStateSchema: z.ZodEnum<["pending", "delivering", "delivered", "failed", "suppressed"]>;
export type NotificationState = z.infer<typeof NotificationStateSchema>;
/** 待投递的通知；`dedupeKey` 非空时受唯一索引约束，保证同类系统通知只出现一次 */
export declare const NotificationSchema: z.ZodObject<{
    id: z.ZodString;
    occurrenceId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodEnum<["reminder", "catchup_batch", "system_gap", "failure", "digest"]>;
    title: z.ZodString;
    body: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    priority: z.ZodDefault<z.ZodEnum<["low", "normal", "high", "urgent"]>>;
    scheduledFor: z.ZodNumber;
    state: z.ZodDefault<z.ZodEnum<["pending", "delivering", "delivered", "failed", "suppressed"]>>;
    dedupeKey: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    id: string;
    title: string;
    priority: "normal" | "low" | "high" | "urgent";
    createdAt: number;
    updatedAt: number;
    state: "pending" | "delivered" | "failed" | "delivering" | "suppressed";
    occurrenceId: string | null;
    kind: "reminder" | "catchup_batch" | "system_gap" | "failure" | "digest";
    body: string | null;
    scheduledFor: number;
    dedupeKey: string | null;
}, {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    kind: "reminder" | "catchup_batch" | "system_gap" | "failure" | "digest";
    scheduledFor: number;
    priority?: "normal" | "low" | "high" | "urgent" | undefined;
    state?: "pending" | "delivered" | "failed" | "delivering" | "suppressed" | undefined;
    occurrenceId?: string | null | undefined;
    body?: string | null | undefined;
    dedupeKey?: string | null | undefined;
}>;
export type Notification = z.infer<typeof NotificationSchema>;
/** 通知渠道（D5：CLI 兜底为必做项） */
export declare const ChannelSchema: z.ZodEnum<["os_notification", "cli_fallback", "inapp"]>;
export type Channel = z.infer<typeof ChannelSchema>;
/** 数据分级（M0 骨架；默认保守：未知 → L2） */
export declare const DataClassSchema: z.ZodEnum<["L0", "L1", "L2", "L3"]>;
export type DataClass = z.infer<typeof DataClassSchema>;
/**
 * 未知来源数据的默认分级。
 *
 * 刻意取 **L2（敏感）** 而不是 L0 —— 安全问题的默认值必须保守：
 * 过度脱敏只是体验问题，漏脱敏是事故（PRD FR-S1）。
 */
export declare const DEFAULT_DATA_CLASS: DataClass;
//# sourceMappingURL=index.d.ts.map