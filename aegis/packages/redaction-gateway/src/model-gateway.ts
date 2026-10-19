/**
 * 真实模型网关：分级 → 脱敏 → 审计 → 调用 Provider → 还原
 *
 * ## 顺序不可调换
 *
 * ```
 * 1. 对每条消息做敏感项检测（本地）
 * 2. 分级（来源标签 + 检测命中；未知来源按 L2）
 * 3. 会话级占位替换（同一值跨消息/跨调用保持同一编号）
 * 4. 策略裁决：L3 永远拒绝；超过 maxOutboundClass 拒绝
 * 5. 写审计（外发前；失败则不发送）
 * 6. 调用 Provider（只能拿到脱敏后的消息）
 * 7. 把响应里的已知占位符还原
 * ```
 *
 * ## 失败语义
 *
 * - 策略拒绝：抛 `OutboundBlockedError`（带判定结果，便于界面解释）；
 * - Provider 失败：抛 `ModelGatewayError`（带一条 `failed` 审计），**不重试**；
 *   重试策略由上层决定，避免网关内部隐式放大成本。
 * - 审计写入失败：在发送前抛出，**不发送**（fail-closed）。
 *
 * ## 暂不实现
 *
 * token 预算与成本熔断属于 M4 的 `budget`/`cost_record`；本模块只返回 usage，
 * 不在这里做金额判断。
 */

import { createHash } from "node:crypto";
import type { DataClass } from "@aegis/contracts";
import {
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type CompletionUsage,
  type ModelProvider,
  ProviderError,
} from "@aegis/model-provider";
import { builtinDetectors, runDetectors } from "./detectors.js";
import { type GatewayOptions, type OutboundAuditRecord, POLICY_VERSION } from "./gateway.js";
import {
  DEFAULT_GATEWAY_POLICY,
  DefaultClassificationPolicy,
  type DetectorHit,
  exceedsOutboundPolicy,
  type GatewayPolicy,
  OutboundBlockedError,
  type OutboundDecision,
} from "./index.js";
import { PlaceholderSession } from "./placeholders.js";

/** 一次模型调用的输入；messages 会整体经过脱敏 */
export interface ModelGatewayRequest {
  /** 发起方：daemon / user / 未来的 employee id */
  actor: string;
  /** 用途说明，写入审计（如 "daily-digest"） */
  purpose: string;
  /**
   * 数据来源标签；不传视为未知 → L2（默认会被策略拒绝）。
   *
   * ⚠️ 调用方必须如实标注：网关无法验证来源，把 L2 错标成 public-web 会直接绕过分级。
   */
  source?: string;
  /** 目标描述；默认 `${provider.id}/${model}` */
  destination?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** 网关对外返回的结果；`audit` 已包含脱敏摘要与哈希 */
export interface ModelGatewayResult {
  /** 已经还原占位符的模型输出；**可能包含 L2 原文，调用方不得写入日志/审计** */
  text: string;
  model: string;
  providerId: string;
  usage?: CompletionUsage;
  finishReason?: string;
  audit: OutboundAuditRecord;
  /** 本次调用的脱敏摘要（不含原文） */
  redaction: {
    dataClass: DataClass;
    detectorSummary: Array<{ category: string; count: number }>;
    redactionCount: number;
  };
}

/** 网关构造参数 */
export interface ModelGatewayOptions extends GatewayOptions {
  /** 实际调用哪个 Provider；它只能拿到脱敏后的消息 */
  provider: ModelProvider;
  /** 本次调用使用的模型名 */
  model: string;
  /** 会话级占位符映射；不传则新建一个 */
  session?: PlaceholderSession;
  /** 时间来源；审计时间必须可测试（禁止裸 Date.now） */
  now: () => number;
  /**
   * 审计落点（必填）。**在真正外发之前调用**：抛错则本次调用不会发出。
   * Provider 失败时会再收到一条 outcome="failed" 的记录。
   * 做成必填是为了从类型上杜绝"忘了接线导致外发无审计"（NFR-SP5）。
   */
  onAudit: (record: OutboundAuditRecord) => void;
}

/** 输入本身不合法（空消息、非法 role 等）；发生在任何外发之前 */
export class GatewayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

/** Provider 调用失败；携带失败审计，便于上层落库与展示 */
export class ModelGatewayError extends Error {
  readonly providerId: string;
  readonly audit: OutboundAuditRecord;

  constructor(message: string, audit: OutboundAuditRecord, providerId: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ModelGatewayError";
    this.providerId = providerId;
    this.audit = audit;
  }
}

/** 真实外发网关；一个实例持有一个会话级占位符映射 */
export class ModelGateway {
  readonly #opts: ModelGatewayOptions;
  readonly #session: PlaceholderSession;

  constructor(opts: ModelGatewayOptions) {
    this.#opts = opts;
    this.#session = opts.session ?? new PlaceholderSession();
  }

