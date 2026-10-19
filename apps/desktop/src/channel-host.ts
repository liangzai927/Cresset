/**
 * 桌面通道服务：Electron 侧的通知端点
 *
 * ## 职责
 *
 * 在 `127.0.0.1:<随机端口>` 上起一个极小的 HTTP 服务，接收 daemon 的投递请求，
 * 用 Electron 的 `Notification` 弹出，并把真实结果回传给 daemon。
 *
 * 详见 `docs/ADR-R3-01-原生通知接通方案.md`。
 *
 * ## 为什么不等 daemon 连接而是 daemon 连我
 *
 * daemon 是"决策者"（它知道何时该响），GUI 权限在 Electron 手里。
 * 若反向（Electron 轮询 daemon），延迟不可控且需要在 daemon 侧新增 HTTP 服务；
 * 现在这样 daemon 保持零 GUI 依赖，Electron 关闭时渠道自然消失。
 *
 * ## 安全设计（逐条对应威胁）
 *
 * | 威胁 | 应对 |
 * | --- | --- |
 * | 本机其它进程伪造投递 | Bearer token（随机 32 字节，只存 0600 文件） |
 * | DNS rebinding 让网页打到本机 | 校验 `Host` 头必须是 `127.0.0.1:<port>` |
 * | 恶意进程刷爆主线程 | 并发上限 + 请求体大小上限 |
 * | token 被其它用户读到 | `channel.json` 权限 0600 |
 * | 服务被误暴露到外网 | 只 `listen("127.0.0.1")`，绝不 `0.0.0.0` |
 */

import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DesktopChannelFile } from "@aegis/platform";

/** 单次请求体的最大字节数（通知内容不应该这么大，超出即视为恶意） */
const MAX_BODY_BYTES = 64 * 1024;
/** 同时处理的请求数上限（本地服务，不需要高并发） */
const MAX_CONCURRENT = 8;
/** HTTP 服务超时（毫秒）：避免半开连接长期占用 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 通知弹出的结果 */
export type NotifyOutcome = "success" | "transient_error" | "permanent_error";

/** 通知呈现函数的契约（注入以便测试，不依赖真实 Electron） */
export interface NotificationPresenter {
  /** 系统是否支持通知（权限被拒时 Electron 返回 false） */
  isSupported(): boolean;
  /**
   * 弹出通知。
   *
   * @returns 是否成功交给系统（注意：成功 ≠ 用户一定看到，后者取决于专注模式）
   */
  present(payload: { title: string; body?: string; sound: boolean }): Promise<NotifyOutcome>;
}

/** 通道服务的启动选项；`presenter` 注入以便在没有 Electron 的环境里测试 */
export interface ChannelHostOptions {
  /** `channel.json` 的写入路径（与 daemon 的 DataPaths.channelFile 一致） */
  channelFilePath: string;
  /** 通知呈现器（由主进程用 Electron Notification 实现） */
  presenter: NotificationPresenter;
  /** 端口；默认 0 = 由系统分配（推荐，避免冲突） */
  port?: number;
  /** 日志回调 */
  onLog?: (level: "debug" | "info" | "warn" | "error", event: string, detail?: unknown) => void;
}

/** 已启动通道的句柄；`close()` 会先删 `channel.json` 再关服务 */
export interface ChannelHostHandle {
  /** 实际监听的端点，如 `http://127.0.0.1:52341` */
  readonly endpoint: string;
  /** 停止服务并删除 channel.json */
  close(): Promise<void>;
}

/**
 * 启动桌面通道服务。
 *
 * @throws 端口绑定失败（极少见，因为默认用 0 让系统分配）
 */
