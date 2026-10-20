/**
 * Telegram 通知渠道（M3）
 *
 * Bot Token 是凭据：由 daemon 从系统钥匙串读取，本类只接收异步 token provider，
 * 不持久化、不写日志。错误信息不回显 URL/Token。
 */

import type { ChannelOutcome, Notifier, NotifyPayload } from "./index.js";

/** Telegram 渠道配置 */
export interface TelegramNotifierOptions {
  chatId: string;
  /** 每次发送时从钥匙串读取；返回 null 表示未配置 */
  token: () => Promise<string | null>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 测试可覆盖 API 根地址 */
  apiBase?: string;
}

/** Telegram Bot API 渠道 */
export class TelegramNotifier implements Notifier {
  readonly channel = "telegram" as const;
  readonly #chatId: string;
  readonly #token: () => Promise<string | null>;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #apiBase: string;

  constructor(options: TelegramNotifierOptions) {
    this.#chatId = options.chatId;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#apiBase = (options.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
  }

  /** 只检查 chatId/token 是否存在，不发网络请求 */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.#chatId) return { ok: false, detail: "Telegram chatId 未配置" };
    try {
      const token = await this.#token();
      return token
        ? { ok: true, detail: "Telegram Token 已配置（未发送探测请求）" }
        : { ok: false, detail: "Telegram Token 未配置" };
    } catch {
      return { ok: false, detail: "钥匙串读取失败" };
    }
  }

  /** 发送消息；错误不包含 token */
  async send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }> {
    let token: string | null;
    try {
      token = await this.#token();
    } catch {
      return { outcome: "permanent_error", error: "钥匙串读取失败" };
    }
    if (!token) return { outcome: "permanent_error", error: "Telegram Token 未配置" };

    const text = payload.body ? `${payload.title}\n${payload.body}` : payload.title;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBase}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.#chatId,
          text,
          disable_notification: payload.sound === false,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      return name === "TimeoutError" || name === "AbortError"
        ? { outcome: "timeout", error: "Telegram 请求超时" }
        : { outcome: "transient_error", error: "Telegram 网络错误" };
    }
    if (response.ok) return { outcome: "success" };
    const outcome: ChannelOutcome =
      response.status === 429 || response.status >= 500 ? "transient_error" : "permanent_error";
    return { outcome, error: `HTTP ${response.status}` };
  }
}
