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

import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { type HealthView, PROTOCOL_VERSION } from "@aegis/ipc-contract";

/** 握手文件内容；token 只经此文件传递（不走命令行/环境变量，那些会出现在进程列表） */
export interface HandshakeFileShape {
  token: string;
  pid: number;
  protocolVersion: number;
  endpoint: string;
  dataDir: string;
  startedAt: number;
  /** 旧版 daemon 可能没有这三个诊断字段，因此按可选读取 */
  daemonVersion?: string;
  nodeExecPath?: string;
  daemonEntry?: string;
}

/** 读取并校验握手文件；内容不完整时抛错（而不是返回半截数据） */
export function readHandshakeFile(path: string): HandshakeFileShape {
  const raw = JSON.parse(readFileSync(path, "utf8")) as HandshakeFileShape;
  if (!raw.token || !raw.endpoint) {
    throw new Error(`握手文件内容不完整：${path}`);
  }
  return raw;
}

/** 协议版本不匹配；客户端应提示升级，而不是静默错乱 */
export class ProtocolMismatchError extends Error {
  constructor(
    readonly serverVersion: number,
    readonly clientVersion: number,
  ) {
    super(`协议版本不匹配：服务端 ${serverVersion}，客户端 ${clientVersion}`);
    this.name = "ProtocolMismatchError";
  }
}

/** 服务端返回的 JSON-RPC 错误 */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
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

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * IPC 客户端。
 *
 * ★ 关键语义（约束 C-4）：**每次（重）连接都必须重放 `sys.hello` 握手** ——
 * 新连接是新的鉴权会话，服务端不会沿用上一个连接的鉴权状态。
 * 本类把"连接时自动重放握手"内聚在内部，调用方无需记着这件事。
 */
export class IpcClient {
  readonly #opts: Required<
    Pick<IpcClientOptions, "endpoint" | "token" | "clientVersion" | "requestTimeoutMs">
  > &
    Pick<IpcClientOptions, "onEvent" | "onStateChange">;
  #socket: Socket | null = null;
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #handshakeResult: {
    protocolVersion: number;
    daemonVersion: string;
    dataDir: string;
    startedAt: number;
  } | null = null;

  constructor(opts: IpcClientOptions) {
    this.#opts = {
      endpoint: opts.endpoint,
      token: opts.token,
      clientVersion: opts.clientVersion ?? "0.0.0",
      requestTimeoutMs: opts.requestTimeoutMs ?? 5_000,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.onStateChange ? { onStateChange: opts.onStateChange } : {}),
    };
  }

  get handshake(): {
    protocolVersion: number;
    daemonVersion: string;
    dataDir: string;
    startedAt: number;
  } | null {
    return this.#handshakeResult;
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  /** 建立连接并完成握手 */
  async connect(): Promise<void> {
    this.#opts.onStateChange?.("connecting");
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(this.#opts.endpoint);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });

    this.#attach(socket);
    try {
      await this.#handshake();
      this.#opts.onStateChange?.("connected");
    } catch (err) {
      socket.destroy();
      this.#socket = null;
      throw err;
    }
  }

  /** 带重试的连接（daemon 可能尚未就绪——启动顺序竞态是常态） */
  async connectWithRetry(maxMs = 3_000, intervalMs = 50): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    for (;;) {
      try {
        await this.connect();
        return true;
      } catch {
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }

  #attach(socket: Socket): void {
    this.#socket = socket;
    this.#buffer = "";
    socket.on("data", (chunk) => {
      this.#buffer += chunk.toString("utf8");
      let idx = this.#buffer.indexOf("\n");
      while (idx >= 0) {
        const line = this.#buffer.slice(0, idx).trim();
        this.#buffer = this.#buffer.slice(idx + 1);
        if (line) this.#handleLine(line);
        idx = this.#buffer.indexOf("\n");
      }
    });
    socket.on("error", () => {
      /* 断线由 close 处理 */
    });
    socket.on("close", () => {
      this.#socket = null;
      this.#opts.onStateChange?.("disconnected");
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        this.#pending.delete(id);
        p.reject(new Error("连接已断开"));
      }
    });
  }

  #handleLine(line: string): void {
    let msg: {
      id?: number | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.method !== undefined) {
      this.#opts.onEvent?.(msg.method, msg.params);
      return;
    }

    const id = typeof msg.id === "number" ? msg.id : null;
    if (id === null) return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new RpcError(msg.error.code, msg.error.message));
    else pending.resolve(msg.result);
  }

  /** ★ 握手：每次连接后都必须调用（C-4） */
  #handshake(): Promise<void> {
    return this.#rawCall("sys.hello", {
      token: this.#opts.token,
      clientVersion: this.#opts.clientVersion,
    }).then((result) => {
      const r = result as {
        protocolVersion: number;
        daemonVersion: string;
        dataDir: string;
        startedAt: number;
      };
      if (r.protocolVersion !== PROTOCOL_VERSION) {
        throw new ProtocolMismatchError(r.protocolVersion, PROTOCOL_VERSION);
      }
      this.#handshakeResult = r;
    });
  }

  /** 请求（自动复用当前连接；未连接则先连） */
  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (!this.connected) {
      const ok = await this.connectWithRetry();
      if (!ok) throw new Error(`无法连接到 daemon：${this.#opts.endpoint}`);
    }
    return this.#rawCall(method, params) as Promise<T>;
  }

  #rawCall(method: string, params: unknown): Promise<unknown> {
    const socket = this.#socket;
    if (!socket) return Promise.reject(new Error("未连接"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`请求超时：${method}`));
      }, this.#opts.requestTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async health(): Promise<HealthView> {
    return this.call<HealthView>("sys.health", {});
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }
}
