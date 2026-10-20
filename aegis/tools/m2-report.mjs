#!/usr/bin/env node
/**
 * M2 验收证据自动汇总
 *
 * M2 的目标是"3 个自建 Skill 替代 3 件手动任务，稳定 7 天"。
 * 本脚本不替你判断"任务是否真的有用"，只把可自动核对的证据汇总出来：
 * 配置了哪些监测器/Skill、实际触发过哪些 Skill、通知与错误数量、heartbeat 覆盖。
 *
 * 用法：
 *   node tools/m2-report.mjs
 *   AEGIS_DATA_DIR=/path/to/data node tools/m2-report.mjs
 *
 * 输出：docs/acceptance/m2-report.md（本机证据，已 gitignore）
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** 从 M2.md 读取窗口开始日期；读不到就回退到今天 */
function readStartDate() {
  try {
    const doc = readFileSync(join(ROOT, "docs", "acceptance", "M2.md"), "utf8");
    const m = /\|\s*开始日期\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/.exec(doc);
    if (m?.[1]) return m[1];
  } catch {
    /* 文档缺失时回退 */
  }
  return null;
}

/** 读取 config.json 中的 monitors；坏配置不阻断报告 */
function readMonitorConfigs() {
  const configFile = join(dataDir, "config.json");
  if (!existsSync(configFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(configFile, "utf8"));
    return Array.isArray(parsed.monitors) ? parsed.monitors : [];
  } catch {
    return [];
  }
}

const startDate = process.env.AEGIS_M2_START ?? readStartDate();
const startedAt = startDate ? new Date(`${startDate}T00:00:00`).getTime() : Date.now();
const configs = readMonitorConfigs();
const activeConfigs = configs.filter((m) => m && m.enabled !== false);
const configuredSkills = new Set(
  activeConfigs.flatMap((m) => (Array.isArray(m.skills) ? m.skills : [])).filter(Boolean),
);

const skillsDir = join(dataDir, "skills");
const skillFiles = existsSync(skillsDir) ? readdirSync(skillsDir).filter((f) => /\.ya?ml$/i.test(f)) : [];

const db = new DatabaseSync(dbFile);
db.exec("PRAGMA busy_timeout = 5000");
const one = (sql, ...params) => db.prepare(sql).get(...params);
const rows = (sql, ...params) => db.prepare(sql).all(...params);

const hasCooldown = Boolean(
  one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'monitor_cooldown'"),
);
const hasMonitorKind = Boolean(one("SELECT 1 AS ok FROM notification WHERE kind = 'monitor' LIMIT 1"));

const heartbeats = one(
  "SELECT COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM heartbeat WHERE at >= ?",
  startedAt,
);
const days = rows(
  "SELECT DISTINCT date(at / 1000, 'unixepoch', 'localtime') AS d FROM heartbeat WHERE at >= ? ORDER BY d",
  startedAt,
).map((r) => r.d);
const gaps = rows(
  "SELECT detected_at, gap_start, gap_end, cause FROM run_gap WHERE detected_at >= ? ORDER BY detected_at",
  startedAt,
);
const monitorNotifications = one(
  "SELECT COUNT(*) AS n FROM notification WHERE kind = 'monitor' AND created_at >= ?",
  startedAt,
);
const failureNotifications = one(
  "SELECT COUNT(*) AS n FROM notification WHERE kind = 'failure' AND created_at >= ?",
  startedAt,
);
const monitorStates = rows(
  "SELECT state, COUNT(*) AS n FROM notification WHERE kind = 'monitor' AND created_at >= ? GROUP BY state ORDER BY state",
  startedAt,
);
const firedSkills = hasCooldown
  ? rows(
      "SELECT skill_name, COUNT(*) AS n, MAX(last_notified_at) AS last FROM monitor_cooldown GROUP BY skill_name ORDER BY skill_name",
    )
  : [];
const monitorErrors = one(
  "SELECT COUNT(*) AS n FROM run_log WHERE at >= ? AND event LIKE 'monitor.%error%'",
  startedAt,
);
db.close();

const now = Date.now();
const elapsedDays = Math.min(7, Math.max(1, Math.ceil((now - startedAt) / 86_400_000)));
const remainingDays = Math.max(0, 7 - elapsedDays);
const missingDays = Math.max(0, elapsedDays - days.length);
const concerns = [];

