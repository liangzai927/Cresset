#!/usr/bin/env node
/**
 * S1 —— 打包随附 Node 运行时运行 daemon
 *
 * 验证 ADR-01（D1 决策）：daemon 不依赖 Electron 的 Node，而用随包分发的独立 Node 运行时。
 * 做法：
 *   1. 把当前 Node 的发行目录"复制式打包"到 spike-artifacts/node-runtime/（模拟打包流程，
 *      只取真实发行版需要的子集：bin/node + 必要的 lib/dylib，跳过 npm 缓存等）
 *   2. 用一个最小 daemon 脚本（写 SQLite + 落锁文件 + 打印 JSON 状态）在**打包副本**下运行
 *   3. 校验：可启动、可写库、可被 SIGTERM 优雅停止、退出码正确
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ARTIFACTS = process.env.SPIKE_ARTIFACTS ?? resolve(import.meta.dirname, "../../spike-artifacts");
const STAGE = join(ARTIFACTS, "s1");
const NODE_DIR = resolve(process.execPath, "../.."); // .../node 发行根
const evidence = [];

function fail(detail, extra = []) {
  console.log(JSON.stringify({ status: "fail", detail, evidence: [...evidence, ...extra] }));
  process.exit(0);
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// 1) 打包 Node 运行时（复制发行目录，排除体积大且运行时不需要的部分）
const runtimeDir = join(STAGE, "node-runtime");
const EXCLUDE = new Set(["node_modules", "include", "share", "CHANGELOG.md", "README.md"]);
cpSync(NODE_DIR, runtimeDir, {
  recursive: true,
  filter: (src) => !EXCLUDE.has(src.split("/").pop() ?? ""),
});
const stagedNode = join(runtimeDir, "bin", "node");
if (!existsSync(stagedNode)) fail(`打包后未找到 ${stagedNode}`);

const sizeOf = (p) => {
  const r = spawnSync("du", ["-sk", p], { encoding: "utf8" });
  return Number.parseInt(r.stdout.trim().split(/\s+/)[0] ?? "0", 10) * 1024;
};
const runtimeBytes = sizeOf(runtimeDir);
evidence.push(`源运行时：${NODE_DIR}`);
evidence.push(`打包副本体积：${(runtimeBytes / 1024 / 1024).toFixed(1)} MB`);
evidence.push(`打包副本 Node 版本：${spawnSync(stagedNode, ["-v"], { encoding: "utf8" }).stdout.trim()}`);

// 2) 最小 daemon 脚本（只用 Node 内置能力，验证"独立运行时"这一前提）
const daemonScript = join(STAGE, "mini-daemon.mjs");
writeFileSync(
  daemonScript,
  `import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const dataDir = process.argv[2];
mkdirSync(dataDir, { recursive: true });
const lock = join(dataDir, "daemon.lock");
writeFileSync(lock, String(process.pid));
// node:sqlite 是 Node 22.5+ 内置能力，独立运行时下必须可用
let sqliteOk = false, sqliteErr = null, extOk = false;
try {
  const { DatabaseSync } = await import("node:sqlite");
  // node:sqlite 的扩展加载必须在**建库时**开启（allowExtension），事后 enableLoadExtension 无效
  const db = new DatabaseSync(join(dataDir, "mini.db"), { allowExtension: true });
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO t(v) VALUES (?)").run("hello");
  const row = db.prepare("SELECT COUNT(*) AS n FROM t").get();
  sqliteOk = row.n === 1;
  // 扩展加载能力（sqlite-vec 路线的前提）
  try {
    if (typeof db.enableLoadExtension === "function") db.enableLoadExtension(true);
    extOk = typeof db.loadExtension === "function";
    if (!extOk) sqliteErr = "loadExtension 不存在";
  } catch (e) { sqliteErr = String(e); }
  db.close();
} catch (e) { sqliteErr = String(e); }
console.log(JSON.stringify({ ok: true, pid: process.pid, execPath: process.execPath,
  node: process.version, sqliteOk, extLoadApi: extOk, sqliteErr }));
process.on("SIGTERM", () => { process.exit(0); });
setInterval(() => {}, 1000);
`,
);

// 3) 在打包副本下运行 daemon
const dataDir = join(STAGE, "data");
const child = spawn(stagedNode, [daemonScript, dataDir], { encoding: "utf8" });
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  stdout += d;
});
child.stderr.on("data", (d) => {
  stderr += d;
});

await new Promise((r) => setTimeout(r, 1500));

if (child.exitCode !== null) {
  fail(`打包副本无法运行 daemon（退出码 ${child.exitCode}）`, [stderr.trim().slice(0, 400)]);
}

let parsed = null;
try {
  parsed = JSON.parse(stdout.trim().split("\n").pop());
} catch {
  fail("daemon 未输出预期 JSON", [stdout.trim().slice(0, 300), stderr.trim().slice(0, 300)]);
}

const lockOk = existsSync(join(dataDir, "daemon.lock"));
const walOk = existsSync(join(dataDir, "mini.db-wal")) || existsSync(join(dataDir, "mini.db"));

// 4) 优雅停止
child.kill("SIGTERM");
const exited = await Promise.race([
  new Promise((r) => child.once("exit", (code) => r(code))),
  new Promise((r) => setTimeout(() => r("timeout"), 3000)),
]);
if (exited === "timeout") {
  child.kill("SIGKILL");
  fail("daemon 未在 3 秒内响应 SIGTERM");
}

evidence.push(`daemon 在打包副本下启动成功（pid=${parsed.pid}）`);
evidence.push(`node:sqlite 可用：${parsed.sqliteOk}｜loadExtension API 存在：${parsed.extLoadApi}`);
if (parsed.sqliteErr) evidence.push(`sqlite 备注：${parsed.sqliteErr}`);
evidence.push(`写库文件存在：${walOk}｜单实例锁文件存在：${lockOk}`);
evidence.push(`SIGTERM 优雅退出，退出码 ${exited}`);

const ok = parsed.ok && parsed.sqliteOk && lockOk && walOk && exited === 0;
console.log(
  JSON.stringify({
    status: ok ? "pass" : "fail",
    detail: ok
      ? `随附 Node 运行时可以完整运行 daemon（体积 +${(runtimeBytes / 1024 / 1024).toFixed(0)}MB）`
      : "随附运行时下 daemon 行为不符合预期",
    evidence,
    metrics: { runtimeBytes, sqliteOk: parsed.sqliteOk, exitCode: exited },
  }),
);
