/**
 * daemon ↔ UI 的 IPC 契约（两侧共享单一真相源）
 *
 * 依据《M0+M1 详细设计》§7：
 *   - 传输：UDS（macOS/Linux）/ NamedPipe（Windows），NDJSON 分帧，JSON-RPC 2.0
 *   - 鉴权：握手 token（首帧必须是 sys.hello）
 *   - 事件：daemon → UI 单向推送
 *
 * ⚠️ 契约变更必须同步快照测试，避免两侧版本漂移。
 */

import { NotificationKindSchema, PrioritySchema, WallClockSchema } from "@aegis/contracts";
import { z } from "zod";

/** 协议版本：不匹配时 UI 必须提示升级，而不是静默错乱 */
export const PROTOCOL_VERSION = 1;

/** JSON-RPC 错误码；客户端应优先用 code 判断，message 仅作展示 */
export const RpcErrorCode = {
  E_PROTOCOL: -32000,
  E_AUTH: -32001,
  E_METHOD_NOT_FOUND: -32601,
  E_INVALID_PARAMS: -32602,
  E_INTERNAL: -32603,
} as const;

/** 需要用户选择重复方式时的输入形态（UI 友好，服务端翻译成 RRULE） */
export const RepeatModeSchema = z.enum([
  "once",
  "daily",
  "weekly",
  "monthly",
  "weekdays",
  "every_minutes",
  "custom_rrule",
]);
export type RepeatMode = z.infer<typeof RepeatModeSchema>;

/** 重复方式的输入（UI 友好，服务端翻译成 RRULE） */
export const RepeatInputSchema = z
  .object({
    mode: RepeatModeSchema,
    /** weekly：1=周一 … 7=周日 */
    byWeekday: z.array(z.number().int().min(1).max(7)).optional(),
    /** monthly：1-31 */
    byMonthDay: z.number().int().min(1).max(31).optional(),
    /** every_minutes */
    intervalMinutes: z.number().int().min(1).max(10_080).optional(),
    /** custom_rrule：原样 RRULE */
    rrule: z.string().optional(),
  })
  .strict();

/** 任务对全局免打扰的覆盖策略 */
export const DndOverrideSchema = z.enum(["inherit", "allow", "block"]);

/** 创建任务的入参（UI 友好形态：repeat.mode 由服务端翻译成 RRULE） */
export const CreateTaskInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    notes: z.string().max(4_000).optional(),
    priority: PrioritySchema.optional(),
    firstFireAtWall: WallClockSchema,
    repeat: RepeatInputSchema,
    catchupWindowS: z.number().int().nonnegative().optional(),
    dndOverride: DndOverrideSchema.optional(),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

/**
 * 任务的对外视图。
 *
 * ⚠️ 刻意与数据库行类型解耦：视图只暴露 UI 需要的字段，并附带 `repeatLabel`
 * 这类**已计算好的人话描述**，避免把展示逻辑泄漏到 UI 层。
 */
export const TaskViewSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    notes: z.string().nullable(),
    priority: PrioritySchema,
    enabled: z.boolean(),
    /** 人话描述的重复规则，如"每周一、周三" */
    repeatLabel: z.string(),
    /** 下一次触发（UTC ms）；已结束为 null */
    nextFireAt: z.number().int().nullable(),
    nextFireWall: WallClockSchema.nullable(),
    lastFiredAt: z.number().int().nullable(),
    firedCount: z.number().int().nonnegative(),
  })
  .strict();
export type TaskView = z.infer<typeof TaskViewSchema>;

/** 编辑任务时需要回填的完整输入（比列表视图多 repeat/时间） */
export const TaskEditViewSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    notes: z.string().nullable(),
    priority: PrioritySchema,
    firstFireAtWall: WallClockSchema,
    repeat: RepeatInputSchema,
    catchupWindowS: z.number().int().nonnegative(),
    dndOverride: DndOverrideSchema,
  })
  .strict();
export type TaskEditView = z.infer<typeof TaskEditViewSchema>;

/** 免打扰时段；days 为 ISO 星期（1=周一 … 7=周日），允许跨午夜 */
export const DndWindowSchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1),
    from: z.string().regex(/^\d{2}:\d{2}$/),
    to: z.string().regex(/^\d{2}:\d{2}$/),
  })
  .strict();
/** 全局免打扰设置；windows 最多 10 段，空数组表示启用但不生效 */
export const DndSettingsSchema = z
  .object({
    enabled: z.boolean(),
    windows: z.array(DndWindowSchema).max(10),
  })
  .strict();
export type DndSettingsView = z.infer<typeof DndSettingsSchema>;

