#!/usr/bin/env node
/**
 * pre-commit hook —— 强制"改代码必须更新开发流水账"
 *
 * ## 为什么这条要靠机械强制
 *
 * "改完记得写记录"这句话，在赶进度时永远排在最后。
 * 而这个项目的核心风险恰恰是**跨会话失忆**：
 * 上一次的临时决定，下一次就变成无从解释的既成事实。
 *
 * 所以规则很简单：
 *   **本次提交里只要动了代码，就必须同时更新 docs/DEVLOG.md。**
 *
 * ## 判定规则
 *
 * | 变更内容 | 需要更新 DEVLOG |
 * | --- | --- |
 * | `packages/**`、`apps/**`、`tools/**`、构建/测试配置 | ✅ 需要 |
 * | 只有文档（`docs/**`、`*.md`、`.dsh/**`） | ❌ 不需要 |
 * | 只有 `docs/DEVLOG.md` 本身 | ❌ 不需要 |
 *
 * 例外：`AEGIS_SKIP_DEVLOG=1 git commit ...` 可跳过，
 * 但请在提交信息里说明理由（code review 时会看）。
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** 视为"代码"的路径前缀：改了这些就必须记录 */
const CODE_PREFIXES = ["packages/", "apps/", "tools/"];

/** 视为"代码"的具体文件（构建/测试配置，改了同样影响所有人） */
const CODE_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "vitest.config.ts",
  "tsconfig.base.json",
  "tsconfig.dev.json",
  "tsconfig.json",
  "biome.json",
];

/** 流水账文件路径 */
const DEVLOG_PATH = "docs/DEVLOG.md";

/** 取本次暂存的变更文件列表（忽略删除：删代码也应当记录，但这里只做必要性判断） */
function stagedFiles() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function isCodeFile(file) {
  if (CODE_FILES.includes(file)) return true;
  return CODE_PREFIXES.some((p) => file.startsWith(p));
}

// ── 主逻辑

if (process.env.AEGIS_SKIP_DEVLOG === "1") {
  console.log("⚠ 已跳过开发流水账检查（AEGIS_SKIP_DEVLOG=1）");
  process.exit(0);
}

const files = stagedFiles();
if (files.length === 0) {
  // 极端情况（如 --allow-empty）：无事可查
  process.exit(0);
}

const codeFiles = files.filter(isCodeFile);
const touchedLog = files.includes(DEVLOG_PATH);

if (codeFiles.length === 0) {
  // 只动了文档 → 不强制
  process.exit(0);
}

if (touchedLog) {
  // 结构校验交给 devlog check，避免在这里重复实现
  try {
    execFileSync(process.execPath, [resolve(ROOT, "tools", "devlog.mjs"), "check"], {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch {
    console.error("");
    console.error("✗ 开发流水账内容不合规，提交已中止。");
    process.exit(1);
  }
  process.exit(0);
}

// ── 拒绝提交，并给出**可照抄**的解决步骤
console.error("");
console.error("✗ 提交被拒绝：本次修改了代码，但没有更新开发流水账。");
console.error("");
console.error(`  改动涉及的代码文件（${codeFiles.length} 个）：`);
for (const f of codeFiles.slice(0, 8)) console.error(`    · ${f}`);
if (codeFiles.length > 8) console.error(`    · …另有 ${codeFiles.length - 8} 个`);
console.error("");
console.error("  为什么必须写：这个项目跨多个会话开发，");
console.error("  「改了什么、为什么这么改、怎么验证的」不写下来，下次接手只能靠猜。");
console.error("");
console.error("  怎么做（三选一）：");
console.error("    1) pnpm devlog:add              在顶部插入一条模板，补全后提交");
console.error("    2) pnpm devlog                  先看最近几条，照格式写");
console.error("    3) AEGIS_SKIP_DEVLOG=1 git commit ...");
console.error("       跳过（仅限错别字/注释等无关改动，并在提交信息里说明）");
console.error("");
process.exit(1);
