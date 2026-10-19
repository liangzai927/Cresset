/**
 * OpenAI 兼容协议的 Provider 适配器
 *
 * 覆盖 OpenAI 以及 DeepSeek、Kimi、GLM 等提供 `/chat/completions` 的服务。
 * 只依赖 `fetch`，不引入厂商 SDK —— 少一个供应链风险，也避免 SDK 类型渗透到网关。
 *
 * 本文件不负责脱敏、分级、审计；这些必须在调用本适配器之前完成。
 */

import { ProviderError } from "./errors.js";
import { assertAllowedEndpoint, postJson } from "./http.js";
import type { CompletionRequest, CompletionResponse, CompletionUsage, ModelProvider } from "./types.js";

/** OpenAI 兼容 Provider 的构造参数 */
export interface OpenAiCompatibleOptions {
  /** 审计里显示的 provider id，默认 "openai-compatible" */
  id?: string;
  /** 服务根地址，如 `https://api.deepseek.com/v1`（不要带 `/chat/completions`） */
  baseUrl: string;
  /** API Key；只保存在内存/钥匙串，不写日志 */
  apiKey: string;
  /** 单次请求超时（毫秒），默认 60000 */
  timeoutMs?: number;
  /** 额外请求头（可选） */
  headers?: Record<string, string>;
  /** 可注入 fetch，测试用 */
  fetchImpl?: typeof fetch;
}

/** OpenAI 兼容 `/chat/completions` 的 Provider 实现 */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;

  constructor(opts: OpenAiCompatibleOptions) {
    this.id = opts.id ?? "openai-compatible";
    if (!opts.apiKey.trim()) {
      throw new ProviderError(this.id, "configuration", "OpenAI 兼容 Provider 缺少 API Key");
    }
    const base = assertAllowedEndpoint(opts.baseUrl, this.id);
    this.#endpoint = `${base.toString().replace(/\/+$/, "")}/chat/completions`;
    this.#apiKey = opts.apiKey;
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
    if (this.#timeoutMs <= 0) {
      throw new ProviderError(this.id, "configuration", `timeoutMs 必须大于 0（收到 ${this.#timeoutMs}）`);
    }
    this.#headers = opts.headers ?? {};
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.#assertRequest(request);

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: false,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;

    const parsed = await postJson({
      providerId: this.id,
      url: this.#endpoint,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
        ...this.#headers,
      },
      body,
      timeoutMs: this.#timeoutMs,
      fetchImpl: this.#fetch,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    return parseOpenAiResponse(parsed, request.model, this.id);
  }

  /** 请求进入网络前做最后一道形状检查；避免把错误结构发给厂商 */
  #assertRequest(request: CompletionRequest): void {
    if (!request.model.trim()) {
      throw new ProviderError(this.id, "configuration", "request.model 不能为空");
    }
    if (request.messages.length === 0) {
      throw new ProviderError(this.id, "configuration", "request.messages 不能为空");
    }
  }
}

/** 解析 OpenAI 兼容响应；所有字段都从 unknown 收窄，避免把 any 带进网关 */
function parseOpenAiResponse(parsed: unknown, fallbackModel: string, providerId: string): CompletionResponse {
  if (!isRecord(parsed)) {
    throw new ProviderError(providerId, "invalid_response", "Provider 响应不是 JSON 对象");
  }
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError(providerId, "invalid_response", "Provider 响应缺少 choices");
  }
  const first = choices[0];
  if (!isRecord(first)) {
    throw new ProviderError(providerId, "invalid_response", "choices[0] 不是对象");
  }
  const message = first.message;
  if (!isRecord(message) || typeof message.content !== "string") {
    throw new ProviderError(providerId, "invalid_response", "choices[0].message.content 不是字符串");
  }

  const usage = parseUsage(parsed.usage);
  const finishReason = typeof first.finish_reason === "string" ? first.finish_reason : undefined;
  return {
    text: message.content,
    model: typeof parsed.model === "string" && parsed.model ? parsed.model : fallbackModel,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

/** OpenAI 风格 usage：prompt_tokens / completion_tokens / total_tokens */
function parseUsage(raw: unknown): CompletionUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const inputTokens = numberOrZero(raw.prompt_tokens);
  const outputTokens = numberOrZero(raw.completion_tokens);
  const totalTokens = numberOrZero(raw.total_tokens) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
