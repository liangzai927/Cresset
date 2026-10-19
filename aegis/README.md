# Aegis — 个人桌面 Agent 工作台

> 24 小时常驻的桌面 Agent：下层是替我盯着世界的**哨兵**，上层是一支有明确角色、可并行工作、能把活互相交接直到交付的**员工团队**；所有外发给模型的数据都经过**脱敏网关**。

**当前阶段：R4 进行中** —— 崩溃自恢复与 ad-hoc 打包已完成；剩余正式签名、公证与分发。

> **开发顺序铁律**：严格按 M0 → M1（R0–R5）→ M2 → M3 → M4 推进，禁止提前实现后续里程碑；详见 [AGENTS.md](AGENTS.md)。

| 里程碑 | 状态 |
| --- | --- |
| R0 工程骨架 + 6 项 spike | ✅ 完成（6/6 通过） |
| R1 运行时基础 | ✅ 完成 |
| R2 调度引擎 | ✅ 完成：recurrence ｜ scheduler ｜ notify ｜ daemon 接入 ｜ CLI |
| **R3 桌面外壳 + 界面** | ✅ **完成**：Electron 三层 ｜ 原生通知 ｜ 三块界面 ｜ 托盘 |
| R4 系统集成（打包/自启/自恢复） | 🚧 进行中：自启 ✅ ｜ 自恢复（崩溃/启动卡死）✅ ｜ 打包（ad-hoc）✅ ｜ 备份导出 ✅ ｜ 正式签名/公证 待做 |

**当前验证状态**：`pnpm verify` 全绿 ｜ **12 个工作区包** ｜ **326 测试通过** ｜ 注释占比 19.4%
**桌面验证**：`pnpm verify:desktop` 11 项集成检查全部通过（含 SIGKILL 后自动重启）

### 一条命令启动

```bash
cd /Users/liuwenliang/lwl/ai/aegis
pnpm dev
```

就这一条。它会自己判断要不要构建（产物缺失或源码更新过才构建，否则约 4 秒进界面），
然后拉起桌面应用与后台服务。

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | **日常启动**（智能增量：需要时构建） |
| `pnpm start` | 同上（`start` 是最符合直觉的名字） |
| `pnpm dev --force` | 强制先构建 |
| `pnpm dev --skip-build` | 完全不构建（确信产物最新时最快） |
| `pnpm desktop` | 只启动界面（假定已构建） |
| `pnpm daemon` | 只跑后台服务（不开界面） |
| `pnpm verify` | 全量校验（门禁 + 类型 + 构建 + lint + 测试） |
| `pnpm verify:desktop` | 桌面端到端验证（真启动 GUI，10 项检查） |

### 出问题时怎么查

启动脚本会把**完整日志**写到 `<数据目录>/desktop.log`（macOS 上是
`~/Library/Application Support/Aegis/desktop.log`），终端里同时显示 warn/error。

常见情况：

| 现象 | 处理 |
| --- | --- |
| 界面显示"后台服务启动中…"超过几秒 | 看 `desktop.log` 里的 `supervisor.spawn` 与 `daemon_state` |
| 提示"daemon 不可用" | 执行 `pnpm daemon` 看前台报错（锁被占 / 权限 / 迁移失败） |
| 想彻底重来 | `pkill -f "aegis/apps/daemon"`，然后删掉数据目录里的 `daemon.lock`、`handshake.json`、`daemon.sock` |
| 通知不弹 | **先看界面"设置 → 系统通知"那一行**。开发版应用在 macOS 上会被系统拒绝投递（见下方说明），此时提醒会改用**窗口提醒**兜底 |
| 想确认提醒真的会到 | 界面点"测试通知"：窗口会跳到最前、响一声、并弹出一条需要确认的横幅 |

**注意**：关掉窗口后 daemon **仍然在跑**（这是设计）。要停它用 `pnpm daemon` 之外的
`node apps/daemon/dist/main.js stop`，或菜单里的"完全退出（含后台服务）"。

