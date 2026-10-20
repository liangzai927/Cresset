#!/usr/bin/env node
/**
 * 单仓库门禁：禁止在 Cresset 工作区里出现嵌套的 `.git`
 *
 * ## 为什么需要这条门禁
 *
 * 2026-10-19 实际发生过：`aegis/.git` 是一个没有 remote 的旧嵌套仓库，
 * VS Code 同时识别出根仓库与它，源代码管理里长期显示 42 个"未提交"文件；
 * 更严重的是，旧 daemon 会从旧 checkout 启动并占住同一个用户数据目录的 UDS。
 *
 * 根仓库 `/Users/liuwenliang/lwl/Cresset/.git` 是唯一真相源。
 * 只要在它下面再出现一个 `.git`，就说明有人误 `git init` 或搬入了旧仓库，
 * 必须在提交前拦住，而不是等界面出现两套 Source Control 再排查。
 *
 * 用法：`node tools/check-single-repo.mjs`（已接入 `pnpm verify` 与 git hook）
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const AEGIS_ROOT = resolve(import.meta.dirname, "..");

/** 从 aegis 目录向上找 git 根；找不到时回退到父目录 */
function findRepoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: AEGIS_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return resolve(AEGIS_ROOT, "..");
  }
}

const REPO_ROOT = findRepoRoot();

/** 这些目录不参与扫描：体积大，且不可能存放业务仓库 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".pnpm-store",
  "coverage",
  ".next",
  ".turbo",
  "spike-artifacts",
]);

/**
 * 深度优先扫描 `.git` 目录/文件。
 *
 * 根仓库自己的 `.git` 跳过；其他任何 `.git` 都视为嵌套仓库。
 * 不跟随符号链接，避免把外部目录误判进来。
 *
 * @param {string} dir 当前目录
 * @param {string[]} found 收集到的嵌套 `.git` 绝对路径
 */
function scan(dir, found) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 无权限/刚被删除：不阻断其余扫描
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.name === ".git") {
      if (path !== join(REPO_ROOT, ".git")) found.push(path);
      continue;
    }
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    scan(path, found);
  }
}

const found = [];
scan(REPO_ROOT, found);

if (found.length > 0) {
  console.error("✗ 单仓库检查失败：发现嵌套的 .git");
  for (const path of found) console.error(`    · ${path}`);
  console.error("");
  console.error("根仓库是唯一真相源：/Users/liuwenliang/lwl/Cresset/.git");
  console.error("请先确认该嵌套仓库没有 remote、且改动已进入根仓库，再移除它：");
  console.error("    tar -czf ~/aegis-nested-git-backup.tar.gz -C <父目录> .git");
  console.error("    rm -rf <嵌套 .git>");
  process.exit(1);
}

console.log("✓ 单仓库检查通过：没有发现嵌套 .git");
