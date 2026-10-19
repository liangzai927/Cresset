#!/usr/bin/env node
/**
 * 安装 git hooks（规范：.dsh/skills/aegis-git-workflow）
 *
 * 把仓库里的 hook 脚本链接到 .git/hooks/。克隆仓库后执行一次即可：
 *   pnpm hooks:install
 *
 * 为什么用符号链接而不是复制：复制出来的 hook 会与仓库里的版本漂移，
 * 改了 tools/commit-msg-hook.mjs 却不生效是最常见的困惑来源。
 * 链接则始终指向仓库内的唯一真相源。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const GIT_DIR = join(ROOT, ".git");
const HOOKS_DIR = join(GIT_DIR, "hooks");
const HOOK_SRC = join(ROOT, "tools", "commit-msg-hook.mjs");
const HOOK_DEST = join(HOOKS_DIR, "commit-msg");

if (!existsSync(GIT_DIR)) {
  console.error("✗ 当前目录不是 git 仓库。请先运行：git init");
  process.exit(1);
}
if (!existsSync(HOOK_SRC)) {
  console.error(`✗ 未找到 hook 源文件：${HOOK_SRC}`);
  process.exit(1);
}

mkdirSync(HOOKS_DIR, { recursive: true });

// 若已存在同名 hook（无论是文件还是链接），先移除
if (existsSync(HOOK_DEST)) {
  try {
    const existing = readFileSync(HOOK_DEST, "utf8").slice(0, 200);
    if (!existing.includes("aegis") && !existing.includes("commit-msg-hook")) {
      console.warn(`⚠ 已存在一个非本项目安装的 commit-msg hook，将被覆盖：${HOOK_DEST}`);
    }
  } catch {
    /* 可能是符号链接，readFileSync 失败则直接覆盖 */
  }
  unlinkSync(HOOK_DEST);
}

// hook 需要是可执行的 shebang 脚本；用一层薄壳调用 node，避免依赖文件权限位在符号链接上的行为
writeFileSync(
  HOOK_DEST,
  `#!/bin/sh
# 由 aegis 的 pnpm hooks:install 生成；真正的逻辑在 tools/commit-msg-hook.mjs
exec node "${HOOK_SRC}" "$1"
`,
  "utf8",
);
chmodSync(HOOK_DEST, 0o755);

console.log("✓ 已安装 commit-msg hook");
console.log(`   ${HOOK_DEST}`);
console.log(`   → 调用 node ${HOOK_SRC}`);
console.log("");
console.log("校验项：type 白名单 / 必须有 scope / 描述为中文且 ≤50 字 / 禁止无信息量词汇");
console.log("临时绕过（不推荐）：git commit --no-verify");
