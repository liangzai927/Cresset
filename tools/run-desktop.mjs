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

if (!verbose) {
  // 非 verbose 模式下只转发错误与关键日志，避免刷屏
  child.stdout.on("data", (buf) => {
    const text = String(buf);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      if (line.includes('"level":"error"') || line.includes("AEGIS")) {
        process.stdout.write(`  ${line}\n`);
      }
    }
  });
  child.stderr.on("data", (buf) => {
    const text = String(buf).trim();
    if (text) process.stderr.write(`  ${text}\n`);
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
