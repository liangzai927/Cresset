/**
 * `aegis` 命令行入口 —— R2 的可用性落点
 *
 * ## 为什么 R2 必须有 CLI
 *
 * M1 的产品形态是"常驻 daemon + 界面"，但界面要到 R3 才有。
 * 若没有 CLI，这一阶段的提醒只能靠"写脚本调 IPC"来创建 —— 等于没法实际使用，
 * 也就无法获得真实反馈（"它到底会不会响"）。CLI 补齐了这个缺口，并且：
 *   - 它是 R2 期间的**唯一人工入口**
 *   - 它是 R3 界面的**后备通道**（通知权限出问题时仍可用）
 *   - 它是最好的**端到端验证工具**（不用启动界面）
 *
 * ## 用法
 *
 * ```
 * aegis status                     查看 daemon 状态
 * aegis add "交周报" --at 明天9:00   加一条提醒（支持自然写法）
 * aegis add "喝水" --every 30m       每 30 分钟
 * aegis list                       列出任务
 * aegis history                    通知历史
 * aegis test-notify                立刻发一条测试通知
 * aegis pause / resume             全部暂停 / 恢复
 * aegis rm <id>                    删除任务
 * aegis start / stop               启动 / 停止 daemon
 * ```
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SystemClock } from "@aegis/clock";
import { type DataPaths, resolveDataPaths } from "@aegis/product";
import { loadSkillFile, SkillLoadError } from "@aegis/skills";
import { createBackup } from "./bootstrap/backup.js";
import { DAEMON_VERSION } from "./bootstrap/run-daemon.js";
import { IpcClient, readHandshakeFile } from "./ipc/client.js";

/** CLI 退出码：0 成功、1 用法错误、2 运行时错误（便于脚本判断） */
const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_RUNTIME = 2;

function usage(): string {
  return [
    "aegis —— 24 小时个人提醒助手（R2）",
    "",
    "用法：aegis <命令> [参数]",
    "",
    "  status                        查看 daemon 是否在运行",
    "  add <标题> [选项]              新建提醒",
    "      --at <时间>               触发时间：09:00 / 明天9:00 / 2026-03-01T09:00",
    "      --in <时长>               多久后触发：10m / 2h / 3d",
    "      --every <间隔>            重复：30m / 2h / 1d",
    "      --weekdays                工作日重复（周一至周五）",
    "      --weekly <1,3,5>          每周指定星期（1=周一）",
    "      --monthly <15>            每月指定日",
    "      --priority important      高优先级（可穿透免打扰）",
    "  list                          列出全部提醒",
    "  history [--limit N]           通知历史（含投递渠道与结果）",
    "  test-notify                   立刻发一条测试通知",
    "  pause / resume                全部暂停 / 恢复",
    "  rm <id>                       删除提醒",
    "  start / stop                  启动 / 停止 daemon",
    "  paths                         打印数据目录",
    "  backup --out <目录>            导出一致性数据备份（不包含钥匙串）",
    "  skill check <file.yaml>       校验 Skill YAML（M2）",
    "",
    "示例：",
    '  aegis add "交周报" --at 明天9:00 --weekly 5',
    '  aegis add "喝水" --every 30m',
    '  aegis add "站会" --at 10:00 --weekdays',
  ].join("\n");
}

/** 解析数据目录（与 daemon 保持一致：优先环境变量，其次默认位置） */
function dataPaths(): DataPaths {
  const dir = process.env.AEGIS_DATA_DIR ?? join(homedir(), "Library", "Application Support", "Aegis");
  return resolveDataPaths({ dataDir: dir });
}

