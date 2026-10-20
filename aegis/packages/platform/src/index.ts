/**
 * 平台适配层 —— 所有操作系统差异只允许出现在这里（NFR-X2）。
 *
 * M1 只实现 macOS；Windows / Linux 的接口先占位，M8 再补实现，
 * 目的是避免 M8 时"重构平台层"而不是"填实现"。
 */
export type ChannelOutcome = "success" | "transient_error" | "permanent_error" | "timeout";

/** 一条待投递的通知内容（渠道无关） */
export interface NotifyPayload {
  title: string;
  body?: string;
  /** 仅作为提示，是否发声由渠道实现决定 */
  sound?: boolean;
  /** 同一 tag 的通知可被系统合并/替换 */
  tag?: string;
  /**
   * 触发本次通知的 occurrence id。
   *
   * 仅桌面通道使用：界面收到提醒后，用户点"完成/稍后"需要它来调用
   * `task.complete` / `task.snooze`。系统通知与 CLI 渠道忽略它。
   */
  occurrenceId?: string;
}

/**
 * 通知渠道适配器。
 *
 * `probe()` 用于启动自检：渠道不可用时必须让用户看得见，而不是静默不发
 * （D5 决策要求实现 CLI 兜底通道，正是为了消除"UI 挂了就不响"的单点依赖）。
 */
export interface Notifier {
  readonly channel: "os_notification" | "cli_fallback" | "webhook" | "fanout";
  /** 是否可用（权限、依赖是否存在） */
  probe(): Promise<{ ok: boolean; detail: string }>;
  send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }>;
}

/** 开机自启管理（macOS LaunchAgent / Windows 计划任务 / Linux systemd user unit） */
export interface AutostartManager {
  isEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
}

/** 系统权限状态；unknown 表示尚未询问过 */
export interface PermissionStatus {
  notifications: "granted" | "denied" | "unknown";
}

export * from "./autostart.js";
export * from "./composite-notifier.js";
export * from "./desktop-channel.js";
export * from "./macos-notifier.js";
export * from "./webhook-notifier.js";
