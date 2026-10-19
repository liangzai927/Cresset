/**
 * Provider 适配器协议测试
 *
 * 全部使用注入的 fake fetch，不发真实网络请求，也不需要 API Key。
 * 重点验证：请求形状、鉴权头、响应解析、HTTP 错误映射，以及错误消息不泄露响应正文。
 */

import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
import { ProviderError } from "./errors.js";
import { FakeModelProvider } from "./fake.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

interface FetchHarness {
  fetchImpl: typeof fetch;
  calls: CapturedCall[];
}

/** 构造一个返回固定响应的 fetch，并记录调用 */
function harness(response: Response | (() => Promise<Response>)): FetchHarness {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return typeof response === "function" ? response() : response;
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function firstCall(calls: CapturedCall[]): CapturedCall {
  const call = calls[0];
  if (!call) throw new Error("测试前提不成立：fetch 没有被调用");
  return call;
}

function parseBody(call: CapturedCall): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(call.init.body));
  if (!isRecord(parsed)) throw new Error("请求体不是 JSON 对象");
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const messages = [{ role: "user" as const, content: "你好" }];

describe("OpenAiCompatibleProvider", () => {
  it("发送正确的 URL、鉴权头与请求体，并解析 usage", async () => {
    const h = harness(
      jsonResponse({
        model: "deepseek-chat",
        choices: [{ message: { content: "你好呀" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      fetchImpl: h.fetchImpl,
    });

    const result = await provider.complete({
      model: "deepseek-chat",
      messages,
      temperature: 0.2,
      maxTokens: 100,
    });

    const call = firstCall(h.calls);
    expect(call.url).toBe("https://api.example.com/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    const body = parseBody(call);
    expect(body.model).toBe("deepseek-chat");
    expect(body.messages).toEqual([{ role: "user", content: "你好" }]);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(100);
    expect(body.stream).toBe(false);
    expect(result).toMatchObject({
      text: "你好呀",
      model: "deepseek-chat",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it("401 映射为 auth，且错误消息不回显响应正文", async () => {
    const h = harness(new Response('{"error":"secret prompt echo"}', { status: 401 }));
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "bad-key",
      fetchImpl: h.fetchImpl,
    });

    await expect(provider.complete({ model: "m", messages })).rejects.toMatchObject({
      name: "ProviderError",
      kind: "auth",
      status: 401,
      retryable: false,
    });
    await expect(provider.complete({ model: "m", messages })).rejects.not.toThrow(/secret prompt echo/);
  });

  it("429 映射为可重试的 rate_limit", async () => {
    const h = harness(new Response("rate limited", { status: 429 }));
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "key",
      fetchImpl: h.fetchImpl,
    });

    await expect(provider.complete({ model: "m", messages })).rejects.toMatchObject({
      kind: "rate_limit",
      retryable: true,
    });
  });

  it("非 JSON 响应映射为 invalid_response", async () => {
    const h = harness(new Response("not json", { status: 200 }));
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "key",
      fetchImpl: h.fetchImpl,
    });

    await expect(provider.complete({ model: "m", messages })).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("非本机 http 地址在构造时被拒绝", () => {
    expect(
      () => new OpenAiCompatibleProvider({ baseUrl: "http://api.example.com/v1", apiKey: "key" }),
    ).toThrow(ProviderError);
  });

  it("缺少 API Key 时拒绝构造", () => {
    expect(
      () => new OpenAiCompatibleProvider({ baseUrl: "https://api.example.com/v1", apiKey: "  " }),
    ).toThrow(/API Key/);
  });
});

describe("AnthropicProvider", () => {
  it("把 system 抽到顶层，拼接 text block，并解析 usage", async () => {
    const h = harness(
      jsonResponse({
        model: "claude-test",
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "第二段" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    );
    const provider = new AnthropicProvider({ apiKey: "test-key", fetchImpl: h.fetchImpl });

    const result = await provider.complete({
      model: "claude-test",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "你好" },
      ],
    });

    const call = firstCall(h.calls);
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(call.init.headers);
    expect(headers.get("x-api-key")).toBe("test-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = parseBody(call);
    expect(body.system).toBe("你是助手");
    expect(body.messages).toEqual([{ role: "user", content: "你好" }]);
    expect(body.max_tokens).toBe(1_024);
    expect(result).toMatchObject({
      text: "第一段第二段",
      model: "claude-test",
      finishReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
  });

  it("没有 text block 时映射为 invalid_response", async () => {
    const h = harness(jsonResponse({ content: [{ type: "tool_use", id: "x" }] }));
    const provider = new AnthropicProvider({ apiKey: "key", fetchImpl: h.fetchImpl });
    await expect(provider.complete({ model: "m", messages })).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("没有 user 消息时在发送前拒绝", async () => {
    const h = harness(jsonResponse({ content: [{ type: "text", text: "x" }] }));
    const provider = new AnthropicProvider({ apiKey: "key", fetchImpl: h.fetchImpl });
    await expect(
      provider.complete({ model: "m", messages: [{ role: "system", content: "只给 system" }] }),
    ).rejects.toMatchObject({ kind: "configuration" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("OllamaProvider", () => {
  it("默认连本机回环，解析 message.content 与 usage", async () => {
    const h = harness(
      jsonResponse({
        model: "llama-test",
        message: { content: "本地回答" },
        prompt_eval_count: 12,
        eval_count: 4,
        done_reason: "stop",
      }),
    );
    const provider = new OllamaProvider({ fetchImpl: h.fetchImpl });

    const result = await provider.complete({
      model: "llama-test",
      messages,
      temperature: 0.1,
      maxTokens: 64,
    });

    const call = firstCall(h.calls);
    expect(call.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(new Headers(call.init.headers).get("authorization")).toBeNull();
    const body = parseBody(call);
    expect(body.model).toBe("llama-test");
    expect(body.stream).toBe(false);
    expect(body.options).toEqual({ temperature: 0.1, num_predict: 64 });
    expect(result).toMatchObject({
      text: "本地回答",
      model: "llama-test",
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    });
  });
});

describe("FakeModelProvider", () => {
  it("记录请求并按 responder 返回", async () => {
    const provider = new FakeModelProvider((req) => ({ text: `收到 ${req.model}`, model: req.model }));
    const result = await provider.complete({ model: "fake-1", messages });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages).toEqual(messages);
    expect(result.text).toBe("收到 fake-1");
    provider.reset();
    expect(provider.requests).toHaveLength(0);
  });
});