### ⚠️ 关于系统通知（重要）

**当前开发态下 macOS 不允许本应用投递系统通知。** 实测证据（系统日志）：

```
Entitlement 'com.apple.private.usernotifications.bundle-identifiers' required
addRequest not allowed: com.github.Electron
```

| 启动方式 | `Notification.show()` 结果 |
| --- | --- |
| 原始 Electron 二进制 | `failed: UNErrorDomain 错误 1` |
| 打包 + ad-hoc 签名 | `failed: Notifications are not allowed for this application` |
| 系统设置的通知列表 | **完全查不到该应用**（用户想手动授权也做不到） |

这是 macOS 对**未用 Developer ID 正式签名**应用的硬限制，代码层面绕不过去。
正式解决需要 Apple Developer 账号签名 —— 属 R4（打包分发）。

**因此实现了分层提醒**（`apps/desktop/src/attention.ts`）：

```
① 系统通知 ── 失败/超时/未确认显示 ──► ② 前台强提醒
                                        · 窗口置前 + Dock 跳动 + 提示音
                                        · 应用内横幅（必须手动点"知道了"）
```

关键点：**只有收到 `show` 事件才算成功**。`Notification.show()` 在失败时并不抛异常，
早期实现只看"没报错"就报成功 —— 界面写着"已发送"，用户什么也没收到。

拿不到正式签名时，第 ② 层保证提醒仍然能到达你眼前；打包签名后会自动回到第 ① 层。

界面有三块：
- **提醒**：列表（含人话重复描述、下次触发、已触发次数）、新建（六种重复模式）、暂停/恢复/删除
- **历史**：每条通知的**投递渠道链路**（如"系统通知 · 可用 → 命令行兜底 · 成功"）
- **设置**：运行状态、渠道可用性、数据目录、版本

**首次启动有 3 步向导**：欢迎（含时区说明）→ 通知权限自检（可发测试通知）→
开机自启 + **「不需要配置模型」的说明**。全部可跳过，跳过不影响任何定时功能。

关闭窗口后**留在托盘继续运行**；菜单里可显式"完全退出（含后台服务）"。

**开机自启是真实可用的**（不是占位）：向 `~/Library/LaunchAgents` 写 plist，
`RunAtLoad` + `KeepAlive` 双开，自启的是 **daemon** 而不是界面 ——
因此用户登录后在后台静默开始工作，不需要看到窗口。

### R3 交付物

| 组件 | 内容 |
| --- | --- |
| `apps/desktop` | Electron 主进程 + preload + renderer（无框架，零构建步骤） |
| `packages/platform` | **`DesktopChannelSender`**：daemon 反向调用 Electron 弹原生通知（ADR-R3-01） |
| `apps/desktop/src/channel-host.ts` | 本地 HTTP 通道服务（回环 + Bearer token + Host 校验） |
| `apps/desktop/src/supervisor.ts` | daemon 监督者（拉起、探活、有限次重启、**不杀 daemon**） |
| `tools/verify-desktop.mjs` | 9 项端到端集成验证（真实启动 GUI） |
| `packages/platform/src/autostart.ts` | macOS LaunchAgent 自启（plist 生成 + 安装/卸载/探测） |
| `apps/desktop/src/renderer` | 三块界面 + 首次启动向导（3 步，可跳过） |

### 关键成果：原生通知真的通了

R2 时每次投递都是 `os_notification:permanent_error → cli_fallback:success`（高级渠道坏了）。
R3 之后实测：

```
$ aegis history
✓ 2026-10-19 10:49  原生通道端到端验证
      渠道：os_notification:success      ← 一次成功，不再降级
```

机制见 [`docs/ADR-R3-01-原生通知接通方案.md`](docs/ADR-R3-01-原生通知接通方案.md)：
Electron 起一个本地 HTTP 服务并把端点写入 `channel.json`（0600），
daemon **每次投递前重新发现**该端点并反向调用 —— 因此 UI 重启换端口无需重启 daemon，
UI 未启动时该渠道自动消失、降级链照常工作。daemon 保持**零 Electron 依赖**。

