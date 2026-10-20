/**
 * Bark 通知渠道（M3）
 *
 * Device Key 是凭据：由 daemon 从系统钥匙串读取，本类只接收异步 provider。
 * 错误信息不包含 Device Key 或完整请求 URL。
 */

import type { ChannelOutcome, Notifier, NotifyPayload } from "./index.js";

/** Bark 渠道配置 */
export interface BarkNotifierOptions {
  /** 自建 Bark 服务地址；默认 https://api.day.app */
  serverUrl?: string;
  /** 每次发送时从钥匙串读取；null 表示未配置 */
  deviceKey: () => Promise<string | null>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Bark 渠道实现 */
export class BarkNotifier implements Notifier {
  readonly channel = "bark" as const;
  readonly #serverUrl: string;
  readonly #deviceKey: () => Promise<string | null>;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: BarkNotifierOptions) {
    this.#serverUrl = (options.serverUrl ?? "https://api.day.app").replace(/\/+$/, "");
    this.#deviceKey = options.deviceKey;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** 只检查 Device Key 是否存在，不发探测请求 */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const key = await this.#deviceKey();
      return key
        ? { ok: true, detail: "Bark Device Key 已配置（未发送探测请求）" }
        : { ok: false, detail: "Bark Device Key 未配置" };
    } catch {
      return { ok: false, detail: "钥匙串读取失败" };
    }
  }

  /** 发送 Bark 推送 */
  async send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }> {
    let key: string | null;
    try {
      key = await this.#deviceKey();
    } catch {
      return { outcome: "permanent_error", error: "钥匙串读取失败" };
    }
    if (!key) return { outcome: "permanent_error", error: "Bark Device Key 未配置" };

    let response: Response;
    try {
      response = await this.#fetch(`${this.#serverUrl}/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_key: key,
          title: payload.title,
          body: payload.body ?? "",
          ...(payload.sound === false ? { sound: "" } : {}),
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      return name === "TimeoutError" || name === "AbortError"
        ? { outcome: "timeout", error: "Bark 请求超时" }
        : { outcome: "transient_error", error: "Bark 网络错误" };
    }
    if (response.ok) return { outcome: "success" };
    const outcome: ChannelOutcome = response.status >= 500 ? "transient_error" : "permanent_error";
    return { outcome, error: `HTTP ${response.status}` };
  }
}
