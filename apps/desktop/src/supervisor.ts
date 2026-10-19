/**
 * daemon 监督者 —— Electron 主进程与 daemon 的生命周期协调
 *
 * ## 职责
 *
 * | 场景 | 行为 |
 * | --- | --- |
 * | 应用启动时 daemon 未运行 | 拉起它（detached，不随 UI 退出） |
 * | daemon 已在运行（例如 CLI 先启动的） | 直接连上，不重复拉起 |
 * | daemon 崩溃 | 有限次自动重启（指数退避），失败后告知 UI |
 * | 应用退出 | **不杀 daemon** —— 它必须继续 24 小时运行 |
 *
 * ## 为什么 UI 不拥有 daemon 的生命周期
 *
 * 本产品的核心承诺是"24 小时常驻"。若 daemon 随 UI 退出，
 * 用户关掉窗口就等于关掉了提醒 —— 这与产品定位直接冲突（PRD NFR-R1）。
 *
 * 因此设计为：**daemon 是长期居民，UI 是随时可关的观察窗**。
 * 两者通过 `<dataDir>/handshake.json` 与 UDS 通信，互不拥有。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataPaths } from "@aegis/product";

/** 握手文件内容（daemon 写入） */
export interface Handshake {
  endpoint: string;
  token: string;
  daemonVersion: string;
  pid: number;
}

/** daemon 生命周期状态（供界面展示） */
export type DaemonState =
  | { kind: "stopped" }
  | { kind: "starting"; since: number }
  | { kind: "running"; handshake: Handshake; spawnedByUs: boolean }
  | { kind: "crashed"; reason: string; restarts: number }
  | { kind: "unavailable"; reason: string };

/** daemon 监督者的注入项；`nodeExecPath` 必须是**系统 Node**而不是 Electron 二进制 */
export interface SupervisorOptions {
  paths: DataPaths;
  /** daemon 入口脚本的绝对路径（打包后指向 resources 内的副本） */
  daemonEntry: string;
  /** 用哪个可执行文件跑 daemon（默认当前进程的 execPath，但 Electron 需要切回系统 Node） */
  nodeExecPath: string;
  /** 重启策略 */
  maxRestarts?: number;
  /** 首次重启的退避（毫秒） */
  restartBaseMs?: number;
  onStateChange?: (state: DaemonState) => void;
  onLog?: (level: "debug" | "info" | "warn" | "error", event: string, detail?: unknown) => void;
}

