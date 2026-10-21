/**
 * M3 模型服务：设置、钥匙串凭据、真实外发测试与审计
 *
 * 安全边界：
 *   - API Key 只写系统钥匙串，配置/视图/日志里永远没有明文；
 *   - 任何真实请求都必须经过 `RedactingModelGateway`；
 *   - `llm.test` 只发送固定的公开探针文本，不发送用户数据；
 *   - 审计落 `outbound_audit`，只存哈希与类别。
 */

import type { Clock } from "@aegis/clock";
import { KnowledgeBase, type KnowledgeHit } from "@aegis/knowledge";
import {
  OpenAICompatibleProvider,
  type OutboundAuditRecord,
  OutboundBlockedError,
  ProviderError,
  RedactingModelGateway,
} from "@aegis/redaction-gateway";
import type { SecretStore } from "@aegis/secrets";
import type { Skill, SkillDecision } from "@aegis/skills";
import { AuditRepo, type Db, type StoredAuditEntry } from "@aegis/storage";
import { type DaemonConfig, loadConfig, saveConfig } from "./config.js";

/** 钥匙串内的 key 名；值绝不落配置 */
export const LLM_API_KEY = "llm.apiKey";

/** 模型设置（非敏感） */
export interface LlmSettings {
  enabled: boolean;
  provider: "openai" | "deepseek" | "kimi" | "glm" | "custom";
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxOutboundClass: "L0" | "L1" | "L2";
  dailyCallLimit: number;
}

/** 设置页视图；不含 API Key */
export interface LlmView extends LlmSettings {
  hasApiKey: boolean;
  keychainError: string | null;
  callsToday: number;
  remainingCalls: number;
}

/** 知识库问答的引用 */
export interface KnowledgeCitation {
  chunkId: string;
  title: string;
  sourcePath: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
}

/** 知识库问答结果 */
export type KnowledgeAnswerResult =
  | { ok: true; answer: string; citations: KnowledgeCitation[] }
  | {
      ok: false;
      reason: "no_evidence" | "sensitive" | "blocked" | "budget" | "llm_unavailable" | "invalid_answer";
      message: string;
    };

/** 测试结果；不返回任何请求细节，只返回安全摘要 */
export type LlmTestResult =
  | { ok: true; text: string; destination: string }
  | { ok: false; blocked: boolean; reason: string }
  | { ok: false; blocked: false; errorKind: string; reason: string };

/** LLM 服务配置 */
export interface LlmServiceOptions {
  configFile: string;
  db: Db;
  clock: Clock;
  secrets: SecretStore;
}

/** 从配置提取 LLM 设置 */
function toSettings(cfg: DaemonConfig): LlmSettings {
  return { ...cfg.llm };
}

/** 构造服务 */
export class LlmService {
  readonly #configFile: string;
  readonly #clock: Clock;
  readonly #secrets: SecretStore;
  readonly #db: Db;
  readonly #audit: AuditRepo;
  readonly #knowledge: KnowledgeBase;

  constructor(options: LlmServiceOptions) {
    this.#configFile = options.configFile;
    this.#clock = options.clock;
    this.#secrets = options.secrets;
    this.#db = options.db;
    this.#audit = new AuditRepo(options.db);
    this.#knowledge = new KnowledgeBase({ db: options.db, now: () => options.clock.wall() });
  }

