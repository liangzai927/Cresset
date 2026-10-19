#!/usr/bin/env node
/**
 * 一条命令启动桌面应用
 *
 * ## 为什么需要它
 *
 * 原本要两步：`node tools/build.mjs` 然后 `node tools/run-desktop.mjs`。
 * 多一步就多一个忘记的机会 —— 而"忘了构建"的症状是**界面开着但代码是旧的**，
 * 这类问题最难察觉（用户以为改动没生效，实际是没重新构建）。
 *
 * 因此这里做**智能增量**：
 *   - 产物不存在 → 构建
 *   - 源码比产物新 → 构建
 *   - 否则 → 直接启动（约 1 秒进入界面）
 *
 * ## 用法
 *
 * ```
 * pnpm dev              # 智能：需要时构建，然后启动
 * pnpm dev --force      # 强制先构建
 * pnpm dev --skip-build # 完全不构建（确信产物是最新时用，最快）
 * ```
 */

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const skipBuild = args.includes("--skip-build");

/** 需要参与"是否过期"判断的源目录 */
const SOURCE_DIRS = [
  join(ROOT, "packages"),
  join(ROOT, "apps"),
  join(ROOT, "tools"),
  join(ROOT, "tsconfig.base.json"),
  join(ROOT, "tsconfig.dev.json"),
  join(ROOT, "package.json"),
  join(ROOT, "pnpm-workspace.yaml"),
];

/** 判断入口产物是否存在 */
const DESKTOP_ENTRY = join(ROOT, "apps", "desktop", "dist", "main.js");
const DAEMON_ENTRY = join(ROOT, "apps", "daemon", "dist", "main.js");

/**
 * 求一棵目录树里最新的 mtime。
 *
 * 跳过 `dist`、`node_modules` —— 它们不是"输入"，
 * 把它们算进来会导致"每次都判定过期、每次都重建"。
 */
function newestMtime(target) {
  let newest = 0;
  const stack = [target];

  while (stack.length > 0) {
    const cur = stack.pop();
    let st;
    try {
      st = statSync(cur);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      const base = cur.split("/").pop() ?? "";
      if (base === "dist" || base === "node_modules" || base === ".git") continue;
      let entries;
      try {
        entries = readdirSync(cur);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(join(cur, e));
    } else if (st.isFile()) {
      // 只关心会进产物的文件类型
      if (/\.(ts|mjs|js|json|html|css)$/.test(cur)) {
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  }
  return newest;
}

/** 求产物目录里最早的 mtime（用来判断"产物是否早于源码"） */
function oldestMtime(target) {
  let oldest = Number.POSITIVE_INFINITY;
  const stack = [target];

  while (stack.length > 0) {
    const cur = stack.pop();
    let st;
    try {
      st = statSync(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const e of readdirSync(cur)) stack.push(join(cur, e));
    } else if (st.mtimeMs < oldest) {
      oldest = st.mtimeMs;
    }
  }
  return oldest;
}

/**
 * 判断是否需要构建。
 *
 * 判定逻辑保守：只要有任何不确定，就构建。
 * 构建只需约 2–3 秒，而"用了旧代码"的代价是一次莫名其妙的调试。
 */
function needsBuild() {
  // 入口缺失 → 必然要构建
  try {
    statSync(DESKTOP_ENTRY);
    statSync(DAEMON_ENTRY);
  } catch {
    return { needed: true, reason: "产物缺失" };
  }

  const srcNewest = Math.max(...SOURCE_DIRS.map((d) => newestMtime(d)));
  const distOldest = Math.min(
    oldestMtime(join(ROOT, "apps", "desktop", "dist")),
    oldestMtime(join(ROOT, "apps", "daemon", "dist")),
  );

  if (srcNewest > distOldest) {
    return { needed: true, reason: "源码比产物新" };
  }
  return { needed: false, reason: "产物已是最新" };
}

/** 同步运行一个子进程并等待结束 */
function run(script, scriptArgs, label) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...scriptArgs], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} 失败（退出码 ${code}）`));
    });
    child.on("error", reject);
  });
}

async function main() {
  const buildScript = join(ROOT, "tools", "build.mjs");

  if (skipBuild) {
    console.log("▶ 跳过构建（--skip-build）");
  } else if (force) {
    console.log("▶ 强制构建");
    await run(buildScript, [], "构建");
  } else {
    const { needed, reason } = needsBuild();
    if (needed) {
      console.log(`▶ 需要构建（${reason}）`);
      await run(buildScript, [], "构建");
    } else {
      console.log("▶ 产物已是最新，直接启动");
    }
  }

  // 启动桌面应用（run-desktop.mjs 负责清 ELECTRON_RUN_AS_NODE 等环境问题）
  await run(
    join(ROOT, "tools", "run-desktop.mjs"),
    args.filter((a) => !a.startsWith("--force") && a !== "--skip-build"),
    "启动",
  );
}

try {
  await main();
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
