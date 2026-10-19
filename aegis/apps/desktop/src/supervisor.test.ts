/**
 * daemon 监督者测试
 *
 * 验证的是**崩溃后的时间线**，不是"函数被调用过"：
 *   - 进程退出后是否真的按 2/4/8 秒重新拉起；
 *   - 连续失败后是否仍在重试（旧实现三次就永久放弃）；
 *   - 稳定运行 60 秒后，失败计数是否重置；
 *   - 应用退出（dispose）后是否还残留会拉起进程的定时器。
 *
 * 进程与时钟都是注入的：假进程只记录回调，虚拟时钟负责推进退避，
 * 因此整条时间线是确定性的、毫秒级跑完，不依赖真实 sleep 或真实 daemon。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "@aegis/clock";
import { type DataPaths, resolveDataPaths } from "@aegis/product";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DaemonSupervisor,
  resolveDaemonEntry,
  resolveNodeExecPath,
  type SupervisedChild,
  type SupervisorOptions,
} from "./supervisor.js";

/** 受控的假子进程：测试显式触发 exit / error 回调 */
class FakeChild implements SupervisedChild {
  readonly pid: number;
  #onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  #onError: ((error: Error) => void) | null = null;
  #killed: NodeJS.Signals[] = [];

  constructor(pid: number) {
    this.pid = pid;
  }

  unref(): void {
    /* 假进程不需要脱离事件循环 */
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#onExit = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.#onError = listener;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.#killed.push(signal);
    return true;
  }

  /** 看门狗实际发出的信号（断言"有没有杀、用什么信号"） */
  get killedWith(): readonly NodeJS.Signals[] {
    return this.#killed;
  }

  /** 模拟进程退出（调用方负责先把它从存活表里移除） */
  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.#onExit?.(code, signal);
  }

  /** 模拟 spawn 失败 */
  emitError(error: Error): void {
    this.#onError?.(error);
  }
}

interface Harness {
  supervisor: DaemonSupervisor;
  clock: VirtualClock;
  paths: DataPaths;
  spawned: FakeChild[];
  livePids: Set<number>;
  /** 监督者发出的信号（用于验证"旧工作区 daemon"被停掉） */
  killed: Array<{ pid: number; signal: NodeJS.Signals }>;
}

let dir: string;
let nextPid: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-supervisor-"));
  nextPid = 40_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 构造一个所有外部依赖都可控的监督者 */
function createHarness(
  overrides: Partial<SupervisorOptions> = {},
  harnessOptions: { autoHandshake?: boolean } = {},
): Harness {
  const clock = new VirtualClock();
  const paths = resolveDataPaths({ dataDir: dir });
  const spawned: FakeChild[] = [];
  const livePids = new Set<number>();
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const autoHandshake = harnessOptions.autoHandshake ?? true;

  const options: SupervisorOptions = {
    paths,
    daemonEntry: join(dir, "fake-daemon", "main.js"),
    nodeExecPath: join(dir, "fake-node"),
    clock,
    restartBaseMs: 2_000,
    restartMaxMs: 8_000,
    stableAfterMs: 60_000,
    spawnProcess: () => {
      const pid = nextPid;
      nextPid += 1;
      const child = new FakeChild(pid);
      spawned.push(child);
      livePids.add(pid);
      // daemon 启动后的第一件事就是写握手；这里同步模拟，避免测试真的等。
      // autoHandshake=false 用于模拟"进程活着但卡死"。
      if (autoHandshake) {
        writeFileSync(
          paths.handshakeFile,
          JSON.stringify({
            endpoint: "unix:///tmp/fake-daemon.sock",
            token: "test-token-must-be-long-enough",
            daemonVersion: "test",
            pid,
          }),
        );
      }
      return child;
    },
    isProcessAlive: (pid) => livePids.has(pid),
    killProcess: (pid, signal) => {
      killed.push({ pid, signal });
      livePids.delete(pid);
    },
    ...overrides,
  };

  return { supervisor: new DaemonSupervisor(options), clock, paths, spawned, livePids, killed };
}

