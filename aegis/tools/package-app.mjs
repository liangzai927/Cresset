#!/usr/bin/env node
/**
 * macOS 打包 —— 把 Electron 壳、desktop/daemon 产物、工作区包与 Node 运行时
 * 组装成可双击的 `dist/Aegis.app`
 *
 * ## 为什么手写而不是 electron-builder
 *
 * 目前只需要 macOS 的 `.app`，electron-builder 会引入一整套依赖与配置；
 * 而本仓库的产物规则已经稳定（esbuild 逐包打包，`@aegis/*` 保持 external）。
 * 手写复制能精确控制四类内容：
 *
 * ```
 * Aegis.app/Contents/Resources/
 * ├── app/                     Electron 主进程 + renderer + preload
 * ├── daemon/                  daemon 产物（入口 main.js）
 * ├── node/bin/node            随附 Node 运行时（ADR-01：不依赖系统 Node）
 * └── node_modules/@aegis/*    工作区包（供 app 与 daemon 解析）
 * ```
 *
 * ## 为什么必须重新签名
 *
 * 复制 Electron.app 后只要改了 `Info.plist` 或 Resources，原签名就失效。
 * 这里默认用 ad-hoc 签名（`codesign -s -`），保证本机可以启动；
 * 要分发仍需 Apple Developer 的 Developer ID 与公证，见 `--sign`。
 *
 * ## 用法
 *
 * ```bash
 * node tools/package-app.mjs                  # 构建 + 组装 + ad-hoc 签名
 * node tools/package-app.mjs --skip-build     # 复用现有 dist（调试打包脚本时）
 * node tools/package-app.mjs --verify         # 组装后真实启动打包产物自检
 * node tools/package-app.mjs --sign "Developer ID Application: ..."
 * node tools/package-app.mjs --no-sign        # 明确不签名（只用于排查）
 *
 * AEGIS_E2E_NO_SANDBOX=1 node tools/package-app.mjs --verify   # 外层已有沙箱时
 * ```
 *
 * 退出码：0 成功；1 任一步骤失败。
 */

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const ELECTRON_APP = join(ROOT, "node_modules", "electron", "dist", "Electron.app");
const OUT_DIR = join(ROOT, "dist");
const APP = join(OUT_DIR, "Aegis.app");
const RESOURCES = join(APP, "Contents", "Resources");

const argv = process.argv.slice(2);
const skipBuild = argv.includes("--skip-build");
const doVerify = argv.includes("--verify");
const noSign = argv.includes("--no-sign");
const signFlagIndex = argv.indexOf("--sign");
const signIdentity = signFlagIndex >= 0 ? argv[signFlagIndex + 1] : "-";
if (signFlagIndex >= 0 && (!signIdentity || signIdentity.startsWith("--"))) {
  fail('--sign 后面必须跟签名身份（例如 "Developer ID Application: ..."）');
}

await main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

/** 打包主流程；任何一步失败都以退出码 1 结束 */
async function main() {
  if (!skipBuild) {
    console.log("▶ 构建全部产物");
    run(process.execPath, [join(ROOT, "tools", "build.mjs")]);
  }

  assertInputs();

  // 产品名/数据目录/Bundle ID 前缀的单一真相源（构建后才有 dist）
  const productDist = join(ROOT, "packages", "product", "dist", "index.js");
  if (!existsSync(productDist)) {
    fail("缺少 product 产物；去掉 --skip-build 先执行一次完整构建");
  }
  const { PRODUCT } = await import(pathToFileURL(productDist).href);
  const desktopVersion = JSON.parse(
    readFileSync(join(ROOT, "apps", "desktop", "package.json"), "utf8"),
  ).version;
  const shortVersion = toShortVersion(desktopVersion);

  console.log("▶ 组装 Aegis.app");
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // 用 ditto 而不是 cpSync：Electron.app 的 Frameworks 里有大量符号链接，
  // ditto 会按 bundle 语义原样保留，cpSync 在部分 Node 版本上会解引用或漏拷贝。
  run("ditto", [ELECTRON_APP, APP]);

  configureInfoPlist({
    plist: join(APP, "Contents", "Info.plist"),
    displayName: PRODUCT.displayName,
    bundleId: `${PRODUCT.bundleIdPrefix}.desktop`,
    version: shortVersion,
  });

  // Electron 会优先加载 Resources/app；默认 app.asar 留着只会让人怀疑到底加载了谁
  rmSync(join(RESOURCES, "default_app.asar"), { force: true });
  rmSync(join(RESOURCES, "app"), { recursive: true, force: true });

  copyDesktopApp(desktopVersion);
  copyDaemon();
  copyWorkspacePackages();
  copyNodeRuntime();

  if (!noSign) {
    console.log(`▶ 签名（${signIdentity === "-" ? "ad-hoc" : signIdentity}）`);
    run("codesign", ["--force", "--deep", "--sign", signIdentity, APP]);
    run("codesign", ["--verify", "--deep", "--strict", APP]);
  }

  console.log(`✓ 打包完成：${APP}`);
  console.log(`  大小：${duSh(APP)}`);

  if (doVerify) {
    await verifyPackagedApp();
  } else {
    console.log(`  启动：open "${APP}"`);
  }
}

