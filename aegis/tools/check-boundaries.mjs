#!/usr/bin/env node
/**
 * 依赖方向门禁（架构基线：《技术选型与架构设计》§6.2）
 *
 * 规则：
 *  1. 只允许白名单内的包间依赖；未声明的依赖 = 违规（防"悄悄 import"）。
 *  2. packages/* 不得依赖 apps/*（内核不得反向依赖应用）。
 *  3. 除 redaction-gateway 外，任何包不得依赖 model-provider（M3 起生效，先把规则挂上）。
 *  4. 不得引入裸的模型/HTTP SDK 作为依赖（防绕过网关直连模型）。
 *
 * 用法：node tools/check-boundaries.mjs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** 允许的包间依赖（架构基线，改动需同步文档 §6.2） */
const ALLOWED = {
  "@aegis/clock": [],
  "@aegis/product": [],
  "@aegis/contracts": [],
  "@aegis/ipc-contract": ["@aegis/contracts"],
  "@aegis/recurrence": ["@aegis/clock", "@aegis/contracts"],
  "@aegis/skills": ["@aegis/contracts"],
  "@aegis/monitors": ["@aegis/clock"],
  "@aegis/scheduler": [
    "@aegis/clock",
    "@aegis/contracts",
    "@aegis/platform",
    "@aegis/recurrence",
    "@aegis/storage",
  ],
  "@aegis/storage": ["@aegis/clock", "@aegis/contracts", "@aegis/product"],
  "@aegis/secrets": ["@aegis/contracts", "@aegis/product"],
  "@aegis/platform": ["@aegis/clock", "@aegis/contracts"],
  "@aegis/redaction-gateway": ["@aegis/contracts", "@aegis/model-provider"],
  "@aegis/model-provider": ["@aegis/contracts"],
  "@aegis/daemon": [
    "@aegis/clock",
    "@aegis/contracts",
    "@aegis/product",
    "@aegis/ipc-contract",
    "@aegis/platform",
    "@aegis/redaction-gateway",
    "@aegis/secrets",
    "@aegis/storage",
    "@aegis/scheduler",
    "@aegis/recurrence",
    "@aegis/monitors",
    "@aegis/skills",
  ],
  // 桌面外壳：需要直接连 daemon 的 IPC 客户端（token 只留在主进程）、
  // 需要 platform 的渠道探测与通道发现、需要 product 的数据目录解析。
  // clock 用于监督者的重启退避（测试注入 VirtualClock，禁止裸 Date.now）。
  // 注意这里**不允许**依赖 scheduler/storage —— 界面不该直接碰数据库。
  "@aegis/desktop": [
    "@aegis/clock",
    "@aegis/contracts",
    "@aegis/daemon",
    "@aegis/ipc-contract",
    "@aegis/platform",
    "@aegis/product",
  ],
  "@aegis/ui": ["@aegis/ipc-contract", "@aegis/contracts"],
};

/** 禁止作为直接依赖的模型 SDK（必须经 redaction-gateway） */
const FORBIDDEN_DEPS = ["openai", "@anthropic-ai/sdk", "@google/generative-ai", "ollama", "ai"];

const errors = [];
const notes = [];

function listPackages() {
  const out = [];
  for (const group of ["packages", "apps", "tools"]) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const manifest = join(dir, name.name, "package.json");
      if (!existsSync(manifest)) continue;
      out.push({ group, dirName: name.name, manifest });
    }
  }
  return out;
}

const pkgs = listPackages().map((p) => {
  const json = JSON.parse(readFileSync(p.manifest, "utf8"));
  return { ...p, name: json.name, deps: { ...(json.dependencies ?? {}), ...(json.peerDependencies ?? {}) } };
});

const byName = new Map(pkgs.map((p) => [p.name, p]));

for (const pkg of pkgs) {
  const allowed = ALLOWED[pkg.name];
  if (!allowed) {
    notes.push(
      `未在门禁表中登记的工作区包：${pkg.name}（若新增包，请同步 tools/check-boundaries.mjs 与架构文档）`,
    );
    continue;
  }
  for (const dep of Object.keys(pkg.deps)) {
    const isWorkspacePkg = dep.startsWith("@aegis/");
    if (isWorkspacePkg && !allowed.includes(dep)) {
      errors.push(`${pkg.name} 依赖了未授权的内部包 ${dep}（允许：${allowed.join(", ") || "无"}）`);
      continue;
    }
    if (FORBIDDEN_DEPS.includes(dep)) {
      errors.push(`${pkg.name} 直接依赖模型 SDK "${dep}"：必须经 @aegis/redaction-gateway（C3 零绕过）`);
    }
    // 规则 2：packages/* 不得依赖 apps/*
    if (pkg.group === "packages" && isWorkspacePkg) {
      const target = byName.get(dep);
      if (target?.group === "apps") {
        errors.push(`${pkg.name}（packages）反向依赖了 ${dep}（apps）：内核不得依赖应用`);
      }
    }
  }
  // 规则 3：只有网关可依赖 model-provider
  if (pkg.deps["@aegis/model-provider"] && pkg.name !== "@aegis/redaction-gateway") {
    errors.push(`${pkg.name} 依赖 model-provider：仅 @aegis/redaction-gateway 允许（C3 唯一出口）`);
  }
}

for (const n of notes) console.log(`  • 提示：${n}`);

if (errors.length > 0) {
  console.error(`\n✗ 依赖方向门禁失败（${errors.length} 项）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`✓ 依赖方向门禁通过（检查了 ${pkgs.length} 个工作区包）`);
