/**
 * daemon 运行时编排 —— 《M0+M1 详细设计》§3 的启动序列落地
 *
 * 启动顺序（每一步都有存在理由，不要随意调换）：
 *   1  解析参数
 *   2  获取单实例锁（O_EXCL + 陈旧锁探活）
 *   3  载入配置（缺失/损坏 → 默认值 + 明确报告）
 *   4  打开数据库 + 迁移
 *   5  记录墙钟/单调钟快照
 *   6  检测时钟跳变（判据：双时钟差值）
 *   7  补偿扫描（R1 仅记录待补数量；实际补发属 M1 调度器）
 *   8  写启动审计
 *   9  启动 tick 循环（R1 为骨架心跳）
 *   10 启动心跳写入
 *   11 打开 IPC 监听 + 写握手文件
 *   12 标记 ready
 *   13 注册信号处理（优雅停止）
 *
 * R1 明确**不含**：物化/派发/投递等 M1 业务逻辑。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type Clock, detectSkew, SystemClock } from "@aegis/clock";
import type { HealthView } from "@aegis/ipc-contract";
import { KnowledgeBase } from "@aegis/knowledge";
import {
  BarkNotifier,
  CompositeNotifier,
  createDesktopChannelSender,
  defaultNotifiers,
  EmailNotifier,
  type Notifier,
  RoutingNotifier,
  TelegramNotifier,
  TtsNotifier,
  WebhookNotifier,
} from "@aegis/platform";
import { type DataPaths, KEYCHAIN_SERVICE, resolveDataPaths } from "@aegis/product";
import { Scheduler, type TickResult } from "@aegis/scheduler";
import { MacOsKeychain } from "@aegis/secrets";
import { AuditRepo, type Db, migrate, OccurrenceDao, openDb, rowOf } from "@aegis/storage";
import { createMethods } from "../ipc/methods.js";
import type { HandshakeFile } from "../ipc/server.js";
import { IpcServer } from "../ipc/server.js";
import { BriefingService } from "./briefing-service.js";
import { type DaemonConfig, loadConfig, type MonitorConfig, saveConfig } from "./config.js";
import { installDefaultSkills } from "./default-skills.js";
import { LlmService } from "./llm-service.js";
import { DaemonLock } from "./lock.js";
import { buildMonitorBindings } from "./monitor-bindings.js";
import { MonitorRuntime } from "./monitor-runtime.js";
import { BARK_DEVICE_KEY, EMAIL_PASSWORD_KEY, TELEGRAM_BOT_TOKEN_KEY } from "./notify-secrets.js";

/** daemon 版本；与里程碑对应（发 tag 时同步更新） */
export const DAEMON_VERSION = "0.2.0-r2";

/** 启动参数；`clock`/`onLog` 可注入以便测试 */
export interface RunDaemonOptions {
  dataDir: string;
  clock?: Clock;
  /** 日志输出（默认写 stdout；测试可注入收集器） */
  onLog?: (record: DaemonLogRecord) => void;
  /** tick 间隔覆盖（测试用） */
  tickMs?: number;
  /** 心跳间隔覆盖（测试用） */
  heartbeatIntervalMs?: number;
}

/** 结构化日志记录；库代码不直接写 stdout，由调用方决定落点 */
export interface DaemonLogRecord {
  at: number;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  detail?: Record<string, unknown>;
}

/** 一个已启动的 daemon 实例句柄 */
export interface RunningDaemon {
  readonly paths: DataPaths;
  readonly config: DaemonConfig;
  readonly db: Db;
  readonly ipc: IpcServer;
  /** 优雅停止；返回退出码应使用的值 */
  stop(reason: string): Promise<number>;
  /** 已停止（供测试等待） */
  readonly stopped: Promise<number>;
  /** 本次启动的统计（供诊断与测试断言） */
  readonly startup: {
    staleLockRecovered: boolean;
    clockJump: ReturnType<typeof detectSkew>;
    appliedMigrations: number[];
    catchupPending: number;
    configIssues: string[];
  };
}

/** 已有实例在运行（不是错误：CLI 会以退出码 0 结束，便于脚本无脑调用） */
export class AlreadyRunningError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "AlreadyRunningError";
  }
}