/** 前置检查：缺任何一项都给出可执行的修复提示，而不是 ENOENT 栈 */
function assertInputs() {
  const required = [
    [ELECTRON_APP, "找不到 Electron.app，先执行 pnpm install（需要下载 Electron 二进制）"],
    [join(ELECTRON_APP, "Contents", "MacOS", "Electron"), "Electron.app 不完整，先执行 pnpm install"],
    [join(ROOT, "apps", "desktop", "dist", "main.js"), "缺少 desktop 产物，先执行 pnpm build"],
    [join(ROOT, "apps", "daemon", "dist", "main.js"), "缺少 daemon 产物，先执行 pnpm build"],
  ];
  for (const [path, message] of required) {
    if (!existsSync(path)) fail(message);
  }
}

/** 把 Electron 的 Info.plist 改成 Aegis 的身份；executable 仍叫 Electron，避免改坏 Helper 链 */
function configureInfoPlist(opts) {
  setPlist(opts.plist, "CFBundleName", opts.displayName);
  setPlist(opts.plist, "CFBundleDisplayName", opts.displayName);
  setPlist(opts.plist, "CFBundleIdentifier", opts.bundleId);
  setPlist(opts.plist, "CFBundleShortVersionString", opts.version);
  setPlist(opts.plist, "CFBundleVersion", opts.version);
}

/** 设置 plist 键；不存在时回退到 Add（Electron 不同版本键集合会变） */
function setPlist(plist, key, value) {
  const quoted = `"${String(value).replace(/"/g, '\\"')}"`;
  try {
    run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${quoted}`, plist], { quiet: true });
  } catch {
    run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${quoted}`, plist], { quiet: true });
  }
}

