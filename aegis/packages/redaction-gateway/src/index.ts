/**
 * 脱敏外发网关 —— 唯一外发出口（M0 骨架，D2 决策）
 *
 * M1 阶段没有任何真实外发路径（无 LLM 调用），但**接口与 fail-closed 语义必须先钉死**：
 * 若等到 M3 才定义签名，所有调用点都要改一遍。
 *
 * 铁律（PRD §8.2 / 技术架构 §5.2）：
 *   1. 所有外发必须经过本模块，其他地方不得 import 模型 SDK（由 dependency-cruiser 强制）。
 *   2. 检测到 L3 或脱敏失败 → **硬失败**（抛错），绝不"降级放行"。
 *   3. 审计只记录脱敏项摘要与哈希，**不记录原文**（NFR-SP5）。
 */

import type { DataClass } from "@aegis/contracts";
import { DEFAULT_DATA_CLASS } from "@aegis/contracts";

/** 检测器：识别一段文本中的敏感项 */
export interface Detector {
  /** 检测器标识（写入审计，不含原文） */
  readonly id: string;
  /** 命中项的语义类别，如 id_card / phone / email / api_key */
  readonly category: string;
  /** 该检测器命中的最低数据分级（命中即把整段至少提升到该级别） */
  readonly escalatesTo: DataClass;
  detect(text: string): DetectorHit[];
}

/** 一次检测命中的位置与取值；`matched` 仅用于本地占位替换，**绝不写入审计或日志** */
export interface DetectorHit {
  category: string;
  start: number;
  end: number;
  /** 仅用于本地占位替换；绝不写入审计或日志 */
  matched: string;
}

/** 分级策略：判定某段载荷的数据级别 */
export interface ClassificationPolicy {
  /** 依据来源标签给出的初始级别（未知 → L2，保守默认） */
  baseClass(source: string): DataClass;
  /** 结合检测结果提升级别（只升不降） */
  escalate(base: DataClass, hits: DetectorHit[]): DataClass;
}

/** 外发请求 */
export interface OutboundRequest {
  /** 发起方：daemon / user / 未来的 employee id */
  actor: string;
  /** 用途说明，写入审计（如 "daily-digest"） */
  purpose: string;
  /** 目标：provider/model */
  destination: string;
  /** 载荷（M1 无真实调用，仅用于策略判定测试） */
  payload: string;
  /** 数据来源标签，用于初始分级 */
  source?: string;
}

/** 外发判定结果；`payloadSha256` 是唯一允许保留的内容身份 */
export interface OutboundDecision {
  allowed: boolean;
  dataClass: DataClass;
  /** 脱敏后的载荷（占位符形式）；M1 不实现还原 */
  redactedPayload: string;
  /** 命中项摘要（不含原文） */
  detectorSummary: Array<{ category: string; count: number }>;
  /** 只记录哈希 */
  payloadSha256: string;
  /** 拒绝原因（allowed=false 时必填） */
  reason?: string;
}

/** 外发被策略拒绝；携带完整判定结果，便于上层向用户解释被拒原因 */
export class OutboundBlockedError extends Error {
  readonly decision: OutboundDecision;
  constructor(decision: OutboundDecision) {
    super(`外发被拒绝（${decision.dataClass}）：${decision.reason ?? "策略不允许"}`);
    this.name = "OutboundBlockedError";
    this.decision = decision;
  }
}

/** 允许外发的最高分级（本机自用默认：L1 可外发，L2 需显式开启，L3 永不） */
export interface GatewayPolicy {
  /** 允许外发的最高数据分级 */
  maxOutboundClass: DataClass;
}

/** 默认策略：只允许 L0/L1 外发；L2 需显式开启，L3 永不外发（PRD FR-S13） */
export const DEFAULT_GATEWAY_POLICY: GatewayPolicy = {
  maxOutboundClass: "L1",
};

const CLASS_ORDER: Record<DataClass, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

/** 取两个分级中更严格的一个（分级**只升不降**：自动化只能提升，降级需人工确认） */
export function maxClass(a: DataClass, b: DataClass): DataClass {
  return CLASS_ORDER[a] >= CLASS_ORDER[b] ? a : b;
}

/** 默认分级策略：未知来源 → L2（保守），检测命中只能提升级别 */
export class DefaultClassificationPolicy implements ClassificationPolicy {
  baseClass(source: string): DataClass {
    const known: Record<string, DataClass> = {
      "public-web": "L0",
      "open-source": "L0",
      "team-doc": "L1",
      "project-code": "L1",
    };
    return known[source] ?? DEFAULT_DATA_CLASS;
  }

  escalate(base: DataClass, hits: DetectorHit[]): DataClass {
    let level = base;
    for (const hit of hits) {
      const detectorLevel = DETECTOR_LEVELS[hit.category];
      if (detectorLevel) level = maxClass(level, detectorLevel);
    }
    return level;
  }
}

/** 各类命中的默认提升级别（凭据类直接 L3 → 永不外发） */
export const DETECTOR_LEVELS: Record<string, DataClass> = {
  id_card: "L2",
  phone: "L2",
  bank_card: "L2",
  email: "L1",
  address: "L2",
  ip_address: "L1",
  api_key: "L3",
  private_key: "L3",
  connection_string: "L3",
};

/**
 * 模型网关接口。
 *
 * ⚠️ M1 只提供 fail-closed 实现（NoopModelGateway）：任何调用都抛错。
 *    这不是"没实现"，而是**刻意的安全默认值**：在 M3 补齐真实 Provider 之前，
 *    任何试图外发的代码路径都会立刻失败，而不是静默地把数据发出去。
 */
export interface ModelGateway {
  complete(req: OutboundRequest): Promise<never>;
}