/** 把运行缺口长度变成人话（system_gap 通知正文用） */
function formatGapDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

/**
 * 启动 daemon，按《M0+M1 详细设计》§3 的十三步顺序执行：
 * 单实例锁 → 配置 → 迁移 → 时钟快照与跳变检测 → 补偿扫描（R1 仅统计）→
 * 启动审计 → tick/心跳 → IPC 监听 → 握手文件 → ready → 信号处理。
 *
 * @throws AlreadyRunningError 已有实例持有单实例锁
 */
export async function runDaemon(opts: RunDaemonOptions): Promise<RunningDaemon> {
  const clock = opts.clock ?? new SystemClock();
  /**
   * ⚠️ 必须 bind：Clock 的 wall/monotonic 是类方法，直接作为回调传递会丢失 this，
   * 报 "Cannot read properties of undefined (reading '#wall')"。这类错误只在
   * 传参时才会出现，单元测试如果只用内联箭头函数是发现不了的。
   */
  const now = (): number => clock.wall();
  const log = (level: DaemonLogRecord["level"], event: string, detail?: Record<string, unknown>): void => {
    const record: DaemonLogRecord = { at: clock.wall(), level, event, ...(detail ? { detail } : {}) };
    if (opts.onLog) opts.onLog(record);
    else process.stdout.write(`${JSON.stringify(record)}\n`);
  };

  // ── 1/2 单实例锁
  const paths = resolveDataPaths({ dataDir: opts.dataDir });
  mkdirSync(paths.dataDir, { recursive: true });
  const lock = new DaemonLock(paths.lockFile);
  const acquired = lock.acquire(`aegis-daemon ${DAEMON_VERSION}`, now);
  if (!acquired.acquired) {
    throw new AlreadyRunningError(acquired.detail);
  }
  const staleLockRecovered = acquired.staleRecovered !== null;
  if (staleLockRecovered) {
    log("warn", "bootstrap.stale_lock_recovered", { stalePid: acquired.staleRecovered?.pid ?? null });
  }

  // ── 3 配置
  const cfg = loadConfig(paths.configFile);
  for (const issue of cfg.issues) log("warn", "bootstrap.config_issue", { issue });

  // ── 4 数据库 + 迁移
  const db = openDb({ file: paths.dbFile });
  const migration = migrate(db, now);
  log("info", "bootstrap.migrations", { applied: migration.applied, skipped: migration.skipped.length });

  // ── 5/6 时钟快照 + 跳变检测
  const monoStart = clock.monotonic();
  const wallStart = clock.wall();
  const prev = readPreviousSnapshot(db);
  const clockJump = prev
    ? detectSkew({ wall: prev.wall, mono: prev.mono }, { wall: wallStart, mono: monoStart })
    : { wallDelta: 0, monoDelta: 0, skewMs: 0, kind: "none" as const };

  if (clockJump.kind !== "none") {
    log("warn", "bootstrap.clock_jump_detected", {
      kind: clockJump.kind,
      skewMs: clockJump.skewMs,
      wallDelta: clockJump.wallDelta,
      monoDelta: clockJump.monoDelta,
    });
  }
  writeSnapshot(db, wallStart, monoStart, now());

  // ── 7 启动审计（M0 骨架：写一条"启动"记录，验证审计链路可用）
  const audit = new AuditRepo(db);
  const knowledge = new KnowledgeBase({ db, now: () => clock.wall() });
  const llmService = new LlmService({
    configFile: paths.configFile,
    db,
    clock,
    secrets: new MacOsKeychain({ service: KEYCHAIN_SERVICE }),
  });
  audit.record(
    {
      actor: "daemon",
      purpose: "startup",
      destination: "local",
      dataClass: "L0",
      detectorSummary: [],
      redactionCount: 0,
      policyVersion: "m0-v1",
      payloadSha256: sha256Hex(`${DAEMON_VERSION}:${wallStart}`),
      outcome: "allowed",
    },
    now(),
  );

  // ── 8 调度器（R2：真正的补偿与派发）
  //
  // 这一步取代了 R1 的"仅统计"版本：现在启动后第一轮 tick 就会把
  // 关机/休眠期间错过、且仍在补偿窗口内的提醒补发出去。
  const occurrences = new OccurrenceDao(db, now);
  const catchupPending = occurrences.listDue(now(), 1_000).length;
  if (catchupPending > 0) {
    log("info", "bootstrap.catchup_pending", { count: catchupPending });
  }

  const scheduler = new Scheduler({
    db,
    clock,
    // 渠道按配置顺序构造：原生通知优先、CLI 兜底殿后（D5 决策）
    notifiers: buildNotifiers(cfg.config, paths),
    dnd: {
      enabled: cfg.config.dnd.enabled,
      windows: cfg.config.dnd.windows.map((w) => ({ days: w.days, from: w.from, to: w.to })),
    },
    catchupMergeThreshold: cfg.config.notify.catchupMergeThreshold,
    lookaheadMs: cfg.config.lookaheadHours * 3_600_000,
    audit,
    onLog: (r) => log(r.level, r.event, r.detail),
  });

  /**
   * 最近一条待投递通知的计划时刻（供 UI 显示"下次提醒"）。
   *
   * 返回 null 表示当前没有待投递的通知（可能没有任务，也可能都已被免打扰推迟到更晚）。
   */
  const nextDueAt = (): number | null => {
    const due = scheduler.daos.notifications.listDue(Number.MAX_SAFE_INTEGER, 1);
    return due.length > 0 ? (due[0]?.scheduledFor ?? null) : null;
  };

  // ── 8.5 运行缺口检测（NFR-R5）
  //
  // 用上一条 heartbeat 与新进程启动时刻比较。超过阈值（默认 15 分钟）就记录
  // run_gap，并投递一条 system_gap 通知；dedupe_key 保证同一缺口只发一次。
  // 必须放在写本次 heartbeat 之前，否则会拿自己刚写的行做比较。
  const lastHeartbeat = rowOf<{ at: number }>(
    db.prepare("SELECT at FROM heartbeat ORDER BY at DESC LIMIT 1"),
  );
  const gapThresholdMs = Math.max(
    15 * 60_000,
    cfg.config.heartbeat.intervalS * 1_000 * cfg.config.heartbeat.gapWarnMultiplier,
  );
  if (lastHeartbeat && wallStart - lastHeartbeat.at >= gapThresholdMs) {
    const gapStart = lastHeartbeat.at;
    const gapEnd = wallStart;
    const cause = clockJump.kind === "wall_jumped" ? "clock_jump" : "sleep";
    const existing = rowOf<{ id: string }>(
      db.prepare("SELECT id FROM run_gap WHERE gap_start = ? AND gap_end = ?"),
      gapStart,
      gapEnd,
    );
    const gapId = existing?.id ?? randomUUID();
    if (!existing) {
      db.prepare(
        "INSERT INTO run_gap (id, detected_at, gap_start, gap_end, cause, notified) VALUES (?, ?, ?, ?, ?, 0)",
      ).run(gapId, gapEnd, gapStart, gapEnd, cause);
    }
    const note = scheduler.daos.notifications.createWithOutbox({
      kind: "system_gap",
      title: "我有一段时间没有运行",
      body: `约 ${formatGapDuration(gapEnd - gapStart)} 未运行；期间可能错过提醒。`,
      priority: "high",
      scheduledFor: gapEnd,
      dedupeKey: `system-gap:${gapStart}:${gapEnd}`,
    });
    if (note.created) {
      db.prepare("UPDATE run_gap SET notified = 1 WHERE id = ?").run(gapId);
    }
    log("warn", "bootstrap.run_gap", {
      gapStart,
      gapEnd,
      cause,
      notified: note.created,
    });
  }

  // ── 9/10 tick 与心跳
  const counters: {
    tickCount: number;
    lastTickAt: number | null;
    lastTickResult: TickResult | null;
  } = { tickCount: 0, lastTickAt: now(), lastTickResult: null };
  const tickMs = opts.tickMs ?? cfg.config.tickMs;
  // 注意：Clock 的实现对定时器做了 unref（库代码不应阻止进程退出），
  // 因此常驻 daemon 这里刻意用原生 setInterval 持有 ref 句柄。
  // ★ 调度 tick：这一轮里完成"物化 → 派发 → 投递 → 收敛"。
  //
  // 用 async 而不是同步：投递要 await 渠道（osascript 是子进程调用）。
  // 通过 `ticking` 标志防止上一轮未结束时重入（否则同一批实例会被两个循环同时处理）。
  let ticking = false;
  let briefing: BriefingService | null = null;
  const tickTimer = setInterval(() => {
    if (ticking) {
      log("warn", "scheduler.tick_skipped", { reason: "上一轮尚未结束" });
      return;
    }
    ticking = true;
    counters.tickCount += 1;
    counters.lastTickAt = now();
    void scheduler
      .tick()
      .then((result) => {
        counters.lastTickResult = result;
        for (const err of result.errors) log("error", "scheduler.tick_error", { error: err });
        briefing?.maybeGenerate();
      })
      .catch((err: unknown) => {
        // 顶层兜底：调度器内部已做阶段隔离，走到这里说明是不可预期的错误
        log("error", "scheduler.tick_fatal", { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        ticking = false;
        writeHeartbeat(db, clock, counters.tickCount, DAEMON_VERSION);
      });
  }, tickMs);

  const heartbeatMs = opts.heartbeatIntervalMs ?? cfg.config.heartbeat.intervalS * 1_000;
  const heartbeatTimer = setInterval(() => {
    writeHeartbeat(db, clock, counters.tickCount, DAEMON_VERSION);
  }, heartbeatMs);
  writeHeartbeat(db, clock, 0, DAEMON_VERSION);

  // ── 10.5 M2 监测器运行时（无 monitors 配置时为空，不产生定时器）
  const monitorBindings = buildMonitorBindings(cfg.config.monitors, paths.dataDir, clock, log);
  const monitorRuntime = new MonitorRuntime({
    db,
    clock,
    scheduler,
    bindings: monitorBindings,
    judge: (skill, decision, fields) => llmService.judge(skill, decision, fields),
    onLog: log,
  });
  monitorRuntime.start();

  briefing = new BriefingService({
    configFile: paths.configFile,
    db,
    clock,
    scheduler,
    monitorStatus: () => monitorRuntime.status(),
  });
  if (briefing.maybeGenerate()) log("info", "briefing.generated", { reason: "startup" });

  /**
   * 保存 monitors 并热重载。
   *
   * `requireId` 用于新增：若该监测器没有成功绑定（Skill 路径错、trigger 不匹配、
   * 权限不足），拒绝落盘并抛错 —— 避免 UI 显示"已添加"但运行时根本没有它。
   */
  /** 一键补齐 M2 验收场景：默认 Skills + 系统磁盘 + 下载目录 */
  const installAcceptancePreset = (): {
    installedSkills: string[];
    addedMonitors: string[];
    skippedMonitors: string[];
    monitors: MonitorConfig[];
  } => {
    const installed = installDefaultSkills(paths.dataDir);
    const current = loadConfig(paths.configFile).config.monitors;
    const presets: MonitorConfig[] = [
      {
        id: "system.host",
        kind: "system",
        enabled: true,
        intervalS: 60,
        skills: ["skills/disk-space-guard.yaml"],
      },
      {
        id: "files.downloads",
        kind: "files",
        enabled: true,
        root: "~/Downloads",
        patterns: [],
        ignore: [],
        intervalS: 30,
        stableMs: 2_000,
        skills: ["skills/downloads-change.yaml", "skills/large-file-guard.yaml"],
      },
    ];
    const added = presets.filter((p) => !current.some((m) => m.id === p.id));
    const skipped = presets.filter((p) => current.some((m) => m.id === p.id)).map((p) => p.id);
    const next = added.length > 0 ? saveMonitors([...current, ...added]) : current;
    return {
      installedSkills: installed.installed,
      addedMonitors: added.map((p) => p.id),
      skippedMonitors: skipped,
      monitors: next,
    };
  };

  const saveMonitors = (next: MonitorConfig[], requireId?: string): MonitorConfig[] => {
    const bindings = buildMonitorBindings(next, paths.dataDir, clock, log);
    if (requireId && !bindings.some((b) => b.monitor.id === requireId)) {
      throw new Error(`监测器 ${requireId} 未绑定成功，请检查 Skill 路径、trigger.monitor 与权限`);
    }
    const current = loadConfig(paths.configFile);
    saveConfig(paths.configFile, { ...current.config, monitors: next });
    monitorRuntime.reload(bindings);
    return next;
  };

  // ── 11 IPC + 握手文件
  const token = randomUUID();
  const startedAt = now();
  const ipc = new IpcServer({
    endpoint: paths.ipcEndpoint,
    token,
    daemonVersion: DAEMON_VERSION,
    dataDir: paths.dataDir,
    startedAt,
    health: (): HealthView => ({
      ok: true,
      uptimeS: Math.round((clock.monotonic() - monoStart) / 1_000),
      tickCount: counters.tickCount,
      lastTickAt: counters.lastTickAt,
      nextDueAt: nextDueAt(), // 由调度器换算：最近一条待投递通知的计划时刻
      rssBytes: process.memoryUsage().rss,
      openFds: null, // R1 暂不采集（macOS 需 lsof 或原生）
      degradedReasons: cfg.usedDefaults ? ["配置使用了默认值"] : [],
    }),
    // 原有内联方法（关停）与 R2 的业务方法合并。
    // 若只保留其中一个，运行时不是 task.* 全部 E_METHOD_NOT_FOUND，就是 sys.shutdown 失效。
    methods: {
      ...createMethods(scheduler, {
        backup: { paths, daemonVersion: DAEMON_VERSION },
        dnd: {
          updateDnd: (dnd) => {
            // 重新读一次配置，避免覆盖用户手工改过的其他字段
            const current = loadConfig(paths.configFile);
            saveConfig(paths.configFile, { ...current.config, dnd });
            scheduler.setDndSettings(dnd);
          },
        },
        llm: llmService,
        knowledge,
        monitors: {
          status: () => monitorRuntime.status(),
          scan: (id) => monitorRuntime.scanById(id),
          config: () => loadConfig(paths.configFile).config.monitors,
          preset: installAcceptancePreset,
          add: (input) =>
            saveMonitors(
              [...loadConfig(paths.configFile).config.monitors, input],
              input.enabled ? input.id : undefined,
            ),
          toggle: (id, enabled) => {
            const next = loadConfig(paths.configFile).config.monitors.map((m) =>
              m.id === id ? { ...m, enabled } : m,
            );
            return saveMonitors(next, enabled ? id : undefined);
          },
          remove: (id) =>
            saveMonitors(loadConfig(paths.configFile).config.monitors.filter((m) => m.id !== id)),
        },
        skills: { dataDir: paths.dataDir },
        secrets: new MacOsKeychain({ service: KEYCHAIN_SERVICE }),
      }),
      /**
       * 关停 daemon。
       *
       * 用 `queueMicrotask` 延后到响应发出之后再执行 —— 否则连接会在响应写回之前关闭，
       * 客户端只能看到"连接断开"而不是 `{ok:true}`。
       */
      "sys.shutdown": async () => {
        queueMicrotask(() => void stop("rpc"));
        return { ok: true };
      },
    },
    log: (event, detail) => log("debug", event, detail),
  });

  try {
    await ipc.listen();
  } catch (err) {
    lock.release();
    db.close();
    throw err;
  }

  const handshake: HandshakeFile = {
    token,
    pid: process.pid,
    protocolVersion: 1,
    endpoint: paths.ipcEndpoint,
    dataDir: paths.dataDir,
    startedAt,
    daemonVersion: DAEMON_VERSION,
    nodeExecPath: process.execPath,
    daemonEntry: process.argv[1] ?? "",
  };
  // token 只写进 0600 的握手文件，不走命令行参数/环境变量（那些会出现在进程列表）
  writeFileSync(paths.handshakeFile, `${JSON.stringify(handshake, null, 2)}\n`, { mode: 0o600 });
  log("info", "bootstrap.ipc_ready", { endpoint: paths.ipcEndpoint });

  // ── 12 ready
  writeFileSync(paths.readyFile, `${JSON.stringify({ at: now(), pid: process.pid })}\n`, { mode: 0o600 });

  // ── 13 信号处理
  let stopped: ((code: number) => void) | null = null;
  const stoppedPromise = new Promise<number>((resolve) => {
    stopped = resolve;
  });

  const stop = async (reason: string): Promise<number> => {
    log("info", "shutdown.begin", { reason });
    monitorRuntime.stop();
    clearInterval(tickTimer);
    clearInterval(heartbeatTimer);
    try {
      await ipc.close();
    } catch (err) {
      log("warn", "shutdown.ipc_close_failed", { error: String(err) });
    }
    for (const p of [paths.readyFile, paths.handshakeFile]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* 忽略 */
      }
    }
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    lock.release();
    log("info", "shutdown.done", { reason });
    stopped?.(0);
    return 0;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    void stop(signal);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  return {
    paths,
    config: cfg.config,
    db,
    ipc,
    stop,
    stopped: stoppedPromise,
    startup: {
      staleLockRecovered,
      clockJump,
      appliedMigrations: migration.applied,
      catchupPending,
      configIssues: cfg.issues,
    },
  };
}

// ── 内部工具 ────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 上次运行的时钟快照（用于跨重启检测睡眠/改时间） */
function readPreviousSnapshot(db: Db): { wall: number; mono: number } | null {
  const row = db.prepare("SELECT value FROM app_setting WHERE key = 'clock.snapshot'").get() as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { wall?: unknown; mono?: unknown };
    if (typeof parsed.wall !== "number" || typeof parsed.mono !== "number") return null;
    return { wall: parsed.wall, mono: parsed.mono };
  } catch {
    return null;
  }
}

function writeSnapshot(db: Db, wall: number, mono: number, at: number): void {
  db.prepare(
    `INSERT INTO app_setting (key, value, updated_at) VALUES ('clock.snapshot', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify({ wall, mono }), at);
}

function writeHeartbeat(db: Db, clock: Clock, tickCount: number, version: string): void {
  const mem = process.memoryUsage();
  db.prepare(
    `INSERT INTO heartbeat (at, wall_now, mono_now, pid, uptime_s, tick_count, rss_bytes, open_fds)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    clock.wall(),
    clock.wall(),
    clock.monotonic(),
    process.pid,
    Math.round(process.uptime()),
    tickCount,
    mem.rss,
  );
  void version;
}

/**
 * 按配置构造通知渠道列表（顺序即降级链）。
 *
 * R3 起 `os_notification` 是**真实可用**的：daemon 通过 `<dataDir>/channel.json`
 * 发现 Electron 提供的本地端点并反向调用（ADR-R3-01）。
 *
 * 关键设计：桌面通道的发现是**每次投递时动态进行**的，而不是启动时固定。因此：
 *   - Electron 没启动 → 该渠道返回 permanent_error，立刻降级到 CLI 兜底
 *   - Electron 中途启动/重启 → 下一次投递自动用上新端点，无需重启 daemon
 */
function buildNotifiers(cfg: DaemonConfig, paths: DataPaths): Notifier[] {
  const enabled = new Set(cfg.notify.channels);
  const native = enabled.has("os_notification")
    ? createDesktopChannelSender({ channelFilePath: paths.channelFile, timeoutMs: 5_000 })
    : null;

  // CLI 是最后兜底；它不参与 fanout，否则会重复提醒。
  const cli = defaultNotifiers({ native: null, includeCliFallback: enabled.has("cli_fallback") });

  const primary: Notifier[] = [];
  if (native) primary.push(native);
  if (enabled.has("webhook") && cfg.notify.webhook.enabled && cfg.notify.webhook.url) {
    primary.push(new WebhookNotifier({ url: cfg.notify.webhook.url }));
  }
  if (enabled.has("bark") && cfg.notify.bark.enabled) {
    const keychain = new MacOsKeychain({ service: KEYCHAIN_SERVICE });
    primary.push(
      new BarkNotifier({
        serverUrl: cfg.notify.bark.serverUrl,
        deviceKey: () => keychain.get(BARK_DEVICE_KEY),
      }),
    );
  }
  if (enabled.has("tts") && cfg.notify.tts.enabled) {
    primary.push(new TtsNotifier({ ...(cfg.notify.tts.voice ? { voice: cfg.notify.tts.voice } : {}) }));
  }
  if (
    enabled.has("email") &&
    cfg.notify.email.enabled &&
    cfg.notify.email.host &&
    cfg.notify.email.from &&
    cfg.notify.email.to
  ) {
    const keychain = new MacOsKeychain({ service: KEYCHAIN_SERVICE });
    primary.push(
      new EmailNotifier({
        host: cfg.notify.email.host,
        port: cfg.notify.email.port,
        secure: cfg.notify.email.secure,
        from: cfg.notify.email.from,
        to: cfg.notify.email.to,
        ...(cfg.notify.email.user ? { user: cfg.notify.email.user } : {}),
        password: () => keychain.get(EMAIL_PASSWORD_KEY),
      }),
    );
  }
  if (enabled.has("telegram") && cfg.notify.telegram.enabled && cfg.notify.telegram.chatId) {
    const keychain = new MacOsKeychain({ service: KEYCHAIN_SERVICE });
    primary.push(
      new TelegramNotifier({
        chatId: cfg.notify.telegram.chatId,
        token: () => keychain.get(TELEGRAM_BOT_TOKEN_KEY),
      }),
    );
  }

  // 可选：按通知优先级分流。路由内部仍然是并行扇出，CLI 只做最后兜底。
  if (cfg.notify.routing.enabled) {
    const map: Record<string, Notifier> = {};
    if (native) map.os_notification = native;
    if (enabled.has("webhook") && cfg.notify.webhook.enabled && cfg.notify.webhook.url) {
      map.webhook = new WebhookNotifier({ url: cfg.notify.webhook.url });
    }
    if (enabled.has("telegram") && cfg.notify.telegram.enabled && cfg.notify.telegram.chatId) {
      const keychain = new MacOsKeychain({ service: KEYCHAIN_SERVICE });
      map.telegram = new TelegramNotifier({
        chatId: cfg.notify.telegram.chatId,
        token: () => keychain.get(TELEGRAM_BOT_TOKEN_KEY),
      });
    }
    if (enabled.has("bark") && cfg.notify.bark.enabled) {
      const keychain = new MacOsKeychain({ service: KEYCHAIN_SERVICE });
      map.bark = new BarkNotifier({
        serverUrl: cfg.notify.bark.serverUrl,
        deviceKey: () => keychain.get(BARK_DEVICE_KEY),
      });
    }
    if (enabled.has("tts") && cfg.notify.tts.enabled) {
      map.tts = new TtsNotifier({
        ...(cfg.notify.tts.voice ? { voice: cfg.notify.tts.voice } : {}),
      });
    }
    if (
      enabled.has("email") &&
      cfg.notify.email.enabled &&
      cfg.notify.email.host &&
      cfg.notify.email.from &&
      cfg.notify.email.to
    ) {
      const keychain = new MacOsKeychain({ service: KEYCHAIN_SERVICE });
      map.email = new EmailNotifier({
        host: cfg.notify.email.host,
        port: cfg.notify.email.port,
        secure: cfg.notify.email.secure,
        from: cfg.notify.email.from,
        to: cfg.notify.email.to,
        ...(cfg.notify.email.user ? { user: cfg.notify.email.user } : {}),
        password: () => keychain.get(EMAIL_PASSWORD_KEY),
      });
    }
    const choose = (names: string[] | undefined): Notifier[] => {
      const list = names ? names.map((n) => map[n]).filter((n): n is Notifier => Boolean(n)) : [];
      return list.length > 0 ? list : primary;
    };
    const routing = new RoutingNotifier({
      routes: {
        low: choose(cfg.notify.routing.low),
        normal: choose(cfg.notify.routing.normal),
        high: choose(cfg.notify.routing.high),
      },
    });
    return [routing, ...cli];
  }

  // 同时启用桌面 + Webhook 时并行扇出；只有全部失败才落到 CLI。
  const list =
    primary.length > 1
      ? [new CompositeNotifier(primary), ...cli]
      : primary.length === 1
        ? [primary[0], ...cli].filter((n): n is Notifier => Boolean(n))
        : [...cli];

  // 若配置把两者都关了，仍保留 CLI 兜底 —— 否则"配置错误"会变成"静默不提醒"，
  // 与"零静默失败"的硬约束冲突。宁可多发一条，也不能什么都不发。
  return list.length > 0 ? list : defaultNotifiers({ native: null, includeCliFallback: true });
}
