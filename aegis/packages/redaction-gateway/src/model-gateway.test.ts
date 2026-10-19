/**
 * 真实模型网关测试
 *
 * 验证的是安全链路，而不是"函数能跑"：
 *   - Provider 只能看到占位符，不能看到原文；
 *   - 模型输出里的已知占位符会被还原；
 *   - L2 默认拒绝，L3 即使策略误配也必须拒绝；
 *   - 审计在真正外发之前写入，审计失败则不发送；
 *   - Provider 失败会留下 failed 审计，错误消息不含原文。
 *
 * 全部使用 FakeModelProvider，不联网、不需要 API Key。
 */

import { FakeModelProvider, ProviderError } from "@aegis/model-provider";
import { describe, expect, it } from "vitest";
import type { OutboundAuditRecord } from "./gateway.js";
import { type Detector, type GatewayPolicy, OutboundBlockedError } from "./index.js";
import { GatewayRequestError, ModelGateway, ModelGatewayError } from "./model-gateway.js";

/** 构造一个只带必填项的网关，并把审计收集到外部数组 */
function createGateway(
  provider: FakeModelProvider,
  opts: { policy?: GatewayPolicy; onAudit?: (r: OutboundAuditRecord) => void } = {},
) {
  return new ModelGateway({
    provider,
    model: "test-model",
    now: () => 1_000,
    ...(opts.policy ? { policy: opts.policy } : {}),
    onAudit:
      opts.onAudit ??
      (() => {
        /* 大多数用例只关心返回值；审计链路由专门的用例断言 */
      }),
  });
}

const EMAIL = "alice@example.com";
const PHONE = "13812345678";

describe("脱敏与还原", () => {
  it("Provider 只看到占位符，返回文本会被还原，审计不含原文", async () => {
    const audits: OutboundAuditRecord[] = [];
    const provider = new FakeModelProvider((req) => {
      // 审计必须在真正外发之前写入
      expect(audits).toHaveLength(1);
      expect(req.messages[0]?.content).toBe("联系 [EMAIL_1]");
      return { text: `已记录：${req.messages[0]?.content ?? ""}`, model: req.model };
    });
    const gw = createGateway(provider, { onAudit: (r) => audits.push(r) });

    const result = await gw.complete({
      actor: "unit",
      purpose: "test",
      source: "team-doc",
      messages: [{ role: "user", content: `联系 ${EMAIL}` }],
    });

    expect(result.text).toBe("已记录：联系 alice@example.com");
    expect(result.redaction).toMatchObject({ dataClass: "L1", redactionCount: 1 });
    expect(result.redaction.detectorSummary).toEqual([{ category: "email", count: 1 }]);
    expect(result.audit.outcome).toBe("allowed");
    expect(result.audit.payloadSha256).toHaveLength(64);
    expect(JSON.stringify(audits)).not.toContain(EMAIL);
  });

  it("模型编造的未知占位符不会被还原", async () => {
    const provider = new FakeModelProvider((req) => ({
      text: `${req.messages[0]?.content ?? ""} 以及 [EMAIL_9]`,
      model: req.model,
    }));
    const gw = createGateway(provider);

    const result = await gw.complete({
      actor: "unit",
      purpose: "test",
      source: "team-doc",
      messages: [{ role: "user", content: `联系 ${EMAIL}` }],
    });

    expect(result.text).toBe("联系 alice@example.com 以及 [EMAIL_9]");
  });
});

