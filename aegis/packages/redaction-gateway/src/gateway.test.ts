/**
 * 脱敏网关与检测器的测试。
 *
 * 对应验收用例 TC-M0-01（检测器召回率 100%，漏检即缺陷）、
 * TC-M0-02（fail-closed：不允许就抛错）、TC-M0-03（审计不落原文）。
 */
import { describe, expect, it } from "vitest";
import {
  applyPlaceholders,
  builtinDetectors,
  isValidIdCardChecksum,
  isValidLuhn,
  runDetectors,
} from "./detectors.js";
import { evaluateOutbound, FailClosedGateway } from "./gateway.js";
import { maxClass } from "./index.js";

/**
 * TC-M0-01 检测器样本集（构造样本，非真实数据）。
 * 门禁要求：**召回率 100%**，漏检一个即视为缺陷（NFR-SP1）。
 */
const SAMPLES: Array<{ category: string; text: string }> = [
  { category: "id_card", text: "我的身份证号是 110101199003074215 请记录" },
  { category: "id_card", text: "证件 320502198802031230 已上传" },
  { category: "phone", text: "联系我 13812345678" },
  { category: "phone", text: "备用号码 19900001111" },
  { category: "email", text: "发到 zhangsan.wang@example.com 即可" },
  { category: "bank_card", text: "卡号 6222021234567890128 转账" },
  { category: "ip_address", text: "服务器 192.168.31.77 上的服务挂了" },
  { category: "api_key", text: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345" },
  { category: "api_key", text: "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
  { category: "api_key", text: "aws AKIAIOSFODNN7EXAMPLE 已泄露" },
  {
    category: "private_key",
    text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
  },
  { category: "connection_string", text: "postgres://user:pw@db.internal:5432/app" },
];

describe("TC-M0-01 检测器召回率（漏检即缺陷）", () => {
  const detectors = builtinDetectors();

  it("全部构造样本都被检出（召回 100%）", () => {
    const missed: string[] = [];
    for (const s of SAMPLES) {
      const hits = runDetectors(detectors, s.text);
      if (!hits.some((h) => h.category === s.category)) missed.push(`${s.category}: ${s.text.slice(0, 30)}`);
    }
    expect(missed).toEqual([]);
  });

  it("校验位函数可用于误报统计（不作为过滤条件）", () => {
    expect(isValidIdCardChecksum("110101199003074215")).toBe(true);
    expect(isValidIdCardChecksum("110101199003074219")).toBe(false);
    expect(isValidLuhn("6222021234567890128")).toBe(true);
    expect(isValidLuhn("6222021234567890120")).toBe(false);
  });

  it("同一取值映射到同一占位符，不同取值编号递增", () => {
    const text = "a@x.com 和 a@x.com 以及 b@x.com";
    const hits = runDetectors(detectors, text);
    const { redacted, summary } = applyPlaceholders(text, hits);
    expect(redacted).toContain("[EMAIL_1]");
    expect(redacted).toContain("[EMAIL_2]");
    expect(redacted.match(/\[EMAIL_1\]/g)).toHaveLength(2);
    expect(summary.get("email")).toBe(2);
  });

  it("占位符不泄漏原文", () => {
    const text = "手机 13812345678";
    const hits = runDetectors(detectors, text);
    const { redacted } = applyPlaceholders(text, hits);
    expect(redacted).not.toContain("13812345678");
    expect(redacted).toContain("[PHONE_1]");
  });
});

describe("TC-M0-02 fail-closed 语义", () => {
  const gw = new FailClosedGateway();

  it("L3 载荷被拒绝，且原因是机密级别", () => {
    const { decision } = evaluateOutbound({
      actor: "daemon",
      purpose: "test",
      destination: "openai/gpt-x",
      payload: "key=sk-abcdefghijklmnopqrstuvwxyz012345",
      source: "public-web",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.dataClass).toBe("L3");
    expect(decision.reason).toContain("L3");
  });

  it("未配置 Provider 时 complete() 抛错（绝不静默返回空）", async () => {
    await expect(
      gw.complete({
        actor: "daemon",
        purpose: "test",
        destination: "none",
        payload: "hello world",
        source: "public-web",
      }),
    ).rejects.toThrow(/尚未启用|不允许/);
  });

  it("未知来源默认按 L2 处理（保守默认），因此默认不放行", () => {
    const { decision } = evaluateOutbound({
      actor: "daemon",
      purpose: "test",
      destination: "openai/gpt-x",
      payload: "普通的内部会议纪要内容",
    });
    expect(decision.dataClass).toBe("L2");
    expect(decision.allowed).toBe(false);
  });

  it("公开来源且无敏感命中时放行（L0/L1 可外发）", () => {
    const { decision } = evaluateOutbound({
      actor: "daemon",
      purpose: "test",
      destination: "openai/gpt-x",
      payload: "This is public documentation text.",
      source: "public-web",
    });
    expect(decision.dataClass).toBe("L0");
    expect(decision.allowed).toBe(true);
  });
});

describe("TC-M0-03 审计不落原文", () => {
  it("审计记录只含哈希与类别计数，不含原文片段", () => {
    const secret = "13812345678";
    const { audit } = evaluateOutbound({
      actor: "daemon",
      purpose: "test",
      destination: "openai/gpt-x",
      payload: `联系号码 ${secret}`,
      source: "team-doc",
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(secret);
    expect(serialized).toMatch(/^[0-9a-f]{64}$/m.test(audit.payloadSha256) ? /./ : /^$/);
    expect(audit.detectorSummary).toContainEqual({ category: "phone", count: 1 });
    expect(audit.payloadSha256).toHaveLength(64);
  });
});

describe("分级工具", () => {
  it("maxClass 只升不降", () => {
    expect(maxClass("L1", "L2")).toBe("L2");
    expect(maxClass("L3", "L0")).toBe("L3");
    expect(maxClass("L0", "L1")).toBe("L1");
  });
});
