#!/usr/bin/env node
/**
 * 迁移生成器：把 migrations/*.sql 内嵌为 TypeScript 模块。
 *
 * 为什么需要：daemon 用 esbuild 打包，**运行时读不到仓库里的 .sql 文件**。
 * 因此构建前必须把 SQL 内容内嵌进代码。
 *
 * 为什么同时产出 checksums.json（迁移锁）：
 *   约束是"迁移只增不改"。开发时手滑改了已发布的迁移，会导致：
 *     - 已装用户的库结构与新装用户不一致
 *     - 迁移表的 recorded checksum 与实际文件不匹配
 *   checksums.json 让这个错误在**提交前**就暴露，而不是在用户机器上。
 *   新增迁移时运行本脚本即可刷新锁文件。
 *
 * 用法：
 *   node tools/gen-migrations.mjs            生成（校验现有迁移未被修改）
 *   node tools/gen-migrations.mjs --force    生成并刷新锁文件（仅在新增迁移后使用）
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "packages", "storage", "migrations");
const OUT_TS = join(ROOT, "packages", "storage", "src", "migrations.generated.ts");
const LOCK_FILE = join(MIGRATIONS_DIR, "checksums.json");

const force = process.argv.includes("--force");

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error("✗ migrations/ 下没有 .sql 文件");
  process.exit(1);
}

/** 文件名形如 0001_init_scheduling.sql → id=1, name=init_scheduling */
function parseName(file) {
  const m = /^(\d{4})_(.+)\.sql$/.exec(file);
  if (!m) {
    console.error(`✗ 迁移文件名不符合 0001_name.sql 规范：${file}`);
    process.exit(1);
  }
  return { id: Number(m[1]), name: m[2] };
}

const entries = files.map((file) => {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const { id, name } = parseName(file);
  return { id, name, file, sql, checksum: createHash("sha256").update(sql, "utf8").digest("hex") };
});

// 检查 id 连续且唯一
for (let i = 0; i < entries.length; i++) {
  const expected = i + 1;
  if (entries[i].id !== expected) {
    console.error(`✗ 迁移 id 不连续：期望 ${expected}，实际 ${entries[i].id}（${entries[i].file}）`);
    process.exit(1);
  }
}

// ── 迁移锁校验（只增不改）
if (existsSync(LOCK_FILE) && !force) {
  const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
  const known = new Map(lock.migrations.map((m) => [m.name, m.checksum]));
  const changed = entries.filter((e) => known.has(e.name) && known.get(e.name) !== e.checksum);
  if (changed.length > 0) {
    console.error("✗ 检测到已发布迁移被修改（约束：迁移只增不改）：");
    for (const c of changed) {
      console.error(`  - ${c.file}`);
      console.error(`    已发布: ${known.get(c.name)}`);
      console.error(`    当前值: ${c.checksum}`);
    }
    console.error("\n正确做法：新增一个迁移文件（如 0003_xxx.sql），不要修改已发布的迁移。");
    console.error("若确认是误报，用 --force 刷新锁文件。");
    process.exit(1);
  }
}

// ── 生成 TS 模块
mkdirSync(dirname(OUT_TS), { recursive: true });
const body = entries
  .map(
    (e) => `  {
    id: ${e.id},
    name: ${JSON.stringify(e.name)},
    checksum: ${JSON.stringify(e.checksum)},
    sql: ${JSON.stringify(e.sql)},
  },`,
  )
  .join("\n");

writeFileSync(
  OUT_TS,
  `/**
 * ⚠️ 本文件由 tools/gen-migrations.mjs 生成，请勿手工编辑。
 * 源文件：packages/storage/migrations/*.sql
 * 重新生成：node tools/gen-migrations.mjs（新增迁移后加 --force）
 */

export interface Migration {
  /** 顺序 id，必须从 1 连续递增 */
  readonly id: number;
  readonly name: string;
  /** SQL 内容的 sha256，用于运行期校验（防止已应用迁移被改动） */
  readonly checksum: string;
  readonly sql: string;
}

/**
 * 全部迁移（内嵌 SQL）。
 *
 * ⚠️ 本常量由 \`tools/gen-migrations.mjs\` 从 \`migrations/*.sql\` 生成，**请勿手工编辑**。
 * 之所以内嵌而非运行时读文件：daemon 用 esbuild 打包，运行时读不到仓库里的 .sql。
 */
export const MIGRATIONS: readonly Migration[] = [
${body}
];
`,
  "utf8",
);

writeFileSync(
  LOCK_FILE,
  `${JSON.stringify(
    {
      note: "迁移锁：记录已发布迁移的 checksum。修改已发布迁移会被 tools/gen-migrations.mjs 拒绝。",
      migrations: entries.map((e) => ({ id: e.id, name: e.name, file: e.file, checksum: e.checksum })),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`✓ 已生成 ${entries.length} 个迁移 → packages/storage/src/migrations.generated.ts`);
for (const e of entries)
  console.log(`  ${String(e.id).padStart(4, "0")} ${e.name} (${e.checksum.slice(0, 12)}…)`);
