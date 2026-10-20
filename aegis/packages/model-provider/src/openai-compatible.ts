/**
 * OpenAI 兼容协议适配器
 *
 * 覆盖 OpenAI 以及 DeepSeek、Kimi、GLM 等提供 `/chat/completions` 的服务。
 * 只使用内置 fetch，不引入任何模型 SDK；密钥只在内存中传给请求头，不落日志。
 */

import { kindForHttpStatus, ProviderError } from "./errors.js";
import type { CompletionRequest, CompletionResponse, CompletionUsage, ModelProvider } from "./types.js";

/** OpenAI 兼容 Provider 配置 */
export interface OpenAICompatibleOptions {
  /** 基础地址，如 https://api.openai.com/v1 */
  baseUrl: string;
  /** API Key；由上层从钥匙串读取，本类不持久化 */
  apiKey: string;
  /** 默认模型名 */
  model: string;
  /** 默认超时（毫秒） */
  timeoutMs?: number;
  /** 测试注入；默认使用全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 安全地取 record */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 解析 usage；字段不存在时返回 undefined */
function parseUsage(value: unknown): CompletionUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const result: CompletionUsage = {};
  if (typeof usage.prompt_tokens === "number") result.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") result.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") result.totalTokens = usage.total_tokens;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** OpenAI 兼容 Provider */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #defaultModel: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#defaultModel = options.model;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** 获取服务商模型列表（OpenAI 兼容 /models）；失败同样只暴露安全类别 */
  async listModels(): Promise<string[]> {
    if (!this.#apiKey) throw new ProviderError(this.id, "configuration", "未配置 API Key");
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.#apiKey}` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      const kind = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
      throw new ProviderError(this.id, kind, `请求失败：${kind}`, { cause: err });
    }
    if (!response.ok) {
      throw new ProviderError(this.id, kindForHttpStatus(response.status), `HTTP ${response.status}`, {
        status: response.status,
      });
    }
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch (err) {
      throw new ProviderError(this.id, "invalid_response", "模型列表不是合法 JSON", { cause: err });
    }
    const record = asRecord(body);
    const data = Array.isArray(record?.data) ? record.data : [];
    const models = data
      .map((item) => asRecord(item)?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return [...new Set(models)].slice(0, 200);
  }

  /** 发起一次补全；错误只包含安全类别与状态码 */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.#apiKey) {
      throw new ProviderError(this.id, "configuration", "未配置 API Key");
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model || this.#defaultModel,
          messages: request.messages,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? this.#timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      const kind = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
      throw new ProviderError(this.id, kind, `请求失败：${kind}`, { cause: err });
    }

    if (!response.ok) {
      const kind = kindForHttpStatus(response.status);
      throw new ProviderError(this.id, kind, `HTTP ${response.status}`, { status: response.status });
    }

    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch (err) {
      throw new ProviderError(this.id, "invalid_response", "响应不是合法 JSON", { cause: err });
    }

    const record = asRecord(body);
    const choices = Array.isArray(record?.choices) ? record.choices : [];
    const first = asRecord(choices[0]);
    const message = asRecord(first?.message);
    const content = message?.content;
    if (typeof content !== "string") {
      throw new ProviderError(this.id, "invalid_response", "响应缺少 choices[0].message.content");
    }

    const usage = parseUsage(record?.usage);
    return {
      text: content,
      model: typeof record?.model === "string" ? record.model : request.model,
      ...(usage ? { usage } : {}),
    };
  }
}
