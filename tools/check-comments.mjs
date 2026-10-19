#!/usr/bin/env node
/**
 * 注释门禁（规范：.dsh/skills/aegis-comment-and-docs）
 *
 * 检查两件事，任一失败即退出码 1：
 *   1. **每个源文件必须有文件头注释**（说明职责边界）
 *   2. **每个导出符号必须有 JSDoc**（`/** ... *\/` 形式的文档注释）
 *
 * 另外报告注释行占比（**仅供观察，不做门禁** ——
 * 否则会诱导写"复述代码"的废话注释来凑数，那比没有注释更糟）。
 *
 * 用法：
 *   node tools/check-comments.mjs            检查（失败退出 1）
 *   node tools/check-comments.mjs --report   只报告不失败（用于观察趋势）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_ONLY = process.argv.includes("--report");

/** 扫描范围：源码目录（排除产物、依赖、测试由各自规则处理） */
const SCAN_DIRS = ["packages", "apps"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "spike-artifacts"]);

/**
 * 允许豁免导出符号注释的情形。
 * ⚠️ 新增豁免必须写明理由 —— 豁免应当是"确实自明"，不是"懒得写"。
 */
const EXPORT_EXEMPTIONS = [
  // 纯类型别名/重导出：本身无行为，语义由被引用方承载
  /^export\s+type\s+\w+\s*=\s*[\w.<>[\],"'\s|&]+;?\s*$/,
  /^export\s*\{[^}]*\}\s*(from\s*["'][^"']+["'])?;?\s*$/,
  /^export\s+\*\s+from\s+["'][^"']+["'];?\s*$/,
  // 接口/类型的成员行（不是顶层导出）
  /^\s{2,}/,
];

/**
 * 匹配导出符号声明的起始行。
 *
 * 注意：只匹配**声明所在行**，不匹配块内部的成员行 ——
 * 接口/对象字面量的成员不需要各自写 JSDoc（由所在块的注释统一说明）。
 */
const EXPORT_PATTERNS = [
  /^export\s+(?:async\s+)?function\s+(\w+)/,
  /^export\s+(?:abstract\s+)?class\s+(\w+)/,
  /^export\s+const\s+(\w+)/,
  /^export\s+let\s+(\w+)/,
  /^export\s+interface\s+(\w+)/,
  /^export\s+enum\s+(\w+)/,
  /^export\s+type\s+(\w+)/,
];

/** 测试文件只要求文件头注释（规范：测试用例描述用中文即可自解释） */
function isTestFile(rel) {
  return rel.endsWith(".test.ts");
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** 判断第 i 行之前是否存在紧邻的 JSDoc 块 */
function hasJsDocAbove(lines, i) {
  let j = i - 1;
  // 跳过空行（允许 JSDoc 与声明之间有空行）
  while (j >= 0 && lines[j].trim() === "") j -= 1;
  if (j < 0) return false;
  if (!lines[j].trim().endsWith("*/")) return false;
  // 往上找起始 /**
  for (let k = j; k >= 0 && j - k < 200; k--) {
    if (lines[k].trim().startsWith("/**")) return true;
    if (lines[k].includes("*/") && !lines[k].trim().endsWith("*/")) break;
  }
  return false;
}

/** 判断文件是否以注释块开头（允许 shebang、空行、import 之前的注释） */
function hasFileHeader(lines) {
  const head = lines.slice(0, 12).join("\n");
  return /^\s*(#![^\n]*\n)?\s*\/\*\*/.test(head) || /^\s*(#![^\n]*\n)?\s*\/\//.test(head);
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));

const missingHeader = [];
const missingJsDoc = [];
let totalLines = 0;
let commentLines = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  totalLines += lines.length;

  // 统计注释行（粗略：以 // 或 * 或 /* 开头的行）
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) commentLines += 1;
  }

  if (!hasFileHeader(lines)) missingHeader.push(rel);

  // 测试文件到此为止：只校验文件头
  if (isTestFile(rel)) continue;

  // 块级导出的括号深度跟踪：进入 `export ... {` 后，块内成员行不算独立导出
  let blockDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 在块内：只更新深度，不做导出检查
    if (blockDepth > 0) {
      blockDepth += (line.match(/[{[]/g) ?? []).length;
      blockDepth -= (line.match(/[}\]]/g) ?? []).length;
      if (blockDepth <= 0) blockDepth = 0;
      continue;
    }

    const patternMatch = EXPORT_PATTERNS.map((re) => re.exec(line)).find(Boolean);
    if (!patternMatch) continue;
    if (EXPORT_EXEMPTIONS.some((re) => re.test(line))) continue;

    // 该行开启了块（interface / 多行 const ... z.object({ ... })）→ 记录深度后跳过
    const opens = (line.match(/[{[]/g) ?? []).length;
    const closes = (line.match(/[}\]]/g) ?? []).length;
    const opensBlock = opens > closes;

    if (!hasJsDocAbove(lines, i)) {
      missingJsDoc.push(`${rel}:${i + 1}  ${patternMatch[1] ?? trimmed.slice(0, 40)}`);
    }
    if (opensBlock) blockDepth = opens - closes;
  }
}

// ── 报告
const ratio = totalLines === 0 ? 0 : (commentLines / totalLines) * 100;
console.log("▶ 注释检查（规范：aegis-comment-and-docs）");
console.log(`  扫描 ${files.length} 个源文件，${totalLines} 行`);
console.log(`  注释行占比：${ratio.toFixed(1)}%（${commentLines}/${totalLines}）— 仅供参考，不是门禁`);

if (missingHeader.length > 0) {
  console.log(`\n  ✗ ${missingHeader.length} 个文件缺少文件头注释（说明职责边界）：`);
  for (const f of missingHeader.slice(0, 20)) console.log(`      ${f}`);
  if (missingHeader.length > 20) console.log(`      … 另有 ${missingHeader.length - 20} 个`);
}

if (missingJsDoc.length > 0) {
  console.log(`\n  ✗ ${missingJsDoc.length} 个导出符号缺少 JSDoc：`);
  for (const f of missingJsDoc.slice(0, 30)) console.log(`      ${f}`);
  if (missingJsDoc.length > 30) console.log(`      … 另有 ${missingJsDoc.length - 30} 个`);
}

const failed = missingHeader.length > 0 || missingJsDoc.length > 0;
if (!failed) {
  console.log("  ✓ 文件头与导出符号注释齐备");
  process.exit(0);
}

if (REPORT_ONLY) {
  console.log("\n（--report 模式：不作为门禁失败）");
  process.exit(0);
}

console.log("\n正确做法是补注释，而不是加白名单。确需豁免请在 EXPORT_EXEMPTIONS 里写明理由。");
process.exit(1);