/** 取最近一次拉起的假进程；不存在时直接失败，避免非空断言 */
function lastChild(h: Harness): FakeChild {
  const child = h.spawned[h.spawned.length - 1];
  if (!child) throw new Error("测试前提不成立：还没有拉起过子进程");
  return child;
}

/** 模拟崩溃：先从存活表移除，再触发 exit 回调 */
function crash(h: Harness, child: FakeChild = lastChild(h)): void {
  h.livePids.delete(child.pid);
  child.emitExit(1, null);
}

describe("崩溃后自动重启", () => {
  it("进程退出后按 2 秒退避重新拉起，并回到 running", async () => {
    const h = createHarness();
    const first = await h.supervisor.ensureRunning();
    expect(first.kind).toBe("running");
    expect(h.spawned).toHaveLength(1);
    expect(h.clock.pendingTimers()).toBe(0);

    crash(h);
    expect(h.supervisor.state).toMatchObject({ kind: "crashed", restarts: 1 });
    expect(h.supervisor.state.kind === "crashed" && h.supervisor.state.reason).toContain("2 秒");

    await h.clock.advance(1_999);
    expect(h.spawned).toHaveLength(1);

    await h.clock.advance(1);
    expect(h.spawned).toHaveLength(2);
    expect(h.supervisor.state.kind).toBe("running");
  });

  it("★ 连续三次快速崩溃后仍按上限 8 秒继续重试（不再永久放弃）", async () => {
    const h = createHarness();
    await h.supervisor.ensureRunning();

    const delays = [2_000, 4_000, 8_000, 8_000];
    for (const [index, delay] of delays.entries()) {
      crash(h);
      expect(h.supervisor.state).toMatchObject({ kind: "crashed", restarts: index + 1 });
      await h.clock.advance(delay);
      expect(h.supervisor.state.kind).toBe("running");
    }

    // 已经崩溃 4 次、拉起 5 次；再崩一次仍要重试，而不是停在 unavailable
    crash(h);
    expect(h.supervisor.state).toMatchObject({ kind: "crashed", restarts: 5 });
    expect(h.clock.pendingTimers()).toBe(1);
    await h.clock.advance(8_000);
    expect(h.spawned).toHaveLength(6);
  });

  it("★ 稳定运行 60 秒后崩溃，退避重新从 2 秒开始", async () => {
    const h = createHarness();
    await h.supervisor.ensureRunning();

    // 第一次崩溃后重启，第二个进程稳定运行满 60 秒
    crash(h);
    await h.clock.advance(2_000);
    expect(h.spawned).toHaveLength(2);
    await h.clock.advance(60_000);

    crash(h);
    expect(h.supervisor.state).toMatchObject({ kind: "crashed", restarts: 1 });
    expect(h.supervisor.state.kind === "crashed" && h.supervisor.state.reason).toContain("2 秒");

    await h.clock.advance(2_000);
    expect(h.spawned).toHaveLength(3);
  });

  it("spawn 同步抛错不会冒泡，而是安排下一次重试", () => {
    const h = createHarness({
      spawnProcess: () => {
        throw new Error("bad cwd");
      },
    });

    expect(() => h.supervisor.spawnDaemon()).not.toThrow();
    expect(h.supervisor.state).toMatchObject({ kind: "crashed", restarts: 1 });
    expect(h.supervisor.state.kind === "crashed" && h.supervisor.state.reason).toContain("bad cwd");
    expect(h.clock.pendingTimers()).toBe(1);
  });

  it("spawn 同步抛错时 ensureRunning 立即返回 crashed，而不是等满超时", async () => {
    const h = createHarness({
      spawnProcess: () => {
        throw new Error("bad cwd");
      },
    });

    const state = await h.supervisor.ensureRunning(8_000);
    expect(state).toMatchObject({ kind: "crashed", restarts: 1 });
    expect(h.clock.pendingTimers()).toBe(1);
  });

  it("spawn 异步 error 也会安排重试，而不是留下未处理的 error 事件", async () => {
    const h = createHarness();
    await h.supervisor.ensureRunning();
    const child = lastChild(h);
    h.livePids.delete(child.pid);
    child.emitError(new Error("ENOENT: node not found"));

    expect(h.supervisor.state).toMatchObject({ kind: "crashed", restarts: 1 });
    expect(h.supervisor.state.kind === "crashed" && h.supervisor.state.reason).toContain("ENOENT");
    await h.clock.advance(2_000);
    expect(h.spawned).toHaveLength(2);
  });
});