### R2 交付物

| 组件 | 内容 |
| --- | --- |
| `@aegis/recurrence` | RRULE 子集求解器（墙钟语义 + DST + 小月跳过），85 测试 |
| `@aegis/scheduler` | 四阶段闭环：materialize / dispatch / deliver / reconcile，63 测试 |
| `@aegis/platform` | macOS 双渠道：原生通知（待 Electron）+ `osascript` CLI 兜底（已实测投递成功） |
| `@aegis/storage` | 新增 notification-dao / outbox-dao / delivery-attempt-dao（含部分唯一索引幂等） |
| `apps/daemon` | 调度器接入启动序列与 tick 循环；**13 个 RPC 方法**（task.* / notify.* / ctrl.* / dnd.get） |
| CLI | `aegis status / add / list / history / test-notify / pause / resume / rm / start / stop` |

### 端到端验收（真实验证，非仅单元测试）

```
$ aegis add "CLI 端到端验收" --in 12s --priority important
✓ 已创建，下次：2026-10-16 17:59
$ aegis history
✓ 2026-10-16 17:59  CLI 端到端验收
      渠道：os_notification:permanent_error → cli_fallback:success
```

即：**原生通道不可用 → 自动降级到 CLI 兜底并成功投递**，降级链按设计工作。

### 关键性能事实

| 场景 | 实测 |
| --- | --- |
| 30 天长跑（每 10 分钟，8640 轮 tick） | **5.4 秒**（曾因物化全量重解退化到 2 分钟以上） |
| 物化求解（跨 10 天的 48 小时窗口） | 31.8 ms / 289 条 |
| 时区换算 `wallToUtc` ×144 | 1.1 ms |

| 文档 | 位置 |
| --- | --- |
| 产品需求（PRD v0.6，146 条 FR） | `../personal-agent/PRD-个人桌面Agent.md` |
| 技术选型与架构设计（D1–D8 已确认） | `../personal-agent/技术选型与架构设计.md` |
| M0+M1 详细设计（DDL / 状态机 / IPC / 用例） | `../personal-agent/M0+M1详细设计.md` |
| **R0 spike 结论报告** | `./R0-spike结论报告.md`（**6/6 通过**） |

---

## 快速开始

### 环境要求

- **Node 24.17.x**（见 `.nvmrc`）。⚠️ 避开开启库校验的 Node 构建（如 v24.21.0）：它会拒绝加载签名 Team ID 不同的原生模块，导致 Vitest 无法启动。
- **pnpm 11+**
- macOS（M1 只支持 macOS；Windows/Linux 在 M8）

