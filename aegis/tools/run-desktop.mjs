#!/usr/bin/env node
/**
 * 启动 Aegis 桌面应用（开发态）
 *
 * ## 为什么需要这个脚本而不是直接跑 electron
 *
 * 三个本环境实测过的坑，都在这里被处理：
 *
 * 1. **`ELECTRON_RUN_AS_NODE=1`**
 *    DSH 的运行时环境设置了这个变量。它的作用是"把 Electron 当纯 Node 跑"，
 *    于是主进程拿不到 `app`、`BrowserWindow`，窗口根本不会出现
 *    （实测：`process.type` 为 undefined、`require("electron")` 返回字符串路径）。
 *    必须显式清除。
 *
 * 2. **Electron 二进制路径**
 *    `node_modules/.bin/electron` 是指向 `cli.js` 的软链，而 `cli.js` 会用
 *    `child_process.spawn` 再起一个进程。在某些受限环境里这条链路会失败。
 *    这里直接调用 `Electron.app/Contents/MacOS/Electron`，少一层间接。
 *
 * 3. **工作目录与 app 目录分离**
 *    Electron 用 `<appDir>/package.json` 的 `main` 字段定位入口。
 *    我们传 `apps/desktop`，而它的 `main` 指向 `dist/main.js` —— 因此必须
 *    **先构建**。脚本会在入口不存在时给出明确提示，而不是让 Electron 报 ENOENT。
 *
 * ## 用法
 *
 * ```
 * node tools/run-desktop.mjs              # 启动
 * node tools/run-desktop.mjs --verbose    # 显示 Electron 的完整输出
 * ```
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const APP_DIR = join(ROOT, "apps", "desktop");
const ENTRY = join(APP_DIR, "dist", "main.js");
const verbose = process.argv.includes("--verbose");

if (!existsSync(ENTRY)) {
  console.error(`✗ 桌面应用尚未构建：${ENTRY} 不存在`);
  console.error("  先执行：node tools/build.mjs");
  process.exit(1);
}

/** 定位 Electron 可执行文件（优先直接用二进制，避开 cli.js 的间接层） */
function findElectronBinary() {
  const platform = process.platform;
  if (platform === "darwin") {
    const candidates = [
      join(ROOT, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
  } else if (platform === "win32") {
    const c = join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    if (existsSync(c)) return c;
  } else {
    const c = join(ROOT, "node_modules", "electron", "dist", "electron");
    if (existsSync(c)) return c;
  }

  // 退路：用 cli.js（会多一层进程，但可用）
  const cli = join(ROOT, "node_modules", "electron", "cli.js");
  if (existsSync(cli)) return cli;
  return null;
}

const binary = findElectronBinary();
if (!binary) {
  console.error("✗ 找不到 Electron。执行：pnpm install && node node_modules/electron/install.js");
  process.exit(1);
}

/**
 * 清理环境变量。
 *
 * `ELECTRON_RUN_AS_NODE` 必须删除（不是设为空字符串 —— 空字符串在某些实现里
 * 仍被视为"已设置"）。因此用解构剔除而不是赋 undefined。
 */
const { ELECTRON_RUN_AS_NODE: _drop, ...cleanEnv } = process.env;
void _drop;

console.log(`▶ 启动 Aegis 桌面应用`);
console.log(`  Electron: ${binary}`);
console.log(`  App:      ${APP_DIR}`);

const child = spawn(binary, [APP_DIR, ...(verbose ? [] : [])], {
  stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
  env: {
    ...cleanEnv,
    // 开发态显式指向仓库根，让主进程能定位 daemon 入口
    AEGIS_REPO_ROOT: ROOT,
  },
});

/**
 * 日志策略（这版是踩坑后改的）：
 *
 * 旧做法只转发含 `"level":"error"` 的行，且**只有 error**。
 * 结果是"daemon 尚未就绪"这类问题在界面上只报一句话，
 * 用户（和我）都看不到 daemon 到底为什么没起来 —— 排查全靠猜。
 *
 * 现在：
 *   - warn / error 都转发到终端（info 仍静默，避免刷屏）
 *   - **完整日志写入 <dataDir>/desktop.log**，随时可查
 *
 * 日志文件放在数据目录而不是系统日志：用户找得到，且不会泄露到别处。
 */
const { appendFileSync, mkdirSync } = await import("node:fs");
const dataDir =
  process.env.AEGIS_DATA_DIR ?? join(process.env.HOME ?? "", "Library", "Application Support", "Aegis");
const logFile = join(dataDir, "desktop.log");
try {
  mkdirSync(dataDir, { recursive: true });
} catch {
  /* 目录已存在或无权限：日志照常打到终端 */
}

/** 把一行写入日志文件（失败不影响启动） */
function persist(line) {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志写不进去不应阻塞应用 */
  }
}

if (!verbose) {
  console.log(`  日志: ${logFile}（完整日志，排查用）`);
  child.stdout.on("data", (buf) => {
    for (const line of String(buf).split("\n")) {
      if (!line.trim()) continue;
      persist(line);
      // error 与 warn 都显示；info 只在日志文件里
      if (line.includes('"level":"error"') || line.includes('"level":"warn"')) {
        process.stdout.write(`  ${line}\n`);
      }
    }
  });
  child.stderr.on("data", (buf) => {
    for (const line of String(buf).split("\n")) {
      if (!line.trim()) continue;
      persist(`[stderr] ${line}`);
      process.stderr.write(`  ${line}\n`);
    }
  });
}

child.on("exit", (code) => {
  console.log(`■ 应用已退出（code ${code ?? "null"}）`);
  // 提示用户 daemon 仍在运行 —— 这是刻意的设计，不是泄漏
  if (code === 0) {
    console.log("  提醒服务（daemon）仍在后台运行，可用 `aegis status` 查看。");
  }
  process.exit(code ?? 0);
});

// 把 Ctrl+C 传下去，让 Electron 走正常退出流程（触发 before-quit → 关通道）
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
