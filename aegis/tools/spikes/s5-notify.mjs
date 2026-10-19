#!/usr/bin/env node
/**
 * S5 —— 通知通道 + CLI 兜底（macOS）
 *
 * 验证 D5：Electron 不可用时，daemon 仍能通过平台 CLI 弹出通知（osascript）。
 * 这是"UI 全挂也能响"的关键，也是"24/7 提醒"不被 UI 生命周期绑架的最后一道保障。
 *
 * 注意 macOS 的现实约束：通知是否真正展示，取决于**发起应用是否被授予通知权限**。
 * 因此本探针区分三种结论：
 *   pass    —— 命令成功，且能在系统日志中找到该通知被处理的证据
 *   blocked —— 命令成功但无系统级证据（多半是权限未授予 / 需要用户在 GUI 确认）
 *   fail    —— 命令本身失败
 */
import { spawnSync } from "node:child_process";

const TITLE = `AegisSpike-${Math.random().toString(36).slice(2, 8)}`;
const evidence = [];
const log = (s) => evidence.push(s);
const emit = (status, detail, metrics = {}) =>
  console.log(JSON.stringify({ status, detail, evidence, metrics }));

function run(cmd, args, timeout = 30_000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), signal: r.signal };
}

// ── 通道 1：osascript display notification（CLI 兜底主通道）
const script = `display notification "${TITLE} 的正文，用于验证 CLI 兜底通道。" with title "${TITLE}" sound name "Ping"`;
const osa = run("/usr/bin/osascript", ["-e", script]);
log(`osascript display notification：退出码 ${osa.code}${osa.err ? ` err=${osa.err}` : ""}`);
const channel1Ok = osa.code === 0 && osa.signal !== "SIGTERM";

// ── 通道 2：display alert（更强，但会阻塞；加超时保护，仅作能力探测）
const alertScript = `display alert "${TITLE}" message "若你看到这个弹窗，说明 AppleScript 通知通道可用。它会自动关闭。" giving up after 3`;
const alert = run("/usr/bin/osascript", ["-e", alertScript], 20_000);
log(`osascript display alert（3 秒自动关闭）：退出码 ${alert.code}${alert.err ? ` err=${alert.err}` : ""}`);
const channel2Ok = alert.code === 0 && alert.signal !== "SIGTERM";

// ── 证据检索 1：系统日志中是否出现该通知
let logEvidence = 0;
const since = new Date(Date.now() - 3 * 60 * 1000).toLocaleTimeString("en-US", { hour12: false });
const lg = run(
  "/usr/bin/log",
  [
    "show",
    "--last",
    "3m",
    "--style",
    "compact",
    "--predicate",
    `eventMessage CONTAINS "${TITLE}" OR eventMessage CONTAINS "osascript"`,
  ],
  90_000,
);
if (lg.code === 0) {
  logEvidence = lg.out.split("\n").filter((l) => l.includes(TITLE)).length;
  log(`日志原始命中（含 osascript）行数：${lg.out.split("\n").filter(Boolean).length}`);
} else {
  log(`统一日志检索不可用：退出码 ${lg.code}${lg.err ? ` err=${lg.err.slice(0, 120)}` : ""}`);
}
log(`统一日志检索（近 3 分钟，since≈${since}）：命中 ${logEvidence} 条`);

// ── 证据检索 2：通知中心数据库是否存在该记录（受 TCC 保护，失败属预期）
let dbHit = false;
const dbProbe = run(
  "/bin/sh",
  [
    "-c",
    `DB=$(ls -d /var/folders/*/*/0/com.apple.notificationcenter/db2/db /var/folders/*/*/0/com.apple.notificationcenter/db2/db2 2>/dev/null | head -1); ` +
      `if [ -n "$DB" ]; then sqlite3 "file:$DB?mode=ro" "select count(*) from record where data like '%${TITLE}%'" 2>/dev/null || echo "TCC_DENIED"; else echo "NO_DB"; fi`,
  ],
  20_000,
);
log(`通知中心数据库探测：${dbProbe.out || dbProbe.err || "(无输出)"}`);
dbHit =
  dbProbe.out !== "" && dbProbe.out !== "TCC_DENIED" && dbProbe.out !== "NO_DB" && Number(dbProbe.out) > 0;

// ── 结论
const anyChannelOk = channel1Ok || channel2Ok;
const sandboxed = lg.code !== 0 && /sandboxed/i.test(lg.err);
const status = !anyChannelOk ? "fail" : logEvidence > 0 || dbHit ? "pass" : "blocked";
const detail = !anyChannelOk
  ? "CLI 通知通道不可用：需评估替代（terminal-notifier / 随包分发 helper app）"
  : logEvidence > 0 || dbHit
    ? "CLI 兜底通道可用，且有系统级投递证据"
    : sandboxed
      ? "CLI 通知/弹窗命令均成功（D5 实现基础具备），但沙箱内无法取得系统级投递证据：请在真实终端执行 `node tools/self-check.mjs` 并留意是否真的看到通知"
      : "CLI 命令执行成功，但缺少系统级投递证据：极可能是通知权限未授予（需在 GUI 中授权一次，属已知限制）";

emit(status, detail, {
  channelOsascript: channel1Ok,
  channelAlert: channel2Ok,
  systemLogHits: logEvidence,
  dbHit,
});
