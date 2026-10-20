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
import {
  OpenAICompatibleProvider,
  type OutboundAuditRecord,
  OutboundBlockedError,
  ProviderError,
  RedactingModelGateway,
} from "@aegis/redaction-gateway";
import type { SecretStore } from "@aegis/secrets";
import { AuditRepo, type Db, type StoredAuditEntry } from "@aegis/storage";
import { type DaemonConfig, loadConfig, saveConfig } from "./config.js";

/** 钥匙串内的 key 名；值绝不落配置 */
export const LLM_API_KEY = "llm.apiKey";

/** 模型设置（非敏感） */
export interface LlmSettings {
  enabled: boolean;
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

  constructor(options: LlmServiceOptions) {
    this.#configFile = options.configFile;
    this.#clock = options.clock;
    this.#secrets = options.secrets;
    this.#db = options.db;
    this.#audit = new AuditRepo(options.db);
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

  /** 最近外发审计；只返回安全摘要 */
  audit(limit = 20): StoredAuditEntry[] {
    return this.#audit.recent(limit);
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
    if (!this.#consumeCall(cfg.llm.dailyCallLimit)) {
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
  #consumeCall(limit: number): boolean {
    const now = this.#clock.wall();
    const dayKey = Math.floor(now / 86_400_000);
    const result = this.#db
      .prepare(
        `INSERT INTO llm_usage (day_key, purpose, calls, updated_at)
         VALUES (?, 'llm.test', 1, ?)
         ON CONFLICT(day_key, purpose) DO UPDATE SET
           calls = calls + 1,
           updated_at = excluded.updated_at
         WHERE calls < ?`,
      )
      .run(dayKey, now, limit);
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
