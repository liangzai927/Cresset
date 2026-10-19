#!/usr/bin/env node
/**
 * S2 —— SQLite 能力矩阵：FTS5（BM25）、sqlite-vec（向量）、中文检索可用性
 *
 * 验证 D3（BM25 起步）+ D4（sqlite-vec 同库）。
 *
 * ⚠️ 本探针踩到并修正的四个真实坑（均已写入结论，供 M3 实现直接复用）：
 *   1. node:sqlite 的扩展加载必须在**建库时**用 { allowExtension: true } 开启；
 *      事后调 enableLoadExtension() 会报 "disabled at database creation"。
 *   2. node:sqlite **把所有 JS number 绑定为 REAL**，而 vec0 要求主键是 INTEGER
 *      → 必须用 BigInt（例如 1n）；用 1 会报 "Only integers are allows for primary key values"。
 *   3. FTS5 默认 unicode61 把连续 CJK 当作**一个 token**（"磁盘" 匹配不到 "磁盘告警"）；
 *      实测 trigram 反而更差（3/10），**CJK 单字切分可达 10/10**。
 *   4. FTS5 的 MATCH 中空格 = AND，不是 OR（写探针时极易搞错，会得出完全错误的结论）。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ARTIFACTS = process.env.SPIKE_ARTIFACTS ?? resolve(import.meta.dirname, "../../spike-artifacts");
// ⚠️ 关键：安装目录必须放在**仓库之外**。
// 若放在仓库内，pnpm 会向上找到仓库的 pnpm-lock.yaml / node_modules，
// 导致 "node_modules was installed with a different major version of pnpm" 之类的偶发失败。
const STAGE = join(tmpdir(), `aegis-spike-s2-${process.pid}`);
const RESULT_COPY = join(ARTIFACTS, "s2");
const evidence = [];
const log = (s) => evidence.push(s);

/** 统一出口：清理临时安装目录后输出结论（避免在 tmp 留下 node_modules 垃圾） */
const emit = (status, detail, metrics = {}) => {
  // 留一份可复现的探针副本（临时目录会被清理掉）
  try {
    mkdirSync(RESULT_COPY, { recursive: true });
    copyFileSync(new URL(import.meta.url), join(RESULT_COPY, "s2-sqlite-vec.mjs"));
    writeFileSync(
      join(RESULT_COPY, "README.txt"),
      `本目录由 tools/spikes/s2-sqlite-vec.mjs 生成（可复现副本）。\n` +
        `真实的 pnpm 安装与执行发生在仓库之外的临时目录：${STAGE}\n` +
        `之所以放在仓库外：仓库内的 pnpm 工作区会继承 lockfile/node_modules，\n` +
        `导致 "installed with a different major version of pnpm" 之类的偶发失败。\n` +
        `复现：node tools/spikes/s2-sqlite-vec.mjs\n`,
    );
  } catch {
    /* 留存失败不影响结论 */
  }
  try {
    rmSync(STAGE, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
  console.log(JSON.stringify({ status, detail, evidence, metrics }));
};

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const reach = (() => {
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      "fetch('https://registry.npmjs.org/sqlite-vec',{method:'HEAD'}).then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log('ERR');process.exit(0)})",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  return (r.stdout ?? "").trim();
})();
log(`npm registry：${reach === "ERR" ? "不可达" : `HTTP ${reach}`}`);
if (reach === "ERR") {
  emit("blocked", "无网络：无法安装 sqlite-vec，本项无法验证");
  process.exit(0);
}

writeFileSync(
  join(STAGE, "package.json"),
  JSON.stringify({ name: "s2-probe", private: true, type: "module" }, null, 2),
);
const inst = spawnSync(
  process.execPath,
  [process.env.PNPM_JS ?? "pnpm", "add", "--reporter=append-only", "sqlite-vec@^0.1"],
  { cwd: STAGE, encoding: "utf8", timeout: 300_000 },
);
if ((inst.stdout ?? "").trim()) log(`安装输出：${(inst.stdout ?? "").trim().split("\n").slice(-1)[0]}`);
if (!existsSync(join(STAGE, "node_modules", "sqlite-vec"))) {
  emit("fail", "sqlite-vec 安装失败", { stderr: (inst.stderr ?? "").slice(0, 200) });
  process.exit(0);
}

const probe = join(STAGE, "probe.mjs");
writeFileSync(
  probe,
  `
const out = { errors: [] };
const vec = await import("sqlite-vec");
out.vecPath = vec.getLoadablePath?.() ?? vec.default?.getLoadablePath?.() ?? null;
const { DatabaseSync } = await import("node:sqlite");

const DIM = 32;
const mk = (seed) => Float32Array.from({ length: DIM }, (_, i) => Math.sin(seed * (i + 1)));

// ── A. node:sqlite + vec0 KNN（主键必须用 BigInt）
try {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  db.enableLoadExtension(true);
  db.loadExtension(out.vecPath);
  const ver = db.prepare("select vec_version() v, sqlite_version() s").get();
  db.exec("create virtual table vt using vec0(embedding float[" + DIM + "])");
  const ins = db.prepare("insert into vt(rowid, embedding) values (?, ?)");
  for (let i = 1; i <= 200; i++) ins.run(BigInt(i), mk(i));   // ★ BigInt 是关键
  const q = db.prepare("select rowid, distance from vt where embedding match ? order by distance limit 3").all(mk(42));
  out.knn = { vecVersion: ver.v, sqliteVersion: ver.s, top3: q.map((r) => Number(r.rowid)), top1Distance: q[0]?.distance ?? null };
  // 规模与延迟：1 万条 KNN 用时
  db.exec("create virtual table big using vec0(embedding float[" + DIM + "])");
  const ins2 = db.prepare("insert into big(rowid, embedding) values (?, ?)");
  const t0 = performance.now();
  db.exec("begin");
  for (let i = 1; i <= 10000; i++) ins2.run(BigInt(i), mk(i % 500));
  db.exec("commit");
  const tInsert = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 100; i++) db.prepare("select rowid from big where embedding match ? order by distance limit 10").all(mk(i));
  const tQuery = (performance.now() - t1) / 100;
  out.scale = { rows: 10000, insertMs: Math.round(tInsert), avgKnnMs: Number(tQuery.toFixed(3)) };
  db.close();
} catch (e) { out.errors.push("vec0 KNN: " + String(e).split("\\n")[0]); }

// ── B. 无虚拟表兜底：vec_distance_L2 暴力比较
try {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  db.enableLoadExtension(true);
  db.loadExtension(out.vecPath);
  db.exec("create table bf(id integer primary key, embedding blob)");
  const ins = db.prepare("insert into bf(id, embedding) values (?, ?)");
  for (let i = 1; i <= 50; i++) ins.run(i, Buffer.from(mk(i).buffer));
  const r = db.prepare("select id, vec_distance_L2(embedding, ?) d from bf order by d limit 3").all(Buffer.from(mk(10).buffer));
  out.bruteForce = { top3: r.map((x) => x.id), top1Distance: Number(r[0].d.toFixed(4)) };
  db.close();
} catch (e) { out.errors.push("vec_distance_L2: " + String(e).split("\\n")[0]); }

// ── C. FTS5 中文检索策略对比（D3 的真正前提）
const docs = [
  ["磁盘告警", "D 盘空间不足，请及时清理"],
  ["站会", "每周一上午十点，产品评审"],
  ["周报", "每周五下班前提交给组长"],
];
const queries = ["磁盘", "磁盘告警", "站会", "空间不足", "周报", "每周", "产品评审", "组长", "D盘", "清理", "提交"];
const seg = (s) => s.replace(/([\\u4e00-\\u9fff])/g, " $1 ").replace(/\\s+/g, " ").trim();
const segBigram = (s) => {
  const t = s.match(/[\\u4e00-\\u9fff]+/g) ?? [];
  const parts = [];
  for (const run of t) for (let i = 0; i < run.length - 1; i++) parts.push(run.slice(i, i + 2));
  return parts.length ? parts.join(" ") : s;
};

function evaluate(name, createSql, transform) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(createSql);
  } catch (e) {
    db.close();
    return { name, available: false, error: String(e).split("\\n")[0] };
  }
  for (const [t, b] of docs) db.prepare("insert into f(title, body) values (?, ?)").run(transform(t), transform(b));
  const hits = {};
  for (const q of queries) {
    let r = [];
    try {
      r = db.prepare("select title from f where f match ? order by bm25(f) limit 1").all(transform(q));
    } catch { /* 查询语法错误视为未命中 */ }
    hits[q] = r.length ? r[0].title : null;
  }
  db.close();
  const n = Object.values(hits).filter(Boolean).length;
  return { name, available: true, hits, hitCount: n, hitRate: Number((n / queries.length).toFixed(2)) };
}

out.fts = [
  evaluate("unicode61 原样", "create virtual table f using fts5(title, body)", (s) => s),
  evaluate("trigram", "create virtual table f using fts5(title, body, tokenize=trigram)", (s) => s),
  evaluate("CJK 单字切分", "create virtual table f using fts5(title, body)", seg),
  evaluate("CJK bigram", "create virtual table f using fts5(title, body)", segBigram),
];
out.queries = queries;
out.docs = docs;

console.log(JSON.stringify(out));
`,
);

const run = spawnSync(process.execPath, [probe], { cwd: STAGE, encoding: "utf8", timeout: 180_000 });
let out;
try {
  out = JSON.parse((run.stdout ?? "").trim().split("\n").pop());
} catch {
  emit("fail", `探针未产出结论（exit=${run.status}）`, { stderr: (run.stderr ?? "").slice(0, 400) });
  process.exit(0);
}
for (const e of out.errors ?? []) log(`错误：${e}`);
if (out.vecPath) log(`sqlite-vec 扩展：${out.vecPath}`);

const knn = out.knn;
log(
  `A. node:sqlite + vec0 KNN：${knn ? `可用（sqlite ${knn.sqliteVersion} / vec ${knn.vecVersion}；Top3=[${knn.top3.join(", ")}]，Top1 距离 ${knn.top1Distance}）` : "不可用"}`,
);
if (out.scale)
  log(`   规模与延迟：1 万条向量插入 ${out.scale.insertMs}ms，KNN Top10 平均 ${out.scale.avgKnnMs}ms`);
log(
  `B. 无虚拟表兜底 vec_distance_L2：${out.bruteForce ? `可用（Top3=[${out.bruteForce.top3.join(", ")}]）` : "不可用"}`,
);

log(`C. 中文检索策略对比（${out.queries.length} 个查询，3 篇文档）：`);
let best = null;
for (const s of out.fts ?? []) {
  if (!s.available) {
    log(`   ${s.name.padEnd(16)} 不可用：${s.error}`);
    continue;
  }
  log(`   ${s.name.padEnd(16)} ${s.hitCount}/${out.queries.length}（${(s.hitRate * 100).toFixed(0)}%）`);
  if (!best || s.hitCount > best.hitCount) best = s;
}
if (best) {
  const misses = out.queries.filter((q) => !best.hits[q]);
  log(`   最佳策略：${best.name}${misses.length ? `，未命中：${misses.join("、")}` : "（全覆盖）"}`);
}

const vecOk = Boolean(out.knn) || Boolean(out.bruteForce);
const ftsOk = best && best.hitCount > 0;
const zhGood = best && best.hitRate >= 0.9;

let status = "fail";
let detail;
if (vecOk && ftsOk && zhGood) {
  status = "pass";
  detail = `向量与全文检索均可用（首选 node:sqlite + sqlite-vec，主键须用 BigInt）；中文检索最佳策略为「${best.name}」（${best.hitCount}/${out.queries.length}）`;
} else if (vecOk && ftsOk) {
  status = "pass";
  detail = `能力可用但中文检索未达预期（最佳「${best.name}」${best.hitCount}/${out.queries.length}）：M3 需引入分词层或换检索方案`;
} else {
  detail = "FTS5 或向量能力不满足：检索方案需重选";
}

emit(status, detail, {
  vecKnn: Boolean(out.knn),
  vecBruteForce: Boolean(out.bruteForce),
  ftsBest: best?.name ?? null,
  ftsBestHitRate: best?.hitRate ?? 0,
  knnAvgMs: out.scale?.avgKnnMs ?? null,
});