/** 复制 Electron 主进程产物与 renderer；package.json 决定 Electron 的入口与 userData 名 */
function copyDesktopApp(version) {
  const src = join(ROOT, "apps", "desktop", "dist");
  const dest = join(RESOURCES, "app");
  mkdirSync(dest, { recursive: true });
  cpSync(src, join(dest, "dist"), { recursive: true });

  // 刻意不写 productName：Electron 的 userData 会退到 name（aegis-desktop），
  // 避免和应用自己的数据目录 ~/Library/Application Support/Aegis 混在一起。
  writeFileSync(
    join(dest, "package.json"),
    `${JSON.stringify(
      {
        name: "aegis-desktop",
        version,
        private: true,
        type: "module",
        main: "dist/main.js",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** daemon 产物放到 Resources/daemon；resolveDaemonEntry() 优先找这个路径 */
function copyDaemon() {
  cpSync(join(ROOT, "apps", "daemon", "dist"), join(RESOURCES, "daemon"), { recursive: true });
}

/**
 * 复制所有工作区包的 package.json + dist 到 Resources/node_modules。
 *
 * app 与 daemon 的裸导入都从这里解析：Node 会从
 * Resources/app/dist 或 Resources/daemon 逐级向上找到 Resources/node_modules。
 */
function copyWorkspacePackages() {
  const nodeModules = join(RESOURCES, "node_modules");
  const sources = [];
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(ROOT, "packages", entry.name);
    if (existsSync(join(dir, "package.json"))) sources.push(dir);
  }
  // daemon 也要以包的形式存在：desktop 通过 `@aegis/daemon/ipc-client` 导入它
  sources.push(join(ROOT, "apps", "daemon"));

  for (const dir of sources) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const dist = join(dir, "dist");
    if (!existsSync(dist)) fail(`包 ${manifest.name} 缺少 dist，先执行 pnpm build`);

    const dest = join(nodeModules, manifest.name);
    mkdirSync(dest, { recursive: true });
    cpSync(join(dir, "package.json"), join(dest, "package.json"));
    cpSync(dist, join(dest, "dist"), { recursive: true });
  }
}

/**
 * 复制随附 Node（ADR-01）。
 *
 * 只复制 `bin/node` 单文件：本机 nvm 的 Node 是自包含的（otool 只依赖系统库），
 * 比复制整个发行目录（约 194MB）省 80MB。复制后**真的执行一次 `-v`**，
 * 防止拿到一个依赖外部 dylib、在用户机器上起不来的二进制。
 */
function copyNodeRuntime() {
  const dest = join(RESOURCES, "node", "bin", "node");
  mkdirSync(join(RESOURCES, "node", "bin"), { recursive: true });
  cpSync(process.execPath, dest);
  chmodSync(dest, 0o755);
  try {
    const version = execFileSync(dest, ["-v"], { encoding: "utf8" }).trim();
    console.log(`  随附 Node：${version}`);
  } catch (err) {
    fail(`随附 Node 无法执行（可能是动态链接不完整）：${String(err)}`);
  }
}

/**
 * 启动打包产物做真实自检。
 *
 * 跑的是 `Aegis.app/Contents/MacOS/Electron`，不是开发态脚本 ——
 * 只有这样才能发现"Resources/app 入口写错 / 工作区包漏拷贝 / 随附 Node 起不来"。
 */
async function verifyPackagedApp() {
  console.log("▶ 启动打包产物自检");
  const dataDir = mkdtempSync(join(tmpdir(), "aegis-package-"));
  const png = join(dataDir, "ui.png");
  const handshakePath = join(dataDir, "handshake.json");

  const env = { ...process.env, AEGIS_DATA_DIR: dataDir, AEGIS_CAPTURE: png };
  delete env.ELECTRON_RUN_AS_NODE;

  // 外层文件沙箱（DSH/CI）里 Chromium 沙箱起不来，也写不了 ~/Library；
  // 只有显式设置时才加测试开关，绝不改变用户正常启动的方式。
  const noSandbox = process.env.AEGIS_E2E_NO_SANDBOX === "1";
  const args = noSandbox ? ["--no-sandbox", `--user-data-dir=${join(dataDir, "electron-user-data")}`] : [];

  const bin = join(APP, "Contents", "MacOS", "Electron");
  const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  child.stdout.on("data", (b) => logs.push(String(b)));
  child.stderr.on("data", (b) => logs.push(String(b)));

  let daemonPid = null;
  try {
    const shot = await waitFor(() => existsSync(png) && statSync(png).size > 5_000, 30_000);
    const handshake = await waitFor(() => {
      try {
        const hs = JSON.parse(readFileSync(handshakePath, "utf8"));
        return Number.isInteger(hs.pid) ? hs : null;
      } catch {
        return null;
      }
    }, 20_000);
    if (handshake) daemonPid = handshake.pid;

    const text = logs.join("");
    const moduleError = /ERR_MODULE_NOT_FOUND|Cannot find module/.test(text);
    const ok = Boolean(shot && handshake && !moduleError);
    if (!ok) {
      console.error("✗ 打包产物自检失败");
      console.error(
        `  截图：${shot ? "有" : "无"}；握手：${handshake ? `pid=${handshake.pid}` : "无"}；模块错误：${moduleError}`,
      );
      for (const line of text.split("\n").slice(-20)) console.error(`  ${line}`);
      throw new Error("打包产物无法正常启动");
    }

    // 证明 daemon 用的是包内 Node 与包内入口，而不是碰巧回退到系统 Node。
    // 握手文件由 daemon 自己写，这比 `ps` 更可靠（也避免了沙箱禁止进程探测）。
    const bundledNode = join(RESOURCES, "node", "bin", "node");
    const daemonEntry = join(RESOURCES, "daemon", "main.js");
    if (handshake.nodeExecPath !== bundledNode) {
      throw new Error(`daemon 没有使用随附 Node（实际：${handshake.nodeExecPath ?? "未记录"}）`);
    }
    if (handshake.daemonEntry !== daemonEntry) {
      throw new Error(`daemon 没有使用打包入口（实际：${handshake.daemonEntry ?? "未记录"}）`);
    }

    console.log(`  ✓ 界面已渲染（截图 ${statSync(png).size} 字节）`);
    console.log(`  ✓ daemon 已拉起（pid=${handshake.pid}，版本 ${handshake.daemonVersion ?? "未知"}）`);
    console.log("  ✓ daemon 使用随附 Node 与打包入口");
  } finally {
    if (daemonPid !== null) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        /* 已退出 */
      }
    }
    child.kill("SIGTERM");
    await sleep(1_200);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** 把 `0.3.0-r3` 收敛成 macOS 接受的 `0.3.0` */
function toShortVersion(version) {
  const short = String(version).split("-")[0];
  if (!/^\d+(\.\d+){1,3}$/.test(short)) {
    fail(`无法把版本号 "${version}" 转成 CFBundleShortVersionString`);
  }
  return short;
}

/** 同步执行并继承输出；quiet 用于会输出大量内容的探测命令 */
function run(command, args, opts = {}) {
  const stdio = opts.quiet ? "pipe" : "inherit";
  return execFileSync(command, args, { cwd: ROOT, stdio, encoding: "utf8" });
}

/** 等待条件成立（脚本级工具，使用真实时间；超时返回 null） */
async function waitFor(fn, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

/** 真实等待（只用于打包验证脚本，不涉及业务逻辑） */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** 目录体积（人类可读） */
function duSh(path) {
  return execFileSync("du", ["-sh", path], { encoding: "utf8" }).split("\t")[0];
}

/** 失败退出：打印可执行的原因，不留下半成品继续被误用 */
function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
