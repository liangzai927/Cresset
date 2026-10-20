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
import { AuditRepo, type Db } from "@aegis/storage";
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
}

/** 设置页视图；不含 API Key */
export interface LlmView extends LlmSettings {
  hasApiKey: boolean;
  keychainError: string | null;
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
  readonly #audit: AuditRepo;

  constructor(options: LlmServiceOptions) {
    this.#configFile = options.configFile;
    this.#clock = options.clock;
    this.#secrets = options.secrets;
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
    return { ...toSettings(cfg), hasApiKey, keychainError };
  }

  /** 保存非敏感设置 */
  save(settings: LlmSettings): LlmView {
    const current = loadConfig(this.#configFile);
    saveConfig(this.#configFile, { ...current.config, llm: settings });
    return { ...settings, hasApiKey: false, keychainError: null };
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
