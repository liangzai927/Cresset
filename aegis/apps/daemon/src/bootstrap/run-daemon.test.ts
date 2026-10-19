/**
 * daemon 启动序列的集成测试（《M0+M1 详细设计》§3/§7）。
 *
 * 覆盖：启动步骤产物、0600 权限、单实例锁与陈旧锁回收、跨重启时钟跳变检测、
 * IPC 端到端（含 C-4：断线重连必须自动重放握手）。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "@aegis/clock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IpcClient, readHandshakeFile } from "../ipc/client.js";
import { AlreadyRunningError, DAEMON_VERSION, type RunningDaemon, runDaemon } from "./run-daemon.js";

let dir: string;
let running: RunningDaemon | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-daemon-"));
});

afterEach(async () => {
  if (running) {
    await running.stop("test-cleanup");
    running = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 断言 daemon 已启动（替代非空断言，失败信息更明确） */
function requireRunning(): RunningDaemon {
  if (!running) throw new Error("daemon 尚未启动");
  return running;
}

/** 快速启动参数：放大间隔，避免定时器在测试期间干扰 */
const FAST = { tickMs: 3_600_000, heartbeatIntervalMs: 3_600_000 };

describe("启动序列（详细设计 §3）", () => {
  it("完成全部启动步骤并产出数据库/握手文件/ready 标记", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });

    expect(existsSync(running.paths.dbFile)).toBe(true);
    expect(existsSync(running.paths.handshakeFile)).toBe(true);
    expect(existsSync(running.paths.readyFile)).toBe(true);
    expect(running.startup.appliedMigrations).toEqual([1, 2]);
  });

  it("握手文件权限为 0600（token 不可被其他用户读取）", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    const mode = statSync(running.paths.handshakeFile).mode & 0o777;
    expect(mode).toBe(0o600);
    const hs = readHandshakeFile(running.paths.handshakeFile);
    expect(hs.token.length).toBeGreaterThan(20);
    expect(hs.protocolVersion).toBe(1);
    // 诊断字段：界面"服务版本"与打包验证都依赖它们。
    // daemonEntry 在真实进程里是 main.js；vitest 内嵌运行时 process.argv[1] 是测试入口，
    // 因此这里只断言进程级字段，入口路径由打包验证覆盖。
    expect(hs.daemonVersion).toBe(DAEMON_VERSION);
    expect(hs.nodeExecPath).toBe(process.execPath);
    expect(hs.endpoint).toBe(running.paths.ipcEndpoint);
  });

  it("IPC socket 文件权限为 0600", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    const mode = statSync(running.paths.ipcEndpoint).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("启动时写入心跳与启动审计", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    const hb = running.db.prepare("SELECT COUNT(*) AS n FROM heartbeat").get() as { n: number };
    expect(hb.n).toBeGreaterThanOrEqual(1);

    const audit = running.db
      .prepare("SELECT actor, purpose, outcome FROM outbound_audit ORDER BY at DESC LIMIT 1")
      .get() as { actor: string; purpose: string; outcome: string };
    expect(audit.actor).toBe("daemon");
    expect(audit.purpose).toBe("startup");
    expect(audit.outcome).toBe("allowed");
  });

  it("配置缺失时使用默认值并把问题带出来（不静默）", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    expect(running.startup.configIssues.length).toBeGreaterThan(0);
    expect(running.startup.configIssues[0]).toContain("配置文件不存在");
    expect(running.config.tickMs).toBe(30_000); // 默认值
  });

  it("已有配置文件时按其取值，且不再报缺失", async () => {
    const cfgPath = join(dir, "config.json");
    await import("node:fs").then(({ writeFileSync }) =>
      writeFileSync(cfgPath, JSON.stringify({ tickMs: 45_000, locale: "zh-CN" })),
    );
    running = await runDaemon({ dataDir: dir, ...FAST });
    expect(running.config.tickMs).toBe(45_000);
    expect(running.startup.configIssues).toEqual([]);
  });

  it("损坏的配置文件回退默认值并明确报告", async () => {
    const cfgPath = join(dir, "config.json");
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(cfgPath, "{ 这不是 JSON"));
    running = await runDaemon({ dataDir: dir, ...FAST });
    expect(running.config.tickMs).toBe(30_000);
    expect(running.startup.configIssues.join(" ")).toContain("无法解析");
  });

  it("非法配置项被指出具体路径", async () => {
    const cfgPath = join(dir, "config.json");
    await import("node:fs").then(
      ({ writeFileSync }) => writeFileSync(cfgPath, JSON.stringify({ tickMs: 1 })), // 低于下限 1000
    );
    running = await runDaemon({ dataDir: dir, ...FAST });
    expect(running.startup.configIssues.join(" ")).toContain("tickMs");
  });
});

