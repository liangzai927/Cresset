# AGENTS.md — Aegis 项目给 AI 助手的常驻约定

> 本文件在本仓库根目录，**每次会话开始时就应被读到**。
> 它只放"必须一直遵守"的约定；详细规范在 `.dsh/skills/` 里，按需加载。

## 项目是什么

**Aegis** —— 一个 24 小时常驻的桌面个人 Agent 工作台。
下层是替人盯着世界的**哨兵**（定时提醒 / 监测 / 通知），
上层是一支有角色、能协作的**员工团队**（M4 起），
所有外发给模型的数据都经过**脱敏网关**。

它最大的特点：**要在无人看管下连续运行数月**。因此本仓库的规范不是风格偏好，而是可靠性的组成部分。

## 当前进度

| 阶段 | 状态 |
| --- | --- |
| R0 工程骨架 + 6 项技术 spike | ✅ 完成（6/6 通过） |
| R1 运行时基础（存储/凭据/单实例锁/IPC/审计） | ✅ 完成 |
| R2 调度引擎（M1 核心） | ✅ 完成 |
| **R3 Electron 外壳 + 界面** | ✅ **完成：可本地打开使用** |
| R4 系统集成（打包 / 自启 / 自恢复） | 🚧 进行中：自启、自恢复、ad-hoc 打包完成；正式签名/公证待做 |

文档在 `../personal-agent/`：PRD、技术选型与架构设计、M0+M1 详细设计、R0 spike 报告。

## 开发顺序铁律（最高优先级）

> **总体开发顺序严格按照 PRD §5.2 的里程碑顺序推进；不允许提前实现后续里程碑的代码。**

```
M0 安全地基 → M1 提醒内核（R0–R5）→ M2 Skill/规则/本地监测
→ M3 LLM 判断 + 知识库 → M4 单员工 Agent → M5 团队 → …
```

- 开始任何编码前，先确认**当前里程碑已经验收**。未验收时只能做：本里程碑的缺陷修复、
  本里程碑验收所需的代码、以及本里程碑的文档；**不得写下一里程碑的功能**。
- 不允许用「前置」「骨架」「以后要用」「先把接口写出来」作为提前实现的理由。
  接口可以写进设计文档；**代码必须等里程碑**。
- M1 期间明确不做：任何 LLM 调用、脱敏网关实现（只留接口）、监测器、员工层
  （技术选型 §11）。这条曾经被违反过一次，代价是整块代码回退。
- 发现提前实现时：**撤销该部分代码**，在 `docs/DEVLOG.md` 记录撤销原因；
  不允许保留「已经写好但不接线」的半启用状态。
- 当前闸门：**R4（M1 系统集成）尚未收尾 → R5（14 天验收）尚未开始 → 之后才是 M2**。

## 第 0 条：先读流水账，改完写流水账

> **这是本项目最重要的一条工作纪律，由 git pre-commit hook 机械强制。**

| 时机 | 动作 |
| --- | --- |
| **动手之前** | 读 `docs/DEVLOG.md` 的「当前状态快照」+ 最近 3 条记录 |
| **改完代码** | 在 `docs/DEVLOG.md` 顶部追加一条（`pnpm devlog:add` 生成模板） |
| **提交** | 改了代码却没更新流水账 → **提交被拒绝** |

```bash
pnpm devlog          # 看快照 + 最近 3 条
pnpm devlog --last 8 # 看更多
pnpm devlog:add      # 插入模板
pnpm devlog:check    # 校验结构（verify 也会跑）
```

**为什么这么严**：这个项目跨越很多会话。上一次的"临时决定"如果不写下来，
下一次就变成无从解释的既成事实。写清楚"改了什么、为什么、怎么验证的"，
任何人（包括未来的你）接手都能在 5 分钟内恢复工作状态。

## 六条不可违背的规则

1. **不写注释的代码视为未完成** —— 每个导出符号要有中文 JSDoc，每个文件要有文件头注释（`pnpm comments` 会拦）
2. **禁止静默失败** —— 每个 `catch` 必须有出口（日志 / 抛错 / 状态）；空 catch 仅限清理路径且要写理由
3. **禁止绕过脱敏网关外发** —— 任何模型/网络调用必须经 `@aegis/redaction-gateway`
4. **禁止直接使用 `Date.now()` / `new Date()`** —— 一律走注入的 `Clock`（否则长跑场景无法测试）
5. **禁止修改已发布的迁移文件** —— 只能新增（checksum 锁会拦）
6. **提交前必须 `pnpm verify` 全绿** —— 不允许"先提交，回头再修"

