/**
 * WebhookNotifier 测试：本机 HTTP server，不访问外网。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookNotifier } from "./webhook-notifier.js";

let server: Server;
let url: string;
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
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("WebhookNotifier", () => {
  it("POST JSON；2xx 视为成功", async () => {
    const n = new WebhookNotifier({ url });
    const r = await n.send({ title: "提醒", body: "正文", tag: "t1" });
    expect(r.outcome).toBe("success");
    expect(seen).toMatchObject({ title: "提醒", body: "正文", tag: "t1" });
  });

  it("5xx → transient，4xx → permanent", async () => {
    status = 503;
    expect((await new WebhookNotifier({ url }).send({ title: "t" })).outcome).toBe("transient_error");
    status = 400;
    expect((await new WebhookNotifier({ url }).send({ title: "t" })).outcome).toBe("permanent_error");
  });

  it("probe 只检查 URL，不发请求", async () => {
    const n = new WebhookNotifier({ url });
    expect(await n.probe()).toMatchObject({ ok: true });
    expect(seen).toBeNull();
    expect(await new WebhookNotifier({ url: "ftp://x" }).probe()).toMatchObject({ ok: false });
  });
});
