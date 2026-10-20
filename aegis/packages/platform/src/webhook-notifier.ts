/**
 * Webhook 通知渠道（M3）
 *
 * 把通知以 JSON POST 到用户配置的 HTTP(S) 端点，用于离开电脑后仍能收到关键提醒。
 *
 * 安全边界：
 *   - URL 是用户显式配置的外发目的地；错误信息不包含完整 URL/查询参数；
 *   - 请求体只包含标题/正文/tag，不包含数据库 id、凭据或内部路径；
 *   - 超时与 HTTP 状态错误必须分类，交给调度器决定重试/降级。
 */

import type { ChannelOutcome, Notifier, NotifyPayload } from "./index.js";

/** Webhook 渠道配置 */
export interface WebhookNotifierOptions {
  /** 必须为 http(s) URL；查询参数可能含 token，错误中不得回显 */
  url: string;
  timeoutMs?: number;
  /** 测试注入；默认全局 fetch */
  fetchImpl?: typeof fetch;
}

/** Webhook 渠道实现 */
export class WebhookNotifier implements Notifier {
  readonly channel = "webhook" as const;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: WebhookNotifierOptions) {
    this.#url = options.url;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** 只检查 URL 合法性，不发请求（探测不应触发用户 webhook） */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const u = new URL(this.#url);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, detail: "Webhook 只支持 http/https" };
      }
      return { ok: true, detail: "Webhook URL 格式有效（未发送探测请求）" };
    } catch {
      return { ok: false, detail: "Webhook URL 非法" };
    }
  }

  /** 投递一条通知；不把响应体写进错误 */
  async send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: payload.title,
          body: payload.body ?? "",
          ...(payload.tag ? { tag: payload.tag } : {}),
          ...(payload.sound !== undefined ? { sound: payload.sound } : {}),
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      return name === "TimeoutError" || name === "AbortError"
        ? { outcome: "timeout", error: "Webhook 请求超时" }
        : { outcome: "transient_error", error: "Webhook 网络错误" };
    }

    if (response.ok) return { outcome: "success" };
    const outcome: ChannelOutcome = response.status >= 500 ? "transient_error" : "permanent_error";
    return { outcome, error: `HTTP ${response.status}` };
  }
}
