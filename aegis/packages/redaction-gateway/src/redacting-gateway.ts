/**
 * M3 真实外发网关：判定 → 脱敏 → Provider → 本地还原 → 审计
 *
 * 安全边界（不可绕过）：
 *   1. 任何 L2/L3 按策略拒绝时，**不会调用 Provider**；
 *   2. Provider 只看到脱敏后的 payload；
 *   3. 占位符映射只留在本机内存，响应还原后即丢弃；
 *   4. 审计只写哈希/类别/错误类别，绝不写原文。
 */

import { type ModelProvider, ProviderError, type ProviderErrorKind } from "@aegis/model-provider";
import { applyPlaceholders, builtinDetectors, restorePlaceholders, runDetectors } from "./detectors.js";
import { evaluateOutbound, type GatewayOptions, type OutboundAuditRecord } from "./gateway.js";
import {
  type GatewayCompletionRequest,
  type GatewayResult,
  type ModelGateway,
  OutboundBlockedError,
  type OutboundDecision,
  type OutboundRequest,
} from "./index.js";

/** 真实网关配置 */
export interface RedactingGatewayOptions extends GatewayOptions {
  provider: ModelProvider;
  /** 审计回调；失败语义由调用方决定（建议写 DB，失败要可见） */
  audit?: (record: OutboundAuditRecord) => void;
}

/** M3 的网关实现 */
export class RedactingModelGateway implements ModelGateway {
  readonly #opts: RedactingGatewayOptions;

  constructor(opts: RedactingGatewayOptions) {
    this.#opts = opts;
  }

  /** 只做判定，不发网络请求；供设置页预览 */
  evaluate(req: OutboundRequest): OutboundDecision {
    return evaluateOutbound(req, this.#opts).decision;
  }

  /** 真实外发；Provider 只收到脱敏后的文本 */
  async complete(req: GatewayCompletionRequest): Promise<GatewayResult> {
    const { decision, audit } = evaluateOutbound(req, this.#opts);
    if (!decision.allowed) {
      this.#opts.audit?.(audit);
      throw new OutboundBlockedError(decision);
    }

    // 重新检测以拿到可逆映射；该映射只在本地内存中短暂存在。
    // 不复用 evaluateOutbound 的内部 hits，避免把原文暴露到公开 decision 上。
    const detectors = this.#opts.detectors ?? builtinDetectors();
    const hits = runDetectors(detectors, req.payload);
    const { mapping } = applyPlaceholders(req.payload, hits);

    try {
      const response = await this.#opts.provider.complete({
        model: req.model,
        messages: [{ role: "user", content: decision.redactedPayload }],
      });
      this.#opts.audit?.(audit);
      return {
        text: restorePlaceholders(response.text, mapping),
        decision,
        audit,
      };
    } catch (err) {
      const errorKind: ProviderErrorKind = err instanceof ProviderError ? err.kind : "network";
      this.#opts.audit?.({ ...audit, outcome: "failed", errorKind });
      throw err;
    }
  }
}