/** 一次系统健康采集的对外视图（字段已转成 UI 可直接展示的单位） */
export const SystemHealthViewSchema = z
  .object({
    at: z.number().int(),
    mount: z.string(),
    cpuCount: z.number().int().nonnegative(),
    load1: z.number(),
    load5: z.number(),
    load15: z.number(),
    memoryTotalGb: z.number().nonnegative(),
    memoryFreeGb: z.number().nonnegative(),
    memoryFreePercent: z.number(),
    diskTotalGb: z.number().nonnegative(),
    diskFreeGb: z.number().nonnegative(),
    diskFreePercent: z.number(),
    uptimeS: z.number().int().nonnegative(),
  })
  .strict();
export type SystemHealthView = z.infer<typeof SystemHealthViewSchema>;

/** 监测器采集错误 */
export const MonitorErrorSchema = z.object({ path: z.string(), message: z.string() }).strict();

/** Skill 列表项；坏文件也返回，用 valid=false + error 让 UI 可见 */
export const SkillListEntrySchema = z
  .object({
    file: z.string(),
    valid: z.boolean(),
    name: z.string().nullable(),
    version: z.string().nullable(),
    description: z.string().nullable(),
    permissions: z.array(z.string()),
    triggerMonitor: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type SkillListEntryView = z.infer<typeof SkillListEntrySchema>;

/** LLM 非敏感设置 */
export const LlmSettingsSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(["openai", "deepseek", "kimi", "glm", "custom"]),
    baseUrl: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//.test(u), "只支持 http/https"),
    model: z.string().min(1).max(120),
    timeoutMs: z.number().int().min(1_000).max(120_000),
    maxOutboundClass: z.enum(["L0", "L1", "L2"]),
    dailyCallLimit: z.number().int().min(1).max(10_000),
  })
  .strict();
export type LlmSettingsView = z.infer<typeof LlmSettingsSchema>;

/** LLM 设置页视图；不含 API Key */
export const LlmViewSchema = LlmSettingsSchema.extend({
  hasApiKey: z.boolean(),
  keychainError: z.string().nullable(),
  callsToday: z.number().int().nonnegative(),
  remainingCalls: z.number().int().nonnegative(),
}).strict();

/** 外发审计视图；只含安全摘要 */
export const LlmAuditEntrySchema = z
  .object({
    id: z.string(),
    at: z.number().int(),
    actor: z.string(),
    purpose: z.string(),
    destination: z.string(),
    dataClass: z.string(),
    detectorSummary: z.array(z.object({ category: z.string(), count: z.number().int() }).strict()),
    redactionCount: z.number().int().nonnegative(),
    policyVersion: z.string(),
    payloadSha256: z.string(),
    outcome: z.enum(["allowed", "blocked", "failed"]),
  })
  .strict();
export type LlmAuditEntryView = z.infer<typeof LlmAuditEntrySchema>;

/** LLM 测试结果 */
export const LlmTestResultSchema = z.union([
  z.object({ ok: z.literal(true), text: z.string(), destination: z.string() }).strict(),
  z
    .object({
      ok: z.literal(false),
      blocked: z.boolean(),
      reason: z.string(),
      errorKind: z.string().optional(),
    })
    .strict(),
]);

/** 通知渠道设置（Webhook 为当前唯一可配置的远程渠道） */
export const NotifySettingsSchema = z
  .object({
    channels: z.array(z.enum(["os_notification", "cli_fallback", "webhook", "telegram", "bark", "tts"])),
    webhookEnabled: z.boolean(),
    webhookUrl: z.string().max(2_000).optional(),
    telegramEnabled: z.boolean().default(false),
    telegramChatId: z.string().max(100).optional(),
    telegramHasToken: z.boolean().optional(),
    barkEnabled: z.boolean().default(false),
    barkServerUrl: z.string().url().optional(),
    barkHasToken: z.boolean().optional(),
    ttsEnabled: z.boolean().default(false),
    ttsVoice: z.string().max(100).optional(),
  })
  .strict();
export type NotifySettingsView = z.infer<typeof NotifySettingsSchema>;

/** 每日简报设置 */
export const BriefingSettingsSchema = z
  .object({
    enabled: z.boolean(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间格式 HH:mm"),
  })
  .strict();
export type BriefingSettingsView = z.infer<typeof BriefingSettingsSchema>;

/** 知识库文档视图 */
export const KnowledgeDocumentSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    sourcePath: z.string(),
    dataClass: z.enum(["L0", "L1", "L2", "L3"]),
    contentHash: z.string(),
    chunkCount: z.number().int().nonnegative(),
    updatedAt: z.number().int(),
  })
  .strict();
export type KnowledgeDocumentView = z.infer<typeof KnowledgeDocumentSchema>;

