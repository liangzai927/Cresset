/**
 * daemon 监督者 —— Electron 主进程与 daemon 的生命周期协调
 *
 * ## 职责
 *
 * | 场景 | 行为 |
 * | --- | --- |
 * | 应用启动时 daemon 未运行 | 拉起它（detached，不随 UI 退出） |
 * | daemon 已在运行（例如 CLI 先启动的） | 直接连上，不重复拉起 |
 * | daemon 崩溃 | 按 NFR-R2 退避重启（首次 2 秒、上限 8 秒），**永不放弃** |
 * | 崩溃后稳定运行满 60 秒 | 重置连续失败计数，下次崩溃重新从 2 秒开始 |
 * | 应用退出 | **不杀 daemon** —— 它必须继续 24 小时运行 |
 *
 * ## 为什么 UI 不拥有 daemon 的生命周期
 *
 * 本产品的核心承诺是"24 小时常驻"。若 daemon 随 UI 退出，
 * 用户关掉窗口就等于关掉了提醒 —— 这与产品定位直接冲突（PRD NFR-R1）。
 *
 * 因此设计为：**daemon 是长期居民，UI 是随时可关的观察窗**。
 * 两者通过 `<dataDir>/handshake.json` 与 UDS 通信，互不拥有。
 *
 * ## 为什么"永不放弃"是硬约束
 *
 * 旧实现连续三次异常退出后就停止自动重启，并把状态置为 unavailable。
 * 对 24/7 产品来说，这等于**静默死亡**：用户不会一直盯着界面，
 * 等发现时可能已经漏掉了几天的提醒。退避与连续失败计数只应影响
 * "多久试一次"，不应影响"是否继续试"。
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Clock, SystemClock } from "@aegis/clock";
import type { DataPaths } from "@aegis/product";
import { type RestartPlan, RestartPolicy, type RestartPolicyOptions } from "./restart-policy.js";

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

/**
 * 监督者需要的最小进程句柄。
 *
 * 只暴露"拉起后真正用到的三件事"（pid、unref、退出/错误回调），
 * 这样单测可以注入一个完全受控的假进程，而不必 mock `node:child_process`
 * 或真的 fork 一个 daemon。
 */
export interface SupervisedChild {
  /** 子进程 pid；spawn 失败时为 undefined */
  readonly pid: number | undefined;
  /** 让子进程脱离父进程的事件循环（daemon 要活在 UI 退出之后） */
  unref(): void;
  /** 注册退出回调（只触发一次） */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** 注册启动失败回调（只触发一次） */
  onError(listener: (error: Error) => void): void;
}

/** 拉起子进程的函数签名；测试可注入假实现 */
export type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => SupervisedChild;

/** daemon 监督者的注入项；`nodeExecPath` 必须是**系统 Node**而不是 Electron 二进制 */
export interface SupervisorOptions {
  paths: DataPaths;
  /** daemon 入口脚本的绝对路径（打包后指向 resources 内的副本） */
  daemonEntry: string;
  /** 用哪个可执行文件跑 daemon（默认当前进程的 execPath，但 Electron 需要切回系统 Node） */
  nodeExecPath: string;
  /** 首次重启的退避（毫秒），默认 2000 */
  restartBaseMs?: number;
  /** 重启退避上限（毫秒），默认 8000；超过 NFR-R2 的 10 秒会被拒绝 */
  restartMaxMs?: number;
  /** 连续运行多久视为稳定并重置失败计数（毫秒），默认 60000 */
  stableAfterMs?: number;
  /** 时间与定时器来源；测试注入 VirtualClock（禁止裸 Date.now/setTimeout） */
  clock?: Clock;
  /** 进程拉起函数；测试注入假进程 */
  spawnProcess?: SpawnProcess;
  /** 进程探活函数；测试注入假 pid 表 */
  isProcessAlive?: (pid: number) => boolean;
  onStateChange?: (state: DaemonState) => void;
  onLog?: (level: "debug" | "info" | "warn" | "error", event: string, detail?: unknown) => void;
}

/** daemon 生命周期协调：拉起、探活、按 NFR-R2 退避重启；**不负责杀 daemon** */
export class DaemonSupervisor {
  readonly #opts: SupervisorOptions;
  readonly #clock: Clock;
  readonly #spawnProcess: SpawnProcess;
  readonly #probeProcess: (pid: number) => boolean;
  readonly #policy: RestartPolicy;
  #state: DaemonState = { kind: "stopped" };
  #child: SupervisedChild | null = null;
  #cancelRestart: (() => void) | null = null;
  #stopped = false;