describe("启动看门狗（活着但卡死）", () => {
  it("★ 启动 5 秒仍无握手：SIGKILL 子进程并安排重启", async () => {
    const h = createHarness({ startupTimeoutMs: 5_000 }, { autoHandshake: false });
    const initial = await h.supervisor.ensureRunning(1_000);
    expect(initial.kind).toBe("unavailable");

    const child = lastChild(h);
    expect(h.clock.pendingTimers()).toBe(1); // 只有启动看门狗，没有重启定时器

    await h.clock.advance(4_000);
    expect(child.killedWith).toEqual(["SIGKILL"]);
    expect(h.supervisor.state.kind).toBe("unavailable");
    expect(h.supervisor.state.kind === "unavailable" && h.supervisor.state.reason).toContain("仍未就绪");

    // 真实进程被 SIGKILL 后 exit 事件会到达；这里手动模拟，验证会排下一次重启
    h.livePids.delete(child.pid);
    child.emitExit(null, "SIGKILL");
    expect(h.supervisor.state).toMatchObject({ kind: "crashed", restarts: 1 });
    expect(h.clock.pendingTimers()).toBe(1);
    h.supervisor.dispose();
  });

  it("看门狗到点前收到握手：转入 running，不杀进程", async () => {
    const h = createHarness({ startupTimeoutMs: 5_000 }, { autoHandshake: false });
    await h.supervisor.ensureRunning(1_000);
    const child = lastChild(h);

    // 进程启动很慢，但在看门狗到点前完成了握手
    writeFileSync(
      h.paths.handshakeFile,
      JSON.stringify({
        endpoint: "unix:///tmp/late-daemon.sock",
        token: "late-token-must-be-long-enough",
        daemonVersion: "test",
        pid: child.pid,
      }),
    );

    await h.clock.advance(4_000);
    expect(child.killedWith).toEqual([]);
    expect(h.supervisor.state.kind).toBe("running");
    expect(h.clock.pendingTimers()).toBe(0);
    h.supervisor.dispose();
  });

  it("dispose 取消启动看门狗，不再杀子进程", async () => {
    const h = createHarness({ startupTimeoutMs: 5_000 }, { autoHandshake: false });
    await h.supervisor.ensureRunning(1_000);
    const child = lastChild(h);
    expect(h.clock.pendingTimers()).toBe(1);

    h.supervisor.dispose();
    expect(h.clock.pendingTimers()).toBe(0);

    await h.clock.advance(10_000);
    expect(child.killedWith).toEqual([]);
  });

  it("startupTimeoutMs 必须大于 0", () => {
    expect(() => createHarness({ startupTimeoutMs: 0 })).toThrow(RangeError);
  });
});

describe("0 退出（stop / 已有实例）", () => {
  it("daemon 以 0 退出且没有其他实例：保持 stopped，不重启", async () => {
    const h = createHarness();
    await h.supervisor.ensureRunning();
    const child = lastChild(h);

    h.livePids.delete(child.pid);
    child.emitExit(0, null);

    expect(h.supervisor.state.kind).toBe("stopped");
    expect(h.clock.pendingTimers()).toBe(0);
    await h.clock.advance(10_000);
    expect(h.spawned).toHaveLength(1);
    h.supervisor.dispose();
  });

  it("★ 以 0 退出但已有存活实例：采纳现有实例，不抢重启", async () => {
    const h = createHarness();
    await h.supervisor.ensureRunning();
    const child = lastChild(h);

    // 模拟 launchd/CLI 已经启动的另一个 daemon
    writeFileSync(
      h.paths.handshakeFile,
      JSON.stringify({
        endpoint: "unix:///tmp/existing-daemon.sock",
        token: "existing-token-must-be-long-enough",
        daemonVersion: "test",
        pid: 12_345,
      }),
    );
    h.livePids.add(12_345);
    h.livePids.delete(child.pid);
    child.emitExit(0, null);

    expect(h.supervisor.state).toMatchObject({ kind: "running", spawnedByUs: false });
    expect(h.clock.pendingTimers()).toBe(0);
    await h.clock.advance(10_000);
    expect(h.spawned).toHaveLength(1);
    h.supervisor.dispose();
  });

  it("★ 其他工作区的 daemon 占着数据目录时，先停止再拉起当前入口", async () => {
    const h = createHarness();
    const foreignPid = 12_345;
    writeFileSync(
      h.paths.handshakeFile,
      JSON.stringify({
        endpoint: "unix:///tmp/old-checkout.sock",
        token: "old-token-must-be-long-enough",
        pid: foreignPid,
        daemonEntry: join(dir, "old-checkout", "apps", "daemon", "dist", "main.js"),
      }),
    );
    h.livePids.add(foreignPid);

    const state = await h.supervisor.ensureRunning(1_000);

    expect(state.kind).toBe("running");
    expect(state.kind === "running" && state.spawnedByUs).toBe(true);
    // 不能采纳旧进程：必须先发 SIGTERM
    expect(h.killed).toContainEqual({ pid: foreignPid, signal: "SIGTERM" });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.pid).not.toBe(foreignPid);
    h.supervisor.dispose();
  });
});

