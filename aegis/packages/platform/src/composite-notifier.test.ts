/**
 * CompositeNotifier 测试：并行扇出、任一成功、全失败分类。
 */

import { describe, expect, it } from "vitest";
import { CompositeNotifier } from "./composite-notifier.js";
import type { Notifier } from "./index.js";

/** 构造一个只返回固定结果的假渠道 */
function fake(
  channel: "webhook" | "os_notification",
  outcome: "success" | "transient_error" | "permanent_error",
): Notifier {
  return {
    channel,
    async probe() {
      return { ok: outcome === "success", detail: outcome };
    },
    async send() {
      return { outcome };
    },
  };
}

describe("CompositeNotifier", () => {
  it("两个渠道都会被调用，任一成功即成功", async () => {
    let calls = 0;
    const a: Notifier = {
      channel: "webhook",
      async probe() {
        return { ok: true, detail: "ok" };
      },
      async send() {
        calls += 1;
        return { outcome: "success" };
      },
    };
    const b: Notifier = {
      channel: "os_notification",
      async probe() {
        return { ok: true, detail: "ok" };
      },
      async send() {
        calls += 1;
        return { outcome: "transient_error" };
      },
    };
    const n = new CompositeNotifier([a, b]);
    expect(await n.send({ title: "t" })).toEqual({ outcome: "success" });
    expect(calls).toBe(2);
  });

  it("全部失败时按类别返回", async () => {
    const allPermanent = new CompositeNotifier([
      fake("webhook", "permanent_error"),
      fake("os_notification", "permanent_error"),
    ]);
    expect((await allPermanent.send({ title: "t" })).outcome).toBe("permanent_error");
  });
});
