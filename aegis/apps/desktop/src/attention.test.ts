/**
 * 分层提醒测试
 *
 * 这里验证的是"提醒是否真的被感知"，而不是"API 有没有被调用"。
 * 背景：macOS 上未签名的应用会被系统拒绝投递通知，而 `Notification.show()`
 * **不抛异常** —— 只看"没报错"就会得出"发送成功"的错误结论，
 * 界面写着"已发送"、用户什么也没收到。这是最坏的一种失败：看起来在工作。
 *
 * 因此这里 mock 掉 electron，精确验证三件事：
 *   1. 只有收到 `show` 事件才算成功
 *   2. 收到 `failed` 或超时 → 判定失败并降级到前台强提醒
 *   3. 两层都不可用 → 明确失败（不谎报成功）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** 可脚本化的假 Notification */
class FakeNotification {
  static instances: FakeNotification[] = [];
  static supported = true;
  /** 每次 show() 时触发的事件序列 */
  static behavior: "show" | "failed" | "silent" = "show";
  static failReason = "Notifications are not allowed for this application";

  #handlers = new Map<string, (...args: unknown[]) => void>();

  constructor(readonly opts: { title: string; body?: string; silent?: boolean }) {
    FakeNotification.instances.push(this);
  }

  static isSupported(): boolean {
    return FakeNotification.supported;
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    this.#handlers.set(event, cb);
  }

  show(): void {
    const mode = FakeNotification.behavior;
    const h = this.#handlers;
    if (mode === "show") {
      // 真实环境下 show 事件是异步到达的
      setTimeout(() => h.get("show")?.(), 0);
    } else if (mode === "failed") {
      setTimeout(() => h.get("failed")?.({}, FakeNotification.failReason), 0);
    }
    // silent：两个事件都不发（某些拒绝场景），只能靠超时兜底
  }
}

const beep = vi.fn();
const bounce = vi.fn();
const fakeWin = {
  isDestroyed: () => false,
  isMinimized: () => false,
  isVisible: () => true,
  show: vi.fn(),
  focus: vi.fn(),
  restore: vi.fn(),
  flashFrame: vi.fn(),
  webContents: { isDestroyed: () => false, send: vi.fn() },
};

vi.mock("electron", () => ({
  Notification: FakeNotification,
  app: { dock: { bounce } },
  shell: { beep },
}));

const { deliverWithAttention, trySystemNotification } = await import("./attention.js");

beforeEach(() => {
  FakeNotification.instances = [];
  FakeNotification.behavior = "show";
  FakeNotification.supported = true;
  beep.mockClear();
  bounce.mockClear();
  fakeWin.show.mockClear();
  fakeWin.focus.mockClear();
  fakeWin.webContents.send.mockClear();
});

describe("trySystemNotification", () => {
  it("收到 show 事件才算真的显示了", async () => {
    const r = await trySystemNotification({ title: "t", sound: false });
    expect(r.shown).toBe(true);
  });

  it("★ 收到 failed 事件时判定失败，并带上系统给出的原因", async () => {
    FakeNotification.behavior = "failed";
    const r = await trySystemNotification({ title: "t", sound: false });
    expect(r.shown).toBe(false);
    expect(r.error).toContain("not allowed");
  });

  it("★ 两个事件都不发时靠超时兜底（不能因为没报错就当成功）", async () => {
    FakeNotification.behavior = "silent";
    const r = await trySystemNotification({ title: "t", sound: false }, 50);
    expect(r.shown).toBe(false);
    expect(r.error).toContain("未收到显示确认");
  });

  it("系统不支持时直接失败", async () => {
    FakeNotification.supported = false;
    const r = await trySystemNotification({ title: "t", sound: false });
    expect(r.shown).toBe(false);
    expect(r.error).toContain("不支持");
  });
});

describe("deliverWithAttention：分层降级", () => {
  it("系统通知可用时优先用它（不触发窗口强提醒）", async () => {
    const r = await deliverWithAttention(fakeWin as never, { title: "t", sound: false });
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("system_notification");
    expect(beep).not.toHaveBeenCalled();
  });

  it("★ 系统通知失败时降级到前台强提醒（窗口置前 + Dock 跳动 + 响铃 + 应用内横幅）", async () => {
    FakeNotification.behavior = "failed";
    const r = await deliverWithAttention(fakeWin as never, { title: "提醒标题", body: "正文", sound: true });

    expect(r.ok).toBe(true); // 对调度器而言用户被提醒到了
    expect(r.layer).toBe("in_app");
    expect(r.systemError).toContain("not allowed");

    expect(fakeWin.show).toHaveBeenCalled();
    expect(fakeWin.focus).toHaveBeenCalled();
    expect(bounce).toHaveBeenCalledWith("critical");
    expect(beep).toHaveBeenCalled();
    expect(fakeWin.webContents.send).toHaveBeenCalledWith("aegis:alert", {
      title: "提醒标题",
      body: "正文",
      sound: true,
    });
  });

  it("没有窗口时仍会用声音与 Dock 提醒", async () => {
    FakeNotification.behavior = "failed";
    const r = await deliverWithAttention(null, { title: "t", sound: true });
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("in_app");
    expect(beep).toHaveBeenCalled();
  });

  it("★ 两层都不可用时明确失败，绝不谎报成功", async () => {
    FakeNotification.behavior = "failed";
    // 让所有前台手段都失效
    beep.mockImplementationOnce(() => {
      throw new Error("no audio");
    });
    bounce.mockImplementationOnce(() => {
      throw new Error("no dock");
    });
    const r = await deliverWithAttention(null, { title: "t", sound: true });
    expect(r.ok).toBe(false);
    expect(r.layer).toBeNull();
    expect(r.error).toBeTruthy();
  });
});
