#!/usr/bin/env node
/**
 * 开发流水账工具（docs/DEVLOG.md）
 *
 * ## 为什么需要工具而不是"记得手写"
 *
 * 需要人工记得的事，最终都会忘。这个脚本把"记录"的成本降到一条命令，
 * 并让 pre-commit hook 能机械校验"改了代码就必须更新记录"。
 *
 * ## 用法
 *
 * ```
 * pnpm devlog                    看当前状态快照 + 最近 3 条
 * pnpm devlog --last 8           看最近 8 条
 * pnpm devlog:add                在顶部插入一条模板（日期已填）
 * pnpm devlog:add --from entry.md  用文件内容作为条目正文
 * pnpm devlog:check              校验结构（pre-commit 与 verify 都会跑）
 * ```
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEVLOG = join(ROOT, "docs", "DEVLOG.md");

/** 新条目插入位置：这个标题之后 */
const INSERT_AFTER = "## 记录（新的在最上面）";

/** 一条记录必须包含的字段（缺任一即视为"没写清楚"） */
const REQUIRED_FIELDS = ["里程碑", "改了什么", "为什么", "验证"];

/** 读取文件；不存在时给出可操作的错误 */
function readLog() {
  if (!existsSync(DEVLOG)) {
    console.error(`✗ 找不到 ${DEVLOG}`);
    console.error("  开发流水账是本项目的必需文件，请从版本库恢复它。");
    process.exit(1);
  }
  return readFileSync(DEVLOG, "utf8");
}

/**
 * 把 Markdown 按二级标题切成"条目"。
 *
 * 只取 `## 记录` 之后的 `### ` 段落 —— 快照与说明不属于条目。
 */
