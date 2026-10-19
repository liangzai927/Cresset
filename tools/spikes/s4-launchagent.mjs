#!/usr/bin/env node
/**
 * S4 —— LaunchAgent 自启与异常拉起（macOS）
 *
 * 验证 NFR-I1（开机自启）+ NFR-R2（崩溃自恢复）。
 * 做法：写一个真实的 LaunchAgent（StartInterval 触发 + KeepAlive），加载到用户域，
 * 观察标记文件是否被反复写入；然后杀掉子进程，验证 launchd 是否按 KeepAlive 拉起。
 * 结束必须彻底清理（bootout + 删 plist），不留系统残留。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ARTIFACTS = process.env.SPIKE_ARTIFACTS ?? resolve(import.meta.dirname, "../../spike-artifacts");
const STAGE = join(ARTIFACTS, "s4");
const LABEL = "com.aegis.spike.s4";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const evidence = [];
const log = (s) => evidence.push(s);
const emit = (status, detail, metrics = {}) =>
  console.log(JSON.stringify({ status, detail, evidence, metrics }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = process.getuid?.() ?? 501;
const launchctl = (args, timeout = 15_000) => {
  const r = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

if (process.platform !== "darwin") {
  emit("blocked", "非 macOS：LaunchAgent 验证不适用（Windows 计划任务 / Linux systemd 留待 M8）");
  process.exit(0);
}

function cleanup() {
  launchctl(["bootout", `gui/${uid}/${LABEL}`]);
  if (existsSync(PLIST)) rmSync(PLIST, { force: true });
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// 先探测 LaunchAgents 目录可写性：自动化沙箱里会被拒（EPERM），此时本项无法验证
mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
const writeProbe = join(homedir(), "Library", "LaunchAgents", ".aegis-write-probe");
try {
  writeFileSync(writeProbe, "probe");
  rmSync(writeProbe, { force: true });
} catch (e) {
  log(`~/Library/LaunchAgents 不可写：${String(e.message).split("\n")[0]}`);
  emit(
    "blocked",
    "当前环境禁止写 ~/Library/LaunchAgents（自动化沙箱限制），LaunchAgent 无法在此验证：请在真实终端执行 `node tools/self-check.mjs --full`",
    { sandboxed: true },
  );
  process.exit(0);
}

// launchd 用户域是否可读（沙箱下会返回 I/O error 或拒绝）
const domainProbe = launchctl(["print", `gui/${uid}`]);
log(`launchd 用户域可读：${domainProbe.code === 0}`);
cleanup();

// 探针脚本：每次运行记录 pid 与时间戳；带一个"存活 4 秒"的循环以便测试 KeepAlive
const worker = join(STAGE, "worker.mjs");
const marker = join(STAGE, "marker.log");
writeFileSync(
  worker,
  `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, at: Date.now() }) + "\\n");
const end = Date.now() + 4000;
setTimeout(() => process.exit(0), 4000);
`,
);

writeFileSync(
  PLIST,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${worker}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3</integer>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${join(STAGE, "stdout.log")}</string>
  <key>StandardErrorPath</key><string>${join(STAGE, "stderr.log")}</string>
</dict>
</plist>
`,
);
log(`已写入 LaunchAgent：${PLIST}`);

// 1) 加载（现代 API：bootstrap gui/<uid>）
let boot = launchctl(["bootstrap", `gui/${uid}`, PLIST]);
if (boot.code !== 0) {
  // 退回旧 API（兼容旧系统）
  log(`bootstrap 失败（${boot.err || boot.code}），退回 load -w`);
  boot = launchctl(["load", "-w", PLIST]);
}
log(`bootstrap/load 退出码 ${boot.code}${boot.err ? ` err=${boot.err}` : ""}`);
if (boot.code !== 0) {
  cleanup();
  emit("fail", `LaunchAgent 加载失败：${boot.err || boot.code}`, { bootstrap: boot.code });
  process.exit(0);
}

// 2) 等待 RunAtLoad + StartInterval 触发
await sleep(4500);
const count1 = existsSync(marker)
  ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length
  : 0;
log(`加载后 4.5 秒内执行 ${count1} 次（RunAtLoad + StartInterval=3s）`);

// 3) 验证 KeepAlive：杀掉落地的进程，观察是否被重新拉起
const pidsBefore = existsSync(marker)
  ? readFileSync(marker, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l).pid)
  : [];
let killed = 0;
for (const pid of pidsBefore.slice(-2)) {
  const k = spawnSync("/bin/kill", ["-9", String(pid)], { encoding: "utf8" });
  if (k.status === 0) killed += 1;
}
log(`强制杀掉 ${killed} 个 worker 进程（模拟 daemon 崩溃）`);

// 崩溃后如果 KeepAlive 生效，launchd 会立刻重启（SuccessfulExit=false 表示非 0 退出才重启，
// SIGKILL 也会被视为异常退出）。等待并观察新 pid 出现。
await sleep(6000);
const lines = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean) : [];
const pidsAfter = lines.map((l) => JSON.parse(l).pid);
const newPids = pidsAfter.filter((p) => !pidsBefore.includes(p));
log(`崩溃后 6 秒内新增 worker 进程数：${newPids.length}`);

// 4) 清理
const bootout = launchctl(["bootout", `gui/${uid}/${LABEL}`]);
if (existsSync(PLIST)) rmSync(PLIST, { force: true });
const plistRemoved = !existsSync(PLIST);
log(`bootout 退出码 ${bootout.code}；plist 已清理：${plistRemoved}`);
const stillLoaded = launchctl(["list", LABEL]);
log(`清理后 list 查询（非 0 表示已卸载）：退出码 ${stillLoaded.code}`);

const autostartOk = count1 >= 1;
const keepAliveOk = newPids.length >= 1;
const cleanedOk = plistRemoved && stillLoaded.code !== 0;

emit(
  autostartOk && keepAliveOk && cleanedOk ? "pass" : autostartOk ? "fail" : "fail",
  autostartOk && keepAliveOk && cleanedOk
    ? "LaunchAgent 可加载、RunAtLoad+StartInterval 生效、崩溃后被拉起、可彻底清理"
    : `LaunchAgent 行为不完整（自启=${autostartOk} 拉起=${keepAliveOk} 清理=${cleanedOk}）`,
  { runsOnLoad: count1, restartedAfterKill: newPids.length, cleaned: cleanedOk },
);
