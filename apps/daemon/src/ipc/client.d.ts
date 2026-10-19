/**
 * IPC 客户端 SDK
 *
 * 供两类调用方使用：
 *   - 测试（R1 的集成测试）
 *   - 未来的 Electron main / CLI
 *
 * ★ 关键语义（R0 S6 实测得出的约束 C-4）：
 *   **每次（重）连接都必须重放 `sys.hello` 握手。** 新连接 = 新的鉴权会话，
 *   服务端不会把上一个连接的鉴权状态带过来。少了这一步，重连后所有调用都会
 *   被 E_AUTH 拒绝 —— S6 第一次跑就是这么失败的。
 *
 *   本类把"登记握手参数 → 连接时自动重放"内聚在这里，调用方无需记着这件事。
 */
import { type HealthView } from "@aegis/ipc-contract";
/** 握手文件内容；token 只经此文件传递（不走命令行/环境变量，那些会出现在进程列表） */
export interface HandshakeFileShape {
    token: string;
    pid: number;
    protocolVersion: number;
    endpoint: string;
    dataDir: string;
    startedAt: number;
}
/** 读取并校验握手文件；内容不完整时抛错（而不是返回半截数据） */
export declare function readHandshakeFile(path: string): HandshakeFileShape;
/** 协议版本不匹配；客户端应提示升级，而不是静默错乱 */
export declare class ProtocolMismatchError extends Error {
    readonly serverVersion: number;
    readonly clientVersion: number;
    constructor(serverVersion: number, clientVersion: number);
}
/** 服务端返回的 JSON-RPC 错误 */
export declare class RpcError extends Error {
    readonly code: number;
    constructor(code: number, message: string);
}
/** IPC 客户端选项；`onEvent`/`onStateChange` 用于把连接状态暴露给上层 */
export interface IpcClientOptions {
    endpoint: string;
    token: string;
    clientVersion?: string;
    /** 单次请求超时（毫秒） */
    requestTimeoutMs?: number;
    /** 事件回调 */
    onEvent?: (event: string, payload: unknown) => void;
    /** 连接状态变化（供上层提示"daemon 未运行"） */
    onStateChange?: (state: "connecting" | "connected" | "disconnected") => void;
}
/**
 * IPC 客户端。
 *
 * ★ 关键语义（约束 C-4）：**每次（重）连接都必须重放 `sys.hello` 握手** ——
 * 新连接是新的鉴权会话，服务端不会沿用上一个连接的鉴权状态。
 * 本类把"连接时自动重放握手"内聚在内部，调用方无需记着这件事。
 */
export declare class IpcClient {
    #private;
    constructor(opts: IpcClientOptions);
    get handshake(): {
        protocolVersion: number;
        daemonVersion: string;
        dataDir: string;
        startedAt: number;
    } | null;
    get connected(): boolean;
    /** 建立连接并完成握手 */
    connect(): Promise<void>;
    /** 带重试的连接（daemon 可能尚未就绪——启动顺序竞态是常态） */
    connectWithRetry(maxMs?: number, intervalMs?: number): Promise<boolean>;
    /** 请求（自动复用当前连接；未连接则先连） */
    call<T = unknown>(method: string, params?: unknown): Promise<T>;
    health(): Promise<HealthView>;
    close(): void;
}
//# sourceMappingURL=client.d.ts.map