function parseEntries(text) {
  const idx = text.indexOf(INSERT_AFTER);
  const body = idx >= 0 ? text.slice(idx) : text;
  const parts = body.split(/^### /m).slice(1); // 第一段是标题本身
  return parts.map((p) => {
    const lines = p.split("\n");
    return { title: (lines[0] ?? "").trim(), body: p };
  });
}

/** 校验条目的必需字段 */
function validateEntry(entry) {
  const missing = REQUIRED_FIELDS.filter((f) => !entry.body.includes(`**${f}**`));
  return missing;
}

// ── show ────────────────────────────────────────────────────────────────

function show(count) {
  const text = readLog();
  const entries = parseEntries(text);

  // 先打快照（帮助快速定位"现在在哪"）
  const snapStart = text.indexOf("## 当前状态快照");
  const snapEnd = text.indexOf("## 记录格式");
  if (snapStart >= 0 && snapEnd > snapStart) {
    console.log(text.slice(snapStart, snapEnd).trimEnd());
    console.log("");
  }

  console.log(`── 最近 ${Math.min(count, entries.length)} 条记录 ──`);
  for (const e of entries.slice(0, count)) {
    console.log("");
    console.log(`### ${e.title}`);
    // 去掉标题行，保留正文（缩进两格便于区分）
    for (const line of e.body.split("\n").slice(1)) {
      if (line.trim() === "") continue;
      console.log(`  ${line}`);
    }
  }

  console.log("");
  console.log(`（共 ${entries.length} 条记录，完整内容见 docs/DEVLOG.md）`);
}

// ── add ─────────────────────────────────────────────────────────────────

function today() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function add(fromFile, topic) {
  const text = readLog();
  const idx = text.indexOf(INSERT_AFTER);
  if (idx < 0) {
    console.error(`✗ DEVLOG 结构异常：找不到标题「${INSERT_AFTER}」`);
    process.exit(1);
  }

  // 正文：来自文件或模板
  let body;
  if (fromFile) {
    if (!existsSync(fromFile)) {
      console.error(`✗ 找不到条目文件：${fromFile}`);
      process.exit(1);
    }
    body = readFileSync(fromFile, "utf8").trim();
  } else {
    body = [
      "**里程碑**：（R4 / 修复 / 重构 —— 一句话说明属于哪部分）",
      "**改了什么**：",
      "- ",
      '**为什么**：（决策理由，比"改了什么"重要）',
      '**验证**：（跑了什么命令、结果如何。不要写"应该没问题"）',
      '**踩到的坑**：（没有就写"无"）',
      "**留给下次**：",
    ].join("\n");
  }

  const title = `### ${today()} · ${topic || "（待填主题）"}`;
  const block = `${title}\n${body}\n\n`;

  // 插到「## 记录（新的在最上面）」紧后的第一条之前
  const insertAt = idx + INSERT_AFTER.length;
  const rest = text.slice(insertAt);
  // 跳过标题后的空行
  const leading = rest.match(/^\s*\n/)?.[0] ?? "\n\n";
  const newText = text.slice(0, insertAt) + leading + block + rest.slice(leading.length);

  writeFileSync(DEVLOG, newText, "utf8");
  console.log(`✓ 已在顶部插入新记录：${title}`);
  if (!fromFile) {
    console.log("");
    console.log("  请补齐以下字段（缺任何一个都会被 check 拒绝）：");
    for (const f of REQUIRED_FIELDS) console.log(`    · ${f}`);
    console.log("");
    console.log(`  编辑：${DEVLOG}`);
    console.log("  写完后运行：pnpm devlog:check");
  }
}

// ── check ───────────────────────────────────────────────────────────────

function check() {
  const text = readLog();
  const problems = [];

  if (!text.includes("## 当前状态快照")) problems.push("缺少「当前状态快照」小节");
  if (!text.includes(INSERT_AFTER)) problems.push(`缺少标题「${INSERT_AFTER}」`);

  const entries = parseEntries(text);
  if (entries.length === 0) {
    problems.push("没有任何记录条目");
  } else {
    // 只校验最新一条：历史条目可能有格式演进，不该因此阻止提交
    const latest = entries[0];
    const missing = validateEntry(latest);
    if (missing.length > 0) {
      problems.push(`最新记录缺少字段：${missing.join(" / ")}（标题：${latest.title}）`);
    }
    if (!/^\d{4}-\d{2}-\d{2} · .+/.test(latest.title)) {
      problems.push(`最新记录的标题格式应为「YYYY-MM-DD · 主题」，实际：${latest.title}`);
    }
  }

  if (problems.length > 0) {
    console.error("✗ 开发流水账校验失败：");
    for (const p of problems) console.error(`   - ${p}`);
    console.error("");
    console.error("  正确做法是补全 docs/DEVLOG.md，而不是跳过检查。");
    console.error("  插入模板：pnpm devlog:add");
    process.exit(1);
  }

  console.log(`✓ 开发流水账结构正确（共 ${entries.length} 条记录）`);
}

// ── 入口 ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
// 若首个参数是选项（如 `--last 8`），说明用户只是想看图，按 show 处理
const rawCommand = argv[0];
const command = rawCommand === undefined || rawCommand.startsWith("--") ? "show" : rawCommand;

/** 取一个具名参数的值，如 --last 8 */
function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

switch (command) {
  case "show":
  case undefined:
    show(Number(flag("--last", "3")) || 3);
    break;
  case "add":
    add(flag("--from", null), flag("--topic", ""));
    break;
  case "check":
    check();
    break;
  case "--help":
  case "help":
    console.log(
      [
        "开发流水账工具",
        "",
        "  pnpm devlog                 看快照 + 最近 3 条",
        "  pnpm devlog --last 8        看最近 8 条",
        "  pnpm devlog:add             插入一条模板",
        "  pnpm devlog:add --from f.md 用文件作为条目正文",
        "  pnpm devlog:check           校验结构",
      ].join("\n"),
    );
    break;
  default:
    console.error(`✗ 未知命令：${command}（可用：show / add / check）`);
    process.exit(1);
}
