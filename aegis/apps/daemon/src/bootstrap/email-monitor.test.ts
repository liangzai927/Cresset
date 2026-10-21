/**
 * 邮件规则测试：只测筛选，不连 IMAP。
 */

import { describe, expect, it } from "vitest";
import { isEmailWithinDays, isImportantEmail } from "./email-monitor.js";

describe("isImportantEmail", () => {
  it("发件人命中即重要", () => {
    expect(
      isImportantEmail(
        { uid: 1, from: "boss@example.com", subject: "午饭吃什么" },
        { senders: ["boss@"], keywords: [] },
      ),
    ).toBe(true);
  });

  it("主题关键词命中即重要", () => {
    expect(
      isImportantEmail(
        { uid: 2, from: "news@example.com", subject: "合同待确认" },
        { senders: [], keywords: ["合同"] },
      ),
    ).toBe(true);
  });

  it("只处理最近 N 天的邮件，历史未读被跳过", () => {
    const now = Date.UTC(2026, 9, 21);
    expect(isEmailWithinDays(new Date(now - 60_000), now, 3)).toBe(true);
    expect(isEmailWithinDays(new Date(now - 4 * 86_400_000), now, 3)).toBe(false);
    expect(isEmailWithinDays(undefined, now, 3)).toBe(false);
  });

  it("没有规则时不把邮件判为重要", () => {
    expect(
      isImportantEmail({ uid: 3, from: "x@example.com", subject: "hello" }, { senders: [], keywords: [] }),
    ).toBe(false);
  });
});