/** 连接正在运行的 daemon；未运行时给出可操作的提示而不是抛栈 */
async function connect(): Promise<{ client: IpcClient; paths: DataPaths }> {
  const paths = dataPaths();
  if (!existsSync(paths.handshakeFile)) {
    fail(`没有找到运行中的 daemon（握手文件不存在：${paths.handshakeFile}）\n` + "  先执行：aegis start");
  }
  let hs: { endpoint: string; token: string };
  try {
    hs = readHandshakeFile(paths.handshakeFile);
  } catch (err) {
    fail(`握手文件无法读取（daemon 可能正在重启）：${err instanceof Error ? err.message : String(err)}`);
  }
  const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
  try {
    await client.connect();
  } catch (err) {
    fail(
      `无法连接到 daemon（endpoint=${hs.endpoint}）：${err instanceof Error ? err.message : String(err)}\n` +
        "  daemon 可能已崩溃，试试：aegis start",
    );
  }
  return { client, paths };
}

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(EXIT_RUNTIME);
}

function usageError(message: string): never {
  process.stderr.write(`✗ ${message}\n\n${usage()}\n`);
  process.exit(EXIT_USAGE);
}

// ── 时间解析（CLI 的易用性关键） ─────────────────────────────────────────

const p2 = (n: number): string => String(n).padStart(2, "0");

function toWallString(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * 解析 `--in` / `--every` 的时长写法：`30m` / `2h` / `3d` / `45`（默认分钟）。
 *
 * @returns 毫秒数
 */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)\s*([smhd]?)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const mult = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

/**
 * 解析 `--at` 的时间写法。
 *
 * 支持：`09:00`（今天或明天，取最近未来）、`明天9:00`、`后天14:30`、
 * `2026-03-01T09:00`（绝对时刻）、`+30m`（相对）。
 *
 * @param now 基准时刻（可注入以便测试）
 * @returns 墙上时间字符串（本地时区），或 null 表示无法解析
 */
export function parseAt(text: string, now: Date = new Date()): string | null {
  const t = text.trim();

  // 相对写法：+30m
  if (t.startsWith("+")) {
    const ms = parseDuration(t.slice(1));
    if (ms === null) return null;
    return toWallString(new Date(now.getTime() + ms));
  }

  // 绝对写法：2026-03-01T09:00
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return t;

  // 带日期的相对词：今天/明天/后天 + HH:mm
  const dayMatch = /^(今天|明天|后天)?\s*(\d{1,2}):(\d{2})$/.exec(t);
  if (dayMatch) {
    const [, dayWord, hh, mm] = dayMatch;
    const hour = Number(hh);
    const minute = Number(mm);
    if (hour > 23 || minute > 59) return null;
    const d = new Date(now);
    const offset = dayWord === "明天" ? 1 : dayWord === "后天" ? 2 : 0;
    d.setDate(d.getDate() + offset);
    d.setHours(hour, minute, 0, 0);
    // 只说 HH:mm 且该时刻已过 → 顺延到明天（符合"设个 9 点"的直觉）
    if (!dayWord && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return toWallString(d);
  }

  return null;
}

// ── 参数解析 ────────────────────────────────────────────────────────────

interface AddOptions {
  title: string;
  at?: string;
  in?: string;
  every?: string;
  weekdays?: boolean;
  weekly?: string;
  monthly?: string;
  priority?: string;
}

function parseAddArgs(args: string[]): AddOptions {
  const title = args.find((a) => !a.startsWith("--"));
  if (!title) usageError("缺少提醒标题");

  const opts: AddOptions = { title };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    const next = (): string => {
      const v = args[i + 1];
      if (!v || v.startsWith("--")) usageError(`${a} 缺少取值`);
      i += 1;
      return v;
    };
    switch (a) {
      case "--at":
        opts.at = next();
        break;
      case "--in":
        opts.in = next();
        break;
      case "--every":
        opts.every = next();
        break;
      case "--weekdays":
        opts.weekdays = true;
        break;
      case "--weekly":
        opts.weekly = next();
        break;
      case "--monthly":
        opts.monthly = next();
        break;
      case "--priority":
        opts.priority = next();
        break;
      default:
        if (a.startsWith("--")) usageError(`未知选项：${a}`);
    }
  }
  return opts;
}

