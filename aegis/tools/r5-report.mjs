#!/usr/bin/env node
/**
 * R5 证据自动汇总
 *
 * 14 天验收不需要每天手工填表：daemon 本身已经在写 heartbeat、notification、
 * delivery_attempt、run_gap 与 run_log。这个脚本把这些证据汇总成一份报告，
 * 让"每天在用"变成一件接近零成本的事 —— 只要应用在跑、提醒在响。
 *
 * 用法：
 *   node tools/r5-report.mjs
 *   AEGIS_DATA_DIR=/path/to/data node tools/r5-report.mjs
 *
 * 输出：`docs/acceptance/r5-report.md`（已 gitignore，本机证据）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(import.meta.dirname, "..");
const dataDir = process.env.AEGIS_DATA_DIR ?? join(homedir(), "Library", "Application Support", "Aegis");
const dbFile = join(dataDir, "aegis.db");

if (!existsSync(dbFile)) {
  console.error(`✗ 找不到数据库：${dbFile}`);
  console.error("  先在设置里确认数据目录，或用 AEGIS_DATA_DIR 指定。");
  process.exit(1);
}

/** 从 R5.md 读取开始日期；读不到就回退到最近 14 天 */
function readStartDate() {
  try {
    const doc = readFileSync(join(ROOT, "docs", "acceptance", "R5.md"), "utf8");
    const m = /\|\s*开始日期\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/.exec(doc);
    if (m?.[1]) return m[1];
  } catch {
    /* 文档缺失时回退 */
  }
  return null;
}

const startDate = process.env.AEGIS_R5_START ?? readStartDate();
const startedAt = startDate ? new Date(`${startDate}T00:00:00`).getTime() : Date.now() - 14 * 24 * 3_600_000;

const db = new DatabaseSync(dbFile);
db.exec("PRAGMA busy_timeout = 5000");

const rows = (sql, ...params) => db.prepare(sql).all(...params);
const one = (sql, ...params) => db.prepare(sql).get(...params);

const heartbeats = one(
  "SELECT COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM heartbeat WHERE at >= ?",
  startedAt,
);
const days = rows(
  "SELECT DISTINCT date(at / 1000, 'unixepoch', 'localtime') AS d FROM heartbeat WHERE at >= ? ORDER BY d",
  startedAt,
).map((r) => r.d);
const gaps = rows(
  "SELECT detected_at, gap_start, gap_end, cause, notified FROM run_gap WHERE detected_at >= ? ORDER BY detected_at",
  startedAt,
);
const notificationStates = rows(
  "SELECT state, COUNT(*) AS n FROM notification WHERE created_at >= ? GROUP BY state ORDER BY state",
  startedAt,
);
const notificationKinds = rows(
  "SELECT kind, COUNT(*) AS n FROM notification WHERE created_at >= ? GROUP BY kind ORDER BY kind",
  startedAt,
);
const attempts = rows(
  "SELECT outcome, COUNT(*) AS n FROM delivery_attempt WHERE started_at >= ? GROUP BY outcome ORDER BY outcome",
  startedAt,
);
const errors = one("SELECT COUNT(*) AS n FROM run_log WHERE at >= ? AND level = 'error'", startedAt);
const tasks = {
  active: one("SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NULL AND enabled = 1").n,
  deleted: one("SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NOT NULL").n,
};

db.close();

const now = Date.now();
const elapsedDays = Math.min(14, Math.max(1, Math.ceil((now - startedAt) / 86_400_000)));
const missingDays = Math.max(0, elapsedDays - days.length);
const remainingDays = Math.max(0, 14 - elapsedDays);
const outcome = (name) => attempts.find((a) => a.outcome === name)?.n ?? 0;

/** 毫秒 → 人话 */
function duration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} 小时`;
  return `${(ms / 86_400_000).toFixed(1)} 天`;
}

const lines = [
  "# R5 自动证据报告",
  "",
  `- 生成时间：${new Date().toISOString()}`,
  `- 数据目录：\`${dataDir}\``,
  `- 窗口起点：${startDate ?? "最近 14 天"}`,
  `- R5 第 ${elapsedDays}/14 天；Heartbeat 覆盖 ${days.length} / ${elapsedDays} 天` +
    `${missingDays > 0 ? `（缺 ${missingDays} 天）` : ""}；剩余 ${remainingDays} 天`,
  `- 活跃任务：${tasks.active}；已删除/完成：${tasks.deleted}`,
  "",
  "## Heartbeat",
  "",
  `- 条数：${heartbeats.n ?? 0}`,
  `- 首条：${heartbeats.first ?? "无"}`,
  `- 末条：${heartbeats.last ?? "无"}`,
  "",
  "## 运行缺口",
  "",
];
if (gaps.length === 0) {
  lines.push("无。");
} else {
  for (const g of gaps) {
    lines.push(
      `- ${new Date(g.gap_start).toISOString()} → ${new Date(g.gap_end).toISOString()}：` +
        `${duration(g.gap_end - g.gap_start)}，cause=${g.cause}，notified=${g.notified}`,
    );
  }
}
lines.push(
  "",
  "## 通知",
  "",
  ...notificationStates.map((s) => `- ${s.state}: ${s.n}`),
  "",
  "### 类型",
  "",
  ...notificationKinds.map((k) => `- ${k.kind}: ${k.n}`),
  "",
  "## 投递结果",
  "",
  ...(attempts.length ? attempts.map((a) => `- ${a.outcome}: ${a.n}`) : ["- 无投递记录"]),
  "",
  "## 日志错误",
  "",
  `- level=error：${errors.n}`,
  "",
  "## 需要人工确认",
  "",
);

const concerns = [];
if (missingDays > 0) concerns.push(`有 ${missingDays} 天没有 heartbeat（应用可能整天未运行）`);
if (gaps.length > 0) concerns.push(`检测到 ${gaps.length} 次运行缺口，请确认是否都是预期内`);
if (outcome("permanent_error") > 0) concerns.push(`有 ${outcome("permanent_error")} 次永久投递失败`);
if (errors.n > 0) concerns.push(`run_log 有 ${errors.n} 条 error，查看日志确认是否已修`);
if (concerns.length === 0) lines.push("自动证据未发现明显异常。");
else lines.push(...concerns.map((c) => `- ${c}`));

const outDir = join(ROOT, "docs", "acceptance");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "r5-report.md");
writeFileSync(outFile, `${lines.join("\n")}\n`, "utf8");

console.log(`✓ R5 报告已生成：${outFile}`);
console.log(
  `  R5 第 ${elapsedDays}/14 天；heartbeat 覆盖 ${days.length}/${elapsedDays} 天；缺口 ${gaps.length} 次；日志错误 ${errors.n} 条`,
);
for (const c of concerns) console.log(`  · ${c}`);
