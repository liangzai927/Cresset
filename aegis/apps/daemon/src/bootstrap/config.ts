/**
 * 配置加载（非敏感项；敏感项一律走钥匙串）
 *
 * 设计原则：
 *   - 文件缺失 / 损坏 → 用默认值并**把问题带出去**（不静默吞掉）
 *   - 未知字段 → 保留（向前兼容：旧版本不该因为新字段而拒绝启动）
 *   - 校验失败 → 用默认值 + 明确报告哪一项有问题
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";

/** 一个监测器实例的配置；M2 支持 files/system/web 三种 */
export const MonitorConfigSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().min(1).max(120),
      kind: z.literal("files"),
      enabled: z.boolean().default(true),
      root: z.string().min(1),
      patterns: z.array(z.string()).default([]),
      ignore: z.array(z.string()).default([]),
      intervalS: z.number().int().min(5).max(3_600).default(30),
      stableMs: z.number().int().nonnegative().default(2_000),
      skills: z.array(z.string()).default([]),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(120),
      kind: z.literal("system"),
      enabled: z.boolean().default(true),
      intervalS: z.number().int().min(5).max(3_600).default(60),
      skills: z.array(z.string()).default([]),
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
      mode: z.enum(["page", "json", "rss"]).default("page"),
      /** page 模式的 CSS 选择器；只监控选中区域 */
      selector: z.string().max(200).optional(),
      /** json 模式的受限 JSONPath，如 data.items[0].status */
      jsonPath: z.string().max(300).optional(),
      intervalS: z.number().int().min(5).max(3_600).default(60),
      skills: z.array(z.string()).default([]),
    })
    .strict(),
]);

/** 监测器配置类型 */
export type MonitorConfig = z.infer<typeof MonitorConfigSchema>;

/** 守护进程配置契约（非敏感项；敏感项一律走钥匙串） */
export const DaemonConfigSchema = z
  .object({
    version: z.number().int().positive().default(1),
    locale: z.string().default("zh-CN"),
    /** tick 间隔（毫秒）；30s 对应"误差 ≤30 秒"的要求（FR-A2） */
    tickMs: z.number().int().min(1_000).max(600_000).default(30_000),
    /** 物化窗口前瞻（小时） */
    lookaheadHours: z.number().int().min(1).max(168).default(24),
    /** 默认补偿窗口（秒）；12h（FR-A3） */
    defaultCatchupWindowS: z.number().int().nonnegative().default(43_200),
    heartbeat: z
      .object({
        intervalS: z.number().int().min(10).max(3_600).default(60),
        gapWarnMultiplier: z.number().min(2).max(20).default(3),
      })
      .default({}),
    notify: z
      .object({
        channels: z.array(z.string()).default(["os_notification", "cli_fallback"]),
        soundEnabled: z.boolean().default(true),
        webhook: z
          .object({
            enabled: z.boolean().default(false),
            url: z.string().url().optional(),
          })
          .default({}),
        /** 补偿批量：≥N 条才合并为摘要（I2 决策） */
        catchupMergeThreshold: z.number().int().min(1).max(50).default(3),
      })
      .default({}),
    retention: z
      .object({
        signalDays: z.number().int().positive().default(30),
        auditDays: z.number().int().positive().default(180),
        heartbeatDays: z.number().int().positive().default(14),
        runLogDays: z.number().int().positive().default(30),
        contextSnapshotDays: z.number().int().positive().default(7),
      })
      .default({}),
    autostart: z.boolean().default(true),
    /**
     * M2 监测器实例。
     *
     * `skills` 是 YAML 路径（相对 dataDir 或绝对路径）；daemon 启动时加载并校验。
     * 一个监测器可以绑定多个 Skill；Skill 的 trigger.monitor 必须等于实例 id。
     */
    monitors: z.array(MonitorConfigSchema).default([]),
    /**
     * M3 模型设置（非敏感）；API Key 只走钥匙串，绝不写这里。
     */
    llm: z
      .object({
        enabled: z.boolean().default(false),
        baseUrl: z
          .string()
          .url()
          .refine((u) => /^https?:\/\//.test(u), "只支持 http/https")
          .default("https://api.openai.com/v1"),
        model: z.string().min(1).max(120).default("gpt-4o-mini"),
        timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
        maxOutboundClass: z.enum(["L0", "L1", "L2"]).default("L1"),
        dailyCallLimit: z.number().int().min(1).max(10_000).default(200),
      })
      .default({}),
    /** 通知优先级规则：DND 期间哪些级别可穿透（FR-A7） */
    dnd: z
      .object({
        enabled: z.boolean().default(true),
        windows: z
          .array(
            z.object({
              days: z.array(z.number().int().min(1).max(7)),
              from: z.string().regex(/^\d{2}:\d{2}$/),
              to: z.string().regex(/^\d{2}:\d{2}$/),
            }),
          )
          .default([]),
      })
      .default({}),
  })
  .passthrough();

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

/** 全部取默认值的配置；配置文件缺失/损坏时的兜底 */
export const DEFAULT_CONFIG: DaemonConfig = DaemonConfigSchema.parse({});

/** 配置加载结果；`issues` 与 `usedDefaults` 让调用方能把问题**带出去**而不是静默吞掉 */
export interface LoadConfigResult {
  config: DaemonConfig;
  /** 加载过程中的问题（缺失文件、校验失败等）——调用方应记审计/日志 */
  issues: string[];
  /** 是否使用了默认值（文件不存在或损坏） */
  usedDefaults: boolean;
}

/** 加载配置：文件缺失/无法解析/校验失败时回退默认值，并报告具体问题 */
export function loadConfig(path: string): LoadConfigResult {
  const issues: string[] = [];

  if (!existsSync(path)) {
    return { config: DEFAULT_CONFIG, issues: [`配置文件不存在，使用默认值：${path}`], usedDefaults: true };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      config: DEFAULT_CONFIG,
      issues: [`配置文件无法解析（${String(err)}），使用默认值`],
      usedDefaults: true,
    };
  }

  const parsed = DaemonConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`配置项 ${issue.path.join(".") || "(根)"}：${issue.message}`);
    }
    // 校验失败时退回默认值，但**保留原始文件**供人工修复
    return { config: DEFAULT_CONFIG, issues, usedDefaults: true };
  }

  return { config: parsed.data, issues, usedDefaults: false };
}

/**
 * 原子写回配置（0600，先写临时文件再 rename）。
 *
 * 只用于非敏感配置（DND/语言等）；凭据仍必须走钥匙串。
 * 写失败会抛错，调用方必须把错误带给用户，不能静默丢掉设置。
 *
 * @param path 配置文件路径
 * @param config 完整配置（未知字段会原样保留，依赖 Zod passthrough）
 */
export function saveConfig(path: string, config: DaemonConfig): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理临时文件失败不掩盖原始错误 */
    }
    throw err;
  }
}
