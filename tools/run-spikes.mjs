#!/usr/bin/env node
/**
 * R0 spike 运行器 —— 逐项验证六个技术前提，产出可复现的结论。
 *
 * 每项 spike 输出一行 JSON 结果：{ id, name, status: pass|fail|blocked, detail, evidence[] }
 * 结果写入 spike-artifacts/report.json，并由 --report 打印人类可读摘要。
 *
 * 用法：
 *   node tools/run-spikes.mjs               # 全部运行
 *   node tools/run-spikes.mjs --only s6     # 只跑某项
 *   node tools/run-spikes.mjs --report      # 只读已有结果并打印
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ARTIFACTS = join(ROOT, "spike-artifacts");
const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const reportOnly = argv.includes("--report");

const SPIKES = [
  { id: "s1", name: "S1 随附 Node 运行时运行 daemon", file: "s1-bundled-node.mjs" },
  { id: "s2", name: "S2 SQLite 能力矩阵（FTS5 + sqlite-vec + 中文检索）", file: "s2-sqlite-vec.mjs" },
  { id: "s3", name: "S3 钥匙串读写（macOS security）", file: "s3-keychain.mjs" },
  { id: "s4", name: "S4 LaunchAgent 自启与拉起", file: "s4-launchagent.mjs" },
  { id: "s5", name: "S5 通知通道 + CLI 兜底", file: "s5-notify.mjs" },
  { id: "s6", name: "S6 UDS/named pipe IPC 握手与重连", file: "s6-ipc.mjs" },
];

function printReport(report) {
  const icon = { pass: "✓", fail: "✗", blocked: "⊘", skipped: "·" };
  console.log("\n================ R0 Spike 结论 ================");
  for (const r of report.results) {
    console.log(`${icon[r.status] ?? "?"} ${r.name}  [${r.status}]`);
    console.log(`   ${r.detail}`);
    for (const e of r.evidence ?? []) console.log(`     - ${e}`);
    console.log();
  }
  const passed = report.results.filter((r) => r.status === "pass").length;
  console.log(
    `总计：${passed}/${report.results.length} 通过，环境 ${report.env.platform}/${report.env.arch}，Node ${report.env.node}`,
  );
  const blockers = report.results.filter((r) => r.status !== "pass");
  if (blockers.length) {
    console.log("\n需处理的项：");
    for (const b of blockers) console.log(`  - ${b.id}: ${b.detail}`);
  }
  console.log("==============================================\n");
}

if (reportOnly) {
  const p = join(ARTIFACTS, "report.json");
  printReport(JSON.parse(readFileSync(p, "utf8")));
  process.exit(0);
}

mkdirSync(ARTIFACTS, { recursive: true });
const results = [];

for (const spike of SPIKES) {
  if (only && spike.id !== only) continue;
  process.stdout.write(`▶ ${spike.name} ... `);
  const started = Date.now();
  const proc = spawnSync(process.execPath, [join(ROOT, "tools", "spikes", spike.file)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 240_000,
    env: { ...process.env, SPIKE_ARTIFACTS: ARTIFACTS },
  });
  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  let parsed = null;
  for (const line of stdout.trim().split("\n").reverse()) {
    if (line.startsWith("{")) {
      try {
        parsed = JSON.parse(line);
        break;
      } catch {
        /* 继续找 */
      }
    }
  }
  const result = parsed ?? {
    id: spike.id,
    name: spike.name,
    status: "fail",
    detail: `探针未产出 JSON 结论（exit=${proc.status}）`,
    evidence: [stderr.trim().slice(0, 500) || stdout.trim().slice(0, 500) || "(无输出)"],
  };
  result.id = spike.id;
  result.name = spike.name;
  result.durationMs = Date.now() - started;
  results.push(result);
  console.log(`${result.status} (${result.durationMs}ms)`);
  if (result.status !== "pass" && stderr.trim()) {
    console.log(`   stderr: ${stderr.trim().split("\n").slice(-3).join("\n           ")}`);
  }
}

const reportPath = join(ARTIFACTS, "report.json");
let report;
if (only) {
  // 单项运行时合并到已有报告
  const prev = existsSyncSafe(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
  const merged = new Map((prev?.results ?? []).map((r) => [r.id, r]));
  for (const r of results) merged.set(r.id, r);
  report = { ...makeEnv(), results: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)) };
} else {
  report = { ...makeEnv(), results };
}
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
printReport(report);

function existsSyncSafe(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

function makeEnv() {
  return {
    env: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      execPath: process.execPath,
      at: new Date().toISOString(),
    },
  };
}
