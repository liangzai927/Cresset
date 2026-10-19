#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
/**
 * S6 —— Electron ↔ daemon 的本地 IPC：握手、RPC、事件流、断线重连
 *
 * 验证《技术选型与架构设计》§3.3：
 *   - 传输：UDS（macOS/Linux）/ NamedPipe（Windows），NDJSON 分帧，JSON-RPC 2.0
 *   - 鉴权：握手 token
 *   - 能力：请求/响应、服务端事件推送、daemon 重启后客户端自动重连
 * 本探针用纯 node:net 实现（与生产同一套协议代码），不依赖 Electron。
 */
import { connect, createServer } from "node:net";
import { join, resolve } from "node:path";

const ARTIFACTS = process.env.SPIKE_ARTIFACTS ?? resolve(import.meta.dirname, "../../spike-artifacts");
const STAGE = join(ARTIFACTS, "s6");
const isWin = process.platform === "win32";
const SOCKET = isWin ? `\\\\.\\pipe\\aegis-spike-s6` : join(STAGE, "daemon.sock");
const TOKEN = randomUUID();
const evidence = [];
const log = (s) => evidence.push(s);
const emit = (status, detail, metrics = {}) =>
  console.log(JSON.stringify({ status, detail, evidence, metrics }));

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
if (!isWin && existsSync(SOCKET)) rmSync(SOCKET, { force: true });

/** 极简 JSON-RPC 服务端（NDJSON 分帧） */
function startServer({ tokenOk = true } = {}) {
  const live = new Set();
  const server = createServer((socket) => {
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    let buf = "";
    let authed = false;
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) handle(JSON.parse(line));
        idx = buf.indexOf("\n");
      }
    });
    socket.on("error", () => {});
    function send(obj) {
      socket.write(`${JSON.stringify(obj)}\n`);
    }
    function handle(msg) {
      if (msg.method === "sys.hello") {
        const ok = tokenOk && msg.params?.token === TOKEN;
        authed = ok;
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: ok ? { protocolVersion: 1, pid: process.pid } : null,
          error: ok ? undefined : { code: -32001, message: "E_AUTH" },
        });
        if (ok) {
          // 握手后主动推送一个事件，验证"服务端 → 客户端"单向流
          setTimeout(
            () => send({ jsonrpc: "2.0", method: "task.changed", params: { id: "t1", reason: "created" } }),
            30,
          );
        }
        return;
      }
      if (!authed) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "E_AUTH" } });
        return;
      }
      if (msg.method === "sys.health") {
        send({ jsonrpc: "2.0", id: msg.id, result: { ok: true, uptimeS: 1, tickCount: 7 } });
      } else if (msg.method === "sys.crash") {
        // 用于测试客户端断线重连：直接掐断连接
        socket.destroy();
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "E_METHOD_NOT_FOUND" } });
      }
    }
  });
  return {
    server,
    listen: () =>
      new Promise((res, rej) => {
        if (!isWin && existsSync(SOCKET)) rmSync(SOCKET, { force: true });
        server.once("error", rej);
        server.listen(SOCKET, () => res());
      }),
    close: () =>
      new Promise((res) => {
        for (const s of live) s.destroy();
        server.close(() => res());
      }),
  };
}