```bash
nvm use                      # 或手动切到 .nvmrc 里的版本
pnpm install
pnpm verify                  # 依赖方向门禁 + typecheck + lint + 测试
```

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm verify` | **全量校验（提交前跑这个）**：门禁 → 解析 → 类型 → lint → 测试 → 构建 |
| `pnpm build` | 构建全部产物（类型检查 + esbuild 打包 + 生成 .d.ts） |
| `pnpm package` | 组装 `dist/Aegis.app`（随附 Node + ad-hoc 签名） |
| `pnpm package:verify` | 组装后真实启动打包产物自检 |
| `node apps/daemon/dist/main.js backup --out <目录>` | 导出一致性数据备份（不含钥匙串，daemon 可运行中） |
| `pnpm start` | 运行 daemon（当前为 R1 运行时） |
| `node apps/daemon/dist/main.js --check` | 执行启动序列后立即停止（安装后自检） |
| `node apps/daemon/dist/main.js --print-paths` | 打印路径解析结果（诊断数据目录/socket 位置） |
| `pnpm test` | 单元测试（Vitest） |
| `pnpm typecheck` | 类型检查（不产出文件，走 paths 指向源码） |
| `pnpm lint` / `pnpm lint:fix` | Biome 检查 / 自动修复 |
| `pnpm boundaries` | 依赖方向门禁（架构防腐） |
| `pnpm resolve` | **工作区依赖解析门禁**（声明即可运行时导入） |
| `pnpm spike` | 重跑 S1–S6 全部技术 spike，写入 `spike-artifacts/report.json` |
| `pnpm spike:report` | 只打印上次 spike 结论 |
| `node tools/run-spikes.mjs --only s2` | 只跑某一项 spike |
| `node tools/self-check.mjs --full` | **系统级能力自检**（LaunchAgent / 通知 / 钥匙串 / 系统日志）→ 当前 10/10 通过 |

### 界面操作

| 操作 | 行为 |
| --- | --- |
| `⌘W` | 关闭/隐藏窗口；daemon 继续运行，点菜单栏图标可恢复 |
| `⌘Q` | **连按两次**完全退出（含 daemon）；第一次只提示，3 秒内再按才退出 |
| 提醒卡片 | 「完成」结束当前这条；「稍后提醒」默认 5 分钟，可改成 1–1440 分钟 |
| 菜单栏图标 | 点击显示/隐藏窗口；右键菜单可关闭窗口或完全退出 |
| 设置 → 导出备份… | 选择文件夹导出数据库快照、配置与附件（不含钥匙串） |

> ⚠️ **沙箱限制**：`pnpm spike` 中的 S4/S5 需要写 `~/Library/LaunchAgents` 与读取系统统一日志。
> 在文件沙箱内运行时这两项会报 `blocked`（**不是**失败），需在真实/提权会话下运行才能得到完整结论。

---

## 打包（macOS，R4）

```bash
pnpm package                                 # 构建 + 组装 dist/Aegis.app + ad-hoc 签名
AEGIS_E2E_NO_SANDBOX=1 pnpm package:verify   # 外层已有文件沙箱时（DSH/CI）真实启动自检
open dist/Aegis.app
```

产物是一个自包含的 `.app`，不依赖用户机器上的 Node：

```
Aegis.app/Contents/Resources/
├── app/                     Electron 主进程 + preload + renderer
├── daemon/                  daemon 产物（入口 main.js）
├── node/bin/node            随附 Node 运行时（ADR-01）
└── node_modules/@aegis/*    工作区包（app 与 daemon 共用解析）
```

| 细节 | 说明 |
| --- | --- |
| Node 运行时 | `resolveNodeExecPath()` 在打包态优先用 `Resources/node/bin/node`；只有开发态才回退到系统 Node |
| daemon 入口 | `resolveDaemonEntry()` 优先用 `Resources/daemon/main.js`；开机自启的 plist 也指向它 |
| 签名 | 默认 ad-hoc（`codesign -s -`），保证本机可启动；改 Info.plist/Resources 会使 Electron 原签名失效，必须重签 |
| 正式分发 | `pnpm package --sign "Developer ID Application: ..."`，之后仍需公证（notarization）与 DMG |
| 通知 | ad-hoc/未签名仍会被 macOS 拒绝系统通知，只能走窗口兜底；正式签名后才会恢复 |
| 产物位置 | `dist/Aegis.app`（约 423MB，`dist/` 已被 git 忽略） |

---

## 构建链说明（R0 后期踩坑后定型）

**为什么不用 `tsc -b`（TypeScript 项目引用）**：
项目引用要求每个包先产出 `.d.ts`，而包的 `package.json` `exports` 又指向 `dist/`，
形成"要先有产物才能构建产物"的鸡生蛋问题；`tsc` 也不会因为 `references` 就把
`@aegis/contracts` 这类**包名**解析到被引用工程的产物上。

**实际分工（`tools/build.mjs`，三步顺序不可颠倒）**：

| 步骤 | 工具 | 作用 |
| --- | --- | --- |
| 1. 类型检查 | `tsc -p tsconfig.dev.json --noEmit` | 用 `paths` 指向源码 → **不依赖任何产物** |
| 2. 打包 | esbuild（JS API） | 逐包打包；`external: ["@aegis/*"]` 保留包边界，运行时靠 node_modules 软链解析 |
| 3. 类型声明 | `tsc --emitDeclarationOnly --noCheck` | `noCheck` 避免跨包类型解析再走一遍（第 1 步已保证类型正确），从而避开 `rootDir` 约束 |

**两个必须知道的细节**：

1. **daemon 产出 CJS（`main.cjs`），库产出 ESM** —— ESM 下 esbuild 的 `banner` 会把
   shebang 放到第 2 行导致语法错误；Node 22+ 的 `require()` 可直接加载 ESM 工作区包，
   所以 daemon 用 CJS 不影响引用。
2. **daemon 必须自己持有 ref 句柄** —— `Clock` 对定时器做了 `unref()`（库代码不应阻止
   进程退出），所以常驻进程要用原生 `setInterval`，否则事件循环清空即退出。

**为什么需要 `pnpm resolve` 门禁**：打包把工作区依赖设为 `external`，依赖解析完全交给
node_modules 软链 + `exports`。一旦 `exports` 路径写错、软链缺失或漏声明依赖，
**类型检查能过、构建能过，但运行时会崩** —— 只有真正 import 一次才能发现。

## 工程结构

```
aegis/
├── packages/
│   ├── clock/                Clock + SystemClock + VirtualClock + detectSkew
│   │                         ★ NFR-M1 基石：把"30 天运行 / 休眠恢复 / 跨时区"
│   │                           压成秒级可测；双时钟差值用于判定睡眠/改时间
│   ├── contracts/            Zod 领域契约：Task / RecurrenceRule / Occurrence /
│   │                         Notification / DataClass（单一真相源）
│   ├── ipc-contract/         daemon ↔ UI 契约：17 个 RPC 方法 + 6 类事件
│   ├── redaction-gateway/    唯一外发出口：8 个内置检测器 + fail-closed 网关
│   │                         ★ M1 只有骨架，但接口与 fail-closed 语义已钉死
│   ├── product/              产品标识单一来源（改名只需改这里）+ 路径解析
│   ├── recurrence/           ★ R2：RRULE 求解器（墙钟语义 + DST 正确性）
│   ├── storage/              ★ R1：SQLite 打开/迁移（只增不改+哈希锁）/blobs/DAO
│   ├── secrets/              ★ R1：macOS 钥匙串实现（约束 C-5/C-9）+ 可用性自检
│   └── platform/             平台适配接口：通知 / 自启 / 权限（三平台占位）
├── apps/
│   └── daemon/
│       ├── main.ts           CLI 入口（--check / --print-paths / --data-dir）
│       ├── bootstrap/        ★ R1：启动序列（§3 十三步）/单实例锁/配置
│       └── ipc/              ★ R1：JSON-RPC 服务端 + 客户端 SDK（含 C-4 重握手）
├── tools/
│   ├── build.mjs             构建：类型检查 → esbuild 打包 → 生成 .d.ts
│   ├── check-boundaries.mjs  依赖方向门禁：只允许白名单内包间依赖；
│   │                         禁止任何包直接依赖模型 SDK（C3 零绕过）
│   ├── check-resolve.mjs     工作区依赖解析门禁（外部依赖模式下的运行时保险）
│   ├── run-spikes.mjs        spike 运行器
│   ├── self-check.mjs        系统级能力自检（S4/S5 的实机复验）
│   └── spikes/               S1–S6 探针（可复现）
└── spike-artifacts/          spike 产物（已 gitignore，可重现生成）
```

---

## R0 已确立的关键技术事实

这些是实测结论，实现时必须遵守（详见 `R0-spike结论报告.md`）：

| # | 事实 | 后果 |
| --- | --- | --- |
| F1 | `node:sqlite` 的扩展加载必须在**建库时** `{ allowExtension: true }` | 事后开启会抛错，向量检索不可用 |
| F2 | `node:sqlite` 把 JS number 一律绑定为 REAL → **vec0 主键必须用 BigInt** | 用 `1` 会报错且不提示类型 |
| F3 | FTS5 默认分词器**无法做中文子串检索**（实测 36%） | M3 必须加 CJK 分词层（单字切分 100%） |
| F4 | 存储层用 **`node:sqlite`**，不用 better-sqlite3 | 零原生依赖、无 Electron ABI 风险；与随附 Node 运行时协同 |
| F5 | Node 24.21 的库校验会让 Vitest 无法加载 rollup 原生模块 | 开发机需固定 Node 版本（`.nvmrc`） |
| F6 | IPC **重连必须重放 `sys.hello` 握手**（新连接 = 新鉴权会话） | 否则重连后全部 `E_AUTH` |
| F7 | 钥匙串读取必须带 `-w`（否则弹 GUI 授权，无人值守会卡死） | 且 `security` 的钥匙串路径须为最后一个位置参数 |
| F8 | `security` 的查找/删除会扫**整个钥匙串搜索列表**，行为不确定（R1 实测出现"delete 报成功、find 仍能查到"） | **必须显式指定钥匙串**（约束 C-9），已落到 `MacOsKeychain` 默认行为 |
| F9 | 类方法作为回调传递会**丢失 `this`**（`lock.acquire(..., clock.wall)` 报 `#wall undefined`） | 传参时一律用箭头函数包装（`const now = () => clock.wall()`） |

---

## 开发约定（CI 强制）

| 约定 | 检查方式 |
| --- | --- |
| 禁止直接 `Date.now()` / `new Date()` | 只允许 `packages/clock` 使用（保证时间可注入） |
| 禁止绕过网关调用模型 | `tools/check-boundaries.mjs`：除 `redaction-gateway` 外任何包不得依赖模型 SDK |
| 内核不得依赖应用 | 同上：`packages/*` 不得依赖 `apps/*` |
| 契约变更需同步 | `contracts` / `ipc-contract` 变更必须有对应测试更新 |
| 迁移只增不改 | 已发布迁移文件哈希入 CI 校验（R1 起） |

---

## 下一步

### R0 已完成，无阻断项

6 项 spike 全部通过（S4 的 KeepAlive 拉起、S5 的系统级投递证据均已验证）。唯一建议你留意的是**通知是否真的显示在眼前**（系统日志已确认投递，但展示取决于通知设置）：

```bash
node tools/self-check.mjs     # 只读模式，会发一条测试通知
```

没看到就去「系统设置 → 通知」检查权限与专注模式。这不是阻断项，但会在 R4 落地为首次启动向导里的权限检查与引导。

### R2 范围（下一步）：调度引擎 —— M1 的核心

依据《M0+M1 详细设计》§5–§6，这是 M1 里最难也最关键的一块：

| 模块 | 内容 |
| --- | --- |
| `packages/recurrence` | RRULE 子集求解器（**纯函数**，最易测）：FREQ/INTERVAL/BYDAY/BYMONTHDAY/COUNT/UNTIL；墙钟语义 + tzid（I1 决策） |
| `scheduler/materialize` | 物化未来 24h 实例（`insertIgnore` 已就绪，幂等由唯一索引保证） |
| `scheduler/dispatch` | 到期领取（`claim` 已就绪，影响行数裁决）+ DND 推迟 + 补偿窗口判定 + 批量合并（I2） |
| `scheduler/deliver` | Outbox 派发、渠道降级（os_notification → cli_fallback）、重试退避 |
| `scheduler/reconcile` | 超时 claimed → `unknown`（已就绪）+ 陈旧 inflight 重置 + 运行缺口检测 |
| 通知渠道 | macOS 原生通知（Electron 桥）+ `osascript` CLI 兜底（R0 S5 已验证可用） |

**R2 的验收门槛**：虚拟时钟下跑通《M0+M1 详细设计》§9 的 TC-M1-01…TC-M1-25（尤其 TC-M1-20 的"30 天 4320 条实例 0 重复 0 漏报"）。