/** 把 CLI 选项翻译成 IPC 的 repeat 结构 */
export function buildRepeat(opts: AddOptions): {
  mode: string;
  byWeekday?: number[];
  byMonthDay?: number;
  intervalMinutes?: number;
} {
  if (opts.every) {
    const ms = parseDuration(opts.every);
    if (ms === null) usageError(`--every 的时长无法解析：${opts.every}`);
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) usageError("--every 至少 1 分钟");
    return { mode: "every_minutes", intervalMinutes: minutes };
  }
  if (opts.weekdays) return { mode: "weekdays" };
  if (opts.weekly) {
    const days = opts.weekly
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
    if (days.length === 0) usageError("--weekly 需要 1-7 的星期编号，如 --weekly 1,3,5");
    return { mode: "weekly", byWeekday: days };
  }
  if (opts.monthly) {
    const day = Number(opts.monthly);
    if (!Number.isInteger(day) || day < 1 || day > 31) usageError("--monthly 需要 1-31 的日期");
    return { mode: "monthly", byMonthDay: day };
  }
  return { mode: "once" };
}

// ── 命令实现 ────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<number> {
  const paths = dataPaths();
  if (!existsSync(paths.handshakeFile)) {
    process.stdout.write("daemon 未运行\n");
    return EXIT_RUNTIME;
  }
  const { client } = await connect();
  const h = await client.health();
  const uptime =
    h.uptimeS < 60
      ? `${h.uptimeS}s`
      : h.uptimeS < 3600
        ? `${Math.round(h.uptimeS / 60)}min`
        : `${(h.uptimeS / 3600).toFixed(1)}h`;
  process.stdout.write(`daemon 运行中（已运行 ${uptime}，tick ${h.tickCount} 次）\n`);
  if (h.degradedReasons.length > 0) {
    process.stdout.write(`⚠ 降级中：${h.degradedReasons.join("；")}\n`);
  }
  if (h.nextDueAt) {
    const d = new Date(h.nextDueAt);
    process.stdout.write(`下次待投递：${toWallString(d).replace("T", " ")}\n`);
  }
  client.close();
  return EXIT_OK;
}

async function cmdAdd(args: string[]): Promise<number> {
  const opts = parseAddArgs(args);

  // 触发时刻：--in 与 --at 都可指定，--every 时用 --at 或"现在"
  let firstFireAtWall: string;
  if (opts.in) {
    const ms = parseDuration(opts.in);
    if (ms === null) usageError(`--in 的时长无法解析：${opts.in}`);
    firstFireAtWall = toWallString(new Date(Date.now() + ms));
  } else if (opts.at) {
    const parsed = parseAt(opts.at);
    if (parsed === null) usageError(`--at 的时间无法解析：${opts.at}（试试 09:00 / 明天9:00 / +30m）`);
    firstFireAtWall = parsed;
  } else if (opts.every) {
    // 重复任务未指定起点 → 从现在开始
    firstFireAtWall = toWallString(new Date());
  } else {
    usageError("需要指定触发时间：--at <时间> 或 --in <时长>");
  }

  const { client } = await connect();
  const created = (await client.call("task.create", {
    title: opts.title,
    firstFireAtWall,
    repeat: buildRepeat(opts),
    ...(opts.priority ? { priority: opts.priority } : {}),
  })) as { id: string };

  const list = (await client.call("task.list", {})) as {
    items: Array<{ id: string; repeatLabel: string; nextFireWall: string | null }>;
  };
  const view = list.items.find((t) => t.id === created.id);
  process.stdout.write(`✓ 已创建：${opts.title}\n`);
  process.stdout.write(`  重复：${view?.repeatLabel ?? "未知"}\n`);
  process.stdout.write(`  下次：${(view?.nextFireWall ?? "无").replace("T", " ")}\n`);
  process.stdout.write(`  id：${created.id}\n`);
  client.close();
  return EXIT_OK;
}

