/**
 * 领域契约 —— 单一真相源（Zod → TypeScript 类型 + 运行时校验 + JSON Schema）。
 *
 * 本文件在 R0 只落地 M1 所需的三个核心契约：
 *   Task / RecurrenceRule / Notification
 * 目的是把"格式带版本、变更需同步快照测试"的机制先立起来（详细设计 §10.2）。
 */
import { z } from "zod";

/** 契约版本：Skill/岗位/流程等格式变更时递增，并配套迁移提示 */
export const CONTRACT_VERSION = 1;

/** 本地墙钟时间字符串（不带时区），语义 = "在某时区的这个墙上时间" */
export const WallClockSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "墙钟格式应为 YYYY-MM-DDTHH:mm[:ss]");
export type WallClock = z.infer<typeof WallClockSchema>;

/** IANA 时区，如 Asia/Shanghai；'system' 表示跟随系统时区（I1 决策） */
export const TzidSchema = z.union([z.literal("system"), z.string().min(1)]);

/**
 * 重复规则：墙钟语义 + 时区（详细设计 §5.1）。
 * M1 支持 RRULE 子集：FREQ / INTERVAL / BYDAY / BYMONTHDAY / BYMONTH / COUNT / UNTIL
 */
export const RecurrenceRuleSchema = z
  .object({
    /** null = 一次性任务 */
    rrule: z.string().nullable(),
    dtstartWall: WallClockSchema,
    tzid: TzidSchema.default("system"),
    untilWall: WallClockSchema.nullable().default(null),
    countLimit: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type RecurrenceRule = z.infer<typeof RecurrenceRuleSchema>;

/** 提醒优先级：important 可穿透免打扰（FR-A7） */
export const PrioritySchema = z.enum(["normal", "important"]);
export type Priority = z.infer<typeof PrioritySchema>;

/** 单条任务对全局免打扰的覆盖策略：inherit 继承 / allow 强制放行 / block 强制抑制 */
export const DndOverrideSchema = z.enum(["inherit", "allow", "block"]);
export type DndOverride = z.infer<typeof DndOverrideSchema>;

/**
 * 提醒任务契约。
 *
 * 注意：`dtstartWall + tzid` 采用**墙钟语义** —— 语义是"在该时区的这个墙上时间"，
 * 因此"每天 9:00"跨夏令时仍固定在本地 9:00（I1 决策），而不是固定 UTC 间隔。
 */
export const TaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(200),
    notes: z.string().max(4_000).nullable().default(null),
    priority: PrioritySchema.default("normal"),
    enabled: z.boolean().default(true),
    recurrence: RecurrenceRuleSchema,
    /** 错过补偿窗口（秒）；默认 12h（PRD FR-A3） */
    catchupWindowS: z.number().int().nonnegative().default(43_200),
    snoozeDefaultS: z.number().int().positive().default(600),
    dndOverride: DndOverrideSchema.default("inherit"),
    firedCount: z.number().int().nonnegative().default(0),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    deletedAt: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;

/** 触发实例状态机（详细设计 §6.5） */
export const OccurrenceStateSchema = z.enum([
  "pending",
  "claimed",
  "delivered",
  "failed",
  "skipped",
  "unknown",
]);
export type OccurrenceState = z.infer<typeof OccurrenceStateSchema>;

/**
 * 一次具体的触发实例。
 *
 * `state` 是幂等状态机的核心；`unknown` 表示"已领取但结果未知"（领取后进程崩溃），
 * 上层必须为它生成一次性询问，而不是自动重发或静默丢弃（详细设计 §6.5）。
 */
export const OccurrenceSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    scheduledAt: z.number().int().nonnegative(),
    scheduledWall: WallClockSchema,
    state: OccurrenceStateSchema.default("pending"),
    claimToken: z.string().nullable().default(null),
    claimExpiresAt: z.number().int().nonnegative().nullable().default(null),
    attemptCount: z.number().int().nonnegative().default(0),
    deliveredAt: z.number().int().nonnegative().nullable().default(null),
    lastError: z.string().nullable().default(null),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type Occurrence = z.infer<typeof OccurrenceSchema>;

/** 通知类型：reminder 正常触发 / catchup_batch 补偿摘要 / system_gap 运行缺口 / failure 失败告知 / digest 汇总 */
export const NotificationKindSchema = z.enum([
  "reminder",
  "catchup_batch",
  "system_gap",
  "failure",
  "digest",
  "monitor",
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/** 通知优先级：high/urgent 可穿透免打扰 */
export const NotificationPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export type NotificationPriority = z.infer<typeof NotificationPrioritySchema>;

/** 通知投递状态：suppressed 表示被策略抑制（如免打扰期间的非重要通知） */
export const NotificationStateSchema = z.enum(["pending", "delivering", "delivered", "failed", "suppressed"]);
export type NotificationState = z.infer<typeof NotificationStateSchema>;

/** 待投递的通知；`dedupeKey` 非空时受唯一索引约束，保证同类系统通知只出现一次 */
export const NotificationSchema = z
  .object({
    id: z.string().min(1),
    occurrenceId: z.string().nullable().default(null),
    kind: NotificationKindSchema,
    title: z.string().min(1),
    body: z.string().nullable().default(null),
    priority: NotificationPrioritySchema.default("normal"),
    scheduledFor: z.number().int().nonnegative(),
    state: NotificationStateSchema.default("pending"),
    dedupeKey: z.string().nullable().default(null),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type Notification = z.infer<typeof NotificationSchema>;

/** 通知渠道（D5：CLI 兜底为必做项） */
export const ChannelSchema = z.enum(["os_notification", "cli_fallback", "inapp"]);
export type Channel = z.infer<typeof ChannelSchema>;

/** 数据分级（M0 骨架；默认保守：未知 → L2） */
export const DataClassSchema = z.enum(["L0", "L1", "L2", "L3"]);
export type DataClass = z.infer<typeof DataClassSchema>;

/**
 * 未知来源数据的默认分级。
 *
 * 刻意取 **L2（敏感）** 而不是 L0 —— 安全问题的默认值必须保守：
 * 过度脱敏只是体验问题，漏脱敏是事故（PRD FR-S1）。
 */
export const DEFAULT_DATA_CLASS: DataClass = "L2";