  /** 从服务商获取模型列表；无 Key/网络失败会抛错，由 IPC 转成可读错误 */
  async listModels(): Promise<{ models: string[] }> {
    const cfg = loadConfig(this.#configFile).config;
    const apiKey = await this.#secrets.get(LLM_API_KEY);
    if (!apiKey) throw new Error("未配置 API Key");
    const provider = new OpenAICompatibleProvider({
      baseUrl: cfg.llm.baseUrl,
      apiKey,
      model: cfg.llm.model,
      timeoutMs: cfg.llm.timeoutMs,
    });
    return { models: await provider.listModels() };
  }

  /** 读取设置；钥匙串不可用时把错误带到视图里，而不是静默假装没有 key */
  async get(): Promise<LlmView> {
    const cfg = loadConfig(this.#configFile).config;
    let hasApiKey = false;
    let keychainError: string | null = null;
    try {
      hasApiKey = Boolean(await this.#secrets.get(LLM_API_KEY));
    } catch (err) {
      keychainError = (err as Error).message;
    }
    const callsToday = this.#callsToday();
    return {
      ...toSettings(cfg),
      hasApiKey,
      keychainError,
      callsToday,
      remainingCalls: Math.max(0, cfg.llm.dailyCallLimit - callsToday),
    };
  }

  /** 保存非敏感设置 */
  save(settings: LlmSettings): void {
    const current = loadConfig(this.#configFile);
    saveConfig(this.#configFile, { ...current.config, llm: settings });
  }

  /**
   * 知识库问答：先本地检索；无依据直接拒答；有依据才经网关让模型回答。
   *
   * 所有引用都必须来自检索结果；模型返回的引用编号必须能在本地命中列表中找到，
   * 否则视为无效回答并拒答（不允许"看起来像引用的伪引用"）。
   */
  async answer(question: string): Promise<KnowledgeAnswerResult> {
    const hits = this.#knowledge.searchForQuestion(question, 6);
    if (hits.length === 0) {
      return { ok: false, reason: "no_evidence", message: "知识库里没有找到依据" };
    }
    if (hits.some((h) => h.dataClass === "L3")) {
      return { ok: false, reason: "sensitive", message: "命中的知识包含 L3 内容，不允许外发" };
    }

    const cfg = loadConfig(this.#configFile).config;
    if (hits.some((h) => h.dataClass === "L2") && cfg.llm.maxOutboundClass === "L1") {
      return { ok: false, reason: "blocked", message: "检索结果包含 L2 内容，超过当前外发上限" };
    }
    if (!cfg.llm.enabled) {
      return { ok: false, reason: "llm_unavailable", message: "模型未启用；可以先用检索查看片段" };
    }
    const apiKey = await this.#secrets.get(LLM_API_KEY);
    if (!apiKey) {
      return { ok: false, reason: "llm_unavailable", message: "未配置 API Key；可以先用检索查看片段" };
    }
    let destination: string;
    try {
      destination = new URL(cfg.llm.baseUrl).host;
    } catch {
      return { ok: false, reason: "llm_unavailable", message: "Base URL 非法" };
    }
    if (!this.#consumeCall(cfg.llm.dailyCallLimit, "knowledge.answer")) {
      return { ok: false, reason: "budget", message: "已达到今日调用上限" };
    }

    const source = hits.some((h) => h.dataClass === "L2") ? "unknown" : "team-doc";
    const excerpts = hits
      .map(
        (h, i) => `[${i + 1}] id=${h.chunkId}\n来源：${h.sourcePath}#${h.ordinal}\n${h.text.slice(0, 1_200)}`,
      )
      .join("\n\n---\n\n");
    const prompt = [
      "你是 Aegis 的本地知识库问答助手。",
      "只能依据下面的片段回答，不得使用外部知识或猜测。",
      "每个事实必须用 [编号] 标注来源。找不到依据时 found=false。",
      "只返回 JSON：",
      '{"found":true|false,"answer":"...","citations":[1,2]}',
      "",
      `问题：${question}`,
      "",
      "片段：",
      excerpts,
    ].join("\n");

    const provider = new OpenAICompatibleProvider({
      baseUrl: cfg.llm.baseUrl,
      apiKey,
      model: cfg.llm.model,
      timeoutMs: cfg.llm.timeoutMs,
    });
    const gateway = new RedactingModelGateway({
      provider,
      policy: { maxOutboundClass: cfg.llm.maxOutboundClass },
      now: () => this.#clock.wall(),
      audit: (audit) => this.#recordAudit(audit),
    });

    try {
      const result = await gateway.complete({
        actor: "daemon",
        purpose: "knowledge-answer",
        destination: `${destination}/${cfg.llm.model}`,
        payload: prompt,
        source,
        model: cfg.llm.model,
      });
      const parsed = parseAnswerResponse(result.text);
      if (!parsed || !parsed.found) {
        return { ok: false, reason: "no_evidence", message: "知识库里没有找到足够依据" };
      }
      const citations = parsed.citations
        .map((n) => hits[n - 1])
        .filter((h): h is KnowledgeHit => Boolean(h))
        .map((h) => ({
          chunkId: h.chunkId,
          title: h.title,
          sourcePath: h.sourcePath,
          ordinal: h.ordinal,
          startOffset: h.startOffset,
          endOffset: h.endOffset,
        }));
      if (!parsed.answer.trim() || citations.length === 0) {
        return { ok: false, reason: "invalid_answer", message: "模型没有给出可验证的引用，已拒答" };
      }
      return { ok: true, answer: parsed.answer, citations };
    } catch (err) {
      if (err instanceof OutboundBlockedError) {
        return { ok: false, reason: "blocked", message: err.message };
      }
      if (err instanceof ProviderError) {
        const reason =
          err.kind === "timeout"
            ? `模型请求超时（${cfg.llm.timeoutMs}ms），请调大超时或检查网络`
            : err.kind === "auth"
              ? "模型鉴权失败，请检查 API Key"
              : err.kind === "rate_limit"
                ? "模型触发限流或额度不足，请稍后重试"
                : err.kind === "network"
                  ? "模型网络连接失败"
                  : "模型返回异常，请查看审计";
        return { ok: false, reason: "llm_unavailable", message: reason };
      }
      return { ok: false, reason: "llm_unavailable", message: "模型调用失败，请查看审计" };
    }
  }

  /** 最近外发审计；只返回安全摘要 */
  audit(limit = 20): StoredAuditEntry[] {
    return this.#audit.recent(limit);
  }

  /**
   * 规则命中后的可选 LLM 判断/改写。
   *
   * 失败、未启用、无 Key、超预算、被网关拒绝时**一律返回原规则决策**；
   * 只有模型明确返回 `notify=false` 且 Skill 允许抑制时才返回 null。
   * 这里不抛错，避免模型故障影响已经由规则确认的通知。
   */
  /**
   * 判断一封邮件的发件人/主题是否需要立即提醒。
   *
   * 只发送邮件头（发件人+主题），分级默认为 L2；L1 上限时会被网关阻断，
   * 返回 null，调用方应保持规则结果而不是假装成功。
   */
  async classifyEmail(from: string, subject: string): Promise<boolean | null> {
    const cfg = loadConfig(this.#configFile).config;
    if (!cfg.llm.enabled) return null;
    const apiKey = await this.#secrets.get(LLM_API_KEY);
    if (!apiKey) return null;
    let destination: string;
    try {
      destination = new URL(cfg.llm.baseUrl).host;
    } catch {
      return null;
    }
    if (!this.#consumeCall(cfg.llm.dailyCallLimit, "email.importance")) return null;

    const provider = new OpenAICompatibleProvider({
      baseUrl: cfg.llm.baseUrl,
      apiKey,
      model: cfg.llm.model,
      timeoutMs: cfg.llm.timeoutMs,
    });
    const gateway = new RedactingModelGateway({
      provider,
      policy: { maxOutboundClass: cfg.llm.maxOutboundClass },
      now: () => this.#clock.wall(),
      audit: (audit) => this.#recordAudit(audit),
    });
    try {
      const result = await gateway.complete({
        actor: "daemon",
        purpose: "email-importance",
        destination: `${destination}/${cfg.llm.model}`,
        payload: [
          "你是收件箱过滤器。只根据发件人和主题判断是否需要立即提醒用户。",
          "营销、自动回复、账单通知、社交动态 → 不需要。",
          "需要用户处理的合同、面试、发票、紧急事项 → 需要。",
          `发件人：${from}`,
          `主题：${subject}`,
          '只返回 JSON：{"important":true|false,"reason":"..."}',
        ].join("\n"),
        source: "email-header",
        model: cfg.llm.model,
      });
      const parsed = /"important"\s*:\s*(true|false)/i.exec(result.text);
      return parsed ? parsed[1]?.toLowerCase() === "true" : null;
    } catch {
      // 网关阻断/模型失败：返回 null，让调用方保留规则结果
      return null;
    }
  }

  /**
   * 把本地早报事实整理成更自然的文字。
   *
   * 只发送已生成的事实文本；数据分级按 L2。失败/被阻断返回 null，
   * 调用方必须回退规则版早报。
   */
  async summarizeBrief(facts: string): Promise<string | null> {
    const cfg = loadConfig(this.#configFile).config;
    if (!cfg.llm.enabled) return null;
    const apiKey = await this.#secrets.get(LLM_API_KEY);
    if (!apiKey) return null;
    let destination: string;
    try {
      destination = new URL(cfg.llm.baseUrl).host;
    } catch {
      return null;
    }
    if (!this.#consumeCall(cfg.llm.dailyCallLimit, "daily-briefing")) return null;
    const provider = new OpenAICompatibleProvider({
      baseUrl: cfg.llm.baseUrl,
      apiKey,
      model: cfg.llm.model,
      timeoutMs: cfg.llm.timeoutMs,
    });
    const gateway = new RedactingModelGateway({
      provider,
      policy: { maxOutboundClass: cfg.llm.maxOutboundClass },
      now: () => this.#clock.wall(),
      audit: (audit) => this.#recordAudit(audit),
    });
    try {
      const result = await gateway.complete({
        actor: "daemon",
        purpose: "daily-briefing",
        destination: `${destination}/${cfg.llm.model}`,
        payload: [
          "把下面的本地早报事实整理成简洁、自然的中文早报。",
          "只使用已给事实，不要编造；保留时间/数字；最多 8 行。",
          "只返回正文，不要 Markdown 标题代码块。",
          "",
          facts,
        ].join("\n"),
        source: "briefing",
        model: cfg.llm.model,
      });
      const text = result.text.trim();
      return text ? text.slice(0, 2_000) : null;
    } catch {
      return null;
    }
  }

  async judge(
    skill: Skill,
    decision: SkillDecision,
    fields: Record<string, unknown>,
  ): Promise<SkillDecision | null> {
    if (!skill.judge) return decision;
    const cfg = loadConfig(this.#configFile).config;
    if (!cfg.llm.enabled) return decision;

    const apiKey = await this.#secrets.get(LLM_API_KEY);
    if (!apiKey) return decision;

    let destination: string;
    try {
      destination = new URL(cfg.llm.baseUrl).host;
    } catch {
      return decision;
    }
    if (!this.#consumeCall(cfg.llm.dailyCallLimit, "skill.judge")) return decision;

    const provider = new OpenAICompatibleProvider({
      baseUrl: cfg.llm.baseUrl,
      apiKey,
      model: cfg.llm.model,
      timeoutMs: cfg.llm.timeoutMs,
    });
    const gateway = new RedactingModelGateway({
      provider,
      policy: { maxOutboundClass: cfg.llm.maxOutboundClass },
      now: () => this.#clock.wall(),
      audit: (audit) => this.#recordAudit(audit),
    });

    try {
      const facts = JSON.stringify(fields).slice(0, 4_000);
      const prompt = [
        skill.judge.prompt,
        "",
        "规则命中后的通知草稿：",
        `标题：${decision.title}`,
        `正文：${decision.body}`,
        `优先级：${decision.priority}`,
        "监测事实（可能已被脱敏）：",
        facts,
        "",
        "请只返回 JSON：",
        '{"notify":true|false,"title":"...","body":"...","priority":"low|normal|high|urgent","reason":"..."}',
        skill.judge.canSuppress ? "" : "注意：notify 必须为 true，不能抑制这条通知。",
      ].join("\n");

      const result = await gateway.complete({
        actor: "daemon",
        purpose: "skill-judge",
        destination: `${destination}/${cfg.llm.model}`,
        payload: prompt,
        source: "team-doc",
        model: cfg.llm.model,
      });

      const parsed = parseJudgeResponse(result.text);
      if (!parsed) return decision;
      if (!parsed.notify && skill.judge.canSuppress) return null;
      if (!parsed.notify) return decision;
      return {
        ...decision,
        title: parsed.title || decision.title,
        body: parsed.body || decision.body,
        priority: parsed.priority,
      };
    } catch {
      // 模型/网关/解析失败都必须回退；规则已经确认的通知不能因为模型而丢失
      return decision;
    }
  }

  /** 写入 API Key；只在成功时返回 hasApiKey=true */
  async setApiKey(apiKey: string): Promise<{ hasApiKey: boolean }> {
    if (!apiKey.trim()) throw new Error("API Key 不能为空");
    await this.#secrets.set(LLM_API_KEY, apiKey.trim());
    return { hasApiKey: true };
  }

  /** 删除 API Key；不存在也视为成功 */
  async clearApiKey(): Promise<{ hasApiKey: boolean }> {
    await this.#secrets.delete(LLM_API_KEY);
    return { hasApiKey: false };
  }

  /** 真实外发测试：固定公开探针，经网关与审计 */
  async test(): Promise<LlmTestResult> {
    const cfg = loadConfig(this.#configFile).config;
    if (!cfg.llm.enabled)
      return { ok: false, blocked: false, errorKind: "configuration", reason: "模型未启用" };

    const apiKey = await this.#secrets.get(LLM_API_KEY);
    if (!apiKey) return { ok: false, blocked: false, errorKind: "configuration", reason: "未配置 API Key" };
    let destination: string;
    try {
      destination = new URL(cfg.llm.baseUrl).host;
    } catch {
      return { ok: false, blocked: false, errorKind: "configuration", reason: "Base URL 非法" };
    }
    if (!this.#consumeCall(cfg.llm.dailyCallLimit, "llm.test")) {
      return { ok: false, blocked: false, errorKind: "rate_limit", reason: "已达到今日调用上限" };
    }

    const provider = new OpenAICompatibleProvider({
      baseUrl: cfg.llm.baseUrl,
      apiKey,
      model: cfg.llm.model,
      timeoutMs: cfg.llm.timeoutMs,
    });
    const gateway = new RedactingModelGateway({
      provider,
      policy: { maxOutboundClass: cfg.llm.maxOutboundClass },
      now: () => this.#clock.wall(),
      audit: (audit) => this.#recordAudit(audit),
    });

    try {
      const result = await gateway.complete({
        actor: "daemon",
        purpose: "llm-test",
        destination: `${destination}/${cfg.llm.model}`,
        payload: "Reply with the single word OK.",
        source: "public-web",
        model: cfg.llm.model,
      });
      return { ok: true, text: result.text.slice(0, 1_000), destination };
    } catch (err) {
      if (err instanceof OutboundBlockedError) {
        return { ok: false, blocked: true, reason: err.message };
      }
      if (err instanceof ProviderError) {
        return { ok: false, blocked: false, errorKind: err.kind, reason: err.message };
      }
      return { ok: false, blocked: false, errorKind: "network", reason: (err as Error).message };
    }
  }

  /** 今日调用数；`llm_usage` 按 UTC 天聚合 */
  #callsToday(): number {
    const dayKey = Math.floor(this.#clock.wall() / 86_400_000);
    const row = this.#db
      .prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM llm_usage WHERE day_key = ?")
      .get(dayKey) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * 原子占用一次调用额度。
   *
   * 用条件 UPSERT 而不是"先 SELECT 再 UPDATE"：即使未来出现并发调用，
   * 也只有未达上限的请求能让 changes=1。
   */
  #consumeCall(limit: number, purpose: string): boolean {
    const now = this.#clock.wall();
    const dayKey = Math.floor(now / 86_400_000);
    const result = this.#db
      .prepare(
        `INSERT INTO llm_usage (day_key, purpose, calls, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(day_key, purpose) DO UPDATE SET
           calls = calls + 1,
           updated_at = excluded.updated_at
         WHERE calls < ?`,
      )
      .run(dayKey, purpose, now, limit);
    return result.changes > 0;
  }

  /** 把网关审计映射到仓储；丢弃 errorKind（审计表没有该列） */
  #recordAudit(audit: OutboundAuditRecord): void {
    this.#audit.record(
      {
        actor: audit.actor,
        purpose: audit.purpose,
        destination: audit.destination,
        dataClass: audit.dataClass,
        detectorSummary: audit.detectorSummary,
        redactionCount: audit.redactionCount,
        policyVersion: audit.policyVersion,
        payloadSha256: audit.payloadSha256,
        outcome: audit.outcome,
      },
      audit.at,
    );
  }
}

/** 解析模型 JSON；任何字段不合法都返回 null，由调用方回退 */
function parseJudgeResponse(
  text: string,
): { notify: boolean; title: string; body: string; priority: SkillDecision["priority"] } | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.notify !== "boolean") return null;
  const priority = r.priority;
  if (priority !== "low" && priority !== "normal" && priority !== "high" && priority !== "urgent") {
    return null;
  }
  return {
    notify: r.notify,
    title: typeof r.title === "string" ? r.title : "",
    body: typeof r.body === "string" ? r.body : "",
    priority,
  };
}

/** 解析知识库回答 JSON；任何字段不合法都返回 null */
function parseAnswerResponse(text: string): { found: boolean; answer: string; citations: number[] } | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.found !== "boolean" || typeof r.answer !== "string" || !Array.isArray(r.citations))
    return null;
  const citations = r.citations.filter(
    (n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0,
  );
  return { found: r.found, answer: r.answer, citations };
}