/** daemon 生命周期协调：拉起、探活、有限次重启；**不负责杀 daemon** */
export class DaemonSupervisor {
  readonly #opts: SupervisorOptions;
  readonly #maxRestarts: number;
  readonly #restartBaseMs: number;
  #state: DaemonState = { kind: "stopped" };
  #child: ChildProcess | null = null;
  #restarts = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(opts: SupervisorOptions) {
    this.#opts = opts;
    this.#maxRestarts = opts.maxRestarts ?? 3;
    this.#restartBaseMs = opts.restartBaseMs ?? 2_000;
  }

  get state(): DaemonState {
    return this.#state;
  }

  #setState(next: DaemonState): void {
    this.#state = next;
    this.#opts.onStateChange?.(next);
  }

  #log(level: "debug" | "info" | "warn" | "error", event: string, detail?: unknown): void {
    this.#opts.onLog?.(level, event, detail);
  }

  /**
   * 读取握手文件。
   *
   * @returns 文件不存在或内容不完整时返回 null（而不是抛错 —— 这是启动过程中的常态）
   */
  readHandshake(): Handshake | null {
    const file = this.#opts.paths.handshakeFile;
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Handshake>;
      if (typeof parsed.endpoint !== "string" || typeof parsed.token !== "string") return null;
      return parsed as Handshake;
    } catch {
      // 文件正在被写入时可能读到半截 JSON —— 属于正常竞态，返回 null 让调用方重试
      return null;
    }
  }

  /**
   * 确保 daemon 在运行。
   *
   * 三条路径：
   *   1. 已有可用的握手文件 → 直接认为在跑（可能是 CLI 启动的）
   *   2. 没有 → 拉起一个新进程，等待握手文件出现
   *   3. 超时 → 返回 unavailable 并告知原因
   */
  async ensureRunning(timeoutMs = 8_000): Promise<DaemonState> {
    const existing = this.readHandshake();
    if (existing && isProcessAlive(existing.pid)) {
      this.#setState({ kind: "running", handshake: existing, spawnedByUs: false });
      return this.#state;
    }

    this.#setState({ kind: "starting", since: Date.now() });
    this.spawnDaemon();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hs = this.readHandshake();
      if (hs && isProcessAlive(hs.pid)) {
        this.#setState({ kind: "running", handshake: hs, spawnedByUs: true });
        return this.#state;
      }
      await delay(120);
    }

    this.#setState({
      kind: "unavailable",
      reason: `daemon 在 ${timeoutMs}ms 内未就绪（检查数据目录权限或端口占用）`,
    });
    return this.#state;
  }

  /** 拉起 daemon（不阻塞） */
  spawnDaemon(): void {
    if (this.#child && isProcessAlive(this.#child.pid ?? -1)) return;

    const args = [this.#opts.daemonEntry, "--data-dir", this.#opts.paths.dataDir];
    this.#log("info", "supervisor.spawn", { exec: this.#opts.nodeExecPath, args });

    const child = spawn(this.#opts.nodeExecPath, args, {
      // detached：让 daemon 成为独立进程组，UI 退出不会带走它
      detached: true,
      // 不继承 stdio：daemon 自己写日志文件；若继承，UI 关闭后管道断裂会让 daemon 收到 EPIPE
      stdio: "ignore",
      // ★ 必须清除 ELECTRON_RUN_AS_NODE：
      // Electron 主进程默认带这个变量，它会强制"Node 模式"，而我们要跑的是独立的系统 Node。
      // 保留它会让 daemon 行为异常（本环境实测过）。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    child.unref();
    this.#child = child;

    child.on("exit", (code, signal) => {
      this.#log("warn", "supervisor.daemon_exit", { code, signal });
      this.#child = null;
      if (this.#stopped) return;

      // 非正常退出 → 尝试重启（有限次）
      if (this.#restarts < this.#maxRestarts) {
        const backoff = this.#restartBaseMs * 2 ** this.#restarts;
        this.#restarts += 1;
        this.#setState({ kind: "crashed", reason: `退码 ${code ?? signal}`, restarts: this.#restarts });
        this.#log("info", "supervisor.restart_scheduled", { inMs: backoff, attempt: this.#restarts });
        this.#restartTimer = setTimeout(() => {
          this.#restartTimer = null;
          void this.ensureRunning();
        }, backoff);
      } else {
        this.#setState({
          kind: "unavailable",
          reason: `daemon 连续 ${this.#maxRestarts} 次异常退出，已停止自动重启`,
        });
      }
    });
  }

  /**
   * 停止监督（**不杀 daemon**）。
   *
   * 应用退出时调用。刻意留空对 daemon 的操作 —— 见文件头说明。
   */
  dispose(): void {
    this.#stopped = true;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    // 注意：这里**不** kill 子进程。detached + unref 保证它会继续运行。
    this.#child = null;
  }
}

/** 判断进程是否存活（POSIX 标准做法，不发送真实信号） */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 解析 daemon 入口脚本路径。
 *
 * 开发态：仓库里的 `apps/daemon/dist/main.js`
 * 打包态：Electron resources 目录下的副本
 *
 * 用 `existsSync` 逐条探测而不是靠环境变量判断 ——
 * 打包配置出错时能给出可读的失败原因，而不是 ENOENT 栈。
 */
export function resolveDaemonEntry(opts: {
  /** 仓库根（开发态） */
  repoRoot: string;
  /** 打包后的资源目录（可选） */
  resourcesPath?: string;
}): string | null {
  const candidates: string[] = [];
  if (opts.resourcesPath) candidates.push(join(opts.resourcesPath, "daemon", "main.js"));
  candidates.push(join(opts.repoRoot, "apps", "daemon", "dist", "main.js"));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * 选择用于运行 daemon 的 Node 可执行文件。
 *
 * ⚠️ 关键：**不能用 Electron 自带的 Node**（`process.execPath` 在 Electron 里指向 Electron 二进制）。
 * 用它跑 daemon 会继承 Electron 的运行时，导致：
 *   - `ELECTRON_RUN_AS_NODE` 语义混乱
 *   - 打包后二进制路径随版本变化
 *   - `node:sqlite` 等内置模块行为与系统 Node 不一致（实测过）
 *
 * 探测顺序：显式配置 → 环境变量 → 常见 nvm/系统路径 → PATH 上的 node。
 */
export function resolveNodeExecPath(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit;

  const fromEnv = process.env.AEGIS_NODE_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    join(process.env.HOME ?? "", ".nvm/versions/node/v24.17.0/bin/node"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}
