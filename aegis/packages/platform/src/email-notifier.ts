/**
 * SMTP 邮件通知渠道（M3）
 *
 * 密码是凭据：由 daemon 从系统钥匙串读取，本类只接收异步 provider。
 * 错误信息不回显密码；SMTP 连接超时由 nodemailer 的 timeout 配置控制。
 */

import { createTransport } from "nodemailer";
import type { ChannelOutcome, Notifier, NotifyPayload } from "./index.js";

/** 可注入的最小 SMTP transport，便于测试而不发真实邮件 */
export interface EmailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
  close?(): void;
}

/** SMTP 渠道配置 */
export interface EmailNotifierOptions {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  to: string;
  user?: string;
  password: () => Promise<string | null>;
  timeoutMs?: number;
  transportFactory?: (opts: {
    host: string;
    port: number;
    secure: boolean;
    auth?: { user: string; pass: string };
    connectionTimeout: number;
    socketTimeout: number;
  }) => EmailTransport;
}

/** SMTP 邮件渠道 */
export class EmailNotifier implements Notifier {
  readonly channel = "email" as const;
  readonly #opts: EmailNotifierOptions;
  readonly #timeoutMs: number;

  constructor(options: EmailNotifierOptions) {
    this.#opts = options;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** 只检查必填配置/密码是否存在，不连 SMTP */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.#opts.host || !this.#opts.to || !this.#opts.from) {
      return { ok: false, detail: "SMTP host/from/to 未配置" };
    }
    try {
      const pass = await this.#opts.password();
      return pass
        ? { ok: true, detail: "SMTP 配置存在（未发送探测邮件）" }
        : { ok: false, detail: "SMTP 密码未配置" };
    } catch {
      return { ok: false, detail: "钥匙串读取失败" };
    }
  }

  /** 发送一封纯文本邮件 */
  async send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }> {
    let pass: string | null;
    try {
      pass = await this.#opts.password();
    } catch {
      return { outcome: "permanent_error", error: "钥匙串读取失败" };
    }
    if (!pass) return { outcome: "permanent_error", error: "SMTP 密码未配置" };

    const factory =
      this.#opts.transportFactory ??
      ((opts) =>
        createTransport({
          host: opts.host,
          port: opts.port,
          secure: opts.secure,
          ...(opts.auth ? { auth: opts.auth } : {}),
          connectionTimeout: opts.connectionTimeout,
          socketTimeout: opts.socketTimeout,
        }));
    let transport: EmailTransport;
    try {
      transport = factory({
        host: this.#opts.host,
        port: this.#opts.port,
        secure: this.#opts.secure,
        ...(this.#opts.user ? { auth: { user: this.#opts.user, pass } } : {}),
        connectionTimeout: this.#timeoutMs,
        socketTimeout: this.#timeoutMs,
      });
    } catch {
      return { outcome: "permanent_error", error: "SMTP transport 创建失败" };
    }

    try {
      await transport.sendMail({
        from: this.#opts.from,
        to: this.#opts.to,
        subject: payload.title,
        text: [payload.title, payload.body].filter(Boolean).join("\n\n"),
      });
      return { outcome: "success" };
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "ETIMEDOUT" || code === "ECONNECTION") {
        return { outcome: "timeout", error: "SMTP 连接超时" };
      }
      const permanent = /auth|invalid|recipient|envelope/i.test(code) || /auth|invalid/i.test(String(err));
      return {
        outcome: permanent ? "permanent_error" : "transient_error",
        error: (err as Error).message.slice(0, 200),
      };
    } finally {
      transport.close?.();
    }
  }
}
