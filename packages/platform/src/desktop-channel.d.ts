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
import type { ChannelOutcome, Notifier, NotifyPayload } from "./index.js";
/** `channel.json` 的结构（由 Electron 主进程写入） */
export interface DesktopChannelFile {
    endpoint: string;
    token: string;
    pid: number;
    startedAt: number;
}
/** 读取 channel.json 的结果；`reason` 便于把失败原因暴露到界面上 */
export type ChannelDiscovery = {
    available: true;
    channel: DesktopChannelFile;
} | {
    available: false;
    reason: string;
};
/**
 * 发现桌面通道端点。
 *
 * @param channelFilePath `channel.json` 的绝对路径
 * @param opts.removeStale 是否删除陈旧的 channel.json（默认 true）
 */
export declare function discoverDesktopChannel(channelFilePath: string, opts?: {
    removeStale?: boolean;
}): ChannelDiscovery;
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
export declare class DesktopChannelSender implements Notifier {
    #private;
    readonly channel: "os_notification";
    constructor(opts: DesktopChannelSenderOptions);
    /** 当前发现结果（供诊断页展示"为什么走兜底"） */
    get lastDiscovery(): ChannelDiscovery | null;
    probe(): Promise<{
        ok: boolean;
        detail: string;
    }>;
    send(payload: NotifyPayload): Promise<{
        outcome: ChannelOutcome;
        error?: string;
    }>;
}
/**
 * 动态原生通道：每次投递时重新判断"桌面通道是否可用"，
 * 不可用时立即让位给下一个渠道（CLI 兜底）。
 *
 * 之所以包一层而不是直接用 `DesktopChannelSender`：
 * 调度器会在构造时固定渠道列表，但"Electron 是否开着"是**随时会变**的。
 * 因此这里把"不可用"翻译成 `permanent_error`（触发降级），而不是抛错。
 */
export declare function createDesktopChannelSender(opts: DesktopChannelSenderOptions): DesktopChannelSender;
/**
 * 渠道探测工场。
 *
 * 用途：界面上的"设置 / 诊断"页需要展示**每条渠道当前是否可用**，
 * 让用户理解"为什么这次走的是 CLI 兜底"。
 *
 * 这里只放"构造一个可用于 probe() 的实例"的轻量逻辑，
 * 不参与实际投递（投递由调度器持有的 notifier 列表完成）。
 */
export declare const desktopChannelProbe: {
    /**
     * 构造一个"仅用于探测"的 CLI 兜底渠道。
     *
     * 之所以要它：调度器内部的渠道实例不暴露给界面（避免界面误调用 send），
     * 但界面需要它的 `probe()` 结果。
     */
    cliFallback(): Notifier;
};
//# sourceMappingURL=desktop-channel.d.ts.map