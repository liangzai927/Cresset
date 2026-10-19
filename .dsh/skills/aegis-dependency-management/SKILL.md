---
name: aegis-dependency-management
description: Aegis 的依赖与构建链规范。**新增/升级/移除任何 npm 依赖、调整构建脚本、遇到原生模块或打包问题时加载**。它规定依赖引入的门槛与审批流程、pnpm 11 的 allowBuilds 机制、esbuild 构建链的三步分工、以及原生模块（node:sqlite / sqlite-vec / 钥匙串）的实测约束。当你要 pnpm add、改 package.json、改 tools/build.mjs、或构建失败时，加载本技能。
---

# Aegis 依赖与构建链

## 1. 引入依赖的门槛（先问四个问题）

1. **能不引吗？** 标准库/已有包能覆盖就不引（例：存储层最终选了 Node 内置 `node:sqlite` 而非 `better-sqlite3`）
2. **它是不是原生模块？** 原生模块带来三平台打包与 ABI 风险（见 §4）
3. **它是否违反依赖方向？** 见 `aegis-project-layout` §3
4. **它的许可证能私有分发吗？**（D8 决策：私有起步）

**判断标准**：一个依赖的价值 = 它省下的代码量 ÷ （打包风险 + 供应链风险 + 升级维护成本）。
比值不明显就自己写。

## 2. 新增依赖的完整流程

```
1. 在**使用它的包**里声明（不要图省事放根目录）
   pnpm --filter @aegis/<pkg> add <dep>

2. 若是原生模块 → 在 pnpm-workspace.yaml 的 allowBuilds 里放行（见 §3）

3. 若引入新的工作区依赖边 → 同步四处（见 aegis-project-layout §5）：
   tools/check-boundaries.mjs（ALLOWED）
   tools/build.mjs（TARGETS 的 deps）
   tsconfig.dev.json（paths）
   pnpm install（让软链建立）

4. 改 tools/build.mjs 的 TARGETS（如果新增了包）

5. pnpm verify  ← 必须全绿

6. 提交：build(deps): 引入 xxx，用于 yyy
   body 里写清：为什么需要它、评估过哪些替代、是否原生模块
```

## 3. pnpm 11 的构建脚本放行（容易踩）

pnpm 11 **默认不执行依赖的构建脚本**（安全策略）。原生模块需要显式放行：

```yaml
# pnpm-workspace.yaml
allowBuilds:
  esbuild: true
```

**症状**：装完了但报 `Cannot find module .../binding.node` 或 `Ignored build scripts: xxx`。

**注意**：`onlyBuiltDependencies` 是旧字段，pnpm 11 用 `allowBuilds`。

另外：**不要在根 `package.json` 里写 `packageManager` 字段** —— 会触发 corepack 联网下载，
在受限环境下直接失败（R1 踩到过）。

## 4. 原生模块的实测结论（R0 spike）

| 模块 | 结论 | 理由 |
| --- | --- | --- |
| **`node:sqlite`** | ✅ **采用**（存储层） | 随 Node 运行时提供，**零原生依赖、无 Electron ABI 风险**；性能足够（1 万向量插入 36ms） |
| `better-sqlite3` | ❌ 不用 | pnpm 下 binding 常缺失，需额外构建配置；收益不抵风险 |
| `sqlite-vec` | ✅ 采用（M3 起） | 与主库同文件；需 `allowExtension`（约束 C-1）与 BigInt 主键（C-2） |
| 钥匙串 | ✅ 走系统 CLI | 不引原生模块；`security` 命令足够（约束 C-5/C-9） |

**关键协同**：daemon 随附**自己验证过的 Node 运行时**（D1 决策），于是 daemon + SQLite + FTS5 +
向量扩展全部来自同一份运行时，**打包时零原生编译**。

## 5. 构建链：三步分工（D7 决策，勿轻易改动）

```
① tsc -p tsconfig.dev.json --noEmit      类型检查（走 paths 指向源码，不依赖产物）
② esbuild（JS API）                       逐包打包，external: ["@aegis/*"] 保留包边界
③ tsc --emitDeclarationOnly --noCheck    生成 .d.ts（exports.types 指向它）
```

**为什么不用 `tsc -b`（项目引用）**：包的 `exports` 指向 `dist/`，而项目引用要求先有 `.d.ts` ——
鸡生蛋问题；且 tsc 不会因为 `references` 就把 `@aegis/contracts` 这类**包名**解析到被引用工程的产物。

**两个必须知道的细节**：

1. **daemon 产出 ESM 多入口**（`main.js` + `bootstrap/*.js` + `ipc/*.js`），保留 `src` 下的相对结构，
   因为源码里有相对导入（`./bootstrap/run-daemon.js`）。
   *历史*：曾用 CJS 单入口，后来因多源文件改为 ESM 多入口；ESM 下**不能加 shebang banner**
   （会被放到第 2 行导致语法错误）。
2. **单入口用 `outfile`，多入口用 `outdir`+`outbase`** —— esbuild 不允许两者同时给。

## 6. 构建失败排查表

| 报错 | 原因 | 解决 |
| --- | --- | --- |
| `Cannot use both "outfile" and "outdir"` | 单/多入口分支写错 | 检查 `tools/build.mjs` 的 `isMulti` |
| `SyntaxError: Invalid or unexpected token` 指向 shebang | ESM 下加了 banner | 去掉 banner（可执行性靠 `bin` + 权限） |
| `Cannot find module '@aegis/xxx'` | 漏了 `tsconfig.dev.json` 的 paths | 补 paths |
| `pnpm resolve` 报运行时导入失败 | 漏了 `pnpm install` 或漏声明依赖 | `pnpm install` + 检查 `dependencies` |
| `pnpm boundaries` 报未授权依赖 | 新依赖边未登记 | 改 `ALLOWED` 表 |
| `Top-level await is currently not supported` | 用了 CJS 格式但代码有 TLA | 用 ESM，或去掉 TLA（daemon 曾为此改过） |

## 7. 升级依赖的规矩

- **不追最新**：`pnpm outdated` 只作参考；升级要有明确理由（安全修复 / 需要的特性）
- **原生模块升级需在三个平台验证**（M8 之前至少在 macOS 上跑 `pnpm verify`）
- **主版本升级**必须单独提交，body 里写迁移说明
- **不要顺手升级**：升级与功能改动分开提交，便于二分定位

## 8. 当前依赖清单（保持精简）

| 依赖 | 用在哪 | 是否原生 |
| --- | --- | --- |
| `zod` | contracts / storage / daemon（校验） | 否 |
| `esbuild` | 构建（devDependency） | 否（有平台二进制但走 allowBuilds） |
| `typescript` / `vitest` / `biome` | 开发工具（devDependency） | 否 |
| `sqlite-vec` | 知识库向量检索（M3 起） | 是（预编译 .dylib/.so/.dll） |

**目标**：生产依赖控制在个位数。每引入一个都要能说清"不引它我要多写多少代码"。
