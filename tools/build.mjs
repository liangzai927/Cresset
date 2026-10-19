#!/usr/bin/env node
/**
 * 构建脚本（架构文档 D7）
 *
 * 为什么不用 `tsc -b`（项目引用）：
 *   项目引用要求每个包先产出 .d.ts，而包的 package.json `exports` 又指向 dist/，
 *   形成"要先有产物才能构建产物"的鸡生蛋问题（tsc 不会因 references 就把
 *   `@aegis/contracts` 这类包名解析到被引用工程的产物上）。
 *
 * 本仓库的分工（三步，顺序不可颠倒）：
 *   1. **类型检查**：`tsc -p tsconfig.dev.json --noEmit` —— 用 paths 指向源码，不依赖产物
 *   2. **打包**：esbuild（JS API）逐包打包，工作区内部依赖 external（保留包边界）
 *   3. **类型声明**：`tsc --emitDeclarationOnly --noCheck` —— noCheck 让跨包类型解析
 *      不必再走一遍（第 1 步已保证类型正确），从而避开 rootDir 约束问题
 *
 * 用法：
 *   node tools/build.mjs                    构建全部
 *   node tools/build.mjs --only daemon      只构建某个目标
 *   node tools/build.mjs --skip-typecheck   跳过第 1 步（仅用于调试构建链本身）
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
let esbuildBuild;
try {
  ({ build: esbuildBuild } = require("esbuild"));
} catch {
  console.error("✗ 未找到 esbuild。请先运行 pnpm install。");
  process.exit(1);
}

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const skipTypecheck = argv.includes("--skip-typecheck");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

/** 构建目标；deps 用于生成声明时的 paths 映射（与依赖方向门禁保持一致） */
const TARGETS = [
  { name: "clock", dir: "packages/clock", entry: "src/index.ts", deps: [] },
  { name: "product", dir: "packages/product", entry: "src/index.ts", deps: [] },
  { name: "contracts", dir: "packages/contracts", entry: "src/index.ts", deps: ["product"] },
  { name: "ipc-contract", dir: "packages/ipc-contract", entry: "src/index.ts", deps: ["contracts"] },
  { name: "recurrence", dir: "packages/recurrence", entry: "src/index.ts", deps: ["clock", "contracts"] },
  {
    name: "scheduler",
    dir: "packages/scheduler",
    entry: "src/index.ts",
    deps: ["clock", "contracts", "platform", "recurrence", "storage"],
  },
  { name: "storage", dir: "packages/storage", entry: "src/index.ts", deps: ["clock", "contracts"] },
  { name: "secrets", dir: "packages/secrets", entry: "src/index.ts", deps: ["contracts", "product"] },
  { name: "platform", dir: "packages/platform", entry: "src/index.ts", deps: ["clock", "contracts"] },
  {
    name: "redaction-gateway",
    dir: "packages/redaction-gateway",
    entry: "src/index.ts",
    deps: ["contracts"],
  },
  {
    name: "daemon",
    dir: "apps/daemon",
    // daemon 有多个源文件（main / bootstrap / ipc），保留目录结构分别打包：
    // 相对导入（./bootstrap/run-daemon.js）才能在运行时解析到对应产物。
    entries: [
      "src/main.ts",
      "src/bootstrap/run-daemon.ts",
      "src/bootstrap/lock.ts",
      "src/bootstrap/config.ts",
      "src/ipc/server.ts",
      "src/ipc/client.ts",
    ],
    executable: "src/main.ts",
    deps: [
      "clock",
      "contracts",
      "ipc-contract",
      "platform",
      "product",
      "redaction-gateway",
      "secrets",
      "storage",
    ],
  },
];

