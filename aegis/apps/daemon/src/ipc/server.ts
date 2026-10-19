/**
 * IPC 服务端（《M0+M1 详细设计》§7，R0 S6 已验证该形态可行）
 *
 * 形态：UDS（macOS/Linux）/ NamedPipe（Windows）+ NDJSON 分帧 + JSON-RPC 2.0
 *
 * 两条来自 R0 S6 的硬约束：
 *   - **C-4**：客户端每次（重）连接都必须重放 `sys.hello` 握手 ——
 *     新连接是**新的鉴权会话**，服务端不得把上一个连接的鉴权状态带过去。
 *   - **C-7/协议侧**：UDS 不会自动清理 socket 文件，listen 前必须删除陈旧文件，
 *     否则会 EADDRINUSE（S6 踩到过）。
 *
 * 安全：
 *   - socket 文件权限 0600（仅本用户可连）
 *   - 首帧必须是 `sys.hello` 且 token 匹配，否则关闭连接（E_AUTH）
 *   - token 只写在 0600 的握手文件里，不落日志
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { type HealthView, PROTOCOL_VERSION, RpcErrorCode } from "@aegis/ipc-contract";

/** 一条 JSON-RPC 2.0 请求（NDJSON 单行） */
export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

/** RPC 方法处理器；抛错会被转成 E_INTERNAL 并记录日志 */
export type RpcHandler = (params: unknown, ctx: RpcContext) => Promise<unknown> | unknown;

/** 单次调用的上下文；`push` 用于向该连接主动推送事件 */
export interface RpcContext {
  /** 该连接是否已完成握手 */
  readonly authed: boolean;
  readonly connectionId: string;
  /** 主动向该连接推送事件 */
  push(event: string, payload: unknown): void;
}

/** IPC 服务端选项；`methods` 不包含 sys.hello（由服务端内置处理） */
export interface IpcServerOptions {
  /** UDS 路径或 NamedPipe 名 */
  endpoint: string;
  /** 握手 token */
  token: string;
  /** 服务端标识（hello 响应） */
  daemonVersion: string;
  dataDir: string;
  startedAt: number;
  /** RPC 方法表（不包含 sys.hello —— 由服务端内置处理） */
  methods: Record<string, RpcHandler>;
  /** 健康检查（sys.health） */
  health: () => HealthView;
  /** 日志回调（禁止在此打印 token） */
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

interface Conn {
  id: string;
  socket: Socket;
  buffer: string;
  authed: boolean;
}

/**
 * IPC 服务端（UDS / NamedPipe + NDJSON + JSON-RPC 2.0）。
 *
 * 安全约定：socket 文件 0600；首帧必须是 `sys.hello` 且 token 匹配，
 * 认证失败立即断开（不给暴力尝试留通道）。
 * UDS 不会自动清理，listen 前必须删除陈旧 socket（否则 EADDRINUSE，R0 踩过）。
 */
export class IpcServer {
  readonly #opts: IpcServerOptions;
  #server: Server | null = null;
  readonly #conns = new Map<string, Conn>();

  constructor(opts: IpcServerOptions) {
    this.#opts = opts;
  }

  get endpoint(): string {
    return this.#opts.endpoint;
  }

  get connectionCount(): number {
    return this.#conns.size;
  }

