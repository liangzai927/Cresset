/**
 * Skill 加载器（YAML → 已校验的 Skill）
 *
 * 校验分两层：
 *   1. YAML 语法（yaml 库）
 *   2. 字段/权限/动作契约（Zod 严格模式）
 *
 * 任何失败都返回带 code 的 `SkillLoadError`，由调用方展示给用户；
 * 不允许"解析失败就用默认值"。
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { type Skill, SkillSchema } from "./schema.js";

export type SkillLoadErrorCode = "YAML_PARSE" | "SCHEMA_INVALID" | "READ_FAILED";

/** Skill 加载失败 */
export class SkillLoadError extends Error {
  constructor(
    readonly code: SkillLoadErrorCode,
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "SkillLoadError";
  }
}

/**
 * 解析并校验一段 YAML Skill。
 *
 * @throws SkillLoadError YAML 语法或字段契约不合法
 */
export function parseSkill(source: string): Skill {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new SkillLoadError("YAML_PARSE", `YAML 解析失败：${(err as Error).message}`);
  }

  const parsed = SkillSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(根)"}：${i.message}`);
    throw new SkillLoadError("SCHEMA_INVALID", "Skill 字段校验失败", issues);
  }
  return parsed.data;
}

/** 从文件加载 Skill；读文件失败也转成结构化错误 */
export function loadSkillFile(path: string): Skill {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    throw new SkillLoadError("READ_FAILED", `读取 Skill 失败：${(err as Error).message}`);
  }
  return parseSkill(source);
}
