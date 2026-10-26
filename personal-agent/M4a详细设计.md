# M4a 单员工核心闭环详细设计

> 状态：**设计稿，准备实施**
> 目标里程碑：**M4a**（PRD v0.9 §5.2.1）
> 日期：2026-10-26
> 关联文档：
> - `PRD-个人桌面Agent.md` §5.2.1、§7.2–§7.14
> - `技术选型与架构设计.md` §4 数据模型、§5.4 上下文管理
> - `知识库与RAG详细设计.md`（M4b，不在本阶段实现）
> - `M0+M1详细设计.md`（调度、安全、运行时基础）

---

## 1. 目标

让**一个员工**能够：

```text
用户派活
→ 员工理解任务
→ 在隔离工作区里执行
→ 调用允许的工具/软件
→ 自己跑机械验证
→ 给出可核对证据
→ 预算/高风险动作之前停下来找用户
```

M4a 不追求多员工协作，也不实现完整 RAG。

## 2. 非目标

- 多员工并行协作（M5）
- 团队/组织知识隔离（M6）
- 完整 RAG / embedding / 上下文压缩（M4b）
- 无审批的软件安装、部署、外发
- 全自动合并主干
- 跨平台（M8）

---

## 3. 核心原则

1. 员工不是“一个长提示词”，而是**有岗位、有边界、有工作区、有预算的实例**。
2. “我完成了”不算完成；**机械验证通过**才算。
3. 工具调用必须经过白名单与权限检查。
4. 高风险动作必须审批。
5. 任务状态必须持久化，进程崩溃后能恢复。
6. 任何外发必须经过脱敏网关。
7. 没有验证证据的结论必须标记“未验证”。

---

## 4. 总体架构

```text
UI（员工 / 任务看板 / 审批）
  │ JSON-RPC
  ▼
daemon
  ├─ WorkforceService        员工/岗位/状态
  ├─ WorkItemService         任务状态机
  ├─ WorkspaceService        员工工作区
  ├─ ToolBroker              工具白名单/路径隔离/超时
  ├─ SoftwareBroker          M4a 软件调用（只读/CLI）
  ├─ VerificationService     DoD 命令执行与证据
  ├─ BudgetService           token/金额/时长/工具次数
  ├─ ApprovalService         高风险动作审批门
  └─ ExecutionLoop           计划→执行→验证→收敛
        │
        ├─ LLM Gateway（红act/审计）
        ├─ Scheduler（提醒/通知）
        ├─ KnowledgeBase（M3 FTS）
        └─ Storage（SQLite）
```

M4a 只允许**一个员工实例同时运行一个任务**；全局并发默认 1，后续可调。

---

## 5. 数据模型

> 迁移只增不改；M4a 新增迁移，现有表不动。

### 5.1 role（岗位）

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| name | 岗位名 |
| description | 一句话职责 |
| scope | 职责清单 JSON |
| prohibited | 禁止事项 JSON |
| default_tools | 默认工具白名单 JSON |
| default_dod | 默认交付标准 JSON |
| version | 版本 |
| created_at / updated_at | 时间 |

### 5.2 employee（员工实例）

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| role_id | 岗位 |
| name | 员工名 |
| status | idle / running / paused / error |
| workspace_root | 工作区绝对路径 |
| model | 模型档位 |
| data_class | 允许外发上限 L0–L3 |
| budget_json | token/金额/时长/工具调用上限 |
| created_at / updated_at | 时间 |

约束：

- 一个员工一个工作区
- workspace_root 唯一
- 不允许两个员工共享同一工作区（M4a）

### 5.3 employee_permission

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| employee_id | 员工 |
| tool | 工具名 |
| scope | 路径/命令/软件范围 |
| granted_by | user / role-default |
| expires_at | 可空 |

### 5.4 work_item（任务）

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| employee_id | 员工 |
| title | 标题 |
| brief | 需求 |
| state | draft / queued / running / verifying / needs_approval / done / failed / cancelled |
| priority | low / normal / high |
| dod | 验收条件 JSON |
| budget_json | 任务级预算覆盖 |
| created_at / started_at / finished_at | 时间 |
| last_error | 错误摘要 |