if (!hasCooldown) concerns.push("数据库还没有 monitor_cooldown 表：可能未升级到 M2 代码");
if (!hasMonitorKind) concerns.push("还没有产生过 kind=monitor 的通知");
if (activeConfigs.length < 3) concerns.push(`启用的监测器只有 ${activeConfigs.length} 个（目标 3 个）`);
if (configuredSkills.size < 3) concerns.push(`绑定的 Skill 只有 ${configuredSkills.size} 个（目标 3 个）`);
if (firedSkills.length < 3)
  concerns.push(`实际触发过通知的 Skill 只有 ${firedSkills.length} 个（目标 3 个）`);
if (monitorErrors.n > 0) concerns.push(`monitor 错误日志 ${monitorErrors.n} 条，确认是否是临时网络问题`);
if (failureNotifications.n > 0)
  concerns.push(`failure 通知 ${failureNotifications.n} 条，确认故障是否已恢复`);
if (missingDays > 0) concerns.push(`有 ${missingDays} 天没有 heartbeat（应用可能整天未运行）`);
if (elapsedDays < 7) concerns.push(`窗口尚未满 7 天，还剩 ${remainingDays} 天`);
if (concerns.length === 0) concerns.push("自动证据未发现明显异常，仍需人工确认三个任务是否真的被替代");

const lines = [
  "# M2 自动证据报告",
  "",
  `- 生成时间：${new Date().toISOString()}`,
  `- 数据目录：\`${dataDir}\``,
  `- 窗口起点：${startDate ?? "今天"}（M2 第 ${elapsedDays}/7 天；剩余 ${remainingDays} 天）`,
  `- 监测器：配置 ${configs.length}，启用 ${activeConfigs.length}，绑定 Skill ${configuredSkills.size}`,
  `- Skill 文件：${skillFiles.length}；实际触发过通知：${firedSkills.length}`,
  `- Heartbeat 覆盖：${days.length} 天${missingDays > 0 ? `（缺 ${missingDays} 天）` : ""}`,
  "",
  "## 监测器配置",
  "",
];
if (configs.length === 0) {
  lines.push("无。先到「设置 → 监测器」添加，或在 config.json 配置。");
} else {
  for (const monitor of configs) {
    const skills = Array.isArray(monitor.skills) ? monitor.skills : [];
    lines.push(
      `- ${monitor.id ?? "(无 id)"}（${monitor.kind ?? "?"}，${monitor.enabled === false ? "停用" : "启用"}）` +
        ` · skills: ${skills.join(", ") || "无"}`,
    );
  }
}
lines.push(
  "",
  "## 触发了通知的 Skill",
  "",
  ...(firedSkills.length
    ? firedSkills.map((s) => `- ${s.skill_name}: ${s.n} 次，最近 ${new Date(s.last).toLocaleString("zh-CN")}`)
    : ["- 无（还没有 monitor 通知）"]),
  "",
  "## 通知",
  "",
  `- monitor：${monitorNotifications.n}`,
  ...monitorStates.map((s) => `  - ${s.state}: ${s.n}`),
  `- failure：${failureNotifications.n}`,
  "",
  "## 运行与错误",
  "",
  `- Heartbeat 条数：${heartbeats.n ?? 0}`,
  `- 首条：${heartbeats.first ?? "无"}`,
  `- 末条：${heartbeats.last ?? "无"}`,
  `- monitor 错误日志：${monitorErrors.n}`,
  `- 运行缺口：${gaps.length}`,
  "",
  "## 需要人工确认",
  "",
  ...concerns.map((c) => `- ${c}`),
);

const outDir = join(ROOT, "docs", "acceptance");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "m2-report.md");
writeFileSync(outFile, `${lines.join("\n")}\n`, "utf8");

console.log(`✓ M2 报告已生成：${outFile}`);
console.log(
  `  M2 第 ${elapsedDays}/7 天；启用监测器 ${activeConfigs.length}；触发 Skill ${firedSkills.length}；monitor 通知 ${monitorNotifications.n}`,
);
for (const c of concerns) console.log(`  · ${c}`);
