#!/usr/bin/env node
/**
 * 桌面应用端到端验证（C-11 的机械化检查）
 *
 * ## 为什么需要它
 *
 * R3 的核心承诺是"本地能打开这个软件，并且提醒真的会弹出来"。
 * 这件事**无法用单元测试证明** —— 它依赖 Electron 进程能启动、
 * 通道能建立、daemon 能被拉起、原生通知权限可用。
 *
 * 因此这份脚本做真实启动验证。它检查的是**集成事实**，不是逻辑正确性：
 *
 * | 检查项 | 为什么重要 |
 * | --- | --- |
 * | `ELECTRON_RUN_AS_NODE` 已清除 | 该变量会让 Electron 当纯 Node 跑，窗口永远不出现 |
 * | 窗口真的渲染出内容 | 白屏是最常见的"看起来启动了但没用" |
 * | `channel.json` 存在且为 0600 | 否则 daemon 连不上原生通道 / token 泄露 |
 * | daemon 被自动拉起 | 用户不该手动管理后台进程 |
 * | daemon 被 SIGKILL 后 10 秒内换新 pid | NFR-R2 的崩溃自恢复承诺，只能真杀进程验证 |
 * | 通道鉴权生效 | 无 token 必须被拒 |
 * | 原生通知投递返回 success | 最终目的 |
 * | 截图非空且尺寸合理 | "渲染了"的客观证据 |
 *
 * ## 用法
 *
 * ```
 * node tools/verify-desktop.mjs            # 完整验证（会启动真实 GUI）
 * node tools/verify-desktop.mjs --keep     # 保留临时数据目录便于排查
 * AEGIS_E2E_NO_SANDBOX=1 node tools/verify-desktop.mjs   # 外层已有沙箱（DSH / CI）时
 * ```
 *
 * 退出码：0 全部通过；1 有检查项失败。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const keep = process.argv.includes("--keep");

/**
 * 是否给 Electron 加 `--no-sandbox`。
 *
 * 默认**不加** —— 生产启动路径必须保留 Chromium 沙箱。
 * 只有测试本身已经跑在外层文件沙箱里（DSH / 部分 CI）时才显式开启：
 * 那种环境下 Chromium 沙箱初始化会直接失败，窗口根本起不来。
 * 同时指定独立的 `--user-data-dir`，避免 Electron 去写 `~/Library/Application Support`。
 */
const noChromiumSandbox = process.env.AEGIS_E2E_NO_SANDBOX === "1";

/** 组装 Electron 启动参数（沙箱环境追加测试专用开关，不改变产品启动方式） */
function desktopArgs(userDataDir) {
  const switches = noChromiumSandbox
    ? ["--no-sandbox", `--user-data-dir=${join(userDataDir, "electron-user-data")}`]
    : [];
  return [...switches, join(ROOT, "apps", "desktop")];
}

