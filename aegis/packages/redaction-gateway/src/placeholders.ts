/**
 * 会话级占位符映射
 *
 * ## 为什么需要"会话级"
 *
 * 同一段对话里，同一个手机号必须始终映射到 `[PHONE_1]`，模型才能理解
 * "这两个地方说的是同一个人"。如果每次调用都从 1 重新编号，模型会把
 * 同一个对象当成两个，判断质量会直接下降。
 *
 * ## 安全约束
 *
 * - `#placeholderToValue` / `#valueToPlaceholder` 只存在于内存，**绝不写日志/审计/数据库**；
 * - 审计只使用类别计数与哈希；
 * - `restore()` 只还原本会话确实分配过的占位符，模型编造的占位符原样保留。
 *
 * 本文件不负责分级、策略裁决或网络调用。
 */

import type { DetectorHit } from "./index.js";

/** 一次脱敏的结果；summary 只有类别与次数，不含原文 */
export interface RedactionOutcome {
  /** 已替换占位符的文本 */
  text: string;
  /** 本次替换的片段数（重叠命中已合并为一个片段） */
  redactionCount: number;
  /** 本次按类别统计的片段数 */
  summary: Map<string, number>;
}

/** 合并后的敏感片段；`value` 是即将被占位符替换的原文 */
interface SensitiveSpan {
  start: number;
  end: number;
  category: string;
  value: string;
}

/**
 * 会话级占位符映射器。
 *
 * 一个 `ModelGateway` 实例持有一个 session；如果要开始一段全新的对话，
 * 应创建一个新的 session（否则编号会一直增长，虽然不影响正确性）。
 */
export class PlaceholderSession {
  readonly #valueToPlaceholder = new Map<string, string>();
  readonly #placeholderToValue = new Map<string, string>();
  readonly #counters = new Map<string, number>();

  /** 当前已分配的占位符数量（诊断/测试用，不暴露原文） */
  get size(): number {
    return this.#placeholderToValue.size;
  }

  /**
   * 用占位符替换文本中的敏感片段。
   *
   * 重叠命中会先合并成一个区间（宁可过度脱敏，也不留下半截数字），
   * 再按出现顺序分配编号。同一取值跨调用复用同一占位符。
   */
  redact(text: string, hits: DetectorHit[]): RedactionOutcome {
    const summary = new Map<string, number>();
    const spans = mergeSpans(text, hits);
    if (spans.length === 0) return { text, redactionCount: 0, summary };

    // 先从左到右分配占位符，保证编号与阅读顺序一致
    const replacements: Array<{ start: number; end: number; placeholder: string }> = [];
    for (const span of spans) {
      const placeholder = this.#assign(span.value, span.category);
      replacements.push({ start: span.start, end: span.end, placeholder });
      summary.set(span.category, (summary.get(span.category) ?? 0) + 1);
    }

    // 再从后往前替换，避免前面的替换导致后面的偏移失效
    let output = text;
    for (const item of [...replacements].reverse()) {
      output = output.slice(0, item.start) + item.placeholder + output.slice(item.end);
    }
    return { text: output, redactionCount: replacements.length, summary };
  }

  /**
   * 把模型返回文本中的已知占位符还原为原文。
   *
   * 未知占位符（模型编造的）保留原样 —— 不猜、不还原不存在的映射。
   */
  restore(text: string): string {
    if (this.#placeholderToValue.size === 0) return text;
    return text.replace(/\[[A-Z0-9_]+_\d+\]/g, (token) => this.#placeholderToValue.get(token) ?? token);
  }

  /** 分配或复用占位符；key 是敏感值本身，保证同一值跨调用稳定 */
  #assign(value: string, category: string): string {
    const existing = this.#valueToPlaceholder.get(value);
    if (existing) return existing;

    const n = (this.#counters.get(category) ?? 0) + 1;
    this.#counters.set(category, n);
    const placeholder = `[${category.toUpperCase()}_${n}]`;
    this.#valueToPlaceholder.set(value, placeholder);
    this.#placeholderToValue.set(placeholder, value);
    return placeholder;
  }
}

/**
 * 合并重叠的检测命中。
 *
 * 例：一个 18 位数字同时命中"身份证"和"银行卡"，分别替换会把数字切碎并留下残片。
 * 这里把重叠区间合并为一个 span，类别取更长的命中；类别只影响占位符命名，
 * 数据分级由**所有**命中共同决定（见 ModelGateway）。
 */
function mergeSpans(text: string, hits: DetectorHit[]): SensitiveSpan[] {
  if (hits.length === 0) return [];
  const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number; category: string }> = [];

  for (const hit of sorted) {
    const last = merged[merged.length - 1];
    if (last && hit.start < last.end) {
      // 重叠：扩到并集；类别取更长的命中（同级时保留先出现的）
      if (hit.end - hit.start > last.end - last.start) last.category = hit.category;
      last.end = Math.max(last.end, hit.end);
      continue;
    }
    merged.push({ start: hit.start, end: hit.end, category: hit.category });
  }

  return merged.map((span) => ({
    start: span.start,
    end: span.end,
    category: span.category,
    value: text.slice(span.start, span.end),
  }));
}
