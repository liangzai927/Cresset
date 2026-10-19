/**
 * 会话级占位符测试
 *
 * 重点：同一值跨调用稳定、响应可还原、重叠命中不留下残片。
 * 所有断言都不把原文写进失败消息之外的输出。
 */

import { describe, expect, it } from "vitest";
import { builtinDetectors, runDetectors } from "./detectors.js";
import { PlaceholderSession } from "./placeholders.js";

describe("PlaceholderSession", () => {
  it("同一取值跨调用映射到同一占位符", () => {
    const session = new PlaceholderSession();
    const first = session.redact("电话 13812345678", runDetectors(builtinDetectors(), "电话 13812345678"));
    const second = session.redact("再打 13812345678", runDetectors(builtinDetectors(), "再打 13812345678"));

    expect(first.text).toBe("电话 [PHONE_1]");
    expect(second.text).toBe("再打 [PHONE_1]");
    expect(first.redactionCount).toBe(1);
    expect(second.redactionCount).toBe(1);
    expect(session.size).toBe(1);
  });

  it("restore 只还原已知占位符，模型编造的占位符保留", () => {
    const session = new PlaceholderSession();
    session.redact("alice@example.com", runDetectors(builtinDetectors(), "alice@example.com"));

    expect(session.restore("联系 [EMAIL_1]，不是 [EMAIL_9]")).toBe("联系 alice@example.com，不是 [EMAIL_9]");
  });

  it("★ 身份证与银行卡重叠命中时合并为一个片段，不留下半截数字", () => {
    const session = new PlaceholderSession();
    const text = "110101199003071234";
    const hits = runDetectors(builtinDetectors(), text);

    const outcome = session.redact(text, hits);
    expect(outcome.text).toBe("[ID_CARD_1]");
    expect(outcome.redactionCount).toBe(1);
    expect(outcome.text).not.toMatch(/\d{4,}/);
    expect(session.restore(outcome.text)).toBe(text);
  });

  it("没有命中时原样返回且不分配占位符", () => {
    const session = new PlaceholderSession();
    const outcome = session.redact("public text", []);
    expect(outcome.text).toBe("public text");
    expect(outcome.redactionCount).toBe(0);
    expect(outcome.summary.size).toBe(0);
    expect(session.size).toBe(0);
  });
});
