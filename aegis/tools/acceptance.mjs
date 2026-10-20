#!/usr/bin/env node
/**
 * R5 / M1 验收运行器
 *
 * 把"验收"从一句口号变成一条可重复执行的命令：
 *   - 默认跑 `pnpm verify`（类型/构建/单测/单仓库门禁）；
 *   - `--desktop` 额外跑真实 Electron 桌面验证；
 *   - `--package` 额外跑打包产物验证；
 *   - `--full` = 两者都跑。
 *
 * 结果写到 `docs/acceptance/last-run.json`（已 gitignore，不入库），
 * 方便 14 天观察期里留下"哪一天、哪些门禁、什么结果"的证据。
 *
 * 注意：这是**门禁运行器**，不能替代 14 天真实使用；PRD 明确要求
 * "每个里程碑以我自己每天在用为验收门槛"。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const flags = new Set(process.argv.slice(2));
const full = flags.has("--full");
const runStartedAt = Date.now();

/** 一次门禁执行的结果 */
const checks = [];

/**
 * 运行一个门禁命令，并把结果记录到 checks。
 *
 * @param {string} name 人类可读的门禁名
 * @param {string[]} args 传给 pnpm 的参数
 * @param {Record<string, string>} env 附加环境变量
 * @returns {boolean} 是否通过
 */
function runCheck(name, args, env = {}) {
  console.log(`\n▶ ${name}`);
  const started = Date.now();
  const result = spawnSync("pnpm", args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  const durationMs = Date.now() - started;
  const ok = result.status === 0;
  checks.push({ name, ok, exitCode: result.status, durationMs });
  console.log(`${ok ? "✓" : "✗"} ${name}（${Math.round(durationMs / 1000)}s）`);
  return ok;
}

runCheck("单仓库 / 类型 / 构建 / 单测", ["verify"]);

if (full || flags.has("--desktop")) {
  // DSH/CI 的外层文件沙箱需要关闭 Chromium sandbox；普通桌面环境加这个变量也无害。
  runCheck("真实 Electron 桌面验证", ["verify:desktop"], { AEGIS_E2E_NO_SANDBOX: "1" });
}

if (full || flags.has("--package")) {
  runCheck("打包产物真实启动验证", ["package:verify", "--skip-build"], {
    AEGIS_E2E_NO_SANDBOX: "1",
  });
}

const ok = checks.every((c) => c.ok);
const report = {
  startedAt: new Date(runStartedAt).toISOString(),
  finishedAt: new Date().toISOString(),
  ok,
  checks,
};

const dir = join(ROOT, "docs", "acceptance");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "last-run.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`\n${ok ? "✓ R5 自动化门禁通过" : "✗ R5 自动化门禁失败"}`);
console.log(`  报告：${join(dir, "last-run.json")}`);
if (!ok) process.exit(1);
