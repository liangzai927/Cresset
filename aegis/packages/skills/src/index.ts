/**
 * @aegis/skills —— M2 Skill 契约、YAML 加载与规则引擎
 *
 * 不包含：监测器实现、LLM 调用、通知投递。它们分别在 M2 的 monitor 层与
 * M1 的调度/通知层完成。
 */

export * from "./engine.js";
export * from "./loader.js";
export * from "./schema.js";
export * from "./template.js";
