/**
 * RoutingNotifier 测试：按优先级选组，未配置回退 normal。
 */

import { describe, expect, it } from "vitest";
import type { Notifier } from "./index.js";
import { RoutingNotifier } from "./routing-notifier.js";

function fake(channel: "os_notification" | "webhook", outcome: "success" | "permanent_error"): Notifier {
  return {
    channel,
    async probe() {
      return { ok: outcome === "success", detail: "x" };
    },
    async send() {
      return { outcome };
    },
  };
}

describe("RoutingNotifier", () => {
  it("high 使用 high 组，normal 使用 normal 组", async () => {
    let highCalls = 0;
    let normalCalls = 0;
    const high: Notifier = {
      channel: "webhook",
      async probe() {
        return { ok: true, detail: "x" };
      },
      async send() {
        highCalls += 1;
        return { outcome: "success" };
      },
    };
    const normal: Notifier = {
      channel: "os_notification",
      async probe() {
        return { ok: true, detail: "x" };
      },
      async send() {
        normalCalls += 1;
        return { outcome: "success" };
      },
    };
    const n = new RoutingNotifier({ routes: { high: [high], normal: [normal] } });
    expect((await n.send({ title: "t", priority: "high" })).outcome).toBe("success");
    expect(highCalls).toBe(1);
    expect(normalCalls).toBe(0);
  });

  it("未配置的优先级回退到 normal；全空返回 permanent", async () => {
    const n = new RoutingNotifier({ routes: { normal: [fake("os_notification", "success")] } });
    expect((await n.send({ title: "t", priority: "low" })).outcome).toBe("success");
    const empty = new RoutingNotifier({ routes: {} });
    expect((await empty.send({ title: "t" })).outcome).toBe("permanent_error");
  });
});
