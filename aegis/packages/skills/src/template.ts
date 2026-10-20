/**
 * Skill 模板渲染
 *
 * 只支持 `{{params.x}}` / `{{monitor.x}}` 这种**受控变量替换**；
 * 不执行任意表达式，也不允许访问全局对象 —— Skill 是用户可写的 YAML，
 * 不能变成一段可执行脚本（FR-C6 的安全边界）。
 */

import type { SkillParamValue } from "./schema.js";

/** 模板上下文：参数来自 Skill 定义，monitor 来自监测器事实 */
export interface TemplateContext {
  params: Record<string, SkillParamValue>;
  monitor: Record<string, unknown>;
}

/** 模板变量不存在或不可渲染 */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** 从上下文按点路径取值（只允许一层 params./monitor.） */
function lookup(path: string, context: TemplateContext): unknown {
  const [root, key, ...rest] = path.split(".");
  if (rest.length > 0 || !root || !key) {
    throw new TemplateError(`不支持的模板变量：{{${path}}}（只允许 params.x / monitor.x）`);
  }
  if (root === "params") {
    if (!(key in context.params)) throw new TemplateError(`参数不存在：params.${key}`);
    return context.params[key];
  }
  if (root === "monitor") {
    if (!(key in context.monitor)) throw new TemplateError(`监测字段不存在：monitor.${key}`);
    return context.monitor[key];
  }
  throw new TemplateError(`不支持的模板根：${root}（只允许 params / monitor）`);
}

/** 标量转字符串；对象只做 JSON 序列化，避免出现 [object Object] */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * 渲染模板字符串。
 *
 * @throws TemplateError 变量不存在或语法不在白名单
 */
export function renderTemplate(text: string, context: TemplateContext): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, path: string) =>
    stringify(lookup(path, context)),
  );
}
