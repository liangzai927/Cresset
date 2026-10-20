---
name: aegis-project-layout
description: Aegis 的目录分层与依赖方向规范。**新增文件、新增包、决定"这段代码放哪里"、判断"这个包能不能依赖那个包"时加载**。它给出完整的包清单与职责边界、依赖方向矩阵、允许/禁止的依赖、以及 dependency-cruiser 门禁的绕过与新增白名单流程。当你不确定该建新包还是放进现有包、或门禁报"未授权的内部包依赖"时，加载本技能。
---

# Aegis 目录分层与依赖方向

## 1. 分层总览

```
L4 交互层      Electron Renderer (React)        —— M1 后期
L3 系统集成层   Electron Main（托盘/通知/自启）    —— 不含业务逻辑
      ↕ 本地 IPC（UDS / NamedPipe + JSON-RPC + NDJSON）
L2 核心运行时   apps/daemon                     —— 长驻、无 UI、24/7
L1 执行层       员工 Worker × N（M4 起）          —— 一任务一进程
L0 平台适配     packages/platform               —— 所有 OS 差异只在这里
共享内核        packages/{storage,secrets,redaction-gateway,product,clock,contracts,ipc-contract}
M2 Skill/规则   packages/skills（YAML 契约、加载、模板、纯规则引擎）
M2 本地监测     packages/monitors（Monitor 接口、FileMonitor、SystemMonitor）
M3 知识库       packages/knowledge（文档/分块/FTS 检索/引用）
```

**判定原则（按顺序问）**：

1. 它跟操作系统有关吗？→ `packages/platform`
2. 它是业务无关的基础设施吗？→ 共享内核
3. 它需要在 UI 关闭时也运行吗？→ `apps/daemon`
4. 它只是把已有能力接线起来吗？→ `apps/daemon/bootstrap`
5. 以上都不是 → **先想想是不是不该新增包**（能放进现有包就放）

## 2. 当前包清单与职责边界

| 包 | 职责（**只做这些**） | 明确不做 |
| --- | --- | --- |
| `@aegis/product` | 产品标识单一来源 + 路径解析 | 不读文件、不建目录 |
| `@aegis/clock` | Clock 抽象、真实/虚拟实现、双时钟偏斜检测 | 不含任何业务时间语义 |
| `@aegis/contracts` | 领域契约（Zod：Task/Occurrence/Notification/DataClass…） | 不做 IO、不碰数据库 |
| `@aegis/ipc-contract` | daemon ↔ UI 的方法与事件契约（Zod） | 不含实现、不引 net |
| `@aegis/storage` | SQLite 打开/迁移、blobs、DAO、审计写入 | 不做业务判断（如"该不该发通知"） |
| `@aegis/secrets` | 系统钥匙串读写 + 可用性自检 | 不决定凭据用途 |
| `@aegis/platform` | 通知/自启/权限/系统指标的平台实现 | 不含业务策略 |
| `@aegis/model-provider` | 模型协议抽象与 OpenAI 兼容调用 | 不脱敏、不审计、不决定是否允许外发 |
| `@aegis/redaction-gateway` | 唯一外发出口：分级、检测、脱敏、Provider 调用、审计 | 不做业务提示词 |
| `@aegis/skills` | YAML Skill 契约、加载校验、模板与纯规则引擎 | 不做监测器、不发通知、不调模型 |
| `@aegis/monitors` | 监测器统一接口与本地实现（FileMonitor / SystemMonitor） | 不做 Skill 解析、不做调度/通知 |
| `@aegis/knowledge` | 本地知识库：入库、分块、CJK FTS 检索、引用 | 不做 LLM 问答、embedding、外发 |
| `apps/daemon` | 启动序列、调度编排、IPC 服务端、运行时状态 | 不直连模型、不实现平台细节 |

## 3. 依赖方向矩阵（机械强制）

**权威定义**在 `tools/check-boundaries.mjs` 的 `ALLOWED` 表。当前为：

