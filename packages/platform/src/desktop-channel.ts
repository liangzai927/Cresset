/**
 * 桌面通道：daemon 反向调用 Electron 弹原生通知
 *
 * ## 为什么是"daemon 调 UI"而不是"UI 调 daemon"
 *
 * 通知的**决策**属于 daemon（它知道什么时候该响），
 * 通知的**呈现**必须由持有 GUI 权限的进程完成（Electron 的 Notification）。
 * 因此方向只能是 daemon → Electron。
 *
 * 完整方案见 `docs/ADR-R3-01-原生通知接通方案.md`。
 *
 * ## 端点发现机制
 *
 * Electron 启动时开一个本地 HTTP 服务，把端点与 token 写进 `<dataDir>/channel.json`（0600）。
 * 本模块**每次投递前重新读取**该文件，而不是启动时读一次 —— 这样：
 *   - Electron 重启（换端口）后立刻生效，无需重启 daemon
 *   - Electron 未启动时该渠道自然不可用，降级链照常工作
 *
 * ## 安全边界
 *
 * - 只连 `127.0.0.1`（URL 前缀强制校验，防止配置被改指向外部）
 * - 必带 `Authorization: Bearer <token>`
 * - 校验 `pid` 存活，避免用已死进程留下的陈旧文件
 * - 超时必设（否则会卡住整个投递循环）
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { ChannelOutcome, Notifier, NotifyPayload } from "./index.js";
import { OsascriptNotifier } from "./macos-notifier.js";

/** `channel.json` 的结构（由 Electron 主进程写入） */
export interface DesktopChannelFile {
  endpoint: string;
  token: string;
  pid: number;
  startedAt: number;
}

/** 读取 channel.json 的结果；`reason` 便于把失败原因暴露到界面上 */
export type ChannelDiscovery =
  | { available: true; channel: DesktopChannelFile }
  | { available: false; reason: string };

/**
 * 判断 pid 对应进程是否存活。
 *
 * 用 `process.kill(pid, 0)`：这是 POSIX 的标准探测方式，不发送真实信号。
 * - 成功返回 → 进程存在
 * - 抛 `EPERM` → 进程存在但无权限（仍算存活）
 * - 抛 `ESRCH` → 进程不存在
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 发现桌面通道端点。
 *
 * @param channelFilePath `channel.json` 的绝对路径
 * @param opts.removeStale 是否删除陈旧的 channel.json（默认 true）
 */
