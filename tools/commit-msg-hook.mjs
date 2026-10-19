#!/usr/bin/env node
/**
 * commit-msg hook —— 机械校验提交信息（规范：.dsh/skills/aegis-commit-conventions）
 *
 * 由 `pnpm hooks:install` 安装到 .git/hooks/commit-msg。
 * 参数 $1 为含提交信息的临时文件路径（git 约定）。
 *
 * 校验项：
 *   1. type 必须是九个允许值之一
 *   2. 必须有 scope（形如 `type(scope):`）
 *   3. subject 必须为中文且 ≤ 50 字
 *   4. 禁止无信息量词汇（update / wip / temp / 修改 / 优化 / 测试一下）
 *   5. body 每行 ≤ 72 字（仅警告，不阻断）
 *
 * 例外：以 `Merge`、`Revert`、`fixup!`、`squash!` 开头的提交信息直接放行。
 */
import { readFileSync } from "node:fs";

const ALLOWED_TYPES = ["feat", "fix", "refactor", "perf", "test", "docs", "build", "ci", "chore"];
const BANNED_WORDS = [/^update$/i, /^wip$/i, /^temp$/i, /^misc$/i, /^fix bug$/i];
const BANNED_SUBSTRINGS = ["修改", "优化一下", "测试一下", "随便"];

const msgFile = process.argv[2];
if (!msgFile) {
  console.error("commit-msg hook 用法：commit-msg <path-to-commit-message-file>");
  process.exit(1);
}

const raw = readFileSync(msgFile, "utf8");
// 去掉注释行与首尾空白
const lines = raw
  .split("\n")
  .filter((l) => !l.startsWith("#"))
  .join("\n")
  .replace(/\s+$/, "");

if (lines.trim() === "") {
  console.error("✗ 提交信息为空");
  process.exit(1);
}

const [subjectLine, ...rest] = lines.split("\n");
const trimmedSubject = (subjectLine ?? "").trim();

// 放行特殊提交
if (/^(Merge|Revert|fixup!|squash!|amend!)/.test(trimmedSubject)) {
  process.exit(0);
}

const errors = [];
const warnings = [];

// ── 1/2. type 与 scope
const headerRe = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;
const m = headerRe.exec(trimmedSubject);
if (!m) {
  errors.push("格式应为 `type(scope): 中文描述`，例如 `feat(scheduler): 实现物化器`");
} else {
  const [, type, scope, , subject] = m;
  if (!ALLOWED_TYPES.includes(type)) {
    errors.push(`type "${type}" 不在允许集合内：${ALLOWED_TYPES.join(" / ")}`);
  }
  if (!scope) {
    errors.push("缺少 scope（受影响范围，如 storage / daemon / docs / repo）");
  }
  // ── 3. subject 为中文且长度受限
  const chinese = (subject.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (chinese === 0) {
    errors.push("描述部分必须是中文（type 与 scope 保持英文）");
  }
  const subjectLen = [...(subject ?? "")].length;
  if (subjectLen > 50) {
    errors.push(`描述长度 ${subjectLen} 字，超过 50 字上限（把细节写进 body）`);
  }
  // ── 4. 无信息量词汇
  for (const re of BANNED_WORDS) {
    if (re.test((subject ?? "").trim())) errors.push(`描述过于笼统："${subject}"`);
  }
  for (const w of BANNED_SUBSTRINGS) {
    if ((subject ?? "").includes(w)) errors.push(`描述含无信息量表述："${w}"`);
  }
}

// ── 5. body 行宽（仅警告）
for (const [i, line] of rest.entries()) {
  if ([...line].length > 72) warnings.push(`body 第 ${i + 2} 行超过 72 字`);
}

if (warnings.length > 0) {
  console.warn("⚠ 提交信息警告（不阻断）：");
  for (const w of warnings) console.warn(`   - ${w}`);
}

if (errors.length > 0) {
  console.error("✗ 提交信息不符合规范（.dsh/skills/aegis-commit-conventions）：\n");
  for (const e of errors) console.error(`   - ${e}`);
  console.error(
    [
      "",
      "正确示例：",
      "   feat(storage): 实现迁移 checksum 锁，阻止已发布迁移被改动",
      "",
      "   body 说明**为什么**这么做（不是重复标题）。",
      "",
      "   Refs: M0+M1详细设计 §4",
      "",
      `允许的 type：${ALLOWED_TYPES.join(" / ")}`,
      "临时绕过（不推荐）：git commit --no-verify",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

process.exit(0);