### 5.5 work_step

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| work_item_id | 任务 |
| seq | 序号 |
| kind | plan / tool / verify / note |
| status | pending / running / succeeded / failed / skipped |
| input | JSON（可含脱敏后摘要） |
| output | JSON |
| started_at / finished_at | 时间 |

### 5.6 tool_call

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| employee_id / work_item_id | 归属 |
| tool | 工具名 |
| input_sha256 | 输入哈希（不存原文） |
| outcome | success / denied / timeout / error |
| duration_ms | 耗时 |
| error | 安全摘要 |
| created_at | 时间 |

### 5.7 artifact

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| work_item_id | 任务 |
| path | 工作区相对路径 |
| sha256 | 内容哈希 |
| kind | file / diff / report |
| created_at | 时间 |

### 5.8 verification

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| work_item_id | 任务 |
| command | 执行的 DoD 命令 |
| exit_code | 退出码 |
| output_sha256 | 输出哈希 |
| output_excerpt | 截断后的安全摘要 |
| status | passed / failed / skipped |
| created_at | 时间 |

### 5.9 budget_ledger

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| employee_id / work_item_id | 归属 |
| kind | token / cost / duration / tool_call |
| amount | 数值 |
| at | 时间 |

### 5.10 approval

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| work_item_id | 任务 |
| action | 动作描述 |
| risk | low / medium / high |
| status | pending / approved / rejected / expired |
| requested_at / resolved_at | 时间 |
| resolved_by | user |

---

## 6. 状态机

### 6.1 work_item

```text
draft → queued → running → verifying → done
                    ├──────────────→ needs_approval → running / rejected
                    └──────────────→ failed
queued/running → cancelled
```

规则：

- 只有 `queued` 能被员工领取
- 一个员工同时只能有一个 running
- `done` 必须有 verification passed
- `failed` 必须有 last_error + 证据

### 6.2 employee

```text
idle → running → idle
  ├────────────→ paused → idle
  └────────────→ error → idle
```

### 6.3 work_step

```text
pending → running → succeeded
                 ├→ failed
                 └→ skipped
```

---

## 7. 工作区隔离

路径：

```text
<dataDir>/employees/<employeeId>/workspace/
```

规则：

- 所有文件操作必须 realpath 后仍在 workspace 内
- 拒绝 `..`、绝对路径逃逸、symlink 逃逸
- 读取项目源目录需显式授权（只读挂载/复制）
- 删除、覆盖、重命名需要审批或白名单
- 工具输出默认截断，避免大文件进上下文
- 不在工作区里放凭据

M4a 不实现容器；进程/目录隔离 + 工具白名单。

---

## 8. 工具与权限

### 8.1 工具类型

| 类型 | 示例 | M4a |
| --- | --- | --- |
| 只读文件 | read/list/search | ✅ |
| 写文件 | write/patch | ✅ 需审批 |
| 命令 | build/test/lint | ✅ 白名单 |
| Git | status/diff/log | ✅ 只读 |
| 软件 | Excel/CLI/浏览器 | 只读/CLI，GUI 自动化暂不做 |
| 网络 | fetch | 默认关闭，需审批 |

### 8.2 ToolBroker

每次调用：

```text
工具存在？
→ 员工有权限？
→ 参数在范围内？
→ 路径在工作区？
→ 预算足够？
→ 是否高风险需审批？
→ 执行（超时/输出上限）
→ 记录 tool_call
```

失败必须可见，不能静默降级。

### 8.3 命令白名单

- 只允许配置的命令（如 `pnpm test`、`pnpm build`、`git diff`）
- 禁止 shell 拼接、管道、`;`、`&&`
- 固定工作目录
- 超时（默认 10 分钟）
- 输出上限（如 200KB）
- 退出码 + 输出哈希写 verification

---

## 9. 执行循环

