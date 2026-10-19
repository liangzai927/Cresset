---
name: aegis-commit-conventions
description: Aegis 项目的提交规范。**每次 git commit 之前都要加载**。它规定 Conventional Commits 的类型集合与选择标准、中文正文与页脚的写法、提交粒度（一个提交一件事）、禁止的提交信息、以及与 git hook 的联动。当你要把改动提交到版本库、写提交信息、拆分提交、或判断"这个改动该不该单独提交"时，加载本技能。
---

# Aegis 提交规范

## 1. 基本格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **`type`**：英文枚举（见 §2），必填
- **`scope`**：受影响的包/区域（见 §3），必填（除非改动跨全仓且无单一范围）
- **`subject`**：**中文**，一句话说清"做了什么"，不超过 50 字，结尾不加句号
- **`body`**：**中文**，说明**为什么**（不是重复 subject），每行不超过 72 字
- **`footer`**：关联 issue、破坏性变更（`BREAKING CHANGE:`）、共同作者等

示例：

```
feat(scheduler): 实现物化器，按唯一索引保证实例幂等

调度器需要为每个任务预生成未来 24 小时的触发实例。重复生成是常态
（每次 tick 都会跑一遍），因此幂等不能靠内存判断。

采用 `INSERT ... ON CONFLICT DO NOTHING` 配合唯一索引
uq_occurrence(task_id, scheduled_at)：依赖数据库裁决，而不是应用层状态。
这样即使进程崩溃重启、并发 tick、时钟跳变，也不会产生重复实例。

Refs: M0+M1详细设计 §6.2
```

## 2. type 集合（只用这九个）

| type | 用于 | 反例（不要这样用） |
| --- | --- | --- |
| `feat` | 新增用户可见能力 | 不要用它提交"加了个内部工具函数" |
| `fix` | 修复缺陷 | 不要用它提交"加了日志帮助排查" |
| `refactor` | 重构，**行为不变** | 重构同时改行为 → 拆成两个提交 |
| `perf` | 性能优化 | 不要用它提交"顺手清理" |
| `test` | 只改测试 | 改测试+改实现 → 拆开或归入 feat/fix |
| `docs` | 只改文档 | 代码里的注释算代码改动，归入对应 type |
| `build` | 构建脚本、依赖、工具链 | 加依赖同时用到了 → 至少 `build` + `feat` 两个提交 |
| `ci` | CI/门禁配置 | 本地 hook 脚本算 `build` 或 `ci`，选更贴切的 |
| `chore` | 其他杂项（版本号、忽略文件） | **不要拿它当"不知道归哪类"的垃圾桶** |

**没有 `wip`、`update`、`misc`、`临时`。** 一次提交必须能归类。

## 3. scope 取值（本仓库）

取 `packages/*` 或 `apps/*` 的短名；跨多个时用逗号或选主要受影响者：

```
clock  contracts  product  ipc-contract  storage  secrets  platform
redaction-gateway  daemon  scheduler  recurrence  notify  monitor
tools  docs  repo（仓库级：.gitignore / README / 规范本身）
```

## 4. 提交粒度：一个提交一件事

**判断标准**：能用一句话说清这个提交做了什么，且**回滚它不会连带回滚无关改动**。

| 场景 | 正确做法 |
| --- | --- |
| 修 bug 时顺手重构了代码 | 两个提交：`refactor` 先，`fix` 后（这样 fix 的 diff 干净可评审） |
| 加功能时发现类型定义要改 | 可合并为一个 `feat`（契约是功能的一部分） |
| 加依赖并立刻使用 | `build(deps): ...` + `feat(xxx): ...` 两个提交 |
| 改了三处的同类 bug | 一个 `fix`，body 里列出三处 |
| 格式化全仓 | 单独 `chore(repo): 全仓格式化`，绝不与其他改动混在一起 |

**禁止**：把"R1 的全部工作"塞进一个提交。R1 应当至少拆成 storage / secrets / bootstrap / ipc 等若干提交。

## 5. 禁止的提交信息

- ❌ `update`、`fix bug`、`修改`、`优化`（无信息量）
- ❌ `wip`、`temp`、`测试一下`
- ❌ 只写 `feat: xxx` 而没有 body，而改动涉及**非显然的取舍**（此时 body 是强制的）
- ❌ 全英文 subject（本项目要求中文；type/scope 保持英文）
- ❌ 一行超过 72 字（破坏 `git log` 可读性）
- ❌ 把 `BREAKING CHANGE` 混在 body 里（必须在 footer）

## 6. 什么时候必须在 body 里写理由

满足以下任一条，body **不可省略**：

1. 修改了已确立的约束或架构决策
2. 采用了反直觉的实现（如"为什么不用更自然的写法"）
3. 修复了一个不易复现的缺陷（要写清触发条件）
4. 引入了新的依赖、新的表、新的 IPC 方法
5. 有意识地**不做**某件事（要写明为什么现在不做）
6. 改动会影响已有用户数据（迁移、兼容性）

## 7. 破坏性变更

```
feat(storage)!: 移除 occurrence.legacy_state 列

该列在 0001 迁移中引入但从未被读取，且与 state 语义重叠。

BREAKING CHANGE: 升级后需运行一次数据迁移，旧版本无法读取新库。
迁移命令：aegis-daemon --migrate-legacy-state
```

`!` 标记 + footer 里的 `BREAKING CHANGE:` **两者都要有**。

## 8. 与 git hook 的联动（已落地）

仓库已配置 `commit-msg` hook（`tools/commit-msg-hook.mjs`），会机械校验：

- type 是否在九个允许值内
- 是否有 scope
- subject 是否为中文且 ≤ 50 字
- 是否为空提交信息或含被禁止的词（`update`/`wip`/`temp`）

安装方式（克隆仓库后执行一次）：

```bash
pnpm hooks:install
```

若要临时绕过（**不推荐**，且 PR 评审时应说明原因）：`git commit --no-verify`。

## 9. 提交前的固定动作

```bash
pnpm verify          # 必须全绿（门禁 → 类型 → 构建 → 解析 → lint → 测试）
git diff --cached    # 通读一遍暂存内容，确认没有误提交（dist/、*.db、凭据）
git status           # 确认没有遗漏未添加的新文件
```

特别检查：

- [ ] 没有提交 `dist/`、`node_modules/`、`*.db*`、`spike-artifacts/`
- [ ] 没有提交任何凭据、token、真实个人数据（测试数据必须是构造的）
- [ ] 新增文件已 `git add`（`git status` 看不到 `??` 残留）