/** 知识库检索命中；引用字段来自本地文档偏移 */
export const KnowledgeHitSchema = z
  .object({
    chunkId: z.string(),
    documentId: z.string(),
    title: z.string(),
    sourcePath: z.string(),
    dataClass: z.enum(["L0", "L1", "L2", "L3"]),
    ordinal: z.number().int().nonnegative(),
    text: z.string(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    score: z.number(),
  })
  .strict();
export type KnowledgeHitView = z.infer<typeof KnowledgeHitSchema>;

/** 知识库问答引用 */
export const KnowledgeCitationSchema = z
  .object({
    chunkId: z.string(),
    title: z.string(),
    sourcePath: z.string(),
    ordinal: z.number().int().nonnegative(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
  })
  .strict();

/** 知识库问答结果；失败也必须说明原因 */
export const KnowledgeAnswerResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      answer: z.string(),
      citations: z.array(KnowledgeCitationSchema),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(["no_evidence", "sensitive", "blocked", "budget", "llm_unavailable", "invalid_answer"]),
      message: z.string(),
    })
    .strict(),
]);
export type KnowledgeAnswerResultView = z.infer<typeof KnowledgeAnswerResultSchema>;

/** 监测器配置视图；与 daemon config.monitors 的结构一致 */
export const MonitorConfigViewSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().min(1).max(120),
      kind: z.literal("files"),
      enabled: z.boolean().default(true),
      root: z.string().min(1),
      patterns: z.array(z.string()),
      ignore: z.array(z.string()),
      intervalS: z.number().int().min(5).max(3_600),
      stableMs: z.number().int().nonnegative(),
      skills: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(120),
      kind: z.literal("system"),
      enabled: z.boolean().default(true),
      intervalS: z.number().int().min(5).max(3_600),
      skills: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(120),
      kind: z.literal("web"),
      enabled: z.boolean().default(true),
      url: z
        .string()
        .url()
        .refine((u) => /^https?:\/\//.test(u), "只支持 http/https"),
      mode: z.enum(["page", "json", "rss"]),
      selector: z.string().max(200).optional(),
      jsonPath: z.string().max(300).optional(),
      intervalS: z.number().int().min(5).max(3_600),
      skills: z.array(z.string()),
    })
    .strict(),
]);
export type MonitorConfigView = z.infer<typeof MonitorConfigViewSchema>;

/** 监测器运行状态（设置页展示；不含 Skill 内容） */
export const MonitorStatusViewSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["files", "system", "web"]),
    intervalMs: z.number().int().positive(),
    skills: z.array(z.string()),
    lastScanAt: z.number().int().nullable(),
    lastFacts: z.number().int().nonnegative(),
    lastNotified: z.number().int().nonnegative(),
    lastErrors: z.number().int().nonnegative(),
    error: z.string().nullable(),
    running: z.boolean(),
  })
  .strict();
export type MonitorStatusView = z.infer<typeof MonitorStatusViewSchema>;

/** 通知的对外视图；`isCatchup`/`isUncertain` 用于在界面上区分补偿补发与不确定投递 */
export const NotificationViewSchema = z
  .object({
    id: z.string(),
    kind: NotificationKindSchema,
    title: z.string(),
    body: z.string().nullable(),
    scheduledFor: z.number().int(),
    state: z.enum(["pending", "delivering", "delivered", "failed", "suppressed"]),
    /** 渠道投递摘要，如 [{channel:'os_notification', outcome:'success'}] */
    attempts: z.array(
      z.object({
        channel: z.string(),
        outcome: z.string(),
        error: z.string().nullable(),
      }),
    ),
    /** 是否属于休眠/关机后的补偿补发（FR-A3 的可见性） */
    isCatchup: z.boolean(),
    /** 崩溃期不确定实例（详细设计 §6.5 A） */
    isUncertain: z.boolean(),
  })
  .strict();
export type NotificationView = z.infer<typeof NotificationViewSchema>;

/** 健康检查视图；`degradedReasons` 非空时界面必须显式提示（不允许静默降级） */
export const HealthViewSchema = z
  .object({
    ok: z.boolean(),
    uptimeS: z.number().nonnegative(),
    tickCount: z.number().nonnegative(),
    lastTickAt: z.number().int().nullable(),
    nextDueAt: z.number().int().nullable(),
    rssBytes: z.number().nonnegative().nullable(),
    openFds: z.number().nonnegative().nullable(),
    /** 降级原因（如通知渠道不可用），UI 必须显式展示 */
    degradedReasons: z.array(z.string()),
  })
  .strict();
export type HealthView = z.infer<typeof HealthViewSchema>;