```text
1. 领取任务
2. 构造上下文：任务 + 岗位 + 权限 + 工作区 + M3 检索片段
3. LLM 产出结构化计划（JSON）
4. 校验计划（步骤数/工具/预算）
5. 逐步执行工具
6. 每步写 work_step/tool_call
7. 运行 DoD 验证
8. 通过 → done
   失败 → 重试（≤3）或 needs_approval / failed
9. 输出交付摘要 + 证据
```

计划格式：

```json
{
  "steps": [
    { "kind": "tool", "tool": "fs.read", "args": { "path": "src/app.ts" } },
    { "kind": "tool", "tool": "cmd.run", "args": { "command": "pnpm test" } }
  ],
  "expected_dod": ["pnpm build", "pnpm test"]
}
```

---

## 10. 验证

DoD 必须是机械可验证的：

```json
["pnpm build", "pnpm test", "pnpm lint"]
```

VerificationService：

- 只允许已登记命令
- 在 workspace 运行
- 记录 exit code/输出哈希
- 失败 → 任务不能 done
- 输出截断，避免日志爆炸
- 验证期间不允许员工修改验证脚本

---

## 11. 预算与审批

### 11.1 预算

- token / 金额 / 时长 / 工具调用次数
- 任务级可覆盖员工默认
- 超预算 → 停止，`needs_approval` 或 `failed`
- 写 budget_ledger，UI 可见

### 11.2 审批门

必须审批：

- 写工作区外文件
- 删除/覆盖
- 安装软件
- 网络外发
- 执行非白名单命令
- 超预算继续

审批结果持久化，不依赖内存。

---

## 12. API / IPC

```text
role.list / role.create / role.update
employee.list / employee.create / employee.get / employee.pause / employee.resume
workitem.create / workitem.list / workitem.get / workitem.cancel
workitem.start / workitem.retry
approval.list / approval.resolve
verification.list
budget.summary
```

所有方法：

- Zod 契约
- 错误码
- 审计
- 权限检查

---

## 13. UI

员工页：

- 员工卡片：岗位、状态、当前任务、今日消耗
- 新建员工
- 暂停/恢复
- 任务看板：queued/running/verifying/needs_approval/done/failed
- 任务详情：步骤、工具调用、验证证据、预算
- 审批卡片

原则：

- 过程可见
- 失败可见
- 不能显示“完成了”而没有验证证据

---

## 14. 测试

### 14.1 单元

- 状态机非法迁移
- 工具权限拒绝
- 路径逃逸拒绝
- 预算停止
- 审批状态
- 验证失败不能 done

### 14.2 集成

- 创建岗位/员工/任务
- 执行只读工具
- 写文件需审批
- DoD 通过/失败
- 进程崩溃后任务恢复
- 重复领取幂等

### 14.3 验收

- 2 个岗位 × 各 3 个真实任务
- 至少 1 个任务调用本地软件/CLI
- 每个任务有验证证据
- 无未验证“完成”
- 预算/审批可见

---

## 15. 实施阶段

| 阶段 | 内容 |
| --- | --- |
| A | 迁移 + role/employee/work_item 表 |
| B | WorkforceService / 状态机 |
| C | WorkspaceService / ToolBroker |
| D | ExecutionLoop + 验证 + 预算 |
| E | IPC / UI |
| F | 审批 + 恢复 + 验收 |

每个阶段完成即 `pnpm verify` + 提交。

---

## 16. 风险

| 风险 | 缓解 |
| --- | --- |
| 工具逃逸 | realpath + 白名单 + 审批 |
| 员工“假装完成” | DoD 机械验证 |
| 预算失控 | ledger + 停止 |
| 进程崩溃丢任务 | 状态持久化 + 恢复 |
| LLM 计划非法 | JSON 校验 + 拒绝执行 |
| 软件调用不稳定 | 只读/CLI 优先，超时/输出上限 |

---

## 17. 结论

M4a 的关键不是“让模型多写代码”，而是：

```text
岗位边界
+ 工作区隔离
+ 工具白名单
+ 机械验证
+ 预算/审批
+ 可恢复状态
```

先完成这个闭环，M4b 才有意义。
