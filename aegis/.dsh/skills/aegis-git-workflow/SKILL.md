---
name: aegis-git-workflow
description: Aegis 的 Git 工作流与提交前检查规范。**初始化仓库、创建分支、准备提交、跑检查、或发布版本时加载**。它规定分支模型、提交前的固定动作（pnpm verify 全绿）、hook 安装、以及"发现已提交内容有问题"时的补救方式。当你要 git init / git commit / git branch / 准备交付时，加载本技能。
---

# Aegis Git 工作流

## 1. 仓库现状与初始化

仓库根目录是 `/Users/liuwenliang/lwl/Cresset`，Aegis 代码在 `aegis/`。
旧路径 `/Users/liuwenliang/lwl/ai/aegis` 是历史 checkout，不要再从那里提交或启动 daemon。

```bash
cd /Users/liuwenliang/lwl/Cresset
git status                    # 根仓库是唯一真相源
# 如果尚未初始化才执行 git init；当前仓库已存在
git add -A
git commit -m "chore(repo): 初始化仓库，固化 R0+R1 基线"
pnpm hooks:install      # 安装 commit-msg hook（克隆后必须执行一次）
```

`.gitignore` 已就绪，忽略：`node_modules/`、`dist/`、`*.tsbuildinfo`、`spike-artifacts/`、
`.aegis-data/`、`*.db*`、`*.log`、`.DS_Store`。

**提交前必须确认没有被忽略但仍需纳入的文件**（如新增的 `tools/*.mjs`）。

### 1.1 ⚠️ 嵌套 `aegis/.git` 是历史残留

当前工作区的 `aegis/.git` 是一个**没有 remote 的旧嵌套仓库**，不跟踪当前工作。
唯一真相源是 `/Users/liuwenliang/lwl/Cresset/.git`。

- 不要在 `aegis/` 下执行 `git commit` / `git push`；
- 需要提交时先 `cd /Users/liuwenliang/lwl/Cresset`；
- 看到 `git -C aegis status` 有大量修改时，不要慌：那只是旧仓库与新根仓库的差异。

`pnpm hooks:install` 现在会把 hook 安装到**根仓库** `.git/hooks/`；
根 pre-commit 会先跑 `aegis/tools/check-single-repo.mjs`，发现嵌套 `.git` 直接拒绝提交。
`pnpm verify` 也会跑 `repo:check`，所以 `--no-verify` 之外没有静默通道。

## 2. 分支模型（单人项目，保持简单）

| 分支 | 用途 |
| --- | --- |
| `main` | 始终可构建、可运行；每个提交都应通过 `pnpm verify` |
| `feat/<topic>` | 较大改动（跨多个提交）时用；完成后合并回 `main` |

**单人项目不做 GitFlow。** 但有一条硬规则：

> **`main` 上的每个提交都必须能通过 `pnpm verify`。**
> 不允许"为了保存进度"提交一个红的树 —— 那样就失去了"任何提交都可回退到可用状态"的价值。

需要中途保存进度时，用 `git stash` 或临时分支，而不是在 `main` 上提交未完成的东西。

## 3. 提交前的固定动作（不可省略）

```bash
pnpm verify                  # ① 必须全绿
git status                   # ② 确认没有 ?? 残留（新文件忘了 add）
git diff --cached            # ③ 通读暂存内容
```

### 3.1 `pnpm verify` 具体跑什么

```
boundaries  → 依赖方向门禁（含"只有网关可依赖 model-provider"）
comments    → 注释门禁（导出符号必须有 JSDoc + 文件头注释）
typecheck   → tsc --noEmit（走 paths，不依赖产物）
build       → 类型检查 → esbuild 打包 → 生成 .d.ts
resolve     → 工作区依赖可被运行时导入（软链 + exports 是否有效）
lint        → Biome
test        → Vitest
```

**顺序有意义**：`build` 必须在 `resolve` 之前（解析门禁检查的是**产物**能否被导入）。

### 3.2 第 ③ 步要重点看什么

- [ ] 没有 `dist/`、`node_modules/`、`*.db*`、`spike-artifacts/`
- [ ] 没有凭据、token、真实个人数据（测试数据必须是构造的）
- [ ] 迁移文件：**新增**的文件才该出现，已发布的迁移不应出现在 diff 里
- [ ] 提交信息符合 `aegis-commit-conventions`

## 4. Commit-msg hook

安装：`pnpm hooks:install`（把 `tools/commit-msg-hook.mjs` 链接到 `.git/hooks/commit-msg`）。

校验内容：

- type ∈ {feat, fix, refactor, perf, test, docs, build, ci, chore}
- 必须有 scope
- subject 为中文且 ≤ 50 字
- 禁止 `update` / `wip` / `temp` / `修改` / `优化` 这类无信息量信息
- body 每行 ≤ 72 字

绕过（**不推荐**，且需在 code review 时说明）：`git commit --no-verify`。
若 hook 误判，应当**改 hook 的判断逻辑并提交**，而不是习惯性绕过。

## 5. 提交粒度

见 `aegis-commit-conventions` §4。核心原则：**能用一句话说清，且回滚它不连带无关改动**。

对里程碑工作（如 R2），预期拆成：

```
feat(recurrence): 实现 RRULE 子集求解器
test(recurrence): 补齐 DST 与小月跳过的用例
feat(scheduler): 实现物化器（唯一索引保证幂等）
feat(scheduler): 实现派发器（影响行数裁决 + 补偿窗口）
feat(scheduler): 实现 Outbox 投递与渠道降级
feat(notify): 接入 macOS 原生通知与 osascript 兜底
docs(scheduler): 更新详细设计 §6 的状态机说明
```

**不要**一个 `feat: R2 完成` 提交。那样 code review 无从下手，出问题时也无法定点回滚。

## 6. 发现已提交内容有问题时的补救

| 情况 | 做法 |
| --- | --- |
| 提交信息写错，**尚未推送** | `git commit --amend` |
| 提交信息写错，**已推送** | `git revert` + 新提交（不要改写已推送历史） |
| 漏了文件，尚未推送 | `git add <file>` + `git commit --amend` |
| 误提交了凭据 | **① 立即轮换该凭据** ② 从历史中移除 ③ 记录到 issue。**只删文件不够** |
| 误提交了大文件（如 spike-artifacts） | `git rm -r --cached <path>` + 提交；若已推送则需 `filter-repo` |
| 提交了一个红树 | 立即补一个 `fix` 让它变绿，并在 body 说明 |

## 7. 标签与版本

| 时机 | 动作 |
| --- | --- |
| 里程碑验收通过（如 R1 全绿 + 端到端验收） | `git tag -a r1 -m "R1 运行时基础完成"` |
| 破坏性变更 | 提升 major；在 tag message 里写迁移步骤 |

版本号约定：daemon 的 `DAEMON_VERSION` 与里程碑对应（如 `0.1.0-r1`、`0.2.0-r2`），
在 `apps/daemon/src/bootstrap/run-daemon.ts` 里维护，发 tag 时同步。

## 8. 与 DSH 工作区的关系（当前环境特有）

Git 根目录是 `/Users/liuwenliang/lwl/Cresset`，而 DSH 的文件沙箱锚定在会话工作区。
如果会话工作区不是这个目录，**每次写文件都需要用户授权**。

**建议**：把 DSH 会话工作区切到 `/Users/liuwenliang/lwl/Cresset`，之后无需反复授权。

若必须在当前工作区外操作，把批量改动**先暂存在工作区内，最后一次 `mv` 搬入**，
避免每个文件触发一次审批。
