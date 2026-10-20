#!/usr/bin/env node
/**
 * M3 验收证据自动汇总
 *
 * M3 的目标是"LLM 判断 + 外部数据源 + 多渠道 + 知识库地基"。
 * 本脚本只汇总可自动核对的证据：LLM 外发/引用问答、知识库规模、早报天数、
 * 渠道投递结果、ICS 日历配置。它不替产品负责人判断"早报是否有用"。
 *
 * 用法：
 *   node tools/m3-report.mjs
 *   AEGIS_DATA_DIR=/path node tools/m3-report.mjs
 *
 * 输出：docs/acceptance/m3-report.md（本机证据，已 gitignore）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(import.meta.dirname, "..");
const dataDir = process.env.AEGIS_DATA_DIR ?? join(homedir(), "Library", "Application Support", "Aegis");
const dbFile = join(dataDir, "aegis.db");
const configFile = join(dataDir, "config.json");

if (!existsSync(dbFile)) {
  console.error(`✗ 找不到数据库：${dbFile}`);
  console.error("  先用 AEGIS_DATA_DIR 指定数据目录。");
  process.exit(1);
}

const db = new DatabaseSync(dbFile);
db.exec("PRAGMA busy_timeout = 5000");
const one = (sql, ...params) => db.prepare(sql).get(...params);
const rows = (sql, ...params) => db.prepare(sql).all(...params);

/** 读配置；坏配置不阻断报告 */
function readConfig() {
  if (!existsSync(configFile)) return {};
  try {
    return JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    return {};
  }
}

const cfg = readConfig();
const now = Date.now();
const sevenDaysAgo = now - 7 * 86_400_000;

const audits = rows(
  "SELECT purpose, outcome, COUNT(*) AS n FROM outbound_audit WHERE at >= ? GROUP BY purpose, outcome ORDER BY purpose, outcome",
  sevenDaysAgo,
);
const auditTotal = one("SELECT COUNT(*) AS n FROM outbound_audit");
const blocked = one("SELECT COUNT(*) AS n FROM outbound_audit WHERE outcome = 'blocked'");
const knowledge = rows(
  "SELECT d.source_path, d.data_class, COUNT(c.id) AS chunks FROM knowledge_document d LEFT JOIN knowledge_chunk c ON c.document_id = d.id GROUP BY d.id ORDER BY d.created_at DESC",
);
const knowledgeDocs = one("SELECT COUNT(*) AS n FROM knowledge_document");
const knowledgeChunks = one("SELECT COUNT(*) AS n FROM knowledge_chunk");
const digests = rows(
  "SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n FROM notification WHERE kind = 'digest' GROUP BY day ORDER BY day",
);
const digestDays = digests.length;
const attempts = rows(
  "SELECT channel, outcome, COUNT(*) AS n FROM delivery_attempt GROUP BY channel, outcome ORDER BY channel, outcome",
);
const channels = new Set(attempts.map((a) => a.channel));
const successes = new Set(attempts.filter((a) => a.outcome === "success").map((a) => a.channel));

/** ICS 事件数；坏文件只给 0，不阻断 */
function countIcsEvents(path) {
  if (!path || !existsSync(path)) return 0;
  try {
    const text = readFileSync(path, "utf8");
    return (text.match(/BEGIN:VEVENT/g) ?? []).length;
  } catch {
    return 0;
  }
}

const icsPath = cfg.calendar?.icsPath;
const icsEvents = countIcsEvents(icsPath);
const emailEnabled = cfg.notify?.email?.enabled === true;
const routingEnabled = cfg.notify?.routing?.enabled === true;
db.close();

