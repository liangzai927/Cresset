/**
 * OpenAI 兼容 Provider 测试：本机临时 HTTP server，不访问外网。
 *
 * 覆盖成功响应、鉴权失败、非法响应；错误信息不得包含响应体。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "./errors.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

let server: Server;
let baseUrl: string;
let reply: (body: unknown) => { status: number; body: string };

beforeEach(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* 测试 server 不关心坏请求体 */
      }
      const r = reply(parsed);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("OpenAICompatibleProvider", () => {
  it("发送 chat/completions 并解析文本与 usage", async () => {
    const seen: Record<string, unknown> | null = null;
    reply = () => ({
      status: 200,
      body: JSON.stringify({
        model: "test-model",
        choices: [{ message: { content: "你好" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    });
    const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: "sk-test", model: "test-model" });
    const result = await provider.complete({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toMatchObject({
      text: "你好",
      model: "test-model",
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });
  });

  it("HTTP 401 → auth 错误，且不包含响应体", async () => {
    reply = () => ({ status: 401, body: JSON.stringify({ error: "secret-ish detail" }) });
    const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: "bad", model: "m" });
    try {
      await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }] });
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe("auth");
      expect((err as Error).message).not.toContain("secret-ish");
    }
  });

  it("非法 JSON → invalid_response", async () => {
    reply = () => ({ status: 200, body: "not-json" });
    const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: "k", model: "m" });
    await expect(
      provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });
});