// ── 第 1 步：类型检查
if (!skipTypecheck) {
  console.log("▶ 类型检查（tsc --noEmit）");
  const check = spawnSync(
    process.execPath,
    [TSC, "-p", "tsconfig.dev.json", "--noEmit", "--pretty", "false"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (check.status !== 0) {
    console.error(check.stdout?.trim() ?? "");
    console.error("✗ 类型检查失败，已中止构建");
    process.exit(1);
  }
  console.log("  ✓ 通过");
}

const targets = only ? TARGETS.filter((t) => t.name === only) : TARGETS;
if (targets.length === 0) {
  console.error(`✗ 未找到目标 --only ${only}`);
  process.exit(1);
}

// ── 第 2、3 步：逐包打包 + 生成声明
let failed = 0;
for (const t of targets) {
  const dir = join(ROOT, t.dir);
  const outDir = join(dir, "dist");
  // entries 支持多入口（保留目录结构）；单入口的包仍用一个 index
  const entries = t.entries ?? [t.entry];
  const execEntry = t.executable ?? null;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 2a) 打包 JS
  // 单入口 → outfile（产物名规整：index.js / main.js）
  // 多入口 → outdir + outbase（保留 src 下的相对目录结构）
  const isMulti = entries.length > 1;
  try {
    await esbuildBuild({
      entryPoints: entries.map((e) => join(dir, e)),
      bundle: true,
      external: ["@aegis/*"], // 保留包边界：运行时由 node_modules 软链解析
      format: "esm",
      target: "node24",
      platform: "node",
      sourcemap: true,
      ...(isMulti
        ? { outdir: outDir, outbase: join(dir, "src") }
        : { outfile: join(outDir, t.entry === execEntry ? "main.js" : "index.js") }),
      logLevel: "silent",
    });
  } catch (e) {
    const detail =
      Array.isArray(e?.errors) && e.errors.length > 0
        ? e.errors
            .map((x) => `${x.text}${x.location ? ` @ ${x.location.file}:${x.location.line}` : ""}`)
            .join("; ")
        : String(e.message ?? e).split("\n")[0];
    console.error(`  ✗ ${t.name} 打包失败: ${detail}`);
    failed += 1;
    continue;
  }

  // 2b) 生成 .d.ts（exports.types 指向它）
  const paths = Object.fromEntries(t.deps.map((d) => [`@aegis/${d}`, [`packages/${d}/src/index.ts`]]));
  const tsconfigPath = join(tmpdir(), `aegis-types-${t.name}-${process.pid}.json`);
  writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        extends: join(ROOT, "tsconfig.base.json"),
        compilerOptions: {
          outDir,
          rootDir: join(dir, "src"),
          declaration: true,
          declarationMap: true,
          emitDeclarationOnly: true,
          noEmit: false, // 必须显式关掉（base/extends 可能带 noEmit）
          noCheck: true, // 类型正确性已由第 1 步保证
          baseUrl: ROOT,
          typeRoots: [join(ROOT, "node_modules", "@types")],
          ...(Object.keys(paths).length > 0 ? { paths } : {}),
        },
        include: [join(dir, "src/**/*.ts")],
        // 排除测试文件：相对 include 起点匹配，否则会产出 index.test.d.ts
        exclude: ["**/*.test.ts", "**/*.test.d.ts", join(dir, "src/**/*.test.ts")],
      },
      null,
      2,
    ),
  );
  const decl = spawnSync(process.execPath, [TSC, "-p", tsconfigPath, "--pretty", "false"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  rmSync(tsconfigPath, { force: true });
  if (decl.status !== 0) {
    console.error(`  ⚠ ${t.name} 声明生成失败（JS 已产出）：${(decl.stdout ?? "").trim().split("\n")[0]}`);
  }

  if (execEntry) {
    // 赋予可执行权限，配合 package.json 的 bin 使用。
    // 注意：不加 shebang banner —— 此环境下 banner 会多出一个空行，
    // 导致 "#!/usr/bin/env node" 落到第 2 行报语法错误（R0 踩到过）。
    try {
      const { chmodSync } = require("node:fs");
      const outName = execEntry.replace(/^src\//, "").replace(/\.ts$/, ".js");
      chmodSync(join(outDir, outName), 0o755);
    } catch {
      /* 权限设置失败不影响 node 直接运行 */
    }
  }
  const produced = entries.map((e) => e.replace(/^src\//, "").replace(/\.ts$/, ".js"));
  console.log(`  ✓ ${t.name} → ${t.dir}/dist/{${produced.join(", ")}} (+ .d.ts)`);
}

if (failed > 0) {
  console.error(`\n✗ 构建失败（${failed} 个目标）`);
  process.exit(1);
}
console.log(`\n✓ 构建完成（${targets.length} 个目标）`);
