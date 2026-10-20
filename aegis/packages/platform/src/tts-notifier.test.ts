/**
 * TtsNotifier 测试：注入执行器，不真的发声。
 */

import { describe, expect, it } from "vitest";
import { TtsNotifier } from "./tts-notifier.js";

describe("TtsNotifier", () => {
  it("拼接标题/正文并调用 say", async () => {
    let seen = "";
    const n = new TtsNotifier({
      voice: "Tingting",
      exec: async (text) => {
        seen = text;
        return { code: 0, timedOut: false, stderr: "" };
      },
    });
    expect(await n.send({ title: "提醒", body: "喝水" })).toEqual({ outcome: "success" });
    expect(seen).toBe("提醒。喝水");
  });

  it("超时 → timeout，非零 → permanent", async () => {
    const timeout = new TtsNotifier({
      exec: async () => ({ code: null, timedOut: true, stderr: "" }),
    });
    expect((await timeout.send({ title: "t" })).outcome).toBe("timeout");

    const failed = new TtsNotifier({
      exec: async () => ({ code: 1, timedOut: false, stderr: "voice not found" }),
    });
    expect((await failed.send({ title: "t" })).outcome).toBe("permanent_error");
  });

  it("空内容不调用 say", async () => {
    let called = false;
    const n = new TtsNotifier({
      exec: async () => {
        called = true;
        return { code: 0, timedOut: false, stderr: "" };
      },
    });
    expect((await n.send({ title: "", body: "" })).outcome).toBe("permanent_error");
    expect(called).toBe(false);
  });
});
