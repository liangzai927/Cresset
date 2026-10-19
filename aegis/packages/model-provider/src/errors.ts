/**
 * Provider 调用的领域错误
 *
 * ## 为什么错误里没有响应正文
 *
 * 厂商的错误响应经常回显请求内容（包括 prompt）。如果把 body 拼进
 * `Error.message`，它会顺着日志/界面一路扩散，等于把**已脱敏的数据又还原回去**。
 * 因此这里只保留：provider id、错误类别、HTTP 状态码。
 *
 * 本文件不读环境变量、不发起请求。
 */

/** Provider 失败类别；决定调用方是否值得重试 */
export type ProviderErrorKind =
  | "configuration"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "invalid_response";

/** `ProviderError` 的可选信息 */
export interface ProviderErrorOptions {
  /** HTTP 状态码（没有 HTTP 层时为 undefined） */
  status?: number;
  /** 覆盖按 kind 推导的 retryable 默认值 */
  retryable?: boolean;
  /** 原始异常，便于上层日志记录类型（**不要**把其中的 message 直接给用户） */
  cause?: unknown;
}

/** 默认重试语义：网络/限流/超时/5xx 可重试，配置/鉴权/响应格式不可重试 */
export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return kind === "rate_limit" || kind === "timeout" || kind === "network" || kind === "server";
}

/** Provider 调用失败；`name` 固定为 ProviderError，便于日志区分 */
export class ProviderError extends Error {
  readonly providerId: string;
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(providerId: string, kind: ProviderErrorKind, message: string, opts: ProviderErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderError";
    this.providerId = providerId;
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? isRetryableKind(kind);
  }
}

/** 把 HTTP 状态码映射成错误类别；不读取响应正文 */
export function kindForHttpStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 404 || status === 422) return "invalid_response";
  if (status >= 500) return "server";
  return "invalid_response";
}