export function discoverDesktopChannel(
  channelFilePath: string,
  opts: { removeStale?: boolean } = {},
): ChannelDiscovery {
  if (!existsSync(channelFilePath)) {
    return { available: false, reason: "桌面通道未启动（channel.json 不存在）" };
  }

  let raw: string;
  try {
    raw = readFileSync(channelFilePath, "utf8");
  } catch (err) {
    return { available: false, reason: `channel.json 无法读取：${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { available: false, reason: "channel.json 内容不是合法 JSON" };
  }

  const obj = parsed as Partial<DesktopChannelFile>;
  if (typeof obj.endpoint !== "string" || typeof obj.token !== "string" || typeof obj.pid !== "number") {
    return { available: false, reason: "channel.json 缺少必需字段（endpoint/token/pid）" };
  }

  // ★ 安全：只接受 loopback 地址，绝不连外部主机
  // （即使 channel.json 被篡改为 cloud.example.com 也必须拒绝）
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(obj.endpoint)) {
    return { available: false, reason: `endpoint 不是本机地址，已拒绝：${obj.endpoint}` };
  }

  if (!isProcessAlive(obj.pid)) {
    // 陈旧文件：Electron 崩溃/被强杀后遗留。删除它，避免每次投递都白试一遍。
    if (opts.removeStale !== false) {
      try {
        unlinkSync(channelFilePath);
      } catch {
        /* 删除失败不影响判定：仍然视为不可用 */
      }
    }
    return { available: false, reason: `桌面通道进程已退出（pid ${obj.pid}）` };
  }

  return { available: true, channel: obj as DesktopChannelFile };
}

/** 桌面通道客户端的构造选项；`timeoutMs` 必设，否则会阻塞投递循环 */
export interface DesktopChannelSenderOptions {
  /** channel.json 的绝对路径 */
  channelFilePath: string;
  /** 单次投递超时（毫秒）；必须设置，否则会阻塞投递循环 */
  timeoutMs?: number;
  /** 可注入 fetch，便于测试 */
  fetchImpl?: typeof fetch;
  /** 缓存发现结果的时长（毫秒）。默认 0 = 每次重新发现（正确性优先） */
  discoveryCacheMs?: number;
}

/**
 * 桌面通道的 daemon 侧实现。
 *
 * 注意它的 `channel` 标记为 `os_notification` —— 对调度器而言这与"原生通知"是同一个渠道，
 * 换实现不该改变调度语义。底层的区别（走 HTTP 到 Electron）属于本模块的内部细节。
 */
export class DesktopChannelSender implements Notifier {
  readonly channel = "os_notification" as const;

  readonly #channelFilePath: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #discoveryCacheMs: number;
  /** 上一次发现结果与其时间戳（仅在 cacheMs > 0 时使用） */
  #cached: { at: number; result: ChannelDiscovery } | null = null;
  #lastProbe: ChannelDiscovery | null = null;

  constructor(opts: DesktopChannelSenderOptions) {
    this.#channelFilePath = opts.channelFilePath;
    this.#timeoutMs = opts.timeoutMs ?? 5_000;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#discoveryCacheMs = opts.discoveryCacheMs ?? 0;
  }

  /** 当前发现结果（供诊断页展示"为什么走兜底"） */
  get lastDiscovery(): ChannelDiscovery | null {
    return this.#lastProbe;
  }

  #discover(): ChannelDiscovery {
    if (this.#discoveryCacheMs > 0 && this.#cached) {
      if (Date.now() - this.#cached.at < this.#discoveryCacheMs) return this.#cached.result;
    }
    const result = discoverDesktopChannel(this.#channelFilePath);
    this.#lastProbe = result;
    if (this.#discoveryCacheMs > 0) this.#cached = { at: Date.now(), result };
    return result;
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const d = this.#discover();
    if (!d.available) return { ok: false, detail: d.reason };

    // 真正打一次健康检查，而不是"文件在就算可用"——
    // 文件在但服务没起来是最容易漏掉的一种失败
    try {
      const res = await this.#fetch(`${d.channel.endpoint}/health`, {
        method: "GET",
        headers: { authorization: `Bearer ${d.channel.token}` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!res.ok) return { ok: false, detail: `桌面通道健康检查失败：HTTP ${res.status}` };

      // 通道"可达"不等于"系统通知能用"。
      // Electron 侧会告诉我们它能否真正弹系统通知；不能时它会用前台强提醒兜底，
      // 因此这里仍然算可用，但必须把真实方式说清楚 —— 否则用户会以为系统通知在工作。
      const body = (await res.json().catch(() => ({}))) as { supported?: boolean };
      if (body.supported === false) {
        return {
          ok: true,
          detail: "桌面通道可用，但系统通知被系统拒绝（将用窗口提醒兜底，见上方说明）",
        };
      }
      return { ok: true, detail: `桌面通道可用（${d.channel.endpoint}）` };
    } catch (err) {
      return { ok: false, detail: `桌面通道无法连接：${(err as Error).message}` };
    }
  }

  async send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }> {
    const d = this.#discover();
    if (!d.available) {
      // 不是"失败"而是"该渠道当前不存在"：交给降级链直接用 CLI 兜底
      return { outcome: "permanent_error", error: d.reason };
    }

    try {
      const res = await this.#fetch(`${d.channel.endpoint}/notify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${d.channel.token}`,
        },
        body: JSON.stringify({
          title: payload.title,
          ...(payload.body ? { body: payload.body } : {}),
          sound: payload.sound !== false,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });

      if (res.ok) {
        // 让 Electron 告诉我们它是否真的弹出来了（权限被拒时会返回非 success）
        const body = (await res.json().catch(() => ({}))) as {
          outcome?: unknown;
          error?: string;
          layer?: string;
          systemError?: string;
        };
        // 防御：outcome 必须是字符串。若对端返回了对象（曾经发生过），
        // 直接当作成功会让调用方把对象写进数据库 —— 这里显式识别并降级为成功，
        // 因为"对端返回 200 且结构异常"通常意味着已经投递过。
        if (body.outcome === undefined) return { outcome: "success" };
        if (typeof body.outcome !== "string") {
          return {
            outcome: "success",
            ...(body.systemError ? { error: `对端返回结构异常：${body.systemError}` } : {}),
          };
        }
        if (body.outcome === "success") return { outcome: "success" };
        const outcome = body.outcome as ChannelOutcome;
        return { outcome, ...(body.error ? { error: body.error } : {}) };
      }

      // 401/403 = token 不对 → 永久错误（重试无意义，直接降级）
      if (res.status === 401 || res.status === 403) {
        return { outcome: "permanent_error", error: `桌面通道鉴权失败：HTTP ${res.status}` };
      }
      // 5xx 与其它 4xx：瞬时错误，值得重试
      return { outcome: "transient_error", error: `桌面通道返回 HTTP ${res.status}` };
    } catch (err) {
      const e = err as Error & { name?: string };
      // AbortSignal.timeout 触发的是 TimeoutError
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        return { outcome: "timeout", error: `桌面通道超时（${this.#timeoutMs}ms）` };
      }
      // Electron 正在退出时常见 ECONNRESET / ECONNREFUSED：瞬时错误
      return { outcome: "transient_error", error: `桌面通道调用失败：${e.message}` };
    }
  }
}

/**
 * 动态原生通道：每次投递时重新判断"桌面通道是否可用"，
 * 不可用时立即让位给下一个渠道（CLI 兜底）。
 *
 * 之所以包一层而不是直接用 `DesktopChannelSender`：
 * 调度器会在构造时固定渠道列表，但"Electron 是否开着"是**随时会变**的。
 * 因此这里把"不可用"翻译成 `permanent_error`（触发降级），而不是抛错。
 */
export function createDesktopChannelSender(opts: DesktopChannelSenderOptions): DesktopChannelSender {
  return new DesktopChannelSender(opts);
}

/**
 * 渠道探测工场。
 *
 * 用途：界面上的"设置 / 诊断"页需要展示**每条渠道当前是否可用**，
 * 让用户理解"为什么这次走的是 CLI 兜底"。
 *
 * 这里只放"构造一个可用于 probe() 的实例"的轻量逻辑，
 * 不参与实际投递（投递由调度器持有的 notifier 列表完成）。
 */
export const desktopChannelProbe = {
  /**
   * 构造一个"仅用于探测"的 CLI 兜底渠道。
   *
   * 之所以要它：调度器内部的渠道实例不暴露给界面（避免界面误调用 send），
   * 但界面需要它的 `probe()` 结果。
   */
  cliFallback(): Notifier {
    return new OsascriptNotifier();
  },
};