/** 收集检查结果 */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} ${name}${detail ? `  — ${detail}` : ""}`);
}

/** 等待条件成立（带超时） */
async function waitFor(fn, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

async function main() {
  // ── 前置：产物必须存在
  const desktopMain = join(ROOT, "apps", "desktop", "dist", "main.js");
  const daemonMain = join(ROOT, "apps", "daemon", "dist", "main.js");
  if (!existsSync(desktopMain) || !existsSync(daemonMain)) {
    console.error("✗ 产物缺失，先执行：node tools/build.mjs");
    process.exit(1);
  }

  const dataDir = mkdtempSync(join(tmpdir(), "aegis-verify-"));
  const shotPath = join(dataDir, "ui.png");
  console.log(`▶ 桌面应用端到端验证`);
  console.log(`  数据目录: ${dataDir}`);

  // 用较快的 tick 让"到点触发"能在验证时间内发生
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ version: 1, tickMs: 1_500 }));

  const electronBin = join(
    ROOT,
    "node_modules",
    "electron",
    "dist",
    "Electron.app",
    "Contents",
    "MacOS",
    "Electron",
  );
  if (!existsSync(electronBin)) {
    console.error("✗ 找不到 Electron 二进制，执行：node node_modules/electron/install.js");
    process.exit(1);
  }

  // ── 启动应用（清除 ELECTRON_RUN_AS_NODE —— 这是本环境最大的坑）
  const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env;
  void _drop;

  const child = spawn(electronBin, desktopArgs(dataDir), {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      AEGIS_DATA_DIR: dataDir,
      AEGIS_CAPTURE: shotPath,
      AEGIS_REPO_ROOT: ROOT,
    },
  });

  const logs = [];
  child.stdout.on("data", (b) => logs.push(String(b)));
  child.stderr.on("data", (b) => logs.push(String(b)));

  try {
    // ── ① 通道文件出现（说明通道服务已起来）
    const channelPath = join(dataDir, "channel.json");
    const hasChannel = await waitFor(() => existsSync(channelPath), 25_000);
    check("桌面通道已建立（channel.json）", Boolean(hasChannel));

    if (hasChannel) {
      // ── ② 权限必须是 0600（token 不能给其它用户读）
      const mode = statSync(channelPath).mode & 0o777;
      check("channel.json 权限为 0600", mode === 0o600, `实际 0o${mode.toString(8)}`);

      const ch = JSON.parse(await import("node:fs").then((m) => m.readFileSync(channelPath, "utf8")));

      // ── ③ 端点必须是回环地址
      check("端点为 127.0.0.1 回环", /^http:\/\/127\.0\.0\.1:\d+$/.test(ch.endpoint), ch.endpoint);

      // ── ④ 健康检查可用
      const health = await fetch(`${ch.endpoint}/health`, {
        headers: { authorization: `Bearer ${ch.token}` },
      })
        .then((r) => r.json())
        .catch(() => null);
      check("通道健康检查返回 ok", Boolean(health?.ok), JSON.stringify(health));

      // ── ⑤ 鉴权生效：无 token 必须被拒
      const noAuth = await fetch(`${ch.endpoint}/health`)
        .then((r) => r.status)
        .catch(() => 0);
      check("无 token 请求被拒绝（401）", noAuth === 401, `实际 ${noAuth}`);

      // ── ⑥ 真实投递一条原生通知
      const sent = await fetch(`${ch.endpoint}/notify`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ch.token}` },
        body: JSON.stringify({ title: "Aegis 自检", body: "端到端验证", sound: false }),
      })
        .then((r) => r.json())
        .catch(() => null);
      check("原生通知投递成功", sent?.outcome === "success", JSON.stringify(sent));
    }

    // ── ⑦ daemon 被自动拉起
    //
    // 不能只看文件存在：daemon 可能正在写，读到半截 JSON 会让后面的杀进程检查直接抛错。
    // 因此等到"能解析出整数 pid"才算真正就绪。
    const handshakePath = join(dataDir, "handshake.json");
    const firstHandshake = await waitFor(() => {
      try {
        const hs = JSON.parse(readFileSync(handshakePath, "utf8"));
        return Number.isInteger(hs.pid) ? hs : null;
      } catch {
        return null;
      }
    }, 20_000);
    check("daemon 已被自动拉起（handshake.json）", Boolean(firstHandshake));

    // ── ⑦b 崩溃自恢复（NFR-R2）：真杀 daemon，10 秒内必须换一个新 pid
    //
    // 为什么必须真杀：监督者的退避、稳定计数与"永不放弃"都在 Electron 主进程里，
    // 单测只能证明策略函数对；只有杀掉真实子进程，才能证明退出事件、
    // 定时器与重新拉起这条链路真的接上了。
    if (firstHandshake) {
      const killedAt = Date.now();
      let killed = false;
      try {
        process.kill(firstHandshake.pid, "SIGKILL");
        killed = true;
      } catch (err) {
        check("daemon 被 SIGKILL 后自动重启（NFR-R2）", false, `杀进程失败：${String(err)}`);
      }

      if (killed) {
        const restarted = await waitFor(() => {
          try {
            const hs = JSON.parse(readFileSync(handshakePath, "utf8"));
            if (hs.pid === firstHandshake.pid) return null;
            process.kill(hs.pid, 0);
            return hs;
          } catch {
            return null;
          }
        }, 12_000);
        const elapsedMs = Date.now() - killedAt;
        check(
          "daemon 被 SIGKILL 后自动重启（NFR-R2）",
          Boolean(restarted) && elapsedMs <= 10_000,
          restarted ? `${firstHandshake.pid} → ${restarted.pid}，${elapsedMs}ms` : "12 秒内未出现新 pid",
        );
      }
    }

    // ── ⑧ 界面渲染出内容（截图存在且非空白）
    const shot = await waitFor(() => existsSync(shotPath) && statSync(shotPath).size > 5_000, 25_000);
    check("界面已渲染（截图非空）", Boolean(shot), shot ? `${statSync(shotPath).size} 字节` : "未产出截图");

    // ── ⑨ 日志里不应有致命错误
    const text = logs.join("");
    const fatal = /main\.bootstrap_failed|App threw an error|ERR_MODULE_NOT_FOUND|Dynamic require/.test(text);
    check("启动日志无致命错误", !fatal, fatal ? "见下方日志" : "");
    if (fatal) {
      console.log("\n  ── 日志 ──");
      for (const line of text.split("\n").slice(-15)) console.log(`  ${line}`);
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1_200));
    // 显式停 daemon（它不随 UI 退出，这是设计而非缺陷）
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync(process.execPath, [join(ROOT, "apps", "daemon", "dist", "main.js"), "stop"], {
        env: { ...env, AEGIS_DATA_DIR: dataDir },
        stdio: "ignore",
      });
    } catch {
      /* 停不掉不影响验证结论 */
    }
    if (!keep) rmSync(dataDir, { recursive: true, force: true });
    else console.log(`  保留数据目录: ${dataDir}`);
  }

  // ── ⑩ 冷启动竞态：界面刚出现就点"测试通知"必须成功
  //
  // 这是一次真实事故的回归检查：曾经在 daemon 还没就绪时点按钮会直接报
  // "daemon 尚未就绪"，用户看到的就是一句无从下手的错误。
  // 该链路跨 renderer → preload → 主进程 → daemon，单元测试覆盖不到。
  {
    const raceDir = mkdtempSync(join(tmpdir(), "aegis-race-"));
    const race = spawn(electronBin, desktopArgs(raceDir), {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        AEGIS_DATA_DIR: raceDir,
        AEGIS_E2E_SMOKE: "1", // 主进程会在 150ms 后主动调用 testNotify
        AEGIS_REPO_ROOT: ROOT,
      },
    });
    let raceOut = "";
    race.stdout.on("data", (b) => (raceOut += String(b)));
    race.stderr.on("data", (b) => (raceOut += String(b)));

    // 等它自己退出（冒烟完成后会 app.quit）
    await new Promise((r) => {
      const timer = setTimeout(() => {
        race.kill("SIGTERM");
        r();
      }, 25_000);
      race.on("exit", () => {
        clearTimeout(timer);
        r();
      });
    });

    const ok = raceOut.includes("SMOKE_NOTIFY_OK") && !raceOut.includes("SMOKE_NOTIFY_FAIL");
    check(
      "冷启动立刻点测试通知能成功（竞态回归）",
      ok,
      ok ? "" : (raceOut.match(/SMOKE_NOTIFY_FAIL:[^"\\]*/) ?? ["未得到结果"])[0],
    );

    // 清理该轮 daemon（它不随 UI 退出）
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync(process.execPath, [join(ROOT, "apps", "daemon", "dist", "main.js"), "stop"], {
        env: { ...env, AEGIS_DATA_DIR: raceDir },
        stdio: "ignore",
      });
    } catch {
      /* 忽略 */
    }
    if (!keep) rmSync(raceDir, { recursive: true, force: true });
  }

  // ── 汇总
  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length === 0) {
    console.log(`✓ 桌面应用验证通过（${results.length} 项）`);
    process.exit(0);
  }
  console.error(`✗ 桌面应用验证失败（${failed.length}/${results.length} 项）`);
  for (const f of failed) console.error(`   - ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
  process.exit(1);
}

await main();