async function cmdList(): Promise<number> {
  const { client } = await connect();
  const list = (await client.call("task.list", {})) as {
    items: Array<{
      id: string;
      title: string;
      priority: string;
      enabled: boolean;
      repeatLabel: string;
      nextFireWall: string | null;
      firedCount: number;
    }>;
  };
  if (list.items.length === 0) {
    process.stdout.write("还没有提醒。用 aegis add 创建第一条。\n");
  } else {
    for (const t of list.items) {
      const flag = t.enabled ? " " : "⏸";
      const pri = t.priority === "important" ? "!" : " ";
      const next = (t.nextFireWall ?? "已结束").replace("T", " ");
      process.stdout.write(`${flag}${pri} ${next}  ${t.title}\n`);
      process.stdout.write(`      ${t.repeatLabel}｜已触发 ${t.firedCount} 次｜${t.id.slice(0, 8)}\n`);
    }
  }
  client.close();
  return EXIT_OK;
}

async function cmdHistory(args: string[]): Promise<number> {
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 20 : 20;

  const { client } = await connect();
  const hist = (await client.call("notify.history", { limit })) as {
    items: Array<{
      kind: string;
      state: string;
      title: string;
      scheduledFor: number;
      attempts: Array<{ channel: string; outcome: string }>;
    }>;
  };
  if (hist.items.length === 0) {
    process.stdout.write("还没有通知记录。\n");
  }
  for (const n of hist.items) {
    const when = toWallString(new Date(n.scheduledFor)).replace("T", " ");
    const mark = n.state === "delivered" ? "✓" : n.state === "failed" ? "✗" : "…";
    const channels = n.attempts.map((a) => `${a.channel}:${a.outcome}`).join(" → ");
    process.stdout.write(`${mark} ${when}  ${n.title}\n`);
    if (channels) process.stdout.write(`      渠道：${channels}\n`);
  }
  client.close();
  return EXIT_OK;
}

async function cmdTestNotify(): Promise<number> {
  const { client } = await connect();
  await client.call("notify.test", {});
  process.stdout.write("✓ 已发送测试通知（若没看到，请检查系统通知权限）\n");
  client.close();
  return EXIT_OK;
}

async function cmdControl(pause: boolean): Promise<number> {
  const { client } = await connect();
  await client.call(pause ? "ctrl.pauseAll" : "ctrl.resumeAll", {});
  process.stdout.write(pause ? "✓ 已暂停全部提醒\n" : "✓ 已恢复全部提醒\n");
  client.close();
  return EXIT_OK;
}

async function cmdRemove(id: string): Promise<number> {
  const { client } = await connect();
  const r = (await client.call("task.delete", { id })) as { ok: boolean };
  process.stdout.write(r.ok ? "✓ 已删除\n" : "✗ 未找到该提醒\n");
  client.close();
  return r.ok ? EXIT_OK : EXIT_RUNTIME;
}