  constructor(opts: SupervisorOptions) {
    this.#opts = opts;
    this.#clock = opts.clock ?? new SystemClock();
    this.#spawnProcess =
      opts.spawnProcess ?? ((command, args, spawnOpts) => toSupervisedChild(spawn(command, args, spawnOpts)));
    this.#probeProcess = opts.isProcessAlive ?? isProcessAlive;

    const policyOpts: RestartPolicyOptions = {};
    if (opts.restartBaseMs !== undefined) policyOpts.baseDelayMs = opts.restartBaseMs;
    if (opts.restartMaxMs !== undefined) policyOpts.maxDelayMs = opts.restartMaxMs;
    if (opts.stableAfterMs !== undefined) policyOpts.stableAfterMs = opts.stableAfterMs;
    this.#policy = new RestartPolicy(policyOpts);
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
   *
   * 若当前正等待一次自动重启，本方法会**取消那个定时器并立即尝试** ——
   * 用户的显式操作优先于退避计划，不必再等几秒。
   */
  async ensureRunning(timeoutMs = 8_000): Promise<DaemonState> {
    if (this.#stopped) return this.#state;

    this.#cancelPendingRestart();
    const existing = this.readHandshake();
    if (existing && this.#probeProcess(existing.pid)) {
      this.#setState({ kind: "running", handshake: existing, spawnedByUs: false });
      return this.#state;
    }

    this.#setState({ kind: "starting", since: this.#clock.wall() });
    this.spawnDaemon();

    // spawn 同步失败时 spawnDaemon 已经排好了重试并置为 crashed。
    // 此时不能继续空等 8 秒再覆盖成 unavailable —— 用户需要立刻看到真实原因。
    if (this.#state.kind === "crashed") return this.#state;

    const deadline = this.#clock.wall() + timeoutMs;
    while (this.#clock.wall() < deadline) {
      const hs = this.readHandshake();
      if (hs && this.#probeProcess(hs.pid)) {
        this.#setState({ kind: "running", handshake: hs, spawnedByUs: true });
        return this.#state;
      }
      await this.#clock.sleep(120);
    }

    this.#setState({
      kind: "unavailable",
      reason: `daemon 在 ${timeoutMs}ms 内未就绪（检查数据目录权限或端口占用）`,
    });
    return this.#state;
  }

  /** 拉起 daemon（不阻塞），并挂上退出/启动失败处理 */
  spawnDaemon(): void {
    if (this.#stopped) return;
    if (this.#child && this.#child.pid !== undefined && this.#probeProcess(this.#child.pid)) return;

    const args = [this.#opts.daemonEntry, "--data-dir", this.#opts.paths.dataDir];
    this.#log("info", "supervisor.spawn", { exec: this.#opts.nodeExecPath, args });

    // 记录启动时刻：退出时用它判断本次是否"稳定运行过"，决定要不要重置失败计数。
    this.#policy.markStarted(this.#clock.wall());

    let child: SupervisedChild;
    try {
      child = this.#spawnProcess(this.#opts.nodeExecPath, args, {
        // detached：让 daemon 成为独立进程组，UI 退出不会带走它
        detached: true,
        // 不继承 stdio：daemon 自己写日志文件；若继承，UI 关闭后管道断裂会让 daemon 收到 EPIPE
        stdio: "ignore",
        // ★ 必须清除 ELECTRON_RUN_AS_NODE：
        // Electron 主进程默认带这个变量，它会强制"Node 模式"，而我们要跑的是独立的系统 Node。
        // 保留它会让 daemon 行为异常（本环境实测过）。
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
    } catch (err) {
      // spawn 对非法参数可能**同步**抛错（例如 cwd 不存在）。
      // 不能让它冒泡到 Electron 主进程的 uncaughtException —— 那会直接弹崩溃框。
      const message = err instanceof Error ? err.message : String(err);
      this.#log("error", "supervisor.spawn_threw", { message });
      this.#scheduleRestart(`拉起失败：${message}`);
      return;
    }

    child.unref();
    this.#child = child;

    let terminated = false;
    const onTerminated = (reason: string): void => {
      if (terminated) return;
      terminated = true;
      if (this.#child === child) this.#child = null;
      this.#log("warn", "supervisor.daemon_exit", { reason });
      if (this.#stopped) return;
      this.#scheduleRestart(reason);
    };

    child.onExit((code, signal) => {
      onTerminated(`退出码 ${code ?? signal ?? "unknown"}`);
    });
    child.onError((err) => {
      this.#log("error", "supervisor.spawn_failed", { message: err.message });
      onTerminated(`拉起失败：${err.message}`);
    });
  }

  /**
   * 安排下一次重启。
   *
   * 连续失败只影响退避时长，**不设"放弃"分支**：即使崩溃一百次，
   * 仍会按 8 秒上限继续尝试。稳定运行 60 秒后计数由 RestartPolicy 重置。
   */
  #scheduleRestart(reason: string): void {
    if (this.#stopped) return;

    const plan: RestartPlan = this.#policy.planAfterExit(this.#clock.wall());
    const delayText = formatDelay(plan.delayMs);
    this.#setState({
      kind: "crashed",
      reason: `${reason}；${delayText}后第 ${plan.attempt} 次重启`,
      restarts: plan.attempt,
    });
    this.#log("info", "supervisor.restart_scheduled", {
      inMs: plan.delayMs,
      attempt: plan.attempt,
      reason,
    });

    this.#cancelPendingRestart();
    this.#cancelRestart = this.#clock.setTimer(plan.delayMs, () => {
      this.#cancelRestart = null;
      void this.ensureRunning();
    });
  }

  /** 取消尚未触发的重启定时器（幂等） */
  #cancelPendingRestart(): void {
    if (!this.#cancelRestart) return;
    this.#cancelRestart();
    this.#cancelRestart = null;
  }

  /**
   * 停止监督（**不杀 daemon**）。
   *
   * 应用退出时调用。刻意留空对 daemon 的操作 —— 见文件头说明。
   * 同时取消所有待触发的重启定时器，避免应用退出后还留下一个
   * 会拉起新 daemon 的计时器。
   */
  dispose(): void {
    this.#stopped = true;
    this.#cancelPendingRestart();
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

/** 把 Node 的 ChildProcess 收敛成监督者真正需要的最小接口 */
function toSupervisedChild(child: ChildProcess): SupervisedChild {
  return {
    pid: child.pid,
    unref: () => child.unref(),
    onExit: (listener) => {
      child.once("exit", listener);
    },
    onError: (listener) => {
      child.once("error", listener);
    },
  };
}

/** 把毫秒延迟转成日志/界面里可读的中文（2 秒 / 1.5 秒） */
function formatDelay(ms: number): string {
  if (ms % 1_000 === 0) return `${ms / 1_000} 秒`;
  return `${(ms / 1_000).toFixed(1)} 秒`;
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
