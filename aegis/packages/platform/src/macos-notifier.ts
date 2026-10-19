/**
 * macOS 通知渠道实现
 *
 * ## 两个渠道，一条降级链
 *
 * | 渠道 | 实现 | 特点 |
 * | --- | --- | --- |
 * | `os_notification` | Electron 的 `Notification`（经注入的发送器） | 体验最好（有图标、可交互），但**依赖 Electron 主进程存活** |
 * | `cli_fallback` | `/usr/bin/osascript -e 'display notification …'` | 只要 daemon 活着就能响，是"UI 全挂也能提醒"的保障 |
 *
 * **为什么必须有 CLI 兜底**（D5 决策）：桌面通知的发送方是 Electron 应用，
 * 一旦应用崩溃、正在更新、或用户退出了界面进程，原生通道就断了。
 * 若没有兜底，用户会以为"提醒还在跑"，实际已经静默失效 —— 这是本项目最不能接受的失败模式。
 *
 * ## R0 S5 的实测结论（已固化在此实现中）
 *
 * - `osascript display notification` 命令成功且能在系统统一日志中检索到投递记录
 * - 命令成功 ≠ 用户一定看到（取决于通知权限与专注模式），因此首次启动必须有权限引导
 * - AppleScript 字符串需要转义：标题/正文里的引号与反斜杠会破坏脚本
 */

import { spawnSync } from "node:child_process";
import type { ChannelOutcome, Notifier, NotifyPayload } from "./index.js";

/**
 * AppleScript 字符串转义。
 *
 * ⚠️ 这是安全相关的：未转义的引号会让脚本语法错误（通知静默失败），
 * 更糟的是可能被用于注入额外的 AppleScript 语句。
 * 因此必须转义反斜杠（先）与双引号（后）。
 */
export function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 把通知内容拼成 AppleScript（导出以便测试转义正确性） */
export function buildAppleScript(payload: NotifyPayload): string {
  const title = escapeAppleScript(payload.title);
  const body = escapeAppleScript(payload.body ?? "");
  const sound = payload.sound === false ? "" : ' sound name "Ping"';
  return `display notification "${body}" with title "${title}"${sound}`;
}

/** osascript 渠道的可选项；`exec` 可注入以便测试而不真的发通知 */
export interface OsascriptNotifierOptions {
  /** 调用超时（毫秒）；osascript 卡住会阻塞投递循环 */
  timeoutMs?: number;
  /** 可注入命令执行器，便于测试 */
  exec?: (args: string[]) => { status: number | null; stdout: string; stderr: string; timedOut: boolean };
}

function defaultExec(timeoutMs: number) {
  return (args: string[]) => {
    const r = spawnSync("/usr/bin/osascript", args, { encoding: "utf8", timeout: timeoutMs });
    return {
      status: r.status,
      stdout: (r.stdout ?? "").trim(),
      stderr: (r.stderr ?? "").trim(),
      timedOut: r.signal === "SIGTERM",
    };
  };
}

/**
 * CLI 兜底渠道（经 `/usr/bin/osascript`）。
 *
 * 这是唯一**不依赖 Electron** 的投递方式，因此它在降级链中的位置是"最后一道保障"。
 */
export class OsascriptNotifier implements Notifier {
  readonly channel = "cli_fallback" as const;
  readonly #timeoutMs: number;
  readonly #exec: (args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  };

  constructor(opts: OsascriptNotifierOptions = {}) {
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#exec = opts.exec ?? defaultExec(this.#timeoutMs);
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    // 只检查命令存在与可执行，不真的发通知（探测不该打扰用户）
    if (process.platform !== "darwin") {
      return { ok: false, detail: `平台 ${process.platform} 不支持 osascript` };
    }
    const r = this.#exec(["-e", 'return "ok"']);
    return r.status === 0
      ? { ok: true, detail: "osascript 可用（CLI 兜底通道）" }
      : { ok: false, detail: `osascript 不可用：${r.stderr || r.status}` };
  }

  async send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }> {
    const r = this.#exec(["-e", buildAppleScript(payload)]);
    if (r.timedOut) return { outcome: "timeout", error: "osascript 超时（可能弹出了 GUI 交互）" };
    if (r.status === 0) return { outcome: "success" };
    // 区分瞬时与永久错误：权限类问题重试也不会好
    const err = r.stderr || `osascript 退出码 ${r.status}`;
    const permanent = /not authorized|assistive access|不允许|permission/i.test(err);
    return { outcome: permanent ? "permanent_error" : "transient_error", error: err };
  }
}

/**
 * 经 Electron 发送原生通知的渠道。
 *
 * daemon 与 Electron 是**两个进程**，因此这里不直接依赖 electron 包，
 * 而是注入一个"发送器"（由 Electron 主进程经 IPC 提供实现）。
 * 这样 platform 包保持零 Electron 依赖，也能在测试中用假发送器替换。
 */
export interface NativeSender {
  send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }>;
  probe(): Promise<{ ok: boolean; detail: string }>;
}

/** 经注入的发送器投递原生通知；未连接 Electron 时该渠道判定为不可用，由降级链接手 */
export class NativeNotifier implements Notifier {
  readonly channel = "os_notification" as const;
  readonly #sender: NativeSender | null;

  constructor(sender: NativeSender | null) {
    this.#sender = sender;
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.#sender) {
      return { ok: false, detail: "原生通知不可用（Electron 主进程未连接）" };
    }
    return this.#sender.probe();
  }

  async send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }> {
    if (!this.#sender) {
      // 不是失败而是"该渠道当前不可用"：让降级链立刻走到 CLI 兜底
      return { outcome: "permanent_error", error: "原生通知通道不可用（未连接 Electron）" };
    }
    return this.#sender.send(payload);
  }
}

/**
 * 按降级链构造渠道列表。
 *
 * 顺序即优先级：原生通知优先，CLI 兜底殿后。
 * `includeCliFallback` 为 false 时只保留原生通道（用于"我只想要静默通知"的配置）。
 */
export function defaultNotifiers(opts: {
  native: NativeSender | null;
  includeCliFallback?: boolean;
}): Notifier[] {
  const list: Notifier[] = [new NativeNotifier(opts.native)];
  if (opts.includeCliFallback !== false) list.push(new OsascriptNotifier());
  return list;
}