describe("单实例锁（详细设计 §3 第 2 步）", () => {
  it("第二个实例被拒绝，且给出持有者信息", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    await expect(runDaemon({ dataDir: dir, ...FAST })).rejects.toThrow(AlreadyRunningError);
    await expect(runDaemon({ dataDir: dir, ...FAST })).rejects.toThrow(/已有实例在运行/);
  });

  it("陈旧锁（进程已死）会被自动回收并记录", async () => {
    // 手工造一个指向"不存在的 pid"的锁文件
    await import("node:fs").then(({ writeFileSync }) =>
      writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid: 999_999, startedAt: Date.now() })),
    );
    running = await runDaemon({ dataDir: dir, ...FAST });
    expect(running.startup.staleLockRecovered).toBe(true);
  });

  it("锁文件内容损坏时视为陈旧锁", async () => {
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(join(dir, "daemon.lock"), "not-json"));
    running = await runDaemon({ dataDir: dir, ...FAST });
    expect(running.startup.staleLockRecovered).toBe(true);
  });

  it("优雅停止后锁被释放，可再次启动", async () => {
    const first = await runDaemon({ dataDir: dir, ...FAST });
    await first.stop("test");
    expect(existsSync(first.paths.lockFile)).toBe(false);

    running = await runDaemon({ dataDir: dir, ...FAST });
    expect(existsSync(running.paths.lockFile)).toBe(true);
  });

  it("停止会清理握手文件、ready 标记与 socket", async () => {
    const daemon = await runDaemon({ dataDir: dir, ...FAST });
    const { handshakeFile, readyFile, ipcEndpoint } = daemon.paths;
    await daemon.stop("test");
    expect(existsSync(handshakeFile)).toBe(false);
    expect(existsSync(readyFile)).toBe(false);
    expect(existsSync(ipcEndpoint)).toBe(false);
  });
});

describe("时钟跳变检测（详细设计 §3 第 6 步）", () => {
  it("首次启动无历史快照 → 不报跳变", async () => {
    running = await runDaemon({ dataDir: dir, clock: new VirtualClock(), ...FAST });
    expect(running.startup.clockJump.kind).toBe("none");
  });

  it("跨重启的墙钟跳变会被检出（模拟睡眠/改时间）", async () => {
    // 第一次启动：写入快照
    const clock1 = new VirtualClock();
    const first = await runDaemon({ dataDir: dir, clock: clock1, ...FAST });
    await first.stop("t");

    // 第二次启动：墙钟前进 8 小时但单调钟几乎不动 → 判定为挂起
    const clock2 = new VirtualClock(clock1.wall() + 8 * 3_600_000);
    running = await runDaemon({ dataDir: dir, clock: clock2, ...FAST });
    expect(running.startup.clockJump.kind).toBe("suspended");
    expect(running.startup.clockJump.skewMs).toBeGreaterThan(60_000);
  });
});

