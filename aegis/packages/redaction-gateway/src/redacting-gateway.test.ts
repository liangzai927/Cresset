/**
 * M3 真实网关测试：脱敏后外发、响应还原、拒答、审计。
 *
 * 使用假 Provider，不发起任何外部网络请求。
 */

import type { ModelProvider } from "@aegis/model-provider";
import { ProviderError } from "@aegis/model-provider";
import { describe, expect, it } from "vitest";
import { restorePlaceholders } from "./detectors.js";
import type { OutboundAuditRecord } from "./gateway.js";
import { RedactingModelGateway } from "./redacting-gateway.js";

/** 记录请求的假 Provider；返回内容里故意保留占位符 */
function fakeProvider(seen: Array<{ messages: Array<{ content: string }> }>): ModelProvider {
  return {
    id: "fake",
    async complete(req) {
      seen.push({ messages: req.messages });
      return { text: `收到 ${req.messages[0]?.content ?? ""}`, model: req.model };
    },
  };
}

describe("RedactingModelGateway", () => {
  it("Provider 只看到脱敏文本，响应在本机还原", async () => {
    const seen: Array<{ messages: Array<{ content: string }> }> = [];
    const audits: OutboundAuditRecord[] = [];
    const gw = new RedactingModelGateway({
      provider: fakeProvider(seen),
      audit: (a) => audits.push(a),
      now: () => 1_000,
    });

    const result = await gw.complete({
      actor: "daemon",
      purpose: "test",
      destination: "fake/m",
      payload: "请联系 alice@example.com",
      source: "team-doc",
      model: "m",
    });

    expect(seen[0]?.messages[0]?.content).toContain("[EMAIL_1]");
    expect(seen[0]?.messages[0]?.content).not.toContain("alice@example.com");
    expect(result.text).toContain("alice@example.com");
    expect(result.audit.at).toBe(1_000);
    expect(JSON.stringify(audits)).not.toContain("alice@example.com");
    expect(audits[0]?.outcome).toBe("allowed");
  });

  it("L3 载荷不调用 Provider，审计为 blocked", async () => {
    const seen: Array<{ messages: Array<{ content: string }> }> = [];
    const audits: OutboundAuditRecord[] = [];
    const gw = new RedactingModelGateway({
      provider: fakeProvider(seen),
      audit: (a) => audits.push(a),
    });

    await expect(
      gw.complete({
        actor: "daemon",
        purpose: "test",
        destination: "fake/m",
        payload: "key=sk-abcdefghijklmnopqrstuvwxyz012345",
        source: "team-doc",
        model: "m",
      }),
    ).rejects.toThrow(/L3|机密|拒绝/);
    expect(seen).toHaveLength(0);
    expect(audits[0]?.outcome).toBe("blocked");
    expect(JSON.stringify(audits)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });

  it("Provider 失败时审计 failed，错误保持 ProviderError", async () => {
    const audits: OutboundAuditRecord[] = [];
    const failing: ModelProvider = {
      id: "fake",
      async complete() {
        throw new ProviderError("fake", "auth", "HTTP 401");
      },
    };
    const gw = new RedactingModelGateway({ provider: failing, audit: (a) => audits.push(a) });
    await expect(
      gw.complete({
        actor: "daemon",
        purpose: "test",
        destination: "fake/m",
        payload: "public",
        source: "public-web",
        model: "m",
      }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(audits[0]).toMatchObject({ outcome: "failed", errorKind: "auth" });
  });

  it("restorePlaceholders 只替换占位符", () => {
    const mapping = new Map([["[EMAIL_1]", "a@x.com"]]);
    expect(restorePlaceholders("发给 [EMAIL_1]", mapping)).toBe("发给 a@x.com");
    expect(restorePlaceholders("没有占位符", mapping)).toBe("没有占位符");
  });
});
