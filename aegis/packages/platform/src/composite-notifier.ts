/**
 * 多渠道 fanout（M3）
 *
 * 当用户同时启用桌面通知与 Webhook 时，希望"两边都发"，而不是桌面成功就
 * 不再发远程。本类把多个 Notifier 包成一个逻辑渠道：并行发送，任一成功即成功；
 * 全部失败才交给调度器的下一级兜底。
 */

import type { ChannelOutcome, Notifier, NotifyPayload } from "./index.js";

/** 扇出渠道 */
export class CompositeNotifier implements Notifier {
  readonly channel = "fanout" as const;
  readonly #notifiers: Notifier[];

  constructor(notifiers: Notifier[]) {
    this.#notifiers = notifiers;
  }

  /** 任一子渠道可用即视为可用；详情列出每个渠道 */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    const results = await Promise.all(
      this.#notifiers.map(async (n) => ({ channel: n.channel, ...(await n.probe()) })),
    );
    return {
      ok: results.some((r) => r.ok),
      detail: results.map((r) => `${r.channel}: ${r.ok ? "ok" : r.detail}`).join("; "),
    };
  }

  /** 并行发送；至少一个 success 即 success */
  async send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }> {
    if (this.#notifiers.length === 0) return { outcome: "permanent_error", error: "没有可用渠道" };
    const results = await Promise.all(
      this.#notifiers.map(async (n) => ({
        channel: n.channel,
        ...(await n.send(payload).catch((err: unknown) => ({
          outcome: "transient_error" as const,
          error: (err as Error).message,
        }))),
      })),
    );
    if (results.some((r) => r.outcome === "success")) return { outcome: "success" };
    const allPermanent = results.every((r) => r.outcome === "permanent_error");
    const allTimeout = results.every((r) => r.outcome === "timeout");
    const outcome: ChannelOutcome = allPermanent
      ? "permanent_error"
      : allTimeout
        ? "timeout"
        : "transient_error";
    return {
      outcome,
      error: results
        .map((r) => `${r.channel}: ${r.error ?? r.outcome}`)
        .join("; ")
        .slice(0, 500),
    };
  }
}
