/**
 * Ollama 本地模型的 Provider 适配器
 *
 * 默认连 `http://127.0.0.1:11434`，不需要 API Key。它同样经过脱敏网关，
 * 但数据不出本机；如果用户把 Ollama 暴露到局域网，网关仍会先做脱敏。
 *
 * 本文件不负责脱敏、分级、审计。
 */

import { ProviderError } from "./errors.js";
import { assertAllowedEndpoint, postJson } from "./http.js";
import type { CompletionRequest, CompletionResponse, CompletionUsage, ModelProvider } from "./types.js";

/** Ollama Provider 的构造参数 */
export interface OllamaOptions {
  /** 审计里显示的 provider id，默认 "ollama" */
  id?: string;
  /** 服务根地址，默认 `http://127.0.0.1:11434` */
  baseUrl?: string;
  /** 单次请求超时（毫秒），默认 120000（本地生成可能较慢） */
  timeoutMs?: number;
  /** 可注入 fetch，测试用 */
  fetchImpl?: typeof fetch;
}

/** Ollama `/api/chat` 的 Provider 实现 */
export class OllamaProvider implements ModelProvider {
  readonly id: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(opts: OllamaOptions = {}) {
    this.id = opts.id ?? "ollama";
    const base = assertAllowedEndpoint(opts.baseUrl ?? "http://127.0.0.1:11434", this.id);
    this.#endpoint = `${base.toString().replace(/\/+$/, "")}/api/chat`;
    this.#timeoutMs = opts.timeoutMs ?? 120_000;
    if (this.#timeoutMs <= 0) {
      throw new ProviderError(this.id, "configuration", `timeoutMs 必须大于 0（收到 ${this.#timeoutMs}）`);
    }
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!request.model.trim()) {
      throw new ProviderError(this.id, "configuration", "request.model 不能为空");
    }
    if (request.messages.length === 0) {
      throw new ProviderError(this.id, "configuration", "request.messages 不能为空");
    }

    const options: Record<string, unknown> = {};
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (request.maxTokens !== undefined) options.num_predict = request.maxTokens;

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: false,
      ...(Object.keys(options).length > 0 ? { options } : {}),
    };

    const parsed = await postJson({
      providerId: this.id,
      url: this.#endpoint,
      headers: { "content-type": "application/json" },
      body,
      timeoutMs: this.#timeoutMs,
      fetchImpl: this.#fetch,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    return parseOllamaResponse(parsed, request.model, this.id);
  }
}

/** 解析 Ollama `/api/chat` 的非流式响应 */
function parseOllamaResponse(parsed: unknown, fallbackModel: string, providerId: string): CompletionResponse {
  if (!isRecord(parsed)) {
    throw new ProviderError(providerId, "invalid_response", "Ollama 响应不是 JSON 对象");
  }
  const message = parsed.message;
  if (!isRecord(message) || typeof message.content !== "string") {
    throw new ProviderError(providerId, "invalid_response", "Ollama 响应缺少 message.content");
  }

  const inputTokens = numberOrZero(parsed.prompt_eval_count);
  const outputTokens = numberOrZero(parsed.eval_count);
  const usage: CompletionUsage | undefined =
    inputTokens > 0 || outputTokens > 0
      ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
      : undefined;
  const finishReason = typeof parsed.done_reason === "string" ? parsed.done_reason : undefined;

  return {
    text: message.content,
    model: typeof parsed.model === "string" && parsed.model ? parsed.model : fallbackModel,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
