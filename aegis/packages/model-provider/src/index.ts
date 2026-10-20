/**
 * @aegis/model-provider —— 模型 Provider 抽象与 OpenAI 兼容实现
 *
 * 本包只负责协议调用，不负责脱敏、审计或“是否允许外发”。
 * 这些安全语义全部在 `@aegis/redaction-gateway`，依赖方向门禁会阻止其他包直连。
 */

export * from "./errors.js";
export * from "./openai-compatible.js";
export * from "./types.js";
