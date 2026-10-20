/**
 * 模型 Provider 的公共类型
 *
 * 这一层只描述“发一次补全请求、拿回文本”，不包含提示词、业务判断或脱敏。
 * 任何调用方都必须通过 `@aegis/redaction-gateway`，不能直接依赖本包。
 */

/** 对话角色 */
export type ChatRole = "system" | "user" | "assistant";

/** 一条对话消息 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** 补全请求 */
export interface CompletionRequest {
  /** 模型名，如 gpt-4o-mini / deepseek-chat */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 单次请求超时（毫秒），默认使用 Provider 配置 */
  timeoutMs?: number;
}

/** token 用量；Provider 不返回时省略 */
export interface CompletionUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** 补全结果 */
export interface CompletionResponse {
  text: string;
  model: string;
  usage?: CompletionUsage;
}

/**
 * 模型 Provider 抽象。
 *
 * 约束：
 *   - 只有 `@aegis/redaction-gateway` 可以依赖本包；
 *   - Provider 本身不做脱敏、不写审计、不决定是否允许外发；
 *   - 错误信息不得包含响应体/密钥原文。
 */
export interface ModelProvider {
  /** 稳定标识，写入审计（如 "openai-compatible"） */
  readonly id: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