describe("IPC 端到端（详细设计 §7，含 R0 S6 的 C-4 约束）", () => {
  async function connect(): Promise<IpcClient> {
    const daemon = requireRunning();
    const hs = readHandshakeFile(daemon.paths.handshakeFile);
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token, requestTimeoutMs: 3_000 });
    await client.connect();
    return client;
  }

  it("握手成功并可调用 sys.health", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    const client = await connect();
    try {
      expect(client.handshake?.protocolVersion).toBe(1);
      const health = await client.health();
      expect(health.ok).toBe(true);
      expect(health.tickCount).toBe(0);
      expect(health.rssBytes).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  it("错误 token 被拒绝（E_AUTH）", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    const hs = readHandshakeFile(running.paths.handshakeFile);
    const client = new IpcClient({ endpoint: hs.endpoint, token: "wrong-token" });
    await expect(client.connect()).rejects.toThrow(/E_AUTH/);
    client.close();
  });

  it("未握手的连接调用其它方法被拒绝", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    const hs = readHandshakeFile(running.paths.handshakeFile);
    // 手工建连但不握手
    const { connect } = await import("node:net");
    const socket = connect(hs.endpoint);
    await new Promise<void>((r) => socket.once("connect", () => r()));
    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (d) => resolve(d.toString("utf8")));
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sys.health", params: {} })}\n`);
    });
    expect(reply).toContain("E_AUTH");
    socket.destroy();
  });

  it("未知方法返回 E_METHOD_NOT_FOUND", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    const client = await connect();
    try {
      await expect(client.call("nope.nope", {})).rejects.toThrow(/E_METHOD_NOT_FOUND/);
    } finally {
      client.close();
    }
  });

  it("★ 断线后重连会自动重放握手（C-4：新连接 = 新鉴权会话）", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    const hs = readHandshakeFile(running.paths.handshakeFile);
    let disconnects = 0;
    const client = new IpcClient({
      endpoint: hs.endpoint,
      token: hs.token,
      onStateChange: (s) => {
        if (s === "disconnected") disconnects += 1;
      },
    });
    await client.connect();
    expect((await client.health()).ok).toBe(true);

    // 粗暴断开：模拟 daemon 侧连接被掐断
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(disconnects).toBeGreaterThan(0);

    // 再次调用：客户端应自动重连 + 重新握手，否则会 E_AUTH
    const health = await client.health();
    expect(health.ok).toBe(true);
    client.close();
  });

  it("多个客户端可同时连接并各自独立鉴权", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    const hs = readHandshakeFile(running.paths.handshakeFile);
    const a = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    const b = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await a.connect();
    await b.connect();
    try {
      expect((await a.health()).ok).toBe(true);
      expect((await b.health()).ok).toBe(true);
      expect(running.ipc.authedConnectionCount).toBe(2);
    } finally {
      a.close();
      b.close();
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(running.ipc.authedConnectionCount).toBe(0);
  });

  it("sys.shutdown 可远程触发优雅停止", async () => {
    const daemon = await runDaemon({ dataDir: dir, ...FAST });
    const hs = readHandshakeFile(daemon.paths.handshakeFile);
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();
    try {
      await client.call("sys.shutdown", {});
    } catch {
      // 连接可能在响应前被关停，这不影响"已触发停止"的结论
    }
    const code = await Promise.race([
      daemon.stopped,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("停止超时")), 3_000)),
    ]);
    expect(code).toBe(0);
    client.close();
  });
});

describe("数据库状态（R1 交付面）", () => {
  it("迁移表记录了 2 个迁移且 checksum 完整", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    const rows = running.db
      .prepare("SELECT id, name, checksum FROM schema_migration ORDER BY id")
      .all() as Array<{ id: number; name: string; checksum: string }>;
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows.every((r) => r.checksum.length === 64)).toBe(true);
  });

  it("时钟快照被持久化（供下次启动检测跳变）", async () => {
    running = await runDaemon({ dataDir: dir, ...FAST });
    const row = running.db.prepare("SELECT value FROM app_setting WHERE key = 'clock.snapshot'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    const snapshot = JSON.parse(row?.value ?? "{}") as { wall: number; mono: number };
    expect(typeof snapshot.wall).toBe("number");
    expect(typeof snapshot.mono).toBe("number");
  });

  it("重启后数据库复用（不重复建表、数据保留）", async () => {
    const first = await runDaemon({ dataDir: dir, ...FAST });
    const auditBefore = first.db.prepare("SELECT COUNT(*) AS n FROM outbound_audit").get() as { n: number };
    await first.stop("t");

    running = await runDaemon({ dataDir: dir, ...FAST });
    expect(running.startup.appliedMigrations).toEqual([]); // 已应用过
    const auditAfter = running.db.prepare("SELECT COUNT(*) AS n FROM outbound_audit").get() as { n: number };
    expect(auditAfter.n).toBeGreaterThan(auditBefore.n); // 新增了本次启动的审计
  });
});

