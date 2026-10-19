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
/**
 * 要安装的 hook 清单。
 *
 * - `commit-msg`：校验提交信息格式
 * - `pre-commit`：强制"改代码必须更新开发流水账"（docs/DEVLOG.md）
 *
 * 两个都是"机械记忆"：靠人记得的规范，最终都会忘。
 */
const HOOKS = [
  { name: "commit-msg", src: join(ROOT, "tools", "commit-msg-hook.mjs") },
  { name: "pre-commit", src: join(ROOT, "tools", "pre-commit-hook.mjs") },
];

if (!existsSync(GIT_DIR)) {
  console.error("✗ 当前目录不是 git 仓库。请先运行：git init");
  process.exit(1);
}
for (const hook of HOOKS) {
  if (!existsSync(hook.src)) {
    console.error(`✗ 未找到 hook 源文件：${hook.src}`);
    process.exit(1);
  }
}

mkdirSync(HOOKS_DIR, { recursive: true });

for (const hook of HOOKS) {
  const dest = join(HOOKS_DIR, hook.name);

  // 若已存在同名 hook（无论是文件还是链接），先移除
  if (existsSync(dest)) {
    try {
      const existing = readFileSync(dest, "utf8").slice(0, 200);
      if (!existing.includes("aegis")) {
        console.warn(`⚠ 已存在一个非本项目安装的 ${hook.name} hook，将被覆盖：${dest}`);
      }
    } catch {
      /* 可能是符号链接，readFileSync 失败则直接覆盖 */
    }
    unlinkSync(dest);
  }

  // hook 用一层薄壳调用 node，避免依赖文件权限位在符号链接上的行为
  writeFileSync(
    dest,
    `#!/bin/sh
# 由 aegis 的 pnpm hooks:install 生成；真正的逻辑在 ${hook.src.replace(`${ROOT}/`, "")}
exec node "${hook.src}" "$@"
`,
    "utf8",
  );
  chmodSync(dest, 0o755);
  console.log(`✓ 已安装 ${hook.name} hook`);
  console.log(`   ${dest}`);
  console.log(`   → 调用 node ${hook.src}`);
}

console.log("");
console.log("commit-msg 校验：type 白名单 / 必须有 scope / 中文描述 / 禁止无信息量词汇");
console.log("pre-commit 校验：改了代码就必须更新 docs/DEVLOG.md");
console.log("临时绕过（不推荐）：git commit --no-verify");
