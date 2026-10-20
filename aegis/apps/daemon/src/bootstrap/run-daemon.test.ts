/**
 * daemon 启动序列的集成测试（《M0+M1 详细设计》§3/§7）。
 *
 * 覆盖：启动步骤产物、0600 权限、单实例锁与陈旧锁回收、跨重启时钟跳变检测、
 * IPC 端到端（含 C-4：断线重连必须自动重放握手）。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    expect(running.startup.appliedMigrations).toEqual([1, 2, 3, 4, 5]);
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

describe("运行缺口自监控（TC-M1-19 / NFR-R5）", () => {
  it("★ 停机 5 小时后启动会记录 run_gap 并生成 system_gap 通知", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-gap-"));
    const clock1 = new VirtualClock();
    const first = await runDaemon({ dataDir, clock: clock1, ...FAST });
    await first.stop("test");

    const clock2 = new VirtualClock(clock1.wall() + 5 * 3_600_000);
    const second = await runDaemon({ dataDir, clock: clock2, ...FAST });

    const gaps = second.db
      .prepare("SELECT gap_start, gap_end, cause, notified FROM run_gap ORDER BY detected_at DESC")
      .all() as Array<{ gap_start: number; gap_end: number; cause: string; notified: number }>;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.cause).toBe("sleep");
    expect(gaps[0]?.notified).toBe(1);
    expect(gaps[0]?.gap_end).toBe(clock2.wall());

    const note = second.db
      .prepare("SELECT kind, title, state FROM notification WHERE kind = 'system_gap'")
      .get() as { kind: string; title: string; state: string } | undefined;
    expect(note).toBeDefined();
    expect(note?.title).toContain("没有运行");
    expect(note?.state).toBe("pending");

    await second.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
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
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
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

    // snooze 期间任务不能从列表消失：nextFireAt 应指向新的 pending 通知
    const list = (await client.call("task.list", {})) as {
      items: Array<{ id: string; nextFireAt: number | null }>;
    };
    const view = list.items.find((t) => t.id === created.id);
    expect(view).toBeDefined();
    expect(view?.nextFireAt).toBeGreaterThanOrEqual(now + 5 * 60_000 - 2_000);

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ 完成一次性提醒后从列表移除，重复提醒保留", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-complete-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    const now = Date.now();
    const target = new Date(now + 3_600_000);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    const wall = `${target.getFullYear()}-${p2(target.getMonth() + 1)}-${p2(target.getDate())}T${p2(target.getHours())}:${p2(target.getMinutes())}`;

    const oneTime = (await client.call("task.create", {
      title: "一次性完成",
      firstFireAtWall: wall,
      repeat: { mode: "once" },
      priority: "normal",
    })) as { id: string };
    const recurring = (await client.call("task.create", {
      title: "重复提醒",
      firstFireAtWall: wall,
      repeat: { mode: "daily" },
      priority: "normal",
    })) as { id: string };

    const insertDelivered = (taskId: string): string => {
      const id = randomUUID();
      daemon.db
        .prepare(
          `INSERT INTO occurrence (id, task_id, scheduled_at, scheduled_wall, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'delivered', ?, ?)`,
        )
        .run(id, taskId, now - 1_000, wall, now - 1_000, now);
      return id;
    };

    const done = (await client.call("task.complete", {
      occurrenceId: insertDelivered(oneTime.id),
    })) as { ok: boolean };
    expect(done.ok).toBe(true);

    const afterOne = (await client.call("task.list", {})) as { items: Array<{ id: string }> };
    expect(afterOne.items.map((i) => i.id)).not.toContain(oneTime.id);

    const recurringDone = (await client.call("task.complete", {
      occurrenceId: insertDelivered(recurring.id),
    })) as { ok: boolean };
    expect(recurringDone.ok).toBe(false); // 已投递实例不再 markCompleted，但任务不能被删

    const afterRecurring = (await client.call("task.list", {})) as { items: Array<{ id: string }> };
    expect(afterRecurring.items.map((i) => i.id)).toContain(recurring.id);

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ task.update 修改时间并清掉旧的未来实例", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-update-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    const now = Date.now();
    const p2 = (n: number): string => String(n).padStart(2, "0");
    const wallAt = (offsetMs: number): string => {
      const d = new Date(now + offsetMs);
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
    };
    const firstWall = wallAt(3_600_000);
    const secondWall = wallAt(7_200_000);

    const created = (await client.call("task.create", {
      title: "原标题",
      notes: "原备注",
      firstFireAtWall: firstWall,
      repeat: { mode: "once" },
      priority: "normal",
    })) as { id: string };

    const detail = (await client.call("task.get", { id: created.id })) as {
      title: string;
      firstFireAtWall: string;
      repeat: { mode: string };
    };
    expect(detail.title).toBe("原标题");
    expect(detail.firstFireAtWall).toBe(firstWall);
    expect(detail.repeat.mode).toBe("once");

    // 造一个旧的未来实例：更新后应被删除，避免两套计划并存
    const oldOccurrence = randomUUID();
    daemon.db
      .prepare(
        `INSERT INTO occurrence (id, task_id, scheduled_at, scheduled_wall, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(oldOccurrence, created.id, now + 3_600_000, firstWall, now, now);

    const updated = (await client.call("task.update", {
      id: created.id,
      title: "新标题",
      notes: "新备注",
      priority: "important",
      firstFireAtWall: secondWall,
      repeat: { mode: "once" },
    })) as { id: string };
    expect(updated.id).toBe(created.id);

    const after = (await client.call("task.get", { id: created.id })) as {
      title: string;
      firstFireAtWall: string;
      priority: string;
    };
    expect(after.title).toBe("新标题");
    expect(after.firstFireAtWall).toBe(secondWall);
    expect(after.priority).toBe("important");

    const gone = daemon.db
      .prepare("SELECT COUNT(*) AS n FROM occurrence WHERE id = ?")
      .get(oldOccurrence) as {
      n: number;
    };
    expect(gone.n).toBe(0);

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ dnd.set 持久化到 config.json 并立即影响 dnd.get", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-dnd-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    const settings = {
      enabled: true,
      windows: [{ days: [1, 2, 3, 4, 5], from: "22:00", to: "08:00" }],
    };
    const result = (await client.call("dnd.set", settings)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(await client.call("dnd.get", {})).toEqual(settings);

    const saved = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as {
      dnd?: unknown;
    };
    expect(saved.dnd).toEqual(settings);
    expect(statSync(join(dataDir, "config.json")).mode & 0o777).toBe(0o600);

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ monitor.system 返回可展示的系统健康指标", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-health-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    const result = (await client.call("monitor.system", {})) as {
      health: { cpuCount: number; diskFreePercent: number; memoryFreePercent: number; mount: string };
      errors: unknown[];
    };
    expect(result.health.cpuCount).toBeGreaterThan(0);
    expect(result.health.mount).toBe("/");
    expect(result.health.diskFreePercent).toBeGreaterThanOrEqual(0);
    expect(result.health.memoryFreePercent).toBeGreaterThanOrEqual(0);
    expect(result.errors).toEqual([]);

    const monitors = (await client.call("monitor.status", {})) as { monitors: unknown[] };
    expect(monitors.monitors).toEqual([]);
    const scan = (await client.call("monitor.scan", { id: "missing" })) as { found: boolean };
    expect(scan.found).toBe(false);

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ monitor.preset 一键补齐验收场景且幂等", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-preset-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    const first = (await client.call("monitor.preset", {})) as {
      installedSkills: string[];
      addedMonitors: string[];
      skippedMonitors: string[];
      monitors: Array<{ id: string; skills: string[] }>;
    };
    expect(first.installedSkills).toHaveLength(5);
    expect(first.addedMonitors.sort()).toEqual(["files.downloads", "system.host"]);
    expect(first.skippedMonitors).toEqual([]);
    expect(first.monitors.flatMap((m) => m.skills)).toHaveLength(3);

    const second = (await client.call("monitor.preset", {})) as {
      installedSkills: string[];
      addedMonitors: string[];
      skippedMonitors: string[];
    };
    expect(second.installedSkills).toEqual([]);
    expect(second.addedMonitors).toEqual([]);
    expect(second.skippedMonitors.sort()).toEqual(["files.downloads", "system.host"]);

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ monitor.add/remove 热更新配置并验证绑定", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-monitor-config-"));
    const skillsDir = join(dataDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "test.yaml"),
      `name: monitor-config-test
version: 1.0.0
description: 配置热更新测试
permissions: [system.read]
cooldown: 1h
params: {}
trigger:
  type: change
  monitor: system.test
action:
  notify:
    priority: normal
    title: 配置测试
    body: "{{monitor.mount}}"
`,
    );

    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    const added = (await client.call("monitor.add", {
      id: "system.test",
      kind: "system",
      intervalS: 60,
      skills: ["skills/test.yaml"],
    })) as { monitors: Array<{ id: string }> };
    expect(added.monitors.map((m) => m.id)).toEqual(["system.test"]);

    const status = (await client.call("monitor.status", {})) as { monitors: Array<{ id: string }> };
    expect(status.monitors.map((m) => m.id)).toEqual(["system.test"]);

    await client.call("monitor.toggle", { id: "system.test", enabled: false });
    const disabledStatus = (await client.call("monitor.status", {})) as { monitors: unknown[] };
    expect(disabledStatus.monitors).toEqual([]);
    const disabledConfig = (await client.call("monitor.config", {})) as {
      monitors: Array<{ id: string; enabled: boolean }>;
    };
    expect(disabledConfig.monitors[0]).toMatchObject({ id: "system.test", enabled: false });

    await client.call("monitor.toggle", { id: "system.test", enabled: true });
    const enabledStatus = (await client.call("monitor.status", {})) as { monitors: Array<{ id: string }> };
    expect(enabledStatus.monitors.map((m) => m.id)).toEqual(["system.test"]);

    const removed = (await client.call("monitor.remove", { id: "system.test" })) as {
      monitors: unknown[];
    };
    expect(removed.monitors).toEqual([]);
    const after = (await client.call("monitor.status", {})) as { monitors: unknown[] };
    expect(after.monitors).toEqual([]);

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ skill.import/list/delete 经 RPC 写入数据目录", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-skill-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    const content = `name: rpc-skill
version: 1.0.0
description: RPC 导入测试
permissions: [files.read]
cooldown: 5m
params: {}
trigger:
  type: change
  monitor: files.test
action:
  notify:
    priority: normal
    title: 测试
    body: "{{monitor.path}}"
`;
    const imported = (await client.call("skill.import", { filename: "rpc-skill.yaml", content })) as {
      skill: { name: string; valid: boolean };
    };
    expect(imported.skill).toMatchObject({ name: "rpc-skill", valid: true });

    const listed = (await client.call("skill.list", {})) as { skills: Array<{ file: string }> };
    expect(listed.skills.map((s) => s.file)).toEqual(["rpc-skill.yaml"]);
    const read = (await client.call("skill.read", { filename: "rpc-skill.yaml" })) as {
      content: string;
    };
    expect(read.content).toContain("rpc-skill");

    await client.call("skill.delete", { filename: "rpc-skill.yaml" });
    const after = (await client.call("skill.list", {})) as { skills: unknown[] };
    expect(after.skills).toEqual([]);

    const defaults = (await client.call("skill.installDefaults", {})) as {
      installed: string[];
      skipped: string[];
    };
    expect(defaults.installed).toHaveLength(5);
    expect(defaults.skipped).toEqual([]);

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ knowledge.import/search/list/remove 闭环", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-knowledge-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    const imported = (await client.call("knowledge.import", {
      sourcePath: "/tmp/project.md",
      title: "项目文档",
      content: "Aegis 的项目知识库说明文档。",
      dataClass: "L1",
    })) as { document: { id: string; chunkCount: number } };
    expect(imported.document.chunkCount).toBeGreaterThan(0);

    const hits = (await client.call("knowledge.search", { query: "知识库", limit: 10 })) as {
      hits: Array<{ title: string; sourcePath: string }>;
    };
    expect(hits.hits[0]).toMatchObject({ title: "项目文档", sourcePath: "/tmp/project.md" });

    const listed = (await client.call("knowledge.list", {})) as { documents: unknown[] };
    expect(listed.documents).toHaveLength(1);

    await client.call("knowledge.remove", { id: imported.document.id });
    const empty = (await client.call("knowledge.list", {})) as { documents: unknown[] };
    expect(empty.documents).toEqual([]);

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ notify.get/set 持久化 Webhook 配置", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-notify-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    const before = (await client.call("notify.get", {})) as { webhookEnabled: boolean };
    expect(before.webhookEnabled).toBe(false);

    const saved = (await client.call("notify.set", {
      channels: ["os_notification", "cli_fallback", "webhook"],
      webhookEnabled: true,
      webhookUrl: "https://example.com/aegis-hook",
    })) as { webhookEnabled: boolean; webhookUrl: string };
    expect(saved).toMatchObject({ webhookEnabled: true, webhookUrl: "https://example.com/aegis-hook" });

    const after = (await client.call("notify.get", {})) as { webhookEnabled: boolean; channels: string[] };
    expect(after.webhookEnabled).toBe(true);
    expect(after.channels).toContain("webhook");

    client.close();
    await daemon.stop("test");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("★ backup.export 经 RPC 生成一致快照", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aegis-daemon-backup-"));
    const daemon = await runDaemon({ dataDir, tickMs: 60_000 });
    const hs = readHandshakeFile(join(dataDir, "handshake.json"));
    const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
    await client.connect();

    const targetDir = join(dataDir, "backup-rpc");
    const result = (await client.call("backup.export", { targetDir })) as {
      path: string;
      files: number;
      totalBytes: number;
    };

    expect(result.path).toBe(targetDir);
    expect(result.files).toBeGreaterThan(0);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(existsSync(join(targetDir, "aegis.db"))).toBe(true);
    expect(existsSync(join(targetDir, "manifest.json"))).toBe(true);

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