/** 启动 daemon（脱离当前终端，日志写入数据目录） */
async function cmdStart(): Promise<number> {
  const paths = dataPaths();
  if (existsSync(paths.handshakeFile)) {
    process.stdout.write("daemon 似乎已在运行（aegis status 查看）\n");
    return EXIT_OK;
  }
  const daemonEntry = new URL("./main.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [daemonEntry, "--data-dir", paths.dataDir], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // 等它就绪（最多 5 秒），避免用户立刻执行下一条命令却连不上
  for (let i = 0; i < 50; i++) {
    if (existsSync(paths.handshakeFile)) {
      process.stdout.write(`✓ daemon 已启动（pid ${child.pid}）\n`);
      return EXIT_OK;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.stdout.write(`⚠ daemon 已拉起（pid ${child.pid}）但尚未就绪，稍后用 aegis status 确认\n`);
  return EXIT_OK;
}

async function cmdStop(): Promise<number> {
  if (!existsSync(dataPaths().handshakeFile)) {
    process.stdout.write("daemon 未在运行\n");
    return EXIT_OK;
  }
  const { client } = await connect();
  try {
    await client.call("sys.shutdown", {});
  } catch {
    /* 关停会断开连接，这里忽略 */
  }
  client.close();
  process.stdout.write("✓ 已请求停止\n");
  return EXIT_OK;
}

// ── 入口 ────────────────────────────────────────────────────────────────

/** CLI 主入口；返回进程退出码 */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "status":
      return cmdStatus();
    case "add":
      return cmdAdd(args);
    case "list":
    case "ls":
      return cmdList();
    case "history":
      return cmdHistory(args);
    case "test-notify":
      return cmdTestNotify();
    case "pause":
      return cmdControl(true);
    case "resume":
      return cmdControl(false);
    case "rm":
    case "remove": {
      const id = args[0];
      if (!id) usageError("rm 需要任务 id（见 aegis list）");
      return cmdRemove(id);
    }
    case "start":
      return cmdStart();
    case "stop":
      return cmdStop();
    case "paths": {
      const p = dataPaths();
      process.stdout.write(`数据目录：${p.dataDir}\n数据库：${p.dbFile}\n日志：${p.logsDir}\n`);
      return EXIT_OK;
    }
    case "backup":
      return cmdBackup(args);
    case "skill":
      return cmdSkill(args);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${usage()}\n`);
      return EXIT_OK;
    default:
      usageError(`未知命令：${command}`);
  }
}

/**
 * `backup --out <目录> [--data-dir <目录>]`
 *
 * 备份可在 daemon 运行时执行：数据库使用 SQLite 一致性快照；
 * 不包含钥匙串、握手文件、日志等运行期材料。
 */
function cmdBackup(args: string[]): number {
  let out: string | undefined;
  let dataDir: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--out") {
      out = args[++i];
      if (!out) usageError("backup --out 需要一个目录");
    } else if (arg === "--data-dir") {
      dataDir = args[++i];
      if (!dataDir) usageError("backup --data-dir 需要一个目录");
    } else {
      usageError(`backup 不认识的参数：${arg}`);
    }
  }
  if (!out) usageError("backup 需要 --out <目录>");

  const paths = dataDir ? resolveDataPaths({ dataDir }) : dataPaths();
  try {
    const manifest = createBackup({
      paths,
      outDir: out,
      clock: new SystemClock(),
      daemonVersion: DAEMON_VERSION,
    });
    process.stdout.write(
      `✓ 备份完成：${resolve(out)}\n` +
        `  文件：${manifest.files.length} 个，共 ${formatBytes(manifest.totalBytes)}\n` +
        "  校验：manifest.json 内含每个文件的 sha256\n",
    );
    return EXIT_OK;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `skill check <file.yaml>` —— 校验 Skill 的 YAML 与字段契约。
 *
 * 这是 M2 的第一个可用入口：在接监测器/引擎之前，先让用户能确认
 * 自己写的 Skill 到底合不合法，而不是等导入后才失败。
 */
function cmdSkill(args: string[]): number {
  const [sub, file] = args;
  if (sub !== "check" || !file) usageError("用法：aegis skill check <file.yaml>");
  try {
    const skill = loadSkillFile(file);
    const trigger =
      skill.trigger.type === "threshold"
        ? `${skill.trigger.monitor}.${skill.trigger.field} ${skill.trigger.op}`
        : `${skill.trigger.monitor} 变化`;
    process.stdout.write(
      `✓ Skill 合法：${skill.name}@${skill.version}\n` +
        `  描述：${skill.description}\n` +
        `  权限：${skill.permissions.length > 0 ? skill.permissions.join(", ") : "无"}\n` +
        `  触发：${trigger}\n` +
        `  动作：通知「${skill.action.notify.title}」（${skill.action.notify.priority}）\n` +
        `  冷却：${skill.cooldown}\n`,
    );
    return EXIT_OK;
  } catch (err) {
    if (err instanceof SkillLoadError) {
      fail(
        `${err.message}${err.issues.length > 0 ? `\n${err.issues.map((i) => `  · ${i}`).join("\n")}` : ""}`,
      );
    }
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** 人类可读体积（备份摘要用） */
function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

/** 便于测试：从文件读取握手内容（不做校验） */
export function readHandshakeRaw(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export { homedir };
