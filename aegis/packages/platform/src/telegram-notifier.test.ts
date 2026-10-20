/**
 * TelegramNotifier 测试：本机 HTTP server，不访问 Telegram。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TelegramNotifier } from "./telegram-notifier.js";

let server: Server;
let apiBase: string;
let status = 200;
let seen: unknown = null;

beforeEach(async () => {
  status = 200;
  seen = null;
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen = JSON.parse(raw);
      res.writeHead(status);
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("TelegramNotifier", () => {
  it("从 token provider 取 token 并发送消息", async () => {
    const n = new TelegramNotifier({ chatId: "42", token: async () => "secret-token", apiBase });
    expect(await n.send({ title: "标题", body: "正文" })).toEqual({ outcome: "success" });
    expect(seen).toMatchObject({ chat_id: "42", text: "标题\n正文" });
  });

  it("未配置 token → permanent；错误不包含 token", async () => {
    const n = new TelegramNotifier({ chatId: "42", token: async () => null, apiBase });
    const r = await n.send({ title: "t" });
    expect(r.outcome).toBe("permanent_error");
    expect(r.error).not.toContain("secret");
  });

  it("429 → transient，400 → permanent", async () => {
    status = 429;
    expect(
      (await new TelegramNotifier({ chatId: "42", token: async () => "t", apiBase }).send({ title: "t" }))
        .outcome,
    ).toBe("transient_error");
    status = 400;
    expect(
      (await new TelegramNotifier({ chatId: "42", token: async () => "t", apiBase }).send({ title: "t" }))
        .outcome,
    ).toBe("permanent_error");
  });
});
