/**
 * 按通知优先级分流（M3）
 *
 * 用户可以为 low/normal/high 分别配置渠道集合。调度器把通知优先级放进
 * NotifyPayload，本类据此选择渠道；未配置的级别回退到 normal。
 *
 * 这不是"扇出"本身：每组内部仍由 CompositeNotifier 并行发送。
 */

import { CompositeNotifier } from "./composite-notifier.js";
import type { ChannelOutcome, Notifier, NotifyPayload } from "./index.js";

/** 支持分流的优先级 */
export type NotifyPriority = "low" | "normal" | "high";

/** 路由配置 */
export interface RoutingNotifierOptions {
  routes: Partial<Record<NotifyPriority, Notifier[]>>;
}

/** 按优先级选择渠道 */
export class RoutingNotifier implements Notifier {
  readonly channel = "routing" as const;
  readonly #routes: Partial<Record<NotifyPriority, Notifier[]>>;

  constructor(options: RoutingNotifierOptions) {
    this.#routes = options.routes;
  }

  /** 所有已配置渠道任一可用即可 */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    const all = Object.values(this.#routes).flat();
    if (all.length === 0) return { ok: false, detail: "没有配置任何路由渠道" };
    const results = await Promise.all(all.map(async (n) => `${n.channel}:${(await n.probe()).ok}`));
    return { ok: all.length > 0, detail: results.join("; ") };
  }

  /** 选择优先级对应的组；组内并行，任一成功即成功 */
  async send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }> {
    const priority = payload.priority ?? "normal";
    const selected = this.#routes[priority] ?? this.#routes.normal;
    if (!selected || selected.length === 0) {
      return { outcome: "permanent_error", error: `没有为优先级 ${priority} 配置渠道` };
    }
    return new CompositeNotifier(selected).send(payload);
  }
}
