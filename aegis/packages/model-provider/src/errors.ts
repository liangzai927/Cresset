/**
 * Provider 领域错误
 *
 * 安全约束：错误信息只允许包含 provider id、错误类别与 HTTP 状态码；
 * **绝不携带响应体或请求头**，避免把模型返回的敏感内容带进日志。
 */

/** 失败类别；决定调用方是否值得重试 */
export type ProviderErrorKind =
  | "configuration"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "invalid_response";

/** 可重试的错误类别 */
export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return kind === "rate_limit" || kind === "timeout" || kind === "network" || kind === "server";
}

/** HTTP 状态码 → 错误类别 */
export function kindForHttpStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "invalid_response";
}

/** 带安全错误信息的 Provider 异常 */
export class ProviderError extends Error {
  readonly providerId: string;
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;

  constructor(
    providerId: string,
    kind: ProviderErrorKind,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.providerId = providerId;
    this.kind = kind;
    this.status = options?.status;
  }
}