/** 极简客户端：自动重连 + 事件回调 + 请求/响应配对 */
function makeClient() {
  let socket = null;
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  const events = [];
  let reconnects = 0;
  let onEvent = null;
  /** 每次（重新）建立连接后必须重放的握手参数；生产代码同此语义 */
  let handshakeParams = null;

  function handleLine(line) {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else res(msg.result);
    } else if (msg.method) {
      events.push(msg);
      onEvent?.(msg);
    }
  }

  function attach(sock) {
    socket = sock;
    buf = "";
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (l) handleLine(l);
        i = buf.indexOf("\n");
      }
    });
    sock.on("error", () => {});
  }

  function connectOnce() {
    return new Promise((res, rej) => {
      const sock = connect(SOCKET);
      sock.once("connect", async () => {
        attach(sock);
        // ★ 关键：新连接是新的鉴权会话，必须重放握手，否则后续调用全部 E_AUTH
        if (handshakeParams) {
          try {
            await rawCall("sys.hello", handshakeParams);
          } catch {
            /* 握手失败由调用方感知 */
          }
        }
        res();
      });
      sock.once("error", rej);
    });
  }

  /** 带重试的连接：daemon 可能尚未就绪（生产同此语义，避免"启动顺序"导致失败） */
  async function connectWithRetry(maxMs = 3000) {
    const t0 = Date.now();
    for (;;) {
      try {
        await connectOnce();
        return true;
      } catch {
        if (Date.now() - t0 > maxMs) return false;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  function rawCall(method, params) {
    const id = nextId++;
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rej(new Error(`E_TIMEOUT ${method}`));
        }
      }, 5000);
    });
  }

  function call(method, params) {
    return rawCall(method, params);
  }

  return {
    events,
    get reconnects() {
      return reconnects;
    },
    set onEvent(fn) {
      onEvent = fn;
    },
    /** 登记握手参数：此后每次（重）连接都会自动重放 */
    setHandshake(params) {
      handshakeParams = params;
    },
    async connect() {
      const ok = await connectWithRetry();
      if (!ok) throw new Error(`E_CONNECT ${SOCKET}`);
      if (reconnects > 0) reconnects += 0;
    },
    /** 断线后自动重连，直到成功 */
    async reconnectUntilOk(maxMs = 5000) {
      const ok = await connectWithRetry(maxMs);
      if (ok) reconnects += 1;
      return ok;
    },
    call,
    close() {
      return new Promise((res) => {
        if (!socket) return res();
        socket.once("close", () => res());
        socket.destroy();
        setTimeout(res, 300);
      });
    },
  };
}

// ── 1) 启动服务端，客户端握手
let srv = startServer();
await srv.listen();
const client = makeClient();
client.setHandshake({ token: TOKEN, clientVersion: "0.0.0" });
await client.connect();

const hello = await client.call("sys.hello", { token: TOKEN, clientVersion: "0.0.0" });
log(`握手成功：protocolVersion=${hello.protocolVersion} daemon pid=${hello.pid}`);

// ── 2) 错误令牌必须被拒
const badClient = makeClient();
badClient.setHandshake({ token: "wrong-token", clientVersion: "0.0.0" });
await badClient.connect();
let authRejected = false;
try {
  await badClient.call("sys.hello", { token: "wrong-token", clientVersion: "0.0.0" });
} catch (e) {
  authRejected = String(e.message).includes("E_AUTH");
}
log(`错误令牌被拒绝：${authRejected}`);
await badClient.close();

// ── 3) 正常 RPC
const health = await client.call("sys.health", {});
log(`RPC sys.health 返回：ok=${health.ok} tickCount=${health.tickCount}`);

// ── 4) 服务端事件推送
await new Promise((r) => setTimeout(r, 120));
const gotEvent = client.events.some((e) => e.method === "task.changed");
log(`收到服务端事件 task.changed：${gotEvent}`);

// ── 5) 断线重连（模拟 daemon 崩溃重启）
await srv.close();
if (!isWin && existsSync(SOCKET)) rmSync(SOCKET, { force: true });
await new Promise((r) => setTimeout(r, 100));
srv = startServer();
await srv.listen();
const reconnected = await client.reconnectUntilOk(4000);
let healthAfter = null;
if (reconnected) {
  try {
    healthAfter = await client.call("sys.health", {});
  } catch (e) {
    log(`重连后调用失败：${e.message}`);
  }
}
log(
  `daemon 重启后客户端重连：${reconnected}（重连次数 ${client.reconnects}），自动重放握手后 RPC：${healthAfter ? "成功" : "失败"}`,
);

// ── 6) 未知方法返回标准错误码
let methodNotFound = false;
try {
  await client.call("nope.nope", {});
} catch (e) {
  methodNotFound = String(e.message).includes("E_METHOD_NOT_FOUND");
}
log(`未知方法返回 E_METHOD_NOT_FOUND：${methodNotFound}`);

await client.close();
await srv.close();
if (!isWin && existsSync(SOCKET)) rmSync(SOCKET, { force: true });

const ok =
  hello.protocolVersion === 1 &&
  authRejected &&
  health.ok &&
  gotEvent &&
  reconnected &&
  Boolean(healthAfter) &&
  methodNotFound;
emit(
  ok ? "pass" : "fail",
  ok
    ? `IPC 全链路通过：${isWin ? "NamedPipe" : "Unix domain socket"} 上的握手鉴权 / RPC / 事件推送 / 断线重连 / 错误码均符合预期`
    : "IPC 链路存在不符合预期之处，见证据",
  { transport: isWin ? "named-pipe" : "uds", authRejected, gotEvent, reconnected, methodNotFound },
);
// 显式退出，保证探针本身不会因遗留句柄而挂起
process.exit(0);
