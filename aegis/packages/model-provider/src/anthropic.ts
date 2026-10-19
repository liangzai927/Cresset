/**
 * Anthropic Messages API 的 Provider 适配器
 *
 * 与 OpenAI 兼容协议的三处差异：
 *   - system 是顶层字段，不是 messages 里的一条；
 *   - 请求必须带 `max_tokens`；
 *   - 响应是 content block 数组，需要把 text block 拼起来。
 *
 * 本文件不负责脱敏、分级、审计。
 */

import { ProviderError } from "./errors.js";
import { assertAllowedEndpoint, postJson } from "./http.js";
import type { CompletionRequest, CompletionResponse, CompletionUsage, ModelProvider } from "./types.js";

/** Anthropic Provider 的构造参数 */
export interface AnthropicOptions {
  /** 审计里显示的 provider id，默认 "anthropic" */
  id?: string;
  /** 服务根地址，默认 `https://api.anthropic.com` */
  baseUrl?: string;
  /** API Key；只保存在内存/钥匙串，不写日志 */
  apiKey: string;
  /** `anthropic-version` 请求头，默认 2023-06-01 */
  version?: string;
  /** 单次请求超时（毫秒），默认 60000 */
  timeoutMs?: number;
  /** 可注入 fetch，测试用 */
  fetchImpl?: typeof fetch;
}

/** Anthropic Messages API 的 Provider 实现 */
export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #version: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(opts: AnthropicOptions) {
    this.id = opts.id ?? "anthropic";
    if (!opts.apiKey.trim()) {
      throw new ProviderError(this.id, "configuration", "Anthropic Provider 缺少 API Key");
    }
    const base = assertAllowedEndpoint(opts.baseUrl ?? "https://api.anthropic.com", this.id);
    this.#endpoint = `${base.toString().replace(/\/+$/, "")}/v1/messages`;
    this.#apiKey = opts.apiKey;
    this.#version = opts.version ?? "2023-06-01";
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
    if (this.#timeoutMs <= 0) {
      throw new ProviderError(this.id, "configuration", `timeoutMs 必须大于 0（收到 ${this.#timeoutMs}）`);
    }
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!request.model.trim()) {
      throw new ProviderError(this.id, "configuration", "request.model 不能为空");
    }

    const { system, dialog } = splitSystem(request);
    if (dialog.length === 0) {
      throw new ProviderError(this.id, "configuration", "Anthropic 请求至少需要一条 user/assistant 消息");
    }
    if (!dialog.some((m) => m.role === "user")) {
      throw new ProviderError(this.id, "configuration", "Anthropic 请求至少需要一条 user 消息");
    }

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 1_024,
      messages: dialog,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const parsed = await postJson({
      providerId: this.id,
      url: this.#endpoint,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": this.#version,
      },
      body,
      timeoutMs: this.#timeoutMs,
      fetchImpl: this.#fetch,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    return parseAnthropicResponse(parsed, request.model, this.id);
  }
}

/** 把 system 消息抽到顶层字段；其余消息保持原顺序 */
function splitSystem(request: CompletionRequest): {
  system: string;
  dialog: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const dialog: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else {
      dialog.push({ role: message.role, content: message.content });
    }
  }
  return { system: systemParts.join("\n\n"), dialog };
}

/** 解析 Anthropic 响应：content 是 block 数组，拼接所有 text block */
function parseAnthropicResponse(
  parsed: unknown,
  fallbackModel: string,
  providerId: string,
): CompletionResponse {
  if (!isRecord(parsed)) {
    throw new ProviderError(providerId, "invalid_response", "Anthropic 响应不是 JSON 对象");
  }
  const content = parsed.content;
  if (!Array.isArray(content)) {
    throw new ProviderError(providerId, "invalid_response", "Anthropic 响应缺少 content 数组");
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  if (parts.length === 0) {
    throw new ProviderError(providerId, "invalid_response", "Anthropic 响应没有 text block");
  }

  const usage = parseUsage(parsed.usage);
  const finishReason = typeof parsed.stop_reason === "string" ? parsed.stop_reason : undefined;
  return {
    text: parts.join(""),
    model: typeof parsed.model === "string" && parsed.model ? parsed.model : fallbackModel,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Anthropic usage：input_tokens / output_tokens（没有 total 字段） */
function parseUsage(raw: unknown): CompletionUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const inputTokens = numberOrZero(raw.input_tokens);
  const outputTokens = numberOrZero(raw.output_tokens);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
