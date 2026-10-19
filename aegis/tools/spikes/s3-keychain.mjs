#!/usr/bin/env node
/**
 * S3 —— 钥匙串读写（macOS Keychain，经 /usr/bin/security CLI）
 *
 * 验证 NFR-S1：凭据只进系统钥匙串，不落明文配置。
 * 关键点是"不阻塞交互"：读取时必须用 -w（否则 security 会弹出授权对话框，
 * 对 24/7 无人值守的 daemon 是致命的）。本探针显式验证这一点。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECURITY = "/usr/bin/security";
const SERVICE = "aegis.spike.keychain";
const ACCOUNT = "probe@localhost";
const SECRET = `s3-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const evidence = [];
const log = (s) => evidence.push(s);
const emit = (status, detail, metrics = {}) =>
  console.log(JSON.stringify({ status, detail, evidence, metrics }));

function run(args, timeout = 15_000) {
  const r = spawnSync(SECURITY, args, { encoding: "utf8", timeout });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), signal: r.signal };
}

if (!existsSync(SECURITY)) {
  emit("blocked", `未找到 ${SECURITY}（非 macOS 环境）`);
  process.exit(0);
}

// ── 阶段 0：探测登录钥匙串是否可写（沙箱/CI 常被拒：UNIX[Operation not permitted]）
const probeLogin = run([
  "add-generic-password",
  "-s",
  `${SERVICE}.probe`,
  "-a",
  ACCOUNT,
  "-w",
  "probe",
  "-U",
]);
const loginWritable = probeLogin.code === 0;
run(["delete-generic-password", "-s", `${SERVICE}.probe`, "-a", ACCOUNT]);
log(`登录钥匙串可写：${loginWritable}${loginWritable ? "" : `（${probeLogin.err || probeLogin.code}）`}`);

// 若登录钥匙串被拒（沙箱 / 无会话），回退到独立临时钥匙串 —— 验证 security CLI 与协议本身可用
let KC_ARGS = [];
let tempKeychain = null;
if (!loginWritable) {
  const kcPath = join(tmpdir(), `aegis-s3-${Date.now()}.keychain-db`);
  const create = run(["create-keychain", "-p", "spike-pass", kcPath]);
  log(`创建临时钥匙串：退出码 ${create.code}${create.err ? ` err=${create.err}` : ""}`);
  if (create.code === 0) {
    run(["unlock-keychain", "-p", "spike-pass", kcPath]);
    run(["set-keychain-settings", "-t", "600", "-l", kcPath]); // 10 分钟后自动锁定，避免残留
    KC_ARGS = [kcPath];
    tempKeychain = kcPath;
  }
}

// 清理历史残留
run(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT, ...KC_ARGS]);

// 1) 写入
const add = run(["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", SECRET, "-U", ...KC_ARGS]);
log(`add-generic-password 退出码 ${add.code}`);
if (add.code !== 0) {
  emit("fail", `写入钥匙串失败：${add.err || "(无错误输出)"}`);
  process.exit(0);
}

// 2) 非交互读取（-w）——这是 daemon 唯一允许使用的方式
const read = run(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", ...KC_ARGS]);
const readOk = read.code === 0 && read.out === SECRET;
log(`find-generic-password -w 退出码 ${read.code}，取回值匹配：${readOk}`);

// 3) 显式验证"不带 -w 会刻意不输出口令"（说明为什么必须用 -w）
const readAttrs = run(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, ...KC_ARGS]);
const attrsLeak = readAttrs.out.includes(SECRET);
log(`不带 -w 读取：退出码 ${readAttrs.code}，输出含明文口令：${attrsLeak}（应为 false）`);

// 4) 更新（-U 覆盖）
const SECRET2 = `${SECRET}-v2`;
const upd = run(["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", SECRET2, "-U", ...KC_ARGS]);
const read2 = run(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", ...KC_ARGS]);
log(`覆盖写入退出码 ${upd.code}；覆盖后读回匹配：${read2.out === SECRET2}`);

// 5) 删除
const del = run(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT, ...KC_ARGS]);
const after = run(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", ...KC_ARGS]);
log(`删除退出码 ${del.code}；删除后读取应失败：退出码 ${after.code}（非 0 为正确）`);

// 清理临时钥匙串
if (tempKeychain) {
  const delKc = run(["delete-keychain", tempKeychain]);
  log(`删除临时钥匙串：退出码 ${delKc.code}`);
}

const noHang = read.signal !== "SIGTERM";
const ok = readOk && upd.code === 0 && read2.out === SECRET2 && del.code === 0 && after.code !== 0 && noHang;
emit(
  ok ? "pass" : "fail",
  ok
    ? loginWritable
      ? "登录钥匙串可非交互读写（-w），适合 24/7 无人值守；无阻塞"
      : "登录钥匙串在本环境被拒（沙箱/无 GUI 会话），但 security CLI 与协议本身可用（临时钥匙串验证通过）：需在真实用户会话下复验"
    : "钥匙串交互行为不符合预期：需评估退路（加密文件 + 口令派生）",
  {
    loginWritable,
    tempKeychainUsed: Boolean(tempKeychain),
    add: add.code,
    read: read.code,
    overwrite: upd.code,
    remove: del.code,
    timedOut: !noHang,
  },
);
