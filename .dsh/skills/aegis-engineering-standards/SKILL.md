---
name: aegis-engineering-standards
description: Aegis 项目的工程总纲。**任何**在本仓库里写代码、改代码、加文件、做重构、审查代码或准备提交之前，都应当先加载本技能。它规定分层与依赖方向、命名、注释（中文详细）、错误处理、验证流程与禁止事项。当你不确定"这个改动该放在哪个包"、"要不要加注释"、"提交前要跑什么"时，也加载本技能。
---

# Aegis 工程总纲

本项目是一个 **24 小时常驻的桌面 Agent**。它与普通应用最大的区别是：

> **它要在无人看管的情况下连续运行数月。** 因此本项目的规范不是"风格偏好"，而是**可靠性的组成部分**。
> 一条丢失的注释、一个被吞掉的异常、一次未声明的依赖，都会在凌晨三点变成一次静默失败。

## 0. 十条不可违背的规则（违反即返工）

1. **不写注释的代码视为未完成。** 每个导出符号必须有中文文档注释（见 `aegis-comment-and-docs`）。
2. **禁止吞异常。** 捕获后必须：记录日志 / 转成领域错误 / 显式返回错误结果。空 `catch {}` 只允许出现在清理路径，且必须写明理由（见 `aegis-error-handling`）。
3. **禁止绕过依赖方向。** 包间依赖受 `pnpm boundaries` 机械校验（见 `aegis-project-layout`）。
4. **禁止绕过脱敏网关外发。** 任何模型/网络调用必须经 `@aegis/redaction-gateway`（见 `aegis-security-boundaries`）。
5. **禁止直接使用 `Date.now()` / `new Date()`。** 一律走注入的 `Clock`（见 `aegis-testing-standards` 与 NFR-M1）。
6. **禁止在数据库写入前不校验。** 输入先过 Zod，再落库（见 `aegis-data-and-migrations`）。
7. **禁止修改已发布的迁移文件。** 只能新增迁移（见 `aegis-data-and-migrations`）。
8. **禁止硬编码产品名、路径、label、钥匙串 service。** 一律从 `@aegis/product` 读取。
9. **提交信息必须符合 Conventional Commits 且正文为中文**（见 `aegis-commit-conventions`），由 git hook 机械校验。
10. **提交前必须 `pnpm verify` 全绿。** 不允许"先提交，回头再修"。

## 1. 改动前的四步自检

在写第一行代码之前，先回答这四个问题：

| # | 问题 | 如果答案是"不确定" |
| --- | --- | --- |
| 1 | 这个改动属于哪一层/哪个包？ | 先读 `aegis-project-layout` |
| 2 | 它会不会破坏已确立的约束（C-1…C-9）？ | 读 `README.md` 的"已确立的关键技术事实" |
| 3 | 它怎么被验证？有可自动化的判据吗？ | 读 `aegis-testing-standards`；没有判据就先设计判据 |
| 4 | 它失败时会怎样？用户能看见吗？ | 读 `aegis-error-handling`；"静默失败"是本项目的头号缺陷类型 |

## 2. 本项目的"可靠性优先"取向（决定了大量取舍）

当两个方案冲突时，按以下优先级裁决，**不要凭个人偏好**：

```
可靠性 > 可测试性 > 可读性 > 简洁性 > 性能 > 开发速度
```

具体体现（都是已经落地的决策，不要"顺手优化"掉）：

| 决策 | 为什么不能简化 |
| --- | --- |
| 幂等由**数据库唯一索引 + 影响行数**裁决，不靠内存标志 | 进程崩溃/并发/时钟跳变下，内存状态不可信 |
| 时间全部走注入的 `Clock` | 否则"30 天不漏报"只能真等 30 天，无法验证 |
| 迁移带 checksum 锁 | 否则已装用户的库结构与新装用户不一致 |
| 脱敏网关是唯一出口且 fail-closed | 一次明文外发不可撤销 |
| 派发不确定时用 `unknown` 状态显式暴露 | 宁可问用户一次，也不假装确定 |
| 依赖方向由 CI 机械校验 | 靠自觉的架构约束平均存活不超过两个月 |

## 3. 代码组织的最小单元

一个典型改动应当**同时**包含这四样，缺一即视为未完成：

```
1. 实现（src/xxx.ts）        —— 带中文文档注释
2. 测试（src/xxx.test.ts）   —— 覆盖正常路径 + 至少一个边界/失败路径
3. 契约（如涉及跨包/跨进程）  —— Zod schema（@aegis/contracts 或 ipc-contract）
4. 文档（如涉及约定/决策）    —— README 或对应 .md 的更新
```

