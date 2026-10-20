/**
 * M2 规则引擎（纯函数）
 *
 * 输入：一条已校验的 Skill + 监测器事实。
 * 输出：`null`（条件不成立）或一条可投递的通知决策。
 *
 * 这一层刻意不碰数据库、不调用模型、不发通知：它只回答"这条事实是否命中规则、
 * 命中后应该显示什么"。这样阈值/模板/边界都能用纯单测证明。
 */

import type { Skill, SkillPriority } from "./schema.js";
import { renderTemplate, type TemplateContext } from "./template.js";

/** 监测器产出的事实；key 对应 trigger.field */
export type SkillFacts = Record<string, unknown>;

/** 规则引擎的失败必须可见（而不是静默返回 false） */
export class SkillEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillEvaluationError";
  }
}

/** 命中规则后的通知决策 */
export interface SkillDecision {
  skill: string;
  priority: SkillPriority;
  title: string;
  body: string;
  cooldown: string;
}

/** 数字/字符串比较；不能比较时抛错，避免"看起来没命中"的静默失败 */
export function compareThreshold(
  actual: unknown,
  op: "<" | "<=" | ">" | ">=" | "==" | "!=",
  expected: unknown,
): boolean {
  const a = typeof actual === "number" ? actual : Number(actual);
  const b = typeof expected === "number" ? expected : Number(expected);
  const numeric = Number.isFinite(a) && Number.isFinite(b);

  if (op === "==" || op === "!=") {
    const equal = numeric ? a === b : String(actual) === String(expected);
    return op === "==" ? equal : !equal;
  }
  if (!numeric) {
    throw new SkillEvaluationError(`阈值比较需要数字：actual=${String(actual)} expected=${String(expected)}`);
  }
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}

/**
 * 评估一条 Skill。
 *
 * @returns 命中则返回通知决策；不命中返回 null
 * @throws SkillEvaluationError 事实缺失/类型不可比较/模板变量缺失
 */
export function evaluateSkill(skill: Skill, facts: SkillFacts): SkillDecision | null {
  if (skill.trigger.type === "threshold") {
    const context: TemplateContext = { params: skill.params, monitor: facts };
    if (!(skill.trigger.field in facts)) {
      throw new SkillEvaluationError(`监测事实缺少字段：${skill.trigger.field}`);
    }
    const expected =
      typeof skill.trigger.value === "string"
        ? renderTemplate(skill.trigger.value, context)
        : skill.trigger.value;
    if (!compareThreshold(facts[skill.trigger.field], skill.trigger.op, expected)) return null;
  }

  const context: TemplateContext = { params: skill.params, monitor: facts };
  return {
    skill: skill.name,
    priority: skill.action.notify.priority,
    title: renderTemplate(skill.action.notify.title, context),
    body: renderTemplate(skill.action.notify.body, context),
    cooldown: skill.cooldown,
  };
}
