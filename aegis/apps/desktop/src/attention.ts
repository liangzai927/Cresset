/**
 * 分层提醒 —— 保证"提醒真的能被感知"，而不只是"调用成功"
 *
 * ## 为什么需要这一层
 *
 * macOS 上**未用 Developer ID 正式签名的应用拿不到通知权限**。实测证据：
 *
 * | 启动方式 | `Notification.show()` 的结果 |
 * | --- | --- |
 * | 原始 Electron 二进制 | `failed: UNErrorDomain 错误 1` |
 * | 打包 + ad-hoc 签名 | `failed: Notifications are not allowed for this application` |
 * | 系统设置里 | **完全查不到该应用**，用户想手动授权也做不到 |
 *
 * 更关键的是：`Notification.show()` **不抛异常**，只有 `show` / `failed` 事件能区分
 * "真的显示了"和"被系统拒绝了"。早期实现只看"没抛错"就报 success，
 * 于是界面上写着"已发送"，用户什么也没收到 —— 这是最坏的一种失败：**看起来在工作**。
 *
 * ## 分层策略
 *
 * ```
 * ① 系统通知（体验最好）── 失败/未显示 ──► ② 前台强提醒
 *                                           · 窗口弹到最前
 *                                           · Dock 图标跳动
 *                                           · 系统提示音
 *                                           · 应用内横幅（需手动确认后消失）
 * ```
 *
 * 第 ② 层不依赖任何权限，是"提醒一定能到达你眼前"的保底。
 * 它的代价是必须有窗口（daemon 独立运行时不成立），因此它只能是兜底而不是替代。
 *
 * ## 与 daemon 的关系
 *
 * daemon 仍然只认"这个渠道成功/失败"。分层是 Electron 侧的实现细节 ——
 * 对 daemon 而言，"用户被提醒到了"就是成功，无论用的是哪一层。
 * 但**层信息会回传并展示在界面上**，用户能看到"当前系统通知不可用，正用窗口提醒"。
 */

import { app, type BrowserWindow, Notification, shell } from "electron";

/** 提醒实际生效的层 */
export type AttentionLayer = "system_notification" | "in_app";

/** 分层提醒的结果 */
export interface AttentionResult {
  /** 对调度器而言是否算成功（任一层生效即为成功） */
  ok: boolean;
  /** 实际生效的层 */
  layer: AttentionLayer | null;
  /** 失败原因（两层都失败时） */
  error?: string;
  /** 系统通知被拒绝的具体原因（用于界面解释） */
  systemError?: string;
}

/** 一条要送达用户的通知内容；`sound=false` 用于自检探测（不打扰用户） */
export interface AttentionPayload {
  title: string;
  body?: string;
  sound: boolean;
  /** 触发本次提醒的 occurrence；界面据此提供"完成/稍后"操作 */
  occurrenceId?: string;
}

/** 系统通知"是否真的显示"的等待上限（毫秒） */
const SHOW_TIMEOUT_MS = 1_500;

/**
 * 尝试系统通知，并**确认它真的显示了**。
 *
 * @returns `{ shown, error }`；`shown=false` 时 `error` 说明原因
 */
export function trySystemNotification(
  payload: AttentionPayload,
  timeoutMs = SHOW_TIMEOUT_MS,
): Promise<{ shown: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (shown: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      resolve({ shown, ...(error ? { error } : {}) });
    };

    if (!Notification.isSupported()) {
      settle(false, "本机不支持系统通知");
      return;
    }

    let n: Notification;
    try {
      n = new Notification({
        title: payload.title,
        ...(payload.body ? { body: payload.body } : {}),
        silent: !payload.sound,
      });
    } catch (err) {
      settle(false, `创建通知失败：${(err as Error).message}`);
      return;
    }

    // ★ 只有 show 事件能证明"真的显示了"。
    // failed 事件在 macOS 上会带上系统给出的拒绝原因（如权限未授予）。
    n.on("show", () => settle(true));
    n.on("failed", (_event, error) => settle(false, error ?? "系统拒绝显示"));

    try {
      n.show();
    } catch (err) {
      settle(false, `调用 show() 失败：${(err as Error).message}`);
      return;
    }

    // 超时未收到 show → 视为未显示。
    // 系统在某些拒绝场景下既不发 show 也不发 failed，只能靠超时兜住。
    setTimeout(() => settle(false, `${timeoutMs}ms 内未收到显示确认`), timeoutMs);
  });
}

/**
 * 前台强提醒：把用户的注意力拉回来。
 *
 * 这一层不依赖通知权限，只要应用进程活着就有效。
 */
export function triggerInAppAttention(win: BrowserWindow | null, payload: AttentionPayload): boolean {
  let did = false;

  // ① 窗口置前（用户可能把窗口最小化或隐藏到托盘了）
  if (win && !win.isDestroyed()) {
    try {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.show(); // 确保从托盘状态恢复
      win.focus();
      win.flashFrame(true); // macOS 上 Dock 图标会跳动
      did = true;
    } catch {
      /* 窗口操作失败不致命 */
    }

    // ② 应用内横幅：由 renderer 渲染，需用户确认后才消失。
    // 必须先查 webContents 是否已销毁：退出过程中 send 会抛 "Object has been destroyed"。
    try {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send("aegis:alert", payload);
        did = true;
      }
    } catch {
      /* 渲染进程可能已退出 */
    }
  }

  // ③ Dock 跳动（macOS 专有，最显眼的一种"看我一眼"）
  try {
    app.dock?.bounce("critical");
    did = true;
  } catch {
    /* 非 macOS 或 Dock 不可用 */
  }

  // ④ 提示音：即使窗口被遮挡也能听见。
  // 用 shell.beep 而不是 afplay —— 不依赖外部命令，且尊重系统音量设置。
  try {
    shell.beep();
    did = true;
  } catch {
    /* 无声环境（CI）里失败也无所谓 */
  }

  return did;
}

/** 分层提醒：先试系统通知，不行就用前台强提醒 */
export async function deliverWithAttention(
  win: BrowserWindow | null,
  payload: AttentionPayload,
): Promise<AttentionResult> {
  const sys = await trySystemNotification(payload);
  if (sys.shown) return { ok: true, layer: "system_notification" };

  const inApp = triggerInAppAttention(win, payload);
  if (inApp) {
    return {
      ok: true,
      layer: "in_app",
      ...(sys.error ? { systemError: sys.error } : {}),
    };
  }

  return {
    ok: false,
    layer: null,
    error: `系统通知不可用（${sys.error ?? "未知"}），且无可用窗口做前台提醒`,
    ...(sys.error ? { systemError: sys.error } : {}),
  };
}

/**
 * 探测系统通知在当前环境下是否真的可用。
 *
 * 启动时用一条**静音、无内容**的探测通知判断，结果缓存。
 * 之所以要真发一条而不是查 API：`Notification.isSupported()` 在未授权时同样返回 true
 * （实测），只有 show/failed 事件能反映真实情况。
 */
export async function probeSystemNotification(): Promise<{ ok: boolean; detail: string }> {
  const r = await trySystemNotification({ title: "Aegis 通知能力自检", body: "", sound: false }, 1_200);
  return r.shown
    ? { ok: true, detail: "系统通知可用" }
    : { ok: false, detail: `系统通知不可用：${r.error ?? "未获授权"}（将使用窗口提醒兜底）` };
}
