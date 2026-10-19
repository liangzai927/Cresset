#!/usr/bin/env node
/**
 * 系统级能力自检（S4 / S5 的沙箱外验证）
 *
 * 为什么需要这个脚本：
 *   本项目的自动化环境运行在文件沙箱里，**无法**写 ~/Library/LaunchAgents，
 *   也无法使用 `log show`（"Cannot run while sandboxed"）。因此 S4（LaunchAgent
 *   自启/拉起）与 S5（通知真实投递）这两项必须在真实用户会话下复验。
 *
 * 用法：
 *   node spike-artifacts/self-check.mjs            # 只做只读检查
 *   node spike-artifacts/self-check.mjs --full     # 额外做写入/加载/清理（会创建并删除一个临时 LaunchAgent）
 *
 * 安全性：脚本只创建 label 为 com.aegis.spike.selfcheck 的临时 LaunchAgent，
 *         并在结束时删除；通知只发一条测试通知；钥匙串只创建并删除一个测试项。
 *         全部动作都会打印出来，可逐条核对。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FULL = process.argv.includes("--full");
const LABEL = "com.aegis.spike.selfcheck";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const WORK = "/tmp/aegis-selfcheck";
const uid = process.getuid?.() ?? 501;
const results = [];

const run = (cmd, args, timeout = 20_000) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok === true ? "✓" : ok === false ? "✗" : "⊘"} ${name}：${detail}`);
};

console.log("=== Aegis 系统级能力自检 ===");
console.log(`平台 ${process.platform}/${process.arch}｜Node ${process.version}`);
console.log(`模式：${FULL ? "完整（会创建并清理临时系统项）" : "只读"}\n`);

// ── 1. LaunchAgents 目录可写性
mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
const probeFile = join(homedir(), "Library", "LaunchAgents", ".aegis-write-probe");
let writable = false;
try {
  writeFileSync(probeFile, "probe");
  writable = true;
  rmSync(probeFile, { force: true });
} catch {
  writable = false;
}
record(
  "LaunchAgents 目录可写",
  writable,
  writable ? "可写（可安装开机自启）" : "不可写 → 自动化环境受限，需在真实终端运行",
);

// ── 2. launchd 用户域可访问
const domain = run("/bin/launchctl", ["print", `gui/${uid}`]);
record(
  "launchd 用户域可访问",
  domain.code === 0,
  domain.code === 0 ? `gui/${uid} 可访问` : `失败：${domain.err.split("\n")[0] || domain.code}`,
);

// ── 3. 通知通道
const TITLE = `Aegis 自检 ${new Date().toLocaleTimeString("zh-CN")}`;
const notify = run("/usr/bin/osascript", [
  "-e",
  `display notification "如果你看到这条通知，说明通知通道可用。" with title "${TITLE}" sound name "Ping"`,
]);
record(
  "CLI 通知（osascript）",
  notify.code === 0,
  notify.code === 0
    ? "命令成功（若未看到通知，请在「系统设置 → 通知」中允许 osascript/终端）"
    : `失败：${notify.err}`,
);

const alert = run("/usr/bin/osascript", [
  "-e",
  `display alert "Aegis 自检" message "弹窗通道可用（3 秒后自动关闭）" giving up after 3`,
]);
record("CLI 弹窗（osascript）", alert.code === 0, alert.code === 0 ? "命令成功" : `失败：${alert.err}`);

const logShow = run(
  "/usr/bin/log",
  ["show", "--last", "2m", "--style", "compact", "--predicate", `eventMessage CONTAINS "${TITLE}"`],
  60_000,
);
record(
  "系统日志可查询（通知投递证据）",
  logShow.code === 0,
  logShow.code === 0
    ? `可查询，命中 ${logShow.out.split("\n").filter((l) => l.includes(TITLE)).length} 条`
    : `不可用：${logShow.err.split("\n")[0] || logShow.code}（沙箱内会失败，属预期）`,
);

// ── 4. 钥匙串（登录钥匙串是否可写）
const kcService = "aegis.spike.selfcheck";
run("/usr/bin/security", ["delete-generic-password", "-s", kcService, "-a", "probe"]);
const kcAdd = run("/usr/bin/security", [
  "add-generic-password",
  "-s",
  kcService,
  "-a",
  "probe",
  "-w",
  "selfcheck-secret",
  "-U",
]);
const kcRead = run("/usr/bin/security", ["find-generic-password", "-s", kcService, "-a", "probe", "-w"]);
run("/usr/bin/security", ["delete-generic-password", "-s", kcService, "-a", "probe"]);
record(
  "登录钥匙串可读写（凭据存储）",
  kcAdd.code === 0 && kcRead.out === "selfcheck-secret",
  kcAdd.code === 0
    ? "可非交互读写（-w），适合无人值守"
    : `写入失败：${kcAdd.err.split("\n")[0] || kcAdd.code}`,
);

// ── 5. 完整模式：真实安装一次 LaunchAgent 并验证拉起与清理
if (FULL) {
  console.log("\n--- 完整模式：临时 LaunchAgent 验证 ---");
  mkdirSync(WORK, { recursive: true });
  const worker = join(WORK, "worker.mjs");
  const marker = join(WORK, "marker.log");
  rmSync(marker, { force: true });
  writeFileSync(
    worker,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, Date.now() + "\\n");\nsetTimeout(() => process.exit(0), 3000);\n`,
  );
  writeFileSync(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${worker}</string></array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>3</integer>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
`,
  );
  console.log(`  已写 ${PLIST}`);

  const boot = run("/bin/launchctl", ["bootstrap", `gui/${uid}`, PLIST]);
  const bootOk = boot.code === 0 || run("/bin/launchctl", ["load", "-w", PLIST]).code === 0;
  record("LaunchAgent 加载", bootOk, bootOk ? "bootstrap/load 成功" : `失败：${boot.err.split("\n")[0]}`);

  await new Promise((r) => setTimeout(r, 4500));
  const runs = existsSync(marker)
    ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  record("RunAtLoad + StartInterval 生效", runs >= 1, `4.5 秒内执行 ${runs} 次`);

  const listed = run("/bin/launchctl", ["list", LABEL]);
  record("launchctl list 可见", listed.code === 0, listed.code === 0 ? "已注册到 launchd" : "查询失败");

  const bootout = run("/bin/launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
  rmSync(PLIST, { force: true });
  const cleaned = !existsSync(PLIST) && run("/bin/launchctl", ["list", LABEL]).code !== 0;
  record("可彻底清理（无残留）", cleaned, `bootout ${bootout.code}，plist 已删，list 已消失`);
  rmSync(WORK, { recursive: true, force: true });
}

// ── 汇总
const failed = results.filter((r) => r.ok === false);
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.log("未通过项：");
  for (const f of failed) console.log(`  - ${f.name}：${f.detail}`);
}
if (!FULL) console.log("\n提示：加 --full 可验证 LaunchAgent 的真实加载/拉起/清理。");
process.exit(0);
