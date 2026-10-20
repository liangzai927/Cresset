/**
 * WebMonitor 测试：页面变化、RSS 新条目、HTTP 失败。
 *
 * 使用本机临时 HTTP server，不访问外网 —— 测试必须可离线、可重复。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { VirtualClock } from "@aegis/clock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebMonitor } from "./web-monitor.js";

let server: Server;
let url: string;
let body = "";

beforeEach(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}/`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("WebMonitor", () => {
  it("页面内容真正变化后才产生 web.changed", async () => {
    body = "<html><title>标题</title><body>旧内容</body></html>";
    const monitor = new WebMonitor({ id: "web.test", url, clock: new VirtualClock(1_000) });

    expect((await monitor.scan()).facts).toEqual([]); // 基线
    expect((await monitor.scan()).facts).toEqual([]); // 未变化

    body = "<html><title>标题</title><body>新内容</body></html>";
    const result = await monitor.scan();
    expect(result.errors).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.kind).toBe("web.changed");
    expect(result.facts[0]?.fields.url).toBe(url);
    expect(result.facts[0]?.fields.title).toBe("标题");
  });

  it("RSS 只对新条目产生事实", async () => {
    body = `<?xml version="1.0"?><rss><channel>
      <item><guid>a</guid><title>第一条</title><link>https://example.com/a</link></item>
    </channel></rss>`;
    const monitor = new WebMonitor({ id: "rss.test", url, mode: "rss", clock: new VirtualClock(1_000) });
    expect((await monitor.scan()).facts).toEqual([]);
    expect((await monitor.scan()).facts).toEqual([]);

    body = `<?xml version="1.0"?><rss><channel>
      <item><guid>a</guid><title>第一条</title><link>https://example.com/a</link></item>
      <item><guid>b</guid><title>第二条</title><link>https://example.com/b</link></item>
    </channel></rss>`;
    const result = await monitor.scan();
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.fields).toMatchObject({ item_id: "b", title: "第二条" });
  });

  it("HTTP 失败进入 errors，不抛异常", async () => {
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const monitor = new WebMonitor({ id: "web.fail", url });
    const result = await monitor.scan();
    expect(result.facts).toEqual([]);
    expect(result.errors[0]?.message).toBe("HTTP 500");
  });
});