/** RPC 方法表：方法名 → 入参 / 出参 schema（供两侧类型推导与运行时校验） */
export const RPC_METHODS = {
  "sys.hello": {
    params: z.object({ token: z.string(), clientVersion: z.string() }).strict(),
    result: z
      .object({
        protocolVersion: z.number().int(),
        daemonVersion: z.string(),
        dataDir: z.string(),
        startedAt: z.number().int(),
      })
      .strict(),
  },
  "sys.health": { params: z.object({}).strict(), result: HealthViewSchema },
  "task.list": {
    params: z
      .object({
        filter: z.enum(["today", "all", "paused"]).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    result: z.object({ items: z.array(TaskViewSchema), nextCursor: z.string().nullable() }).strict(),
  },
  "task.create": { params: CreateTaskInputSchema, result: z.object({ id: z.string() }).strict() },
  "task.get": {
    params: z.object({ id: z.string() }).strict(),
    result: TaskEditViewSchema,
  },
  "task.update": {
    params: CreateTaskInputSchema.extend({ id: z.string() }).strict(),
    result: z.object({ id: z.string() }).strict(),
  },
  "task.complete": {
    params: z.object({ occurrenceId: z.string() }).strict(),
    result: z.object({ ok: z.boolean() }).strict(),
  },
  "task.snooze": {
    params: z.object({ occurrenceId: z.string(), minutes: z.number().int().min(1).max(1_440) }).strict(),
    result: z.object({ id: z.string() }).strict(),
  },
  "task.pause": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.boolean() }).strict(),
  },
  "task.resume": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.boolean() }).strict(),
  },
  "task.delete": {
    params: z.object({ id: z.string(), hard: z.boolean().optional() }).strict(),
    result: z.object({ ok: z.boolean() }).strict(),
  },
  "notify.history": {
    params: z
      .object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        kind: NotificationKindSchema.optional(),
      })
      .strict(),
    result: z.object({ items: z.array(NotificationViewSchema), nextCursor: z.string().nullable() }).strict(),
  },
  /** 测试通知：首次启动向导用它让用户立刻验证"它真的会响" */
  "notify.test": { params: z.object({}).strict(), result: z.object({ ok: z.boolean() }).strict() },
  "ctrl.pauseAll": {
    params: z.object({ untilAt: z.number().int().optional() }).strict(),
    result: z.object({ ok: z.boolean() }).strict(),
  },
  "ctrl.resumeAll": { params: z.object({}).strict(), result: z.object({ ok: z.boolean() }).strict() },
  "monitor.system": {
    params: z.object({}).strict(),
    result: z.object({ health: SystemHealthViewSchema, errors: z.array(MonitorErrorSchema) }).strict(),
  },
  "dnd.get": {
    params: z.object({}).strict(),
    result: DndSettingsSchema,
  },
  "dnd.set": {
    params: DndSettingsSchema,
    result: z.object({ ok: z.boolean() }).strict(),
  },
  "platform.permissionStatus": {
    params: z.object({}).strict(),
    result: z.object({ notifications: z.enum(["granted", "denied", "unknown"]) }).strict(),
  },
  "platform.autostartSet": {
    params: z.object({ enabled: z.boolean() }).strict(),
    result: z.object({ ok: z.boolean(), error: z.string().nullable() }).strict(),
  },
  "backup.export": {
    params: z.object({ targetDir: z.string(), includeHistory: z.boolean().optional() }).strict(),
    result: z
      .object({
        path: z.string(),
        files: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
      })
      .strict(),
  },
  "diag.recentLogs": {
    params: z.object({ limit: z.number().int().min(1).max(1_000) }).strict(),
    result: z.object({ lines: z.array(z.string()) }).strict(),
  },
} as const;

export type RpcMethod = keyof typeof RPC_METHODS;

/** 事件流：daemon → UI */
export const EVENTS = {
  "task.changed": z
    .object({ id: z.string(), reason: z.enum(["created", "updated", "deleted", "fired"]) })
    .strict(),
  "occurrence.changed": z.object({ id: z.string(), taskId: z.string(), state: z.string() }).strict(),
  "notification.fired": z
    .object({ notificationId: z.string(), taskId: z.string().nullable(), title: z.string() })
    .strict(),
  /** 投递失败必须显式暴露，不允许静默（PRD NFR-W2） */
  "notification.failed": z
    .object({ notificationId: z.string(), channel: z.string(), error: z.string() })
    .strict(),
  "runtime.gap": z
    .object({ gapStart: z.number().int(), gapEnd: z.number().int(), cause: z.string() })
    .strict(),
  "runtime.degraded": z.object({ reason: z.string() }).strict(),
} as const;

export type EventName = keyof typeof EVENTS;