  /**
   * 执行一次脱敏后的模型补全。
   *
   * @throws {@link OutboundBlockedError} 数据分级超过策略（含任何 L3）
   * @throws {@link GatewayRequestError} 消息为空或 role 非法
   * @throws {@link ModelGatewayError} Provider 调用失败（附失败审计）
   */
  async complete(req: ModelGatewayRequest): Promise<ModelGatewayResult> {
    this.#assertRequest(req);

    const policy: GatewayPolicy = this.#opts.policy ?? DEFAULT_GATEWAY_POLICY;
    const detectors = this.#opts.detectors ?? builtinDetectors();
    const classification = this.#opts.classification ?? new DefaultClassificationPolicy();

    const redactedMessages: ChatMessage[] = [];
    const allHits: DetectorHit[] = [];
    const summary = new Map<string, number>();
    let redactionCount = 0;

    for (const message of req.messages) {
      const hits = runDetectors(detectors, message.content);
      allHits.push(...hits);

      const outcome = this.#session.redact(message.content, hits);
      redactionCount += outcome.redactionCount;
      for (const [category, count] of outcome.summary) {
        summary.set(category, (summary.get(category) ?? 0) + count);
      }
      redactedMessages.push({ role: message.role, content: outcome.text });
    }

    const base = classification.baseClass(req.source ?? "unknown");
    const dataClass = classification.escalate(base, allHits);
    const detectorSummary = [...summary.entries()].map(([category, count]) => ({ category, count }));
    const payloadSha256 = hashMessages(req.messages);
    const destination = req.destination ?? `${this.#opts.provider.id}/${this.#opts.model}`;

    const blockedReason = exceedsOutboundPolicy(dataClass, policy.maxOutboundClass)
      ? dataClass === "L3"
        ? "载荷含 L3 机密（凭据/私钥/连接串）：永不允许外发"
        : `载荷分级 ${dataClass} 超过策略允许上限 ${policy.maxOutboundClass}`
      : undefined;

    const decision: OutboundDecision = {
      allowed: blockedReason === undefined,
      dataClass,
      redactedPayload: redactedMessages.map((m) => m.content).join("\n"),
      detectorSummary,
      payloadSha256,
      ...(blockedReason ? { reason: blockedReason } : {}),
    };

    const audit: OutboundAuditRecord = {
      at: this.#opts.now(),
      actor: req.actor,
      purpose: req.purpose,
      destination,
      dataClass,
      detectorSummary,
      redactionCount,
      policyVersion: POLICY_VERSION,
      payloadSha256,
      outcome: decision.allowed ? "allowed" : "blocked",
    };

    this.#emitAudit(audit);
    if (!decision.allowed) throw new OutboundBlockedError(decision);

    const providerRequest: CompletionRequest = {
      model: this.#opts.model,
      messages: redactedMessages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    };

    let response: CompletionResponse;
    try {
      response = await this.#opts.provider.complete(providerRequest);
    } catch (err) {
      const failedAudit: OutboundAuditRecord = { ...audit, at: this.#opts.now(), outcome: "failed" };
      this.#emitAudit(failedAudit);
      throw new ModelGatewayError(
        `模型调用失败（${this.#opts.provider.id}）：${safeErrorMessage(err)}`,
        failedAudit,
        this.#opts.provider.id,
        err,
      );
    }

    return {
      text: this.#session.restore(response.text),
      model: response.model,
      providerId: this.#opts.provider.id,
      ...(response.usage ? { usage: response.usage } : {}),
      ...(response.finishReason ? { finishReason: response.finishReason } : {}),
      audit,
      redaction: { dataClass, detectorSummary, redactionCount },
    };
  }

  /** 空消息/非法 role 在发送前拒绝；避免把无意义请求发给厂商并计费 */
  #assertRequest(req: ModelGatewayRequest): void {
    if (req.messages.length === 0) {
      throw new GatewayRequestError("messages 不能为空");
    }
    for (const message of req.messages) {
      if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
        throw new GatewayRequestError(`非法消息 role：${String(message.role)}`);
      }
      if (typeof message.content !== "string") {
        throw new GatewayRequestError("消息 content 必须是字符串");
      }
    }
  }

  /** 审计回调失败必须冒泡：允许外发却没有审计记录是不可接受的 */
  #emitAudit(record: OutboundAuditRecord): void {
    this.#opts.onAudit(record);
  }
}

/** 对原始消息做哈希（不落原文）；角色参与哈希，避免同文不同角色碰撞 */
function hashMessages(messages: ChatMessage[]): string {
  const input = messages.map((m) => `${m.role}\u0000${m.content}`).join("\u0001");
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Provider 错误消息可以展示；未知异常不回显 message，避免把 prompt 带进日志 */
function safeErrorMessage(err: unknown): string {
  if (err instanceof ProviderError) return `${err.kind}: ${err.message}`;
  return "未知错误（已省略原始异常信息）";
}