| 包 | 允许依赖的内部包 |
| --- | --- |
| `clock` | （无） |
| `product` | （无） |
| `contracts` | （无） |
| `ipc-contract` | `contracts` |
| `storage` | `clock`, `contracts`, `product` |
| `secrets` | `contracts`, `product` |
| `platform` | `clock`, `contracts` |
| `model-provider` | （无工作区依赖） |
| `knowledge` | `contracts`, `storage` |
| `redaction-gateway` | `contracts`, `model-provider` |
| `daemon` | clock, contracts, ipc-contract, platform, product, redaction-gateway, secrets, skills, monitors, knowledge, storage |

## 4. 四条铁律

1. **`packages/*` 不得依赖 `apps/*`**（内核不得反向依赖应用）
2. **只有 `redaction-gateway` 可依赖 `model-provider`**（保证外发唯一出口，见 `aegis-security-boundaries`）
3. **任何包不得直接依赖模型 SDK**（`openai` / `@anthropic-ai/sdk` / `ai` / `ollama` …），门禁会拦
4. **未在 `ALLOWED` 表登记的包间依赖即违规** —— 包括"只是 import 一下类型"

## 5. 新增依赖时的流程（必须按序）

```
1. 先问：真的需要新增这条依赖边吗？
   —— 常见替代：把共用逻辑下沉到 clock/contracts/product；用回调/接口反转依赖方向
2. 若要新增包：
   a. 建 packages/<name>/{package.json,tsconfig.json,src/index.ts}
   b. 在 tools/check-boundaries.mjs 的 ALLOWED 登记（含允许它依赖谁）
   c. 在 tools/build.mjs 的 TARGETS 登记（含 deps，用于声明生成）
   d. 在 tsconfig.dev.json 的 paths 登记（用于类型检查解析）
   e. 在根 tsconfig.json 视情况登记
   f. 更新本技能文件 §2/§3 的表格
3. 若要新增依赖边：
   a. 改 ALLOWED 表
   b. 改 build.mjs 的 deps 数组
   c. 在 commit body 里说明**为什么要打破原有边界**
4. pnpm install（让软链建立）→ pnpm verify
```

**漏掉任何一步的典型症状**：

| 漏了 | 症状 |
| --- | --- |
| `ALLOWED` | `pnpm boundaries` 失败："依赖了未授权的内部包" |
| `build.mjs` TARGETS | `pnpm resolve` 失败或 .d.ts 缺失 |
| `tsconfig.dev.json` paths | 类型检查报 `Cannot find module '@aegis/xxx'` |
| `pnpm install` | `pnpm resolve` 报"运行时导入失败"（软链未建立） |

## 6. 文件放置速查

| 你要写的东西 | 放哪里 |
| --- | --- |
| 新的领域类型/枚举 | `packages/contracts/src/index.ts`（大了就拆文件） |
| 新的 IPC 方法/事件 | `packages/ipc-contract/src/index.ts` |
| 新的表/DAO | `packages/storage/src/<entity>-dao.ts` + 新迁移 |
| 新的平台能力（如剪贴板） | `packages/platform/src/` |
| 启动序列的一步 | `apps/daemon/src/bootstrap/run-daemon.ts` |
| 调度相关（R2 起） | `packages/scheduler/src/`（新包，走 §5 流程） |
| 一次性脚本/工具 | `tools/*.mjs`（不进 packages，不参与构建） |
| 开发规范 | `.dsh/skills/<name>/SKILL.md` |

## 7. 门禁命令

```bash
pnpm boundaries    # 依赖方向（包级，读 package.json + ALLOWED 表）
pnpm resolve       # 工作区依赖可被运行时导入（软链是否有效）
pnpm verify        # 全部
```

**为什么需要两个门禁**：打包时工作区依赖被标为 `external`，解析完全交给 node_modules 软链与 `exports`。
一旦 `exports` 路径写错、软链缺失或漏声明依赖，**类型检查能过、构建能过，但运行时会崩** ——
只有真正 import 一次才能发现（这是 `resolve` 门禁存在的唯一理由）。
