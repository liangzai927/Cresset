/**
 * BarkNotifier 测试：本机 HTTP server，不访问 Bark。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BarkNotifier } from "./bark-notifier.js";

let server: Server;
let serverUrl: string;
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
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("BarkNotifier", () => {
  it("POST /push 并携带 device_key", async () => {
    const n = new BarkNotifier({ serverUrl, deviceKey: async () => "device-key" });
    expect(await n.send({ title: "提醒", body: "正文" })).toEqual({ outcome: "success" });
    expect(seen).toMatchObject({ device_key: "device-key", title: "提醒", body: "正文" });
  });

  it("未配置 Device Key → permanent，且错误不含 Key", async () => {
    const r = await new BarkNotifier({ serverUrl, deviceKey: async () => null }).send({ title: "t" });
    expect(r.outcome).toBe("permanent_error");
    expect(r.error).not.toContain("device-key");
  });

  it("5xx transient / 4xx permanent", async () => {
    status = 503;
    expect(
      (await new BarkNotifier({ serverUrl, deviceKey: async () => "k" }).send({ title: "t" })).outcome,
    ).toBe("transient_error");
    status = 400;
    expect(
      (await new BarkNotifier({ serverUrl, deviceKey: async () => "k" }).send({ title: "t" })).outcome,
    ).toBe("permanent_error");
  });
});
