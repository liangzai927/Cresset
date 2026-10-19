#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * 工作区依赖解析门禁
 *
 * 验证每个包**声明**的 @aegis/* 依赖都能被运行时真正导入。
 * 为什么需要：打包用 `external: ["@aegis/*"]` 保留包边界，依赖解析完全交给
 * node_modules 软链 + package.json 的 exports。一旦 exports 路径写错、软链缺失、
 * 或忘记声明依赖，**类型检查能过、构建能过，但运行时会崩** —— 这类问题只有真
 * 正 import 一次才能发现。
 *
 * 用法：node tools/check-resolve.mjs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const groups = ["packages", "apps"];
const failures = [];

for (const g of groups) {
  const base = join(ROOT, g);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const pkgDir = join(base, name);
    if (!existsSync(join(pkgDir, "package.json"))) continue;

    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const deps = Object.keys(manifest.dependencies ?? {}).filter((d) => d.startsWith("@aegis/"));

    if (deps.length === 0) {
      console.log(`  · ${manifest.name.padEnd(24)} （无工作区依赖）`);
      continue;
    }

    const bad = [];
    for (const d of deps) {
      // 关键：cwd 必须是该包目录，解析才从它自己的 node_modules 开始
      const r = spawnSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(d)}).then(()=>process.exit(0)).catch(()=>process.exit(1))`],
        { cwd: pkgDir, encoding: "utf8" },
      );
      if (r.status !== 0) bad.push(d);
    }
    if (bad.length > 0) failures.push(`${manifest.name}: ${bad.join(", ")}`);

    console.log(
      `  ${bad.length === 0 ? "✓" : "✗"} ${manifest.name.padEnd(24)} ${deps.length - bad.length}/${deps.length} 运行时导入成功` +
        (bad.length > 0 ? `  失败: ${bad.join(", ")}` : ""),
    );
  }
}

if (failures.length > 0) {
  console.error(`\n✗ 工作区依赖解析失败（${failures.length} 个包）：`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\n排查方向：package.json 的 exports 路径是否正确、是否已运行 pnpm install、是否漏声明依赖。",
  );
  process.exit(1);
}
console.log("\n✓ 所有声明的工作区依赖都可被运行时导入");
