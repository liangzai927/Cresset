/**
 * Provider 的 HTTP 薄封装
 *
 * 只做四件事：URL 安全校验、超时/取消、HTTP 状态映射、JSON 解析。
 * **不读取/不记录响应正文**：错误消息里只有状态码，避免厂商回显 prompt 造成二次泄露。
 *
 * 本文件不包含任何厂商协议细节（那些在各自 adapter 里）。
 */

import { kindForHttpStatus, ProviderError } from "./errors.js";

/**
 * 校验并返回 URL。
 *
 * 约束（防 SSRF / 明文外发）：
 *   - 只允许 `https:`；
 *   - `http:` 仅允许本机回环（localhost / 127.0.0.1 / ::1），供 Ollama、本地兼容服务使用。
 *
 * @throws {@link ProviderError} 协议不受支持或 URL 非法
 */
export function assertAllowedEndpoint(rawUrl: string, providerId: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderError(providerId, "configuration", `Provider 地址不是合法 URL：${rawUrl}`);
  }

  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ProviderError(
      providerId,
      "configuration",
      `Provider 地址必须使用 https（本机回环可用 http）：${url.origin}`,
    );
  }
  return url;
}

/** `postJson` 的注入项 */
export interface PostJsonOptions {
  providerId: string;
  url: string;
  headers: Record<string, string>;
  /** 请求体；调用方保证已经脱敏 */
  body: unknown;
  /** 整次请求的超时（毫秒） */
  timeoutMs: number;
  /** 可注入 fetch，便于测试 */
  fetchImpl: typeof fetch;
  /** 外部取消信号（用户中断等） */
  signal?: AbortSignal;
}

/**
 * POST JSON 并返回解析后的响应体。
 *
 * @throws {@link ProviderError} 超时、网络失败、非 2xx、响应不是合法 JSON
 */
export async function postJson(opts: PostJsonOptions): Promise<unknown> {
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  const abort = (): void => controller.abort();

  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
  }
  if (timeoutSignal.aborted) controller.abort();
  else timeoutSignal.addEventListener("abort", abort, { once: true });

  let response: Response;
  try {
    response = await opts.fetchImpl(opts.url, {
      method: "POST",
      headers: opts.headers,
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new ProviderError(opts.providerId, "timeout", `Provider 请求超时（${opts.timeoutMs}ms）`, {
        cause: err,
      });
    }
    if (opts.signal?.aborted) {
      throw new ProviderError(opts.providerId, "timeout", "Provider 请求已被调用方取消", { cause: err });
    }
    throw new ProviderError(opts.providerId, "network", "Provider 网络请求失败", { cause: err });
  } finally {
    opts.signal?.removeEventListener("abort", abort);
    timeoutSignal.removeEventListener("abort", abort);
  }

  if (!response.ok) {
    // 刻意不读取 response.text()：错误正文可能回显 prompt
    throw new ProviderError(
      opts.providerId,
      kindForHttpStatus(response.status),
      `Provider 返回 HTTP ${response.status}`,
      { status: response.status },
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new ProviderError(opts.providerId, "network", "读取 Provider 响应失败", { cause: err });
  }

  try {
    // JSON.parse 返回 any；显式落到 unknown，避免 any 在包内扩散
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (err) {
    throw new ProviderError(opts.providerId, "invalid_response", "Provider 响应不是合法 JSON", {
      cause: err,
    });
  }
}
