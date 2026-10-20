/**
 * 网关实现（M0 骨架）：fail-closed 的唯一外发出口。
 */
import { createHash } from "node:crypto";
import type { DataClass } from "@aegis/contracts";
import type { ProviderErrorKind } from "@aegis/model-provider";
import { applyPlaceholders, builtinDetectors, runDetectors } from "./detectors.js";
import {
  type ClassificationPolicy,
  DEFAULT_GATEWAY_POLICY,
  DefaultClassificationPolicy,
  type Detector,
  type GatewayPolicy,
  OutboundBlockedError,
  type OutboundDecision,
  type OutboundRequest,
} from "./index.js";

const CLASS_ORDER: Record<DataClass, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

function classRank(c: DataClass): number {
  return CLASS_ORDER[c] ?? 99;
}

/** 网关可注入项（检测器、策略、分级器），便于测试不同策略组合 */
export interface GatewayOptions {
  detectors?: Detector[];
  policy?: GatewayPolicy;
  classification?: ClassificationPolicy;
  /** 注入时钟；测试可固定审计时间 */
  now?: () => number;
}

/**
 * 外发审计记录。
 *
 * ⚠️ 刻意**没有任何字段能承载原文** —— 只存哈希与检测器类别计数（NFR-SP5）。
 * 这是把"审计不落原文"从约定变成类型约束的手段。
 */
export interface OutboundAuditRecord {
  at: number;
  actor: string;
  purpose: string;
  destination: string;
  dataClass: string;
  detectorSummary: Array<{ category: string; count: number }>;
  redactionCount: number;
  policyVersion: string;
  payloadSha256: string;
  outcome: "allowed" | "blocked" | "failed";
  /** 失败类别；只允许 Provider 枚举，不含错误详情 */
  errorKind?: ProviderErrorKind;
}

/** 策略版本；写入审计，便于回溯当时的判定依据是哪一版规则 */
export const POLICY_VERSION = "m0-v1";

/**
 * 网关判定：这是所有外发路径的**唯一入口**。
 *
 * 行为保证：
 *   - 任何 L3（凭据/私钥/连接串）命中 → allowed=false，调用方必须处理失败；
 *   - 分级高于策略上限 → allowed=false（不降级放行）；
 *   - 审计记录只含哈希与命中类别计数，**不含原文**。
 */
export function evaluateOutbound(
  req: OutboundRequest,
  opts: GatewayOptions = {},
): { decision: OutboundDecision; audit: OutboundAuditRecord } {
  const detectors = opts.detectors ?? builtinDetectors();
  const policy = opts.policy ?? DEFAULT_GATEWAY_POLICY;
  const classification = opts.classification ?? new DefaultClassificationPolicy();

  const hits = runDetectors(detectors, req.payload);
  const base = classification.baseClass(req.source ?? "unknown");
  const dataClass = classification.escalate(base, hits);
  const { redacted, summary } = applyPlaceholders(req.payload, hits);
  const payloadSha256 = createHash("sha256").update(req.payload, "utf8").digest("hex");

  const detectorSummary = [...summary.entries()].map(([category, count]) => ({ category, count }));

  let reason: string | undefined;
  // L3 是硬边界：即使策略配置成 L3，也不允许外发（PRD FR-S13）
  if (dataClass === "L3") {
    reason = "载荷含 L3 机密（凭据/私钥/连接串）：永不允许外发";
  } else if (classRank(dataClass) > classRank(policy.maxOutboundClass)) {
    reason = `载荷分级 ${dataClass} 超过策略允许上限 ${policy.maxOutboundClass}`;
  }

  const allowed = reason === undefined;
  const decision: OutboundDecision = {
    allowed,
    dataClass,
    redactedPayload: redacted,
    detectorSummary,
    payloadSha256,
    ...(reason ? { reason } : {}),
  };

  const audit: OutboundAuditRecord = {
    at: opts.now?.() ?? Date.now(),
    actor: req.actor,
    purpose: req.purpose,
    destination: req.destination,
    dataClass,
    detectorSummary,
    redactionCount: hits.length,
    policyVersion: POLICY_VERSION,
    payloadSha256,
    outcome: allowed ? "allowed" : "blocked",
  };

  return { decision, audit };
}

/**
 * M1 的网关实现：**任何真实外发都硬失败**。
 *
 * 这不是占位符，而是刻意的安全默认值（D2 决策）：
 * 在 M3 补齐 Provider 之前，任何误接入的外发代码都会立刻失败，
 * 而不是静默把数据发到外部。
 */
export class FailClosedGateway {
  readonly #opts: GatewayOptions;
  constructor(opts: GatewayOptions = {}) {
    this.#opts = opts;
  }

  /** 只做判定，不外发 —— 供 UI 预览与测试使用 */
  evaluate(req: OutboundRequest): OutboundDecision {
    return evaluateOutbound(req, this.#opts).decision;
  }

  /** 真实外发：M1 一律抛错（fail-closed） */
  async complete(req: OutboundRequest): Promise<never> {
    const { decision } = evaluateOutbound(req, this.#opts);
    if (!decision.allowed) throw new OutboundBlockedError(decision);
    throw new Error(
      "模型外发尚未启用（M1 无外发路径）。完整脱敏网关将在 M3 之前实现；" +
        "在此之前不允许任何数据离开本机。",
    );
  }
}

export { applyPlaceholders, builtinDetectors, runDetectors } from "./detectors.js";
export * from "./index.js";