describe("生命周期边界", () => {
  it("已有存活 daemon 时直接复用，不重复拉起", async () => {
    const h = createHarness();
    writeFileSync(
      h.paths.handshakeFile,
      JSON.stringify({
        endpoint: "unix:///tmp/existing.sock",
        token: "existing-token-must-be-long-enough",
        daemonVersion: "test",
        pid: 12_345,
      }),
    );
    h.livePids.add(12_345);

    const state = await h.supervisor.ensureRunning();
    expect(state).toMatchObject({ kind: "running", spawnedByUs: false });
    expect(h.spawned).toHaveLength(0);
  });

  it("★ dispose 后取消待触发的重启，不再拉起新进程", async () => {
    const h = createHarness();
    await h.supervisor.ensureRunning();
    crash(h);
    expect(h.clock.pendingTimers()).toBe(1);

    h.supervisor.dispose();
    expect(h.clock.pendingTimers()).toBe(0);

    await h.clock.advance(60_000);
    expect(h.spawned).toHaveLength(1);
  });

  it("dispose 之后手动 ensureRunning 也不会再拉起", async () => {
    const h = createHarness();
    h.supervisor.dispose();
    const state = await h.supervisor.ensureRunning();
    expect(state.kind).toBe("stopped");
    expect(h.spawned).toHaveLength(0);
  });

  it("握手文件是半截 JSON 时返回 null，而不是抛错", () => {
    const h = createHarness();
    writeFileSync(h.paths.handshakeFile, '{"endpoint": "unix:///tmp/half');
    expect(h.supervisor.readHandshake()).toBeNull();
  });
});

describe("打包态路径解析", () => {
  it("Resources/node/bin/node 存在时优先使用随附 Node", () => {
    const resources = join(dir, "Resources");
    mkdirSync(join(resources, "node", "bin"), { recursive: true });
    const bundled = join(resources, "node", "bin", "node");
    writeFileSync(bundled, "");

    expect(resolveNodeExecPath(undefined, resources)).toBe(bundled);
  });

  it("Resources/daemon/main.js 存在时优先于开发态入口", () => {
    const resources = join(dir, "Resources");
    mkdirSync(join(resources, "daemon"), { recursive: true });
    const packaged = join(resources, "daemon", "main.js");
    writeFileSync(packaged, "");

    expect(resolveDaemonEntry({ repoRoot: dir, resourcesPath: resources })).toBe(packaged);
  });

  it("资源目录里没有 daemon 时回退到开发态路径", () => {
    const resources = join(dir, "EmptyResources");
    mkdirSync(resources, { recursive: true });
    const devEntry = join(dir, "apps", "daemon", "dist", "main.js");
    mkdirSync(join(dir, "apps", "daemon", "dist"), { recursive: true });
    writeFileSync(devEntry, "");

    expect(resolveDaemonEntry({ repoRoot: dir, resourcesPath: resources })).toBe(devEntry);
  });
});