## 4. 命名约定

| 对象 | 约定 | 示例 |
| --- | --- | --- |
| 包 | `@aegis/<kebab-case>` | `@aegis/redaction-gateway` |
| 文件 | `kebab-case.ts` | `task-dao.ts`、`run-daemon.ts` |
| 类型/接口 | `PascalCase`，接口不加 `I` 前缀 | `SecretStore`、`OccurrenceDao` |
| 函数/变量 | `camelCase` | `insertIgnore`、`catchupWindowS` |
| 常量 | `SCREAMING_SNAKE_CASE` | `DAEMON_LABEL`、`UDS_PATH_LIMIT` |
| 数据库表/列 | `snake_case` | `occurrence`、`scheduled_at` |
| Zod schema | `<Name>Schema` | `TaskSchema`、`CreateTaskInputSchema` |
| 布尔字段 | 用 `is/has/can/should` 或过去分词 | `enabled`、`staleLockRecovered` |
| 时间字段 | 后缀表意：`At`=时刻、`S`=秒、`Ms`=毫秒 | `scheduledAt`、`catchupWindowS`、`tickMs` |

**禁止**：`data`、`info`、`temp`、`obj`、`handle`、`utils`、`helpers` 这类无语义命名（除非作用域极小且语境明确）。

## 5. 函数与模块的规模上限

这些不是硬性红线，而是"看到就该停下来想"的信号：

| 信号 | 阈值 | 处理 |
| --- | --- | --- |
| 单函数长度 | > 60 行 | 抽出命名子步骤；若是一个流程，写成多个私有方法 |
| 嵌套深度 | > 3 层 | 用卫语句（early return）压平 |
| 参数个数 | > 4 个 | 收成 options 对象（已有先例：`OpenDbOptions`） |
| 单文件长度 | > 500 行 | 按职责拆分（DAO 按实体拆、worker 按阶段拆） |
| 导出符号 | > 15 个/文件 | 检查是否混了多个职责 |

## 6. 禁止事项清单（本项目的"反模式"）

- ❌ 用 `any`（`noExplicitAny: error` 已由 Biome 强制）；确需未知类型用 `unknown` + 收窄
- ❌ 用非空断言 `!`（已由 Biome 强制禁止）；改用显式检查或 `requireXxx()` 助手
- ❌ 用 `as` 断言绕过类型（行映射用 `rowsOf/rowOf` 助手，见 `packages/storage/src/rows.ts`）
- ❌ 在库代码里 `console.log`（用结构化日志回调）
- ❌ 把凭据写进日志、审计、数据库或命令行参数
- ❌ 在 `packages/*` 里依赖 `apps/*`（反向依赖，CI 会失败）
- ❌ 新增依赖却不更新 `tools/check-boundaries.mjs`（门禁会失败）
- ❌ 静默失败：失败必须有日志、有状态、或对用户可见
- ❌ 提交 `dist/`、`node_modules/`、`*.db`、`spike-artifacts/`

## 7. 完工定义（Definition of Done）

一个改动只有满足全部条件才算完成：

- [ ] `pnpm verify` 全绿（门禁 → 类型 → 构建 → 解析 → lint → 测试）
- [ ] 新增/修改的每个导出符号都有中文文档注释
- [ ] 新增逻辑有对应测试；修复 bug 有**能复现该 bug 的测试**
- [ ] 涉及契约（跨包/跨进程/数据库）的改动已同步 schema 与文档
- [ ] 提交信息符合规范（见 `aegis-commit-conventions`）
- [ ] 没有引入新的 `TODO` 而不写清"为什么现在不做"

## 8. 相关技能（按需加载）

| 场景 | 技能 |
| --- | --- |
| 决定代码放哪、能否依赖某包 | `aegis-project-layout` |
| 写注释与文档 | `aegis-comment-and-docs` |
| 写测试、用虚拟时钟 | `aegis-testing-standards` |
| 处理异常、降级、用户可见性 | `aegis-error-handling` |
| 碰脱敏、凭据、外发、权限 | `aegis-security-boundaries` |
| 改数据库表、加迁移 | `aegis-data-and-migrations` |
| 改 IPC 方法/事件 | `aegis-ipc-contracts` |
| 加/升级依赖 | `aegis-dependency-management` |
| 提交、分支、发布 | `aegis-git-workflow` |
| 独立性审查（对抗自身盲区） | `aegis-code-review` |
| 怎么把一个需求做完 | `aegis-task-workflow` |