## 提交前必跑

```bash
pnpm verify
```

它依次跑：`boundaries` → `comments` → `devlog:check` → `typecheck` → `build` → `resolve` → `lint` → `test`。
**顺序有意义**：`build` 必须在 `resolve` 之前（解析门禁检查的是产物）。

## 提交信息格式（由 git hook 机械校验）

```
<type>(<scope>): <中文描述，≤50 字>

<body：说明为什么，每行 ≤72 字>
```

`type` ∈ `feat | fix | refactor | perf | test | docs | build | ci | chore`；`scope` 必填。

首次克隆后执行一次：`pnpm hooks:install`（安装 `commit-msg` 与 `pre-commit` 两个 hook）

## 按需加载的技能（`.dsh/skills/`）

| 场景 | 技能 |
| --- | --- |
| 任何写码/改码之前 | `aegis-engineering-standards`（总纲） |
| 决定代码放哪 / 能否依赖某包 | `aegis-project-layout` |
| 写注释与文档 | `aegis-comment-and-docs` |
| 写测试 / 用虚拟时钟 | `aegis-testing-standards` |
| 处理异常与失败可见性 | `aegis-error-handling` |
| 碰脱敏/凭据/外发/权限 | `aegis-security-boundaries` |
| 加表 / 写迁移 / 写 DAO | `aegis-data-and-migrations` |
| 改 IPC 方法或事件 | `aegis-ipc-contracts` |
| 加依赖 / 构建出问题 | `aegis-dependency-management` |
| 提交 / 分支 / 打标签 | `aegis-git-workflow` |
| 自查或审查代码 | `aegis-code-review` |
| 开新里程碑 / 较大需求 | `aegis-task-workflow` |
| 写提交信息 | `aegis-commit-conventions` |

## 已确立的技术约束（踩过的坑，不要重新踩）

详见 `README.md` 的"已确立的关键技术事实"。最常撞到的几条：

| 编号 | 约束 |
| --- | --- |
| C-1 | `node:sqlite` 的扩展加载必须在**建库时** `{ allowExtension: true }` |
| C-2 | vec0 主键必须用 **BigInt** 绑定（`node:sqlite` 把 number 当 REAL） |
| C-4 | IPC **每次重连都必须重放 `sys.hello`**（新连接 = 新鉴权会话） |
| C-5 | 钥匙串读取必须带 `-w`，且钥匙串路径是**最后一个位置参数** |
| C-9 | 钥匙串必须**显式指定**（否则查找/删除会扫整个搜索列表，行为不确定） |
| C-10 | `channel.json` 必须 **0600**；daemon 必须校验其 `pid` 存活与 endpoint 为回环地址 |
| C-11 | **用到 Electron 的验证必须真启动 GUI**（`pnpm verify:desktop`）；单元测试证明不了"窗口能开" |

另有四条 Electron 相关陷阱（都是实测踩过的）：

- **`ELECTRON_RUN_AS_NODE=1` 会让 Electron 当纯 Node 跑** —— 启动脚本必须**删除**该变量
- **`electron` 包必须标为 esbuild external** —— 否则内联后 ESM 下抛 `Dynamic require`
- **`sandbox: true` 时 preload 必须是 CJS** —— 产出 `preload.cjs`，不能用 `.js`
- **不要用绝对耗时做性能门禁** —— 会间歇失败，改用结构性证据

通用陷阱：

- **类方法作为回调会丢 `this`** → 传参时用箭头函数包装（`const now = () => clock.wall()`）
- **包装配类操作的验证必须放在 pnpm 工作区之外** → 否则会继承仓库 lockfile 导致间歇性失败

## 语言约定

- 注释、文档、提交信息正文：**简体中文**
- 标识符（变量/函数/类型/表名/列名）：**英文**
- 专业术语可保留英文（`WAL`、`UDS`、`idempotent`），首次出现宜给中文解释

## 工作区位置提示

项目位于 `/Users/liuwenliang/lwl/ai/aegis`。若 DSH 会话工作区不是该目录，
写文件会需要用户授权 —— 建议把工作区切到 `/Users/liuwenliang/lwl/ai`。
批量改动时可先暂存在工作区内，最后一次性 `mv` 搬入，避免逐文件审批。