describe("R2：调度器接入与 RPC 方法", () => {
  it("★ 启动后调度器已就绪，并能经 RPC 创建提醒", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-sched-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });

    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    // 目标时刻：1 小时后（避免测试期间真的弹出通知打扰用户）
    const target = new Date(Date.now() + 3_600_000);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    const wall = `${target.getFullYear()}-${p2(target.getMonth() + 1)}-${p2(target.getDate())}T${p2(target.getHours())}:${p2(target.getMinutes())}`;

    const created = (await client.call("task.create", {
      title: "集成测试提醒",
      firstFireAtWall: wall,
      repeat: { mode: "once" },
      priority: "normal",
    })) as { id: string };

    expect(typeof created.id).toBe("string");
    expect(created.id.length).toBeGreaterThan(0);

    // task.list 应当能读回，并且带人话描述与下次触发时刻
    const list = (await client.call("task.list", {})) as {
      items: Array<{ id: string; repeatLabel: string; nextFireWall: string | null }>;
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.id).toBe(created.id);
    expect(list.items[0]?.repeatLabel).toContain("一次性");
    expect(list.items[0]?.nextFireWall).not.toBeNull();

    // notify.history 在有调度器后仍可正常调用（结构对齐契约）
    const history = (await client.call("notify.history", {})) as { items: unknown[] };
    expect(Array.isArray(history.items)).toBe(true);

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ task.snooze 从当前时刻起算，而不是原定时刻", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-snooze-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    const now = Date.now();
    const target = new Date(now + 3_600_000);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    const wall = `${target.getFullYear()}-${p2(target.getMonth() + 1)}-${p2(target.getDate())}T${p2(target.getHours())}:${p2(target.getMinutes())}`;

    const created = (await client.call("task.create", {
      title: "稍后提醒测试",
      firstFireAtWall: wall,
      repeat: { mode: "once" },
      priority: "normal",
    })) as { id: string };

    // 手工造一个"一小时前已投递"的实例，模拟延迟处理后的稍后提醒
    const occurrenceId = randomUUID();
    daemon.db
      .prepare(
        `INSERT INTO occurrence (id, task_id, scheduled_at, scheduled_wall, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'delivered', ?, ?)`,
      )
      .run(occurrenceId, created.id, now - 3_600_000, wall, now - 3_600_000, now);

    const snoozed = (await client.call("task.snooze", {
      occurrenceId,
      minutes: 5,
    })) as { id: string };

    const row = daemon.db.prepare("SELECT scheduled_for FROM notification WHERE id = ?").get(snoozed.id) as
      | { scheduled_for: number }
      | undefined;
    expect(row).toBeDefined();
    // 关键：约等于 now + 5 分钟，而不是 occurrence.scheduledAt + 5 分钟（过去）
    expect(row?.scheduled_for).toBeGreaterThanOrEqual(now + 5 * 60_000 - 2_000);
    expect(row?.scheduled_for).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 2_000);

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ 契约里定义的方法都已注册（防止 E_METHOD_NOT_FOUND 回归）", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-methods-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    // 逐个调用应当"方法存在"（参数可能非法，但不能是 E_METHOD_NOT_FOUND）
    const methods = ["task.list", "notify.history", "dnd.get", "ctrl.pauseAll", "ctrl.resumeAll"];
    for (const m of methods) {
      try {
        await client.call(m, {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain("E_METHOD_NOT_FOUND");
      }
    }

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });
});
