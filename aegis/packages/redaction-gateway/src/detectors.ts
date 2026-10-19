/**
 * 检测器注册表 + 内置检测器（M0 骨架）
 *
 * M0/M1 目标：接口 + 少量检测器 + 样本集与召回率测试（TC-M0-01）。
 * M3 的会话级占位映射/还原在 `placeholders.ts`；本文件只负责"检测"与单次替换。
 *
 * 设计要点：
 *   - 只做**本地**检测，绝不调用任何外部服务（那本身就是外发）。
 *   - 宁可过度脱敏（可接受），不可漏检（事故）—— 见 PRD §8.2 FR-S8。
 *   - 校验位（身份证/银行卡）用于降低误报，但**召回优先**：校验失败也照样标记。
 */
import type { Detector, DetectorHit } from "./index.js";

/** 中国大陆身份证：18 位（末位可为 X），带校验位验证 */
const ID_CARD_RE =
  /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g;
/** 手机号：11 位，1 开头，第二位 3-9 */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
/** 银行卡：16-19 位连续数字 */
const BANK_CARD_RE = /(?<!\d)\d{16,19}(?!\d)/g;
/** 邮箱 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** IPv4 */
const IPV4_RE = /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d)/g;
/** 常见 API Key / Token 形态 */
const API_KEY_RES: RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/g, // OpenAI 风格
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS Access Key ID
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];
/** 私钥块 / 连接串 */
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const CONN_STRING_RE = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'`]+/gi;

function regexDetector(
  id: string,
  category: string,
  escalatesTo: Detector["escalatesTo"],
  patterns: RegExp[],
): Detector {
  return {
    id,
    category,
    escalatesTo,
    detect(text: string): DetectorHit[] {
      const hits: DetectorHit[] = [];
      for (const re of patterns) {
        // 每个 pattern 独立重置 lastIndex，避免 g 标志的状态串扰
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          if (m.index === undefined) continue;
          hits.push({
            category,
            escalatesTo,
            start: m.index,
            end: m.index + m[0].length,
            matched: m[0],
          });
        }
      }
      return hits.sort((a, b) => a.start - b.start);
    },
  };
}

/** 身份证校验位（GB 11643-1999）——仅用于统计误报，不用于过滤 */
export function isValidIdCardChecksum(id: string): boolean {
  if (id.length !== 18) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = "10X98765432";
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(id[i]) * (weights[i] ?? 0);
  return codes[sum % 11] === id[17]?.toUpperCase();
}

/** Luhn 校验（银行卡）——同上，仅统计用途 */
export function isValidLuhn(card: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = card.length - 1; i >= 0; i--) {
    let d = Number(card[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** 内置检测器（M1 五个核心类别） */
export function builtinDetectors(): Detector[] {
  return [
    regexDetector("id-card", "id_card", "L2", [ID_CARD_RE]),
    regexDetector("phone-cn", "phone", "L2", [PHONE_RE]),
    regexDetector("email", "email", "L1", [EMAIL_RE]),
    regexDetector("ipv4", "ip_address", "L1", [IPV4_RE]),
    regexDetector("bank-card", "bank_card", "L2", [BANK_CARD_RE]),
    regexDetector("api-key", "api_key", "L3", API_KEY_RES),
    regexDetector("private-key", "private_key", "L3", [PRIVATE_KEY_RE]),
    regexDetector("connection-string", "connection_string", "L3", [CONN_STRING_RE]),
  ];
}

/** 运行全部检测器，按位置排序 */
export function runDetectors(detectors: Detector[], text: string): DetectorHit[] {
  const hits: DetectorHit[] = [];
  for (const d of detectors) hits.push(...d.detect(text));
  return hits.sort((a, b) => a.start - b.start);
}

/**
 * 占位替换（M1：只替换，不做还原）。
 * 同一会话内同一取值必须映射到同一占位符，否则模型无法理解"同一个对象"。
 * 完整实现（映射表 + 响应还原）在 M3。
 */
export function applyPlaceholders(
  text: string,
  hits: DetectorHit[],
): { redacted: string; summary: Map<string, number> } {
  const summary = new Map<string, number>();
  if (hits.length === 0) return { redacted: text, summary };

  // ① 先按**出现顺序**（位置升序）分配占位符编号，保证同一取值始终映射到同一占位符，
  //    且编号顺序与人类阅读顺序一致（[EMAIL_1] 一定出现在 [EMAIL_2] 之前）。
  const byStart = [...hits].sort((a, b) => a.start - b.start);
  const assigned = new Map<string, string>();
  const counters = new Map<string, number>();
  for (const hit of byStart) {
    if (assigned.has(hit.matched)) continue;
    const n = (counters.get(hit.category) ?? 0) + 1;
    counters.set(hit.category, n);
    assigned.set(hit.matched, `[${hit.category.toUpperCase()}_${n}]`);
  }

  // ② 再从后往前替换，避免前面的替换导致后续偏移失效。
  let out = text;
  for (const hit of [...byStart].reverse()) {
    const placeholder = assigned.get(hit.matched);
    if (!placeholder) continue;
    out = out.slice(0, hit.start) + placeholder + out.slice(hit.end);
  }

  for (const [cat, n] of counters) summary.set(cat, n);
  return { redacted: out, summary };
}