const concerns = [];
if (digestDays < 7) concerns.push(`早报只覆盖 ${digestDays}/7 天；还不能宣称“连续 7 天有信息量”`);
if (!emailEnabled) concerns.push("SMTP 邮件渠道未启用；“重要邮件”读取/监测仍未实现");
if (
  !successes.has("webhook") &&
  !successes.has("telegram") &&
  !successes.has("bark") &&
  !successes.has("email")
) {
  concerns.push("还没有任何远程渠道成功投递记录；离开电脑的可靠性未验证");
}
if (!channels.has("fanout") && !channels.has("routing")) {
  concerns.push("还没有 fanout/routing 投递记录；多渠道链路未实际跑过");
}
if ((knowledgeDocs.n ?? 0) === 0) concerns.push("知识库为空，引用问答尚未用真实文档验证");
if (!audits.some((a) => a.purpose === "knowledge-answer"))
  concerns.push("还没有 knowledge-answer 外发审计；真实问答未跑过");
if (!blocked || blocked.n === 0) concerns.push("还没有 blocked 外发审计；拒答路径仅由测试覆盖");
if (!icsPath) concerns.push("未配置 ICS 日历，早报没有真实日程");
if (!routingEnabled) concerns.push("优先级分流未启用（可选，但 M3 验收建议验证）");

const lines = [
  "# M3 验收证据（自动生成）",
  "",
  `- 生成时间：${new Date(now).toLocaleString("zh-CN")}`,
  `- 数据目录：\`${dataDir}\``,
  `- 数据库：\`${dbFile}\``,
  "",
  "## 概览",
  "",
  "| 项 | 值 |",
  "| --- | --- |",
  `| 知识库文档 / 分块 | ${knowledgeDocs?.n ?? 0} / ${knowledgeChunks?.n ?? 0} |`,
  `| 近 7 天外发审计 | ${audits.reduce((n, a) => n + a.n, 0)} 条 |`,
  `| 历史 blocked | ${blocked?.n ?? 0} 条 |`,
  `| 早报覆盖天数 | ${digestDays} 天（目标 ≥7） |`,
  `| ICS 事件数 | ${icsEvents} |`,
  `| SMTP 邮件启用 | ${emailEnabled ? "是" : "否"} |`,
  `| 优先级分流启用 | ${routingEnabled ? "是" : "否"} |`,
  "",
  "## 外发审计（近 7 天）",
  "",
  audits.length === 0
    ? "（没有外发记录）"
    : [
        "| purpose | outcome | 次数 |",
        "| --- | --- | --- |",
        ...audits.map((a) => `| ${a.purpose} | ${a.outcome} | ${a.n} |`),
      ].join("\n"),
  "",
  "## 渠道投递",
  "",
  attempts.length === 0
    ? "（没有投递记录）"
    : [
        "| channel | outcome | 次数 |",
        "| --- | --- | --- |",
        ...attempts.map((a) => `| ${a.channel} | ${a.outcome} | ${a.n} |`),
      ].join("\n"),
  "",
  "## 早报",
  "",
  digests.length === 0
    ? "（还没有 digest 通知）"
    : ["| 日期 | 条数 |", "| --- | --- |", ...digests.map((d) => `| ${d.day} | ${d.n} |`)].join("\n"),
  "",
  "## 知识库",
  "",
  knowledge.length === 0
    ? "（空）"
    : [
        "| 文件 | 分级 | 分块 |",
        "| --- | --- | --- |",
        ...knowledge.map((k) => `| ${k.source_path} | ${k.data_class} | ${k.chunks} |`),
      ].join("\n"),
  "",
  "## 未满足项",
  "",
  concerns.length === 0
    ? "✓ 自动可核对项均满足；仍需产品负责人判断“早报是否有信息量”。"
    : concerns.map((c) => `- ${c}`).join("\n"),
  "",
  "> 本报告不包含 API Key、SMTP 密码、Device Key 或消息正文。",
  "",
];

const outDir = join(ROOT, "docs", "acceptance");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "m3-report.md");
writeFileSync(outFile, lines.join("\n"));
console.log(`✓ 已生成 ${outFile}`);
if (concerns.length > 0) {
  console.log("⚠ 未满足项：");
  for (const c of concerns) console.log(`  · ${c}`);
}