  get authedConnectionCount(): number {
    return [...this.#conns.values()].filter((c) => c.authed).length;
  }

  async listen(): Promise<void> {
    const isPipe = this.#opts.endpoint.startsWith("\\\\.");
    // UDS 不会自动清理：陈旧 socket 文件会导致 EADDRINUSE（S6 踩到过）
    if (!isPipe && existsSync(this.#opts.endpoint)) {
      rmSync(this.#opts.endpoint, { force: true });
    }

    const server = createServer((socket) => this.#onConnection(socket));
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once("error", onError);
      server.listen(this.#opts.endpoint, () => {
        server.off("error", onError);
        server.on("error", (err) => this.#opts.log?.("ipc.server_error", { error: String(err) }));
        resolve();
      });
    });

    // socket 文件权限 0600（仅本用户可连）
    if (!isPipe) {
      try {
        chmodSync(this.#opts.endpoint, 0o600);
      } catch (err) {
        this.#opts.log?.("ipc.chmod_failed", { error: String(err) });
      }
    }
    this.#opts.log?.("ipc.listening", { endpoint: this.#opts.endpoint });
  }

  async close(): Promise<void> {
    for (const conn of this.#conns.values()) conn.socket.destroy();
    this.#conns.clear();
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const isPipe = this.#opts.endpoint.startsWith("\\\\.");
    if (!isPipe && existsSync(this.#opts.endpoint)) rmSync(this.#opts.endpoint, { force: true });
  }

  /** 向所有已完成握手的连接推送事件 */
  broadcast(event: string, payload: unknown): number {
    let n = 0;
    for (const conn of this.#conns.values()) {
      if (!conn.authed) continue;
      this.#send(conn, { jsonrpc: "2.0", method: event, params: payload });
      n += 1;
    }
    return n;
  }

  #onConnection(socket: Socket): void {
    const conn: Conn = { id: randomUUID(), socket, buffer: "", authed: false };
    this.#conns.set(conn.id, conn);
    this.#opts.log?.("ipc.client_connected", { connectionId: conn.id });

    socket.on("data", (chunk) => {
      conn.buffer += chunk.toString("utf8");
      let idx = conn.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = conn.buffer.slice(0, idx).trim();
        conn.buffer = conn.buffer.slice(idx + 1);
        if (line) this.#handleLine(conn, line);
        idx = conn.buffer.indexOf("\n");
      }
    });

    socket.on("error", (err) => {
      this.#opts.log?.("ipc.client_error", { connectionId: conn.id, error: String(err) });
    });
    socket.on("close", () => {
      this.#conns.delete(conn.id);
      this.#opts.log?.("ipc.client_disconnected", { connectionId: conn.id });
    });
  }

  #send(conn: Conn, msg: unknown): void {
    try {
      conn.socket.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      this.#opts.log?.("ipc.write_failed", { connectionId: conn.id, error: String(err) });
    }
  }

  #error(conn: Conn, id: RpcRequest["id"], code: number, message: string): void {
    this.#send(conn, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  }

  #handleLine(conn: Conn, line: string): void {
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      this.#error(conn, null, RpcErrorCode.E_INVALID_PARAMS, "E_PARSE: 非法 JSON");
      return;
    }
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      this.#error(conn, req.id ?? null, RpcErrorCode.E_INVALID_PARAMS, "E_INVALID_REQUEST");
      return;
    }

    // ── 握手：每个新连接都必须重放（C-4）
    if (req.method === "sys.hello") {
      const params = req.params as { token?: unknown; clientVersion?: unknown } | undefined;
      const tokenOk = typeof params?.token === "string" && params.token === this.#opts.token;
      if (!tokenOk) {
        this.#error(conn, req.id ?? null, RpcErrorCode.E_AUTH, "E_AUTH: 认证失败");
        // 认证失败即断开，不给暴力尝试留通道
        conn.socket.end();
        return;
      }
      conn.authed = true;
      this.#send(conn, {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          daemonVersion: this.#opts.daemonVersion,
          dataDir: this.#opts.dataDir,
          startedAt: this.#opts.startedAt,
        },
      });
      return;
    }

    // 未握手：任何其它方法一律拒绝
    if (!conn.authed) {
      this.#error(conn, req.id ?? null, RpcErrorCode.E_AUTH, "E_AUTH: 请先握手");
      return;
    }

    // ── 内置方法
    if (req.method === "sys.health") {
      this.#send(conn, { jsonrpc: "2.0", id: req.id ?? null, result: this.#opts.health() });
      return;
    }

    const handler = this.#opts.methods[req.method];
    if (!handler) {
      this.#error(conn, req.id ?? null, RpcErrorCode.E_METHOD_NOT_FOUND, `E_METHOD_NOT_FOUND: ${req.method}`);
      return;
    }

    const ctx: RpcContext = {
      authed: conn.authed,
      connectionId: conn.id,
      push: (event, payload) => this.#send(conn, { jsonrpc: "2.0", method: event, params: payload }),
    };

    void Promise.resolve()
      .then(() => handler(req.params, ctx))
      .then((result) => {
        this.#send(conn, { jsonrpc: "2.0", id: req.id ?? null, result });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.#opts.log?.("ipc.handler_error", { method: req.method, error: message });
        this.#error(conn, req.id ?? null, RpcErrorCode.E_INTERNAL, `E_INTERNAL: ${message}`);
      });
  }
}

/**
 * 握手文件：把 token 与端点写到 0600 的文件，供本地客户端（Electron/CLI）读取。
 * 不通过命令行参数或环境变量传递 token —— 那些会出现在进程列表里。
 */
export interface HandshakeFile {
  token: string;
  pid: number;
  protocolVersion: number;
  endpoint: string;
  dataDir: string;
  startedAt: number;
}
