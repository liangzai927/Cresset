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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "@aegis/clock";
import { type DataPaths, resolveDataPaths } from "@aegis/product";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonSupervisor, type SupervisedChild, type SupervisorOptions } from "./supervisor.js";

/** 受控的假子进程：测试显式触发 exit / error 回调 */
class FakeChild implements SupervisedChild {
  readonly pid: number;
  #onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  #onError: ((error: Error) => void) | null = null;

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
function createHarness(overrides: Partial<SupervisorOptions> = {}): Harness {
  const clock = new VirtualClock();
  const paths = resolveDataPaths({ dataDir: dir });
  const spawned: FakeChild[] = [];
  const livePids = new Set<number>();

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
      // daemon 启动后的第一件事就是写握手；这里同步模拟，避免测试真的等
      writeFileSync(
        paths.handshakeFile,
        JSON.stringify({
          endpoint: "unix:///tmp/fake-daemon.sock",
          token: "test-token-must-be-long-enough",
          daemonVersion: "test",
          pid,
        }),
      );
      return child;
    },
    isProcessAlive: (pid) => livePids.has(pid),
    ...overrides,
  };

  return { supervisor: new DaemonSupervisor(options), clock, paths, spawned, livePids };
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
