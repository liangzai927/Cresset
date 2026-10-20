#!/usr/bin/env node
/**
 * daemon 入口
 *
 * R1 状态：启动序列已按《M0+M1 详细设计》§3 接通 ——
 *   单实例锁 → 配置 → 迁移 → 时钟快照与跳变检测 → 补偿扫描（仅统计）→
 *   启动审计 → tick/心跳 → IPC 监听 → 握手文件 → ready → 信号处理
 *
 * R1 明确**不含** M1 业务逻辑（物化/派发/投递/监测）。
 *
 * 用法：
 *   aegis-daemon                    正常启动
 *   aegis-daemon --data-dir <path>  指定数据目录
 *   aegis-daemon --print-paths      只打印路径解析结果后退出（诊断用）
 *   aegis-daemon --check            执行启动序列后立即优雅停止（安装后自检）
 */
import { resolveDataDir, resolveDataPaths } from "@aegis/product";
import { AlreadyRunningError, DAEMON_VERSION, runDaemon } from "./bootstrap/run-daemon.js";

interface Args {
  dataDir: string;
  printPaths: boolean;
  check: boolean;
}

/**
 * 判定是否应当走 CLI 分支。
 *
 * 规则：只要出现了**非选项参数**（如 `status`、`add`），或使用了 CLI 专属的
 * `--at/--in/--every` 等选项，就交给 `cli.ts`。这样同一个可执行文件
 * 既是 daemon 本体，也是用户命令入口 —— 用户不必记两个路径。
 */
function isCliInvocation(argv: string[]): boolean {
  const cliCommands = new Set([
    "status",
    "add",
    "list",
    "ls",
    "history",
    "test-notify",
    "pause",
    "resume",
    "rm",
    "remove",
    "start",
    "stop",
    "paths",
    "backup",
    "skill",
    "monitor",
    "help",
  ]);
  if (argv.length === 0) return true; // 无参数 → 打印帮助而不是报错
  const first = argv[0];
  if (first !== undefined && cliCommands.has(first)) return true;
  // 出现 CLI 专属选项也走 CLI
  return argv.some((a) =>
    ["--at", "--in", "--every", "--weekdays", "--weekly", "--monthly", "--priority"].includes(a),
  );
}

function parseArgs(argv: string[]): Args {
  let dataDir = resolveDataDir();
  let printPaths = false;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") {
      const v = argv[++i];
      if (!v) throw new Error("--data-dir 需要一个路径参数");
      dataDir = v;
    } else if (a === "--print-paths") {
      printPaths = true;
    } else if (a === "--check") {
      check = true;
    } else if (a === "--version" || a === "-v") {
      process.stdout.write(`${DAEMON_VERSION}\n`);
      process.exit(0);
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        [
          "用法: aegis-daemon [选项]",
          "",
          "  --data-dir <path>   指定数据目录（默认见 --print-paths）",
          "  --print-paths       打印路径解析结果后退出",
          "  --check             执行启动序列后立即优雅停止（自检）",
          "  --version, -v       打印版本",
          "  --help, -h          显示帮助",
          "",
          "子命令（同一个可执行文件）：",
          "  aegis <命令>         见 `aegis help`（status / add / list / history / backup / skill / monitor …）",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${a}`);
    }
  }
  return { dataDir, printPaths, check };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // ── CLI 分支（R2：让用户能真正"用起来"，而不只是把 daemon 跑起来）
  if (isCliInvocation(argv)) {
    const { runCli } = await import("./cli.js");
    const code = await runCli(argv);
    process.exit(code);
  }

  const args = parseArgs(argv);

  if (args.printPaths) {
    process.stdout.write(`${JSON.stringify(resolveDataPaths({ dataDir: args.dataDir }), null, 2)}\n`);
    return;
  }

  const daemon = await runDaemon({
    dataDir: args.dataDir,
    ...(args.check ? { tickMs: 60_000, heartbeatIntervalMs: 60_000 } : {}),
  });

  if (args.check) {
    process.stdout.write(
      `${JSON.stringify({ event: "check.ok", startup: daemon.startup, endpoint: daemon.paths.ipcEndpoint })}\n`,
    );
    await daemon.stop("check");
    process.exit(0);
  }

  process.stdout.write(
    `${JSON.stringify({
      event: "daemon.ready",
      version: DAEMON_VERSION,
      pid: process.pid,
      dataDir: daemon.paths.dataDir,
      endpoint: daemon.paths.ipcEndpoint,
      startup: daemon.startup,
    })}\n`,
  );

  process.exit(await daemon.stopped);
}

main().catch((err: unknown) => {
  if (err instanceof AlreadyRunningError) {
    // 已有实例在跑不是错误：以 0 退出，便于脚本无脑调用
    process.stderr.write(`${JSON.stringify({ event: "daemon.already_running", detail: err.message })}\n`);
    process.exit(0);
  }
  process.stderr.write(
    `${JSON.stringify({ event: "daemon.fatal", error: err instanceof Error ? err.message : String(err) })}\n`,
  );
  process.exit(1);
});