describe("分级与策略", () => {
  it("L2 在默认策略（上限 L1）下被拒绝，Provider 不会被调用", async () => {
    const audits: OutboundAuditRecord[] = [];
    const provider = new FakeModelProvider();
    const gw = createGateway(provider, { onAudit: (r) => audits.push(r) });

    await expect(
      gw.complete({
        actor: "unit",
        purpose: "test",
        source: "team-doc",
        messages: [{ role: "user", content: `电话 ${PHONE}` }],
      }),
    ).rejects.toBeInstanceOf(OutboundBlockedError);

    expect(provider.requests).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("blocked");
    expect(JSON.stringify(audits)).not.toContain(PHONE);
  });

  it("★ 即使策略误配为 L3，凭据仍然被拒绝（L3 永久阻断）", async () => {
    const provider = new FakeModelProvider();
    const gw = createGateway(provider, { policy: { maxOutboundClass: "L3" } });
    const secret = `sk-${"a".repeat(32)}`;

    const error = await gw
      .complete({
        actor: "unit",
        purpose: "test",
        source: "public-web",
        messages: [{ role: "user", content: `key=${secret}` }],
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OutboundBlockedError);
    if (error instanceof OutboundBlockedError) {
      expect(error.decision.dataClass).toBe("L3");
      expect(error.decision.reason).toContain("L3");
    }
    expect(provider.requests).toHaveLength(0);
  });

  it("★ 自定义检测器的 escalatesTo 生效，不依赖内置类别映射表", async () => {
    const detector: Detector = {
      id: "custom",
      category: "custom_secret",
      escalatesTo: "L3",
      detect(text: string) {
        const start = text.indexOf("TOP-SECRET");
        return start >= 0
          ? [{ category: "custom_secret", escalatesTo: "L3", start, end: start + 10, matched: "TOP-SECRET" }]
          : [];
      },
    };
    const provider = new FakeModelProvider();
    const gw = new ModelGateway({
      provider,
      model: "test-model",
      now: () => 1_000,
      detectors: [detector],
      policy: { maxOutboundClass: "L3" },
      onAudit: () => {
        /* 本用例只验证分级，不关心审计落点 */
      },
    });

    await expect(
      gw.complete({
        actor: "unit",
        purpose: "test",
        source: "public-web",
        messages: [{ role: "user", content: "这里包含 TOP-SECRET" }],
      }),
    ).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(provider.requests).toHaveLength(0);
  });

  it("显式允许 L2 后，同一值在两条消息里复用同一占位符，并可还原", async () => {
    const provider = new FakeModelProvider((req) => ({
      text: req.messages.map((m) => m.content).join(" | "),
      model: req.model,
    }));
    const gw = createGateway(provider, { policy: { maxOutboundClass: "L2" } });

    const result = await gw.complete({
      actor: "unit",
      purpose: "test",
      source: "team-doc",
      messages: [
        { role: "user", content: `电话 ${PHONE}` },
        { role: "assistant", content: `再确认 ${PHONE}` },
      ],
    });

    expect(provider.requests[0]?.messages.map((m) => m.content)).toEqual([
      "电话 [PHONE_1]",
      "再确认 [PHONE_1]",
    ]);
    expect(result.text).toBe(`电话 ${PHONE} | 再确认 ${PHONE}`);
    expect(result.audit.dataClass).toBe("L2");
  });
});

describe("失败可见性", () => {
  it("Provider 失败时写 failed 审计，错误消息不含原文", async () => {
    const audits: OutboundAuditRecord[] = [];
    const provider = new FakeModelProvider(() => {
      throw new ProviderError("fake", "rate_limit", "限流", { status: 429 });
    });
    const gw = createGateway(provider, {
      policy: { maxOutboundClass: "L2" },
      onAudit: (r) => audits.push(r),
    });

    const error = await gw
      .complete({
        actor: "unit",
        purpose: "test",
        source: "team-doc",
        messages: [{ role: "user", content: `电话 ${PHONE}` }],
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ModelGatewayError);
    if (error instanceof ModelGatewayError) {
      expect(error.audit.outcome).toBe("failed");
      expect(error.message).toContain("rate_limit");
      expect(error.message).not.toContain(PHONE);
    }
    expect(audits.map((a) => a.outcome)).toEqual(["allowed", "failed"]);
  });

  it("审计写入失败时拒绝外发（fail-closed）", async () => {
    const provider = new FakeModelProvider();
    const gw = createGateway(provider, {
      onAudit: () => {
        throw new Error("audit down");
      },
    });

    await expect(
      gw.complete({
        actor: "unit",
        purpose: "test",
        source: "team-doc",
        messages: [{ role: "user", content: `联系 ${EMAIL}` }],
      }),
    ).rejects.toThrow("audit down");
    expect(provider.requests).toHaveLength(0);
  });

  it("空消息在发送前拒绝，不产生审计", async () => {
    const audits: OutboundAuditRecord[] = [];
    const provider = new FakeModelProvider();
    const gw = createGateway(provider, { onAudit: (r) => audits.push(r) });

    await expect(gw.complete({ actor: "unit", purpose: "test", messages: [] })).rejects.toBeInstanceOf(
      GatewayRequestError,
    );
    expect(provider.requests).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});