export async function startChannelHost(opts: ChannelHostOptions): Promise<ChannelHostHandle> {
  const token = randomBytes(32).toString("hex");
  const log = opts.onLog ?? ((): void => {});
  let inFlight = 0;
  let expectedHost = "";
  let closed = false;

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ── 并发限制：超出直接 503（daemon 会当作瞬时错误重试）
    if (inFlight >= MAX_CONCURRENT) {
      respond(res, 503, { outcome: "transient_error", error: "通道繁忙" });
      return;
    }
    inFlight += 1;
    try {
      // ── Host 校验：防 DNS rebinding（网页打到 localhost 的场景）
      const host = req.headers.host ?? "";
      if (host !== expectedHost) {
        log("warn", "channel.host_rejected", { host, expected: expectedHost });
        respond(res, 403, { outcome: "permanent_error", error: "Host 头不匹配" });
        return;
      }

      // ── 鉴权：所有路径都需要 token（含 /health），避免暴露"服务存在"这一信息
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${token}`) {
        log("warn", "channel.auth_rejected", { path: req.url });
        respond(res, 401, { outcome: "permanent_error", error: "token 不匹配" });
        return;
      }

      const url = req.url ?? "/";

      if (req.method === "GET" && url === "/health") {
        respond(res, 200, { ok: true, supported: opts.presenter.isSupported() });
        return;
      }

      if (req.method === "POST" && url === "/notify") {
        const body = await readBody(req);
        if (body === null) {
          respond(res, 413, { outcome: "permanent_error", error: "请求体过大" });
          return;
        }

        let parsed: { title?: unknown; body?: unknown; sound?: unknown };
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          respond(res, 400, { outcome: "permanent_error", error: "请求体不是合法 JSON" });
          return;
        }

        if (typeof parsed.title !== "string" || parsed.title.trim() === "") {
          respond(res, 400, { outcome: "permanent_error", error: "缺少 title" });
          return;
        }

        const outcome = await opts.presenter.present({
          title: parsed.title,
          ...(typeof parsed.body === "string" ? { body: parsed.body } : {}),
          sound: parsed.sound !== false,
        });

        log("info", "channel.notified", { title: parsed.title, outcome });
        respond(res, 200, { outcome });
        return;
      }

      respond(res, 404, { outcome: "permanent_error", error: `未知路径：${req.method} ${url}` });
    } catch (err) {
      log("error", "channel.handler_error", { error: (err as Error).message });
      // 走到这里说明是我们的 bug；回 500 让 daemon 当作瞬时错误重试
      if (!res.headersSent) respond(res, 500, { outcome: "transient_error", error: "内部错误" });
    } finally {
      inFlight -= 1;
    }
  }

  /**
   * 读取请求体（带上限）。
   *
   * @returns 超过上限时返回 null（调用方据此回 413）
   */
  function readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(null));
    });
  }

  function respond(res: ServerResponse, status: number, payload: unknown): void {
    if (res.headersSent) return;
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  // ── 绑定端口（只本机回环）
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  server.setTimeout(REQUEST_TIMEOUT_MS);

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("无法获取监听端口");
  }
  const endpoint = `http://127.0.0.1:${address.port}`;
  expectedHost = `127.0.0.1:${address.port}`;

  // ── 写 channel.json（0600，只让当前用户可读）
  const channelFile: DesktopChannelFile = {
    endpoint,
    token,
    pid: process.pid,
    startedAt: Date.now(),
  };
  writeFileSync(opts.channelFilePath, JSON.stringify(channelFile, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  log("info", "channel.listening", { endpoint });

  return {
    endpoint,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // 先删文件：让 daemon 立刻停止尝试这个端点，再关服务
      if (existsSync(opts.channelFilePath)) {
        try {
          unlinkSync(opts.channelFilePath);
        } catch {
          /* 删除失败不阻塞关闭 */
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 强制关闭空闲连接，避免 close 回调一直不返回
        server.closeAllConnections?.();
      });
      log("info", "channel.closed", { endpoint });
    },
  };
}

/**
 * 用 Electron 的 `Notification` 实现呈现器。
 *
 * 该函数**不直接 import electron**：由主进程传入 electron 的 Notification 构造器，
 * 这样本模块可以在普通 Node 环境（测试）里运行。
 */
export function createElectronPresenter(NotificationCtor: {
  isSupported: () => boolean;
  new (opts: {
    title: string;
    body?: string;
    silent?: boolean;
  }): {
    show: () => void;
    on: (event: string, cb: () => void) => void;
  };
}): NotificationPresenter {
  return {
    isSupported(): boolean {
      try {
        return NotificationCtor.isSupported();
      } catch {
        return false;
      }
    },
    async present(payload): Promise<NotifyOutcome> {
      if (!NotificationCtor.isSupported()) {
        // 权限被拒 / 系统不支持 → 永久错误，让 daemon 立刻降级到 CLI 兜底
        return "permanent_error";
      }
      try {
        const n = new NotificationCtor({
          title: payload.title,
          ...(payload.body ? { body: payload.body } : {}),
          silent: !payload.sound,
        });
        n.show();
        // 注意：Electron 的 show() 不返回是否真的显示。
        // 因此这里只能报告"已交给系统" —— 这正是"成功 ≠ 用户看到"的诚实表达。
        return "success";
      } catch {
        return "transient_error";
      }
    },
  };
}
