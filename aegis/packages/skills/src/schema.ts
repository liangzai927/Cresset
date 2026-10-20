/**
 * Skill 的 YAML 契约（M2 / PRD FR-C1）
 *
 * 设计约束：
 *   - 人类可读可写：字段名就是用户在 YAML 里看到的字段；
 *   - 严格模式：未知字段直接拒绝，避免"写错了但静默不生效"；
 *   - M2 动作只有通知，脚本/软件调用要到 M4 且必须显式授权（FR-C6）。
 */

import { z } from "zod";

/** M2 允许声明的最小权限集合；引擎在导入/运行时按此校验 */
export const SkillPermissionSchema = z.enum(["system.read", "files.read", "network.read"]);
export type SkillPermission = z.infer<typeof SkillPermissionSchema>;

/** 通知优先级；与通知域的四级一致（不是任务 priority） */
export const SkillPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export type SkillPriority = z.infer<typeof SkillPrioritySchema>;

/** 参数只允许标量；复杂结构应该由 Skill 作者拆成多个参数 */
export const SkillParamValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type SkillParamValue = z.infer<typeof SkillParamValueSchema>;

/** 触发方式：M2 先支持阈值与"数据源变化" */
export const SkillTriggerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("threshold"),
      /** 监测器 id，如 system.disk / files.downloads */
      monitor: z.string().min(1).max(120),
      /** 监测器产出的字段名 */
      field: z.string().min(1).max(120),
      op: z.enum(["<", "<=", ">", ">=", "==", "!="]),
      /** 可以是字面量，也可以是 {{params.x}} */
      value: z.union([z.string(), z.number()]),
    })
    .strict(),
  z
    .object({
      type: z.literal("change"),
      monitor: z.string().min(1).max(120),
    })
    .strict(),
]);
export type SkillTrigger = z.infer<typeof SkillTriggerSchema>;

/** M2 唯一允许的动作：发通知 */
export const SkillActionSchema = z
  .object({
    notify: z
      .object({
        priority: SkillPrioritySchema.default("normal"),
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(4_000),
      })
      .strict(),
  })
  .strict();
export type SkillAction = z.infer<typeof SkillActionSchema>;

/**
 * 可选的 LLM 判断步骤（M3 FR-D1）。
 *
 * 规则先决定"到没到/变没变"；这里才让模型判断"值不值得打断"与"怎么说"。
 * 没有配置 judge 的 Skill 永远不调用模型。
 */
export const SkillJudgeSchema = z
  .object({
    /** 追加给模型的判断说明；规则命中后的标题/正文仍作为 fallback */
    prompt: z.string().min(1).max(4_000),
    /** 关闭后只让模型改写文案，不允许把通知抑制掉 */
    canSuppress: z.boolean().default(true),
  })
  .strict();
export type SkillJudge = z.infer<typeof SkillJudgeSchema>;

/** 完整 Skill 定义 */
export const SkillSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, "name 必须是 2–63 位小写字母/数字/连字符"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "version 必须是 x.y.z"),
    description: z.string().min(1).max(1_000),
    author: z.string().max(120).optional(),
    permissions: z.array(SkillPermissionSchema).default([]),
    params: z.record(z.string(), SkillParamValueSchema).default({}),
    /** 冷却期；同一 Skill 在此窗口内不重复通知（由引擎/调度器执行） */
    cooldown: z
      .string()
      .regex(/^\d+[smhd]$/, "cooldown 形如 30m / 6h / 1d")
      .default("24h"),
    trigger: SkillTriggerSchema,
    /** 可选：规则命中后再让模型判断/改写；失败必须回退到规则文案 */
    judge: SkillJudgeSchema.optional(),
    action: SkillActionSchema,
  })
  .strict();
export type Skill = z.infer<typeof SkillSchema>;
