# 开发流水账（DEVLOG）

> **这个文件是本项目的"开发记忆"。**
>
> **规矩（由 git pre-commit hook 强制）：**
> 1. **动手改代码之前**：读一遍下面「当前状态快照」+ 最近 3 条记录。
> 2. **改完代码之后**：在顶部追加一条记录（`pnpm devlog:add` 可以帮你填模板）。
> 3. 提交时若改了代码却没更新本文件，**提交会被拒绝**。
>
> 为什么这么做：这个项目跨了很多个会话、很多"接下来做什么"的决定。
> 靠记忆保存上下文必然出错 —— 上一次会话的"临时决定"到了下一次就变成了
> 无从解释的既成事实。把决策与验证写在这里，任何人（包括未来的我、或另一个
> AI/开发者）接手时都能在 5 分钟内恢复到可继续工作的状态。

---

## 当前状态快照

> 这一节是"现在在哪"。每次里程碑变化时更新，不必每次提交都改。

| 项 | 内容 |
| --- | --- |
| 阶段 | **R4 进行中**（自启/崩溃自恢复/ad-hoc 打包/备份导出已完成），剩余正式签名与公证 |
| 版本 | daemon `0.2.0-r2` ／ 桌面 `0.3.0-r3` |
| 校验 | `pnpm verify` 全绿（329 测试）＋ `pnpm verify:desktop` 11/11 ＋ `pnpm package:verify` 通过 |
| 启动 | `pnpm dev`（智能增量构建后启动；打包产物为 `dist/Aegis.app`） |
| 数据目录 | `~/Library/Application Support/Aegis`（含 `desktop.log`） |
| 已实现 | 提醒创建/重复规则/到点投递/补偿/免打扰/历史/托盘/自启/首次向导/崩溃自恢复/启动看门狗/打包（ad-hoc）/备份导出 |
| **未实现** | 系统通知（macOS 拒绝未签名应用，用窗口提醒兜底）、正式签名/公证/DMG、监测器(M2)、LLM+知识库(M3)、员工层(M4) |
| 已知坑 | 见 README 的 F1–F27 与 C-1–C-11 |

### 接手时先看这三处

1. `README.md` —— 技术事实（F 编号）、约束（C 编号）、当前进度
2. `docs/ADR-R3-01-原生通知接通方案.md` —— 通知为什么这么设计
3. 本文件最近的 3 条记录 —— 上一次到底在干什么、为什么

### 当前的"悬而未决"

- **系统通知需要正式签名**：需 Apple Developer 账号；否则只能用窗口提醒兜底（已实现）
- **R4 打包已落地 ad-hoc `.app`**：`tools/package-app.mjs` 可重复产出 `dist/Aegis.app`；
  正式 Developer ID 签名、公证与 DMG 尚未做
- **产品名**仍是占位的 Aegis（集中在 `packages/product/src/index.ts`）

---

## 记录格式（新增条目照抄这个结构）

```
### YYYY-MM-DD · <一句话主题>
**里程碑**：R2 / R3 / 修复 / 重构
**改了什么**：...
**为什么**：...（决策理由，比"改了什么"更重要）
**验证**：...（跑了什么、结果如何；不要写"应该没问题"）
**踩到的坑**：...（没有就写"无"）
**留给下次**：...（未完成的部分或需要注意的地方）
```

---

## 记录（新的在最上面）

### 2026-10-20 · R5：M1 14 天验收启动与自动化门禁
**里程碑**：R5（M1 验收）
**改了什么**：
- 新增 `tools/acceptance.mjs` 与 `pnpm acceptance`：
  - 默认跑 `pnpm verify`；
  - `--desktop` / `--package` / `--full` 追加真实 Electron 与打包产物验证；
  - 报告写 `docs/acceptance/last-run.json`（gitignore，不入库）。
- 新增 `docs/acceptance/R5.md`：时间窗 2026-10-20 至 2026-11-02、每日记录表、
  手工验收清单与结束判据。
- 单仓库门禁继续位于 `verify` 第一步。
**为什么**：R4 的可离线代码已完成；R5 不能靠"感觉能用"，需要每天一条可查记录。
自动化门禁负责证明代码没坏，14 天真实使用负责证明它真的没漏提醒。
**验证**：
- `pnpm acceptance`：`pnpm verify` 全绿（329 测试）
- `docs/acceptance/last-run.json` 生成且被 gitignore
**踩到的坑**：验收运行器不能替代真实使用；`--full` 里的桌面验证需要
`AEGIS_E2E_NO_SANDBOX=1`（DSH/CI 外层沙箱）。
**留给下次**：每天记录 R5；只修 M1 缺陷；14 天通过后才开 M2。

### 2026-10-20 · R4/M1：运行缺口自监控（system_gap）
**里程碑**：R4/M1
**改了什么**：
- 启动时在写本次 heartbeat 之前读取上一条 heartbeat；间隔超过
  `max(15 分钟, heartbeat.intervalS × gapWarnMultiplier)` 就写入 `run_gap`；
- 同时创建一条 `system_gap` 通知（high 优先级，可穿透 DND），
  `dedupe_key = system-gap:<gapStart>:<gapEnd>`，同一缺口只发一次；
- 根据启动时钟跳变判定 cause（wall_jumped → clock_jump，其余 → sleep）；
- 新增集成测试：两次启动相隔 5 小时，断言 run_gap 与 system_gap 通知。
**为什么**：NFR-R5 要求"中断超时后恢复即主动告知我在 X–Y 期间没运行"；
此前 run_gap 表只有建表、从未写入，用户无法知道漏掉了什么。
**验证**：
- `pnpm verify`：329 通过 / 9 跳过
- 缺口测试断言 run_gap.cause=sleep、notified=1、通知处于 pending
**踩到的坑**：检测必须放在写本次 heartbeat 之前；否则比较对象会变成刚写的自己。
**留给下次**：R4 正式签名/公证（需 Apple 账号）→ R5 14 天验收 → M2；M2 不能提前。

### 2026-10-20 · R4/M1：设置页补齐开机自启与通知权限引导
**里程碑**：R4/M1
**改了什么**：
- 设置页新增「启动」卡片：读取 `getOnboarding().autostartEnabled`，开关调用已有
  `setAutostart`（安装/卸载 LaunchAgent），失败时回滚并展示原因；
- 通知渠道卡片新增「打开系统通知设置」：主进程按 macOS 版本依次尝试
  `Notifications-Settings.extension` 与旧 preference pane；
- API/preload 增加 `openNotificationSettings`（固定 URL，不接受 renderer 输入）。
**为什么**：M1 设置页要求开机自启开关与通知权限引导；此前只能在首次向导里设置自启，
系统通知被拒时也没有可操作的入口。
**验证**：
- `pnpm verify`：328 通过 / 9 跳过
- 设置页截图/DOM 检查确认启动卡片与通知设置按钮渲染
- 自启仍走原 `packages/platform/autostart` 的已有测试
**踩到的坑**：macOS 通知设置的 URL 在新旧系统不同，不能只写一个入口；两个都失败时要回退到文字指引。
**留给下次**：R4 正式签名/公证（需 Apple 账号）→ R5 14 天验收 → M2；M2 不能提前。

### 2026-10-20 · R4/M1：提醒编辑（全字段）
**里程碑**：R4/M1
**改了什么**：
- 契约新增 `task.get` / `task.update`；`TaskEditView` 回填完整输入（时间、repeat、catchup、DND 覆盖）；
- 编辑时间/重复时，先抑制该任务仍在 pending 的通知、删除旧的未来 pending 实例，
  再更新 recurrence —— 避免新旧两套计划同时物化；
- 设置页/提醒列表新增「编辑」按钮；对话框改用日期 + 时间选择器，支持自定义 RRULE 和任务级 DND 覆盖；
- 新增集成测试：更新时间后旧未来实例被删除，任务 id 与历史保留。
**为什么**：PRD M1 的最小界面包含"新建/编辑"；此前只能删除重建，会丢任务 id 和已触发历史。
**验证**：
- `pnpm verify`：328 通过 / 9 跳过
- RPC 测试覆盖 `task.get` 回填与 `task.update` 清理旧未来实例
- 对话框字段与列表按钮已通过类型检查/语法检查
**踩到的坑**：
- 只改标题时不能清任务实例；只有 recurrence/首次时间变化才走清理路径；
- 旧 future occurrence 删除前必须先把关联的 pending notification 置为 suppressed，
  否则 outbox 仍会按旧时间投递；
- 编辑不修改 until/count，保留原任务的截止条件。
**留给下次**：R4 正式签名/公证（需 Apple 账号）→ R5 14 天验收 → M2；M2 不能提前。

### 2026-10-20 · R4/M1：免打扰设置（持久化 + 设置页 UI）
**里程碑**：R4/M1
**改了什么**：
- 契约新增 `dnd.set`；抽出 `DndWindowSchema`/`DndSettingsSchema`，`dnd.get` 复用同一 schema；
- daemon 方法上下文注入 `updateDnd`：先原子写 `config.json`（0600），再替换 scheduler 的 DND；
- `Scheduler.setDndSettings` 运行时生效；
- 设置页新增免打扰卡片：启用开关、多时段（星期按钮 + 起止时间）、添加/删除/保存；
- 新增 daemon 集成测试：`dnd.set` 持久化到 config 并立即反映到 `dnd.get`。
**为什么**：M1 的 FR-A7 要求免打扰；此前只有启动时读配置和 `dnd.get`，用户无法在界面里设置。
**验证**：
- `pnpm verify`：327 通过 / 9 跳过
- 设置页截图确认免打扰卡片、启用开关与空时段提示正常
- 配置写入权限测试为 0600
**踩到的坑**：
- `config.ts` 原本已有一个简单 `saveConfig`，直接追加会重复定义；改为单一的原子写实现。
- 修改 DND 只影响之后到点的派发；已经被旧时段推迟的通知不会被自动提前（避免一次性放出历史通知）。
**留给下次**：R4 正式签名/公证（需 Apple 账号）→ R5 14 天验收 → M2；M2 不能提前。

### 2026-10-20 · repo：移除嵌套 .git 并加单仓库门禁
**里程碑**：R4（仓库/流程）
**改了什么**：
- 备份旧嵌套仓库：`/Users/liuwenliang/lwl/Cresset-aegis-nested-git-20261020.tar.gz`（799K）；
- 移除 `/Users/liuwenliang/lwl/Cresset/aegis/.git`（旧仓库无 remote，最后一次提交 4537053）；
- 新增 `tools/check-single-repo.mjs`：扫描根仓库，发现嵌套 `.git` 即失败；
- `pnpm verify` 前置 `repo:check`；根 `pre-commit` 也先跑它；
- `install-hooks.mjs` 改为通过 `git rev-parse --show-toplevel` 安装到根 `.git`，
  不再假设 `aegis/.git` 存在。
**为什么**：VS Code 把旧 `aegis/.git` 识别成第二个仓库，长期显示 42 个"未提交"；
旧 daemon 还会从旧 checkout 占住同一 UDS。根仓库是唯一真相源，必须机械阻止嵌套仓库。
**验证**：
- `pnpm repo:check`：通过；
- `pnpm hooks:install`：已安装到 `/Users/liuwenliang/lwl/Cresset/.git/hooks/`；
- 根仓库 status clean，远端 `31958d3`。
**踩到的坑**：嵌套仓库没有 remote，提交它只会生成孤岛历史；先备份、再删元数据，代码不动。
**留给下次**：R4 正式签名/公证（需 Apple 账号）→ R5 14 天验收 → M2。

### 2026-10-19 · docs：校准工作区路径与技能教训
**里程碑**：R4（文档/流程）
**改了什么**：
- `AGENTS.md`、`README.md`、`aegis-git-workflow` 的路径改为
  git 根 `/Users/liuwenliang/lwl/Cresset` + 代码子目录 `aegis/`；
- `AGENTS.md` 增加 C-12，README 增加 F10：旧 checkout 的 daemon 会占用同一 UDS；
- `aegis-task-workflow` 增加工作区迁移检查；`aegis-ipc-contracts` 增加"先查既有契约"；
  `aegis-testing-standards` 增加"两端 undefined 假通过"；`aegis-code-review` 增加外部实例检查；
- 明确 `aegis/.git` 是旧嵌套仓库，根仓库才是唯一真相源。
**为什么**：今天真实踩到旧路径 `/Users/liuwenliang/lwl/ai/aegis` 的 daemon 占着 socket，
新进程被误认为已在运行，界面长期连旧代码；同时 `backup.export` 证明"契约已存在、
不要另造方法"。把这两类教训固化进技能，避免下个会话重踩。
**验证**：`pnpm devlog:check`；文档路径检查无残留旧路径。
**留给下次**：R4 正式签名/公证（需 Apple 账号）→ R5 14 天验收 → M2；不要提前写 M2。

### 2026-10-19 · R4：设置页导出备份
**里程碑**：R4
**改了什么**：
- 实现契约里已有的 `backup.export` RPC：
  - daemon 启动时注入 `paths`/`daemonVersion`；
  - 结果扩展为 `{ path, files, totalBytes }`（原契约只有 path）。
- 桌面主进程：原生目录选择框选父目录，自动生成
  `Aegis-backup-YYYYMMDD-HHmmss` 子目录；renderer 不能传任意路径（安全边界）。
- 设置页「数据」增加「导出备份…」按钮与结果提示；失败走可见 banner。
- 新增 1 个 daemon RPC 集成测试（`backup.export` 生成 aegis.db + manifest.json）。
**为什么**：CLI 已有备份能力，但普通用户不该被要求开终端；备份是 M1 数据可迁移承诺的一部分。
**验证**：
- `pnpm verify`：326 通过 / 9 跳过
- 设置页截图确认按钮、路径与说明渲染正常
- RPC 测试确认快照包含数据库与 manifest
**踩到的坑**：契约原本就定义了 `backup.export`，不要另造 `backup.create`；直接实现既有契约，
但结果需要补 files/totalBytes 才能给 UI 摘要。
**留给下次**：正式签名/公证/DMG（需 Apple 账号）；然后 R5 14 天验收；M2 不能提前。

### 2026-10-19 · R4 修复：稍后提醒期间任务从列表消失
**里程碑**：R4
**症状**：点「稍后提醒」后，任务从提醒列表消失，用户以为 snooze 被清除。
**根因**：snooze 是新建一条 pending notification，不修改任务的 recurrence；
`task.list` 只按 `scheduler.nextFireAt(task)` 过滤，一次性任务本身已经没有下一次，
于是被当成"已结束"隐藏。
**改了什么**：
- `NotificationDao.earliestPendingForTask(taskId)`：查该任务最早的 pending/delivering
  `reminder` 通知时刻（join occurrence）。
- `toTaskView`：`nextFireAt` 取 recurrence 与 pending snooze 的较早者；
  这样 snooze 期间列表显示下一次会响的时间。
- `task.list` 改为先构造 view 再按 `nextFireAt` 过滤。
- 扩展 snooze 集成测试：请求 snooze 后任务仍在 `task.list` 中，且 `nextFireAt ≈ now+5min`。
**为什么**：用户需要看到"它待会还会再响"；否则会误以为操作失败并重复创建提醒。
**验证**：`pnpm verify` 325 通过 / 9 跳过；另有 snooze 定时投递单测。
**留给下次**：snooze 通知真正投递后，pending 查询消失；此时由提醒卡片接管，
若用户继续 snooze 会重新出现。无需在列表里保留"已结束"状态。

### 2026-10-19 · R4：完成一次性提醒后从列表移除
**里程碑**：R4
**症状**：点「完成」后，一次性提醒仍以"已结束 / 已触发 1 次"留在提醒列表里。
**改了什么**：
- `task.complete`：一次性任务（`rrule === null`）完成时 `softDelete` 任务；
  重复提醒只结束当前实例，任务保留。
- `task.list`：默认/今天视图过滤 `nextFireAt === null` 的任务；显式 `filter: "all"`
  仍可查看已结束任务（CLI/诊断），通知历史不受影响。
- 新增 1 个集成测试：一次性完成从列表移除，重复提醒保留。
**为什么**：提醒列表是"现在还要我关注的事"；已结束的一次性任务没有下一次，
留着只会变成噪音。软删除保留任务行，历史通知仍可查。
**验证**：`pnpm verify` 325 通过 / 9 跳过；另有 snooze 定时投递单测。
**踩到的坑**：旧的一次性任务已经 `delivered`，`markCompleted` 返回 false；
完成逻辑不能只看这个布尔值，必须判断任务是否是 one-time 并主动软删除。
**留给下次**：如果将来要"显示已结束"开关，走 `filter: "all"`；不要恢复默认列表噪音。

### 2026-10-19 · R4 修复：旧工作区 daemon 占着数据目录，提醒按钮失效
**里程碑**：R4
**症状**：提醒卡片只有「知道了」，但数据库里 `notification.occurrence_id` 明明存在；
`channel.notified` 日志显示 `hasOccurrence:false`。
**根因**：旧路径 `/Users/liuwenliang/lwl/ai/aegis` 启动的 daemon（pid 44481）一直持有
`~/Library/Application Support/Aegis/daemon.sock`。新路径的 daemon 启动失败/被忽略，
界面实际连的是旧进程；旧进程发来的通知 payload 没有 `occurrenceId`。
**改了什么**：
- `DaemonSupervisor` 读取已有握手时比较 `daemonEntry`：
  - 与当前入口不一致 → 记录 `supervisor.foreign_daemon`，先 SIGTERM、必要时 SIGKILL 旧进程，
    清理它的握手，再拉起当前入口；
  - 旧版握手没有 `daemonEntry` → 无法判断，仍兼容采纳。
- 新增 1 个 supervisor 测试（20 个）。
**为什么**：旧进程占着 socket 时，新 daemon 启动失败会被 supervisor 当成"已有实例"采纳；
界面和日志都看似正常，实际跑的是旧代码。只靠版本号/pid 无法发现工作区路径迁移。
**验证**：
- `pnpm verify`：323 通过 / 9 跳过
- 手工确认旧进程 44481 停掉后，新 daemon 从 `.../Cresset/aegis/apps/daemon/dist/main.js`
  启动并接管 socket；手头完整链路测试中卡片出现「5 / 稍后提醒 / 完成」
**踩到的坑**：改工作区路径后，旧 daemon 不会自己退出；它占着 socket，新 daemon
即使启动也拿不到锁。`ps` 在 DSH 沙箱里不可用，用 `lsof -U | grep daemon.sock` 定位到旧 pid。
**留给下次**：迁移工作区或换构建目录时，先完全退出旧 daemon；启动日志里
`supervisor.foreign_daemon` 是这类问题的第一现场。

### 2026-10-19 · M1 UI 优化：提醒完成/稍后、快捷键与托盘
**里程碑**：R4/M1（界面与交互）
**改了什么**：
- 通知 payload 透传 `occurrenceId`（scheduler → DesktopChannelSender → Electron → renderer）；
  提醒卡片在带 occurrence 时提供两个出口：
  - 「完成」：结束当前这条（一次性不再出现；重复提醒只结束本次）
  - 「稍后提醒」：默认 5 分钟，可填 1–1440 分钟；从**现在**起算
- 修复 `task.snooze` 的时间基准：原来用 `occurrence.scheduledAt + N`，
  延迟投递的提醒可能立刻再次到期；改为 `scheduler.now() + N`
- 顶部增加 28px 窗口拖动区（覆盖交通灯留白），顶栏保持可拖动、按钮 no-drag
- `⌘W` 隐藏窗口（daemon 继续跑）；`⌘Q` 两段式完全退出：
  第一次提示、3 秒内第二次才停 daemon 并退出；托盘菜单同步
- 托盘图标从圆点换成铃铛，并在图标解码失败时写 `main.tray_icon_empty` 日志
- 新增 toast 与 `aegis:quit-armed` 事件；preload/API 白名单增加
  `completeOccurrence` / `snoozeOccurrence` / `onQuitArmed`
- 测试：occurrenceId 透传（scheduler + platform）、task.snooze 从当前时刻起算
**为什么**：提醒弹出来只有「知道了」等于只能关掉，用户无法表达"这件事完成了"
还是"等会儿再说"。系统通知可用性不稳定，窗口卡片必须承担这个交互；
快捷键与菜单栏图标是桌面常驻工具的基本手感。
**验证**：
- `pnpm verify`：322 通过 / 9 跳过
- `pnpm verify:desktop`：11/11
- 手动截图确认卡片包含「5 分钟后 / 稍后提醒 / 完成」三个控件
- 完整链路验证：临时数据目录直接插入带 occurrence 的通知，daemon 真实投递后
  卡片出现两个按钮；`channel.notified` 日志增加 `hasOccurrence`，用于识别旧 daemon
- 单测：snooze 在 occurrence 原定时刻为一小时前时，新通知仍约等于 now+5min
**踩到的坑**：
- 原通知 payload 只有 title/body，界面拿不到 occurrenceId，无法调用完成/稍后
- `alert-stack` 原 top=34 会盖住顶栏与状态，改为 122（位于页签下方）
- `markCompleted` 只接受 pending/claimed/unknown；已投递的提醒点"完成"返回 false，
  但卡片仍应消失（对一次性提醒本来就不会再响）
- 系统原生通知目前**不带动作按钮**；动作按钮在应用内卡片层。
  若正式签名后系统通知可用、用户只看到原生横幅，需要后续补 macOS actions
**留给下次**：
- 原生通知 actions / 点击通知打开窗口并显示操作卡片
- `⌘Q`/`⌘W`/托盘图标需要真机键盘与菜单栏截图验收
- R5 14 天验收 → M2

### 2026-10-19 · R4：数据备份导出（一致性快照 + manifest）
**里程碑**：R4
**改了什么**：
- 新增 `apps/daemon/src/bootstrap/backup.ts`：
  - `VACUUM INTO` 生成 SQLite 一致性快照（源库在 WAL 下打开也可用）；
  - 导出 `config.json` / `ui-onboarded.json` / `blobs/`；
  - `manifest.json` 记录格式版本、时间、daemon 版本与每个文件的 sha256；
  - 先写临时目录、校验通过后 `rename`；目录 0700、文件 0600；
  - 明确排除 `handshake.json` / `channel.json` / `daemon.lock` / 日志 / `-wal` / `-shm`；
  - 拒绝 blobs 中的符号链接（避免恢复端读到备份目录外）。
- CLI 新增 `aegis backup --out <目录> [--data-dir <目录>]`；`isCliInvocation`/help 同步。
- 新增 5 个测试。
**为什么**：M1 要求配置与数据可备份。直接拷贝 `aegis.db` 在 WAL 下可能拿到不一致的
中间状态；备份包含个人数据，必须收紧权限；运行期 token/日志不属于数据，不能带出去。
**验证**：
- `pnpm verify`：320 通过 / 9 跳过
- 单测：WAL 源库快照仍能读出已提交数据、权限 0700/0600、运行期文件被排除、
  目标已存在拒绝、源库缺失、blobs 符号链接拒绝
- CLI 端到端：`--check` 初始化 → `backup --out` → 产物 `aegis.db` + `manifest.json`，
  daemon 版本 `0.2.0-r2`
**踩到的坑**：
- `VACUUM INTO` 的路径是 SQL 字面量，单引号必须转义；
- 符号链接原样复制会让备份"看起来有文件"但实际指向目录外，直接拒绝；
- 目标已存在时不覆盖，避免把上一份备份重命名覆盖。
**留给下次**：
- 恢复/导入属于 M8；压缩或加密备份暂不做；
- 界面上的"导出备份"按钮（IPC）尚未接；
- R5 14 天验收 → M2。

### 2026-10-19 · R4 修复：尊重 daemon 的 0 退出，避免与 stop/launchd 抢重启
**里程碑**：R4
**改了什么**：
- `DaemonSupervisor` 退出处理区分退出码：
  - code=0 且存在**其他**存活握手 → 采纳现有实例，不重启；
  - code=0 且无存活实例 → 置为 stopped，不自动拉起；
  - 非 0/被信号杀死 → 沿用既有退避重启。
- 新增 2 个测试：0 退出无实例、0 退出但已有实例。
**为什么**：旧逻辑把任何 exit 都当崩溃。执行 `aegis stop` 时 daemon 以 0 退出，
监督者 2 秒后又把它拉起来，导致"停不掉"；launchd 先启动实例时，
桌面监督者也会和 launchd 互相抢着重启。
**验证**：
- `pnpm verify`：315 通过 / 9 跳过
- 单测：0 退出无实例 → 10 秒内不再拉起；0 退出有存活实例 →
  `running` 且 `spawnedByUs=false`，不产生重启定时器
**踩到的坑**：只看"退出码非 0 才是崩溃"不够；0 也可能来自"已有实例"，
必须结合握手里的 pid 与存活探测判断。
**留给下次**：R4 剩余项（备份导出）；R5 14 天验收；之后 M2。

### 2026-10-19 · 撤销 M3 提前实现，固化开发顺序铁律
**里程碑**：工程流程
**改了什么**：
- 撤销 `3cf2cb4`（`model-provider` + `ModelGateway` + 占位符还原），基线回到 `5c77556`
- `AGENTS.md` 增加「开发顺序铁律（最高优先级）」：严格按
  M0 → M1（R0–R5）→ M2 → M3 → M4；禁止提前实现后续里程碑
- `aegis-task-workflow` 技能增加 §0 开发顺序门禁；明确 M1 期间不做
  LLM 调用、脱敏网关实现（只留接口）、监测器、员工层
- 生产路径恢复为 `FailClosedGateway`，没有任何模型外发
**为什么**：上一轮把 M3 的网关实现提前做了，跳过了 M2，违反 PRD §5.2 与
技术选型 §11「M1 期间只留接口」。当时用「未接线、不真实调用」解释，
但风险低不等于顺序对；必须把规则写死，避免下个会话再用「前置」当理由。
**验证**：
- `pnpm verify`：313 通过 / 9 跳过（撤销后基线）
- `git revert` 无冲突；`model-provider`、`ModelGateway`、占位符相关文件全部删除
- 当前闸门：R4（M1 系统集成）收尾 → R5 14 天验收 → 之后才是 M2
**踩到的坑**：把「代码没接线」当成顺序正确的理由；半启用状态仍是提前实现。
**留给下次**：按顺序先做 R4 剩余项，再做 R5，最后 M2；M3 的 Provider/网关
等 M2 完成后再重新实现，不得提前恢复。

### 2026-10-19 · 自恢复补口：启动卡死由看门狗终止重试
**里程碑**：R4
**改了什么**：
- `DaemonSupervisor` 新增启动看门狗：子进程拉起后 `startupTimeoutMs`（默认 30 秒）
  仍无握手 → 先复查握手，确认卡死才 SIGKILL；exit 后复用既有退避重启
- 看门狗绑定具体 child：旧进程的定时器不会误杀新进程；成功握手 / exit / dispose 都会取消
- `SupervisedChild` 增加 `kill()`；`ensureRunning` 的超时提示说明"仍无握手会自动终止重试"
- 新增 4 个单测：卡死终止并重启、迟到握手不误杀、dispose 取消、timeout 参数校验
**为什么**：此前只有"进程退出"会触发重启。进程活着但卡死时没有 exit 事件，
界面会永远停在"不可用"，24/7 承诺已经破了。启动看门狗补上这条失败路径。
**验证**：
- `pnpm verify`：313 通过 / 9 跳过
- 单测：5 秒看门狗未收到握手 → SIGKILL 并排下一次重启；
  看门狗到点前收到握手 → 转 running 且不杀进程；
  dispose 后 10 秒不再杀；`startupTimeoutMs=0` 被拒绝
- 既有崩溃重启、桌面端、打包产物验证保持通过
**踩到的坑**：
- 看门狗不能在超时后直接 kill：daemon 可能只是慢一步；必须先复查握手，
  否则会周期性误杀正常启动的进程
- 定时器必须绑定 child，否则"旧进程的看门狗"会杀掉刚拉起的新进程
- `ensureRunning` 的超时只是 UI 等待上限（8 秒），不能等同启动上限（30 秒）
**留给下次**：
- 若用户在看门狗触发前退出应用，卡死的 daemon 仍会留在后台；
  下次启动会因单实例锁无法拉起。是否在启动时检测"活锁但无握手"并接管，
  需要和 launchd 协调一起设计
- 打包后的开机自启真机验证、正式签名/公证

### 2026-10-19 · R4 打包：可双击的 Aegis.app（ad-hoc）
**里程碑**：R4
**改了什么**：
- 新增 `tools/package-app.mjs`：构建 → ditto Electron.app → 改 Info.plist →
  复制 app/daemon/工作区包/随附 Node → ad-hoc 签名 → 真实启动自检
- 产物布局：`Resources/{app,daemon,node/bin/node,node_modules/@aegis/*}`
- `resolveNodeExecPath()` 支持 `Resources/node/bin/node`，打包态优先于系统 Node；
  `main.ts` 两处传入 `process.resourcesPath`，开机自启的 plist 也改用包内运行时
- 握手文件新增 `daemonVersion` / `nodeExecPath` / `daemonEntry`：
  修掉界面"服务版本"一直为 null 的问题，也让打包验证能证明 daemon 用的是包内运行时
- `package.json` 增加 `package` / `package:verify`；新增 3 个路径解析测试
**为什么**：R4 的"装上就不管"需要一个不依赖开发目录的 `.app`。
手写打包而不是引入 electron-builder，是因为当前只需要 macOS，
且 `@aegis/*` external 的产物规则已经稳定；
随附 Node 是为了避免用户机器 Node 版本漂移（ADR-01）。
ad-hoc 签名先保证本机可启动；正式分发仍需要 Developer ID + 公证。
**验证**：
- `pnpm verify`：309 通过 / 9 跳过
- `AEGIS_E2E_NO_SANDBOX=1 pnpm package:verify`：
  组装 423MB、`codesign --verify --deep --strict` 通过、
  真实启动截图 24505 字节、daemon `0.2.0-r2`、
  握手证明使用 `Resources/node/bin/node` 与 `Resources/daemon/main.js`
- 随附 Node `v24.17.0` 复制后直接执行 `-v` 校验
**踩到的坑**：
- 改 Info.plist/Resources 会让 Electron 原有签名失效，必须 `codesign --force --deep` 重签
- 复制 Electron.app 必须用 `ditto`：Frameworks 里的符号链接用 cpSync 不可靠
- 最初想用 `ps` 证明用了随附 Node，外层沙箱直接 EPERM；
  改为 daemon 在握手文件里自报 `nodeExecPath`/`daemonEntry`，更可靠也更有诊断价值
- Electron 的 `default_app.asar` 必须删掉，避免"到底加载了哪个 app"的歧义
- 打包自检仍需 `AEGIS_E2E_NO_SANDBOX=1`（外层沙箱）；正常 `open Aegis.app` 不需要
**留给下次**：
- 正式 Developer ID 签名 + 公证 + DMG；系统通知要等正式签名后才会恢复
- 应用图标仍是 Electron 默认；当前 `.app` 只含 arm64（跟随开发机），Intel/通用包未做
- 打包后的开机自启尚未在真机验证（plist 会指向包内 Node/daemon，应加一项自检）
- launchd KeepAlive 与监督者双重重启的协调（打包阶段更明显）

### 2026-10-19 · R4 崩溃自恢复：退避封顶且永不放弃
**里程碑**：R4
**改了什么**：
- 新增 `apps/desktop/src/restart-policy.ts`：重启退避抽成纯状态机；
  2 秒起、8 秒封顶（留在 NFR-R2 的 10 秒内），稳定运行 60 秒后重置失败计数
- 重构 `DaemonSupervisor`：改用注入的 `Clock`；删除"三次后永久停止重启"；
  连续失败仍按上限重试；spawn 同步抛错与异步 error 都进入重启流程；
  `dispose()` 取消待触发的重启定时器
- `apps/desktop` 增加 `@aegis/clock` 依赖，同步依赖方向门禁
- 新增 20 个单测（`restart-policy.test.ts` / `supervisor.test.ts`）
- `verify:desktop` 增加第 11 项：真 SIGKILL daemon，断言 10 秒内出现新 pid
**为什么**：旧实现连续三次异常退出后永久停止自动重启，而且失败计数从不重置。
对 24/7 产品来说，"放弃重启"等于静默死亡 —— 用户不会一直盯着界面，
发现时可能已经漏掉几天提醒。退避与计数只应决定"多久试一次"，
不能决定"是否继续试"；稳定运行后重置，则避免几个月内偶发三次崩溃被误判为死循环。
**验证**：
- `pnpm verify` 全绿：306 通过 / 9 跳过（新增 20 个用例）
- `AEGIS_E2E_NO_SANDBOX=1 pnpm verify:desktop` 11/11；
  真 SIGKILL 后 pid `50417 → 50478`，耗时 2122ms（< 10 秒）
- 单测覆盖：2/4/8/8 秒序列、连续失败 100 次仍重试、稳定 60 秒后重置、
  `dispose()` 后不再拉起、已有 daemon 复用、半截握手文件
**踩到的坑**：
- 本会话外层有 DSH 文件沙箱：Chromium 沙箱初始化失败，且写不了
  `~/Library/Application Support`。`verify-desktop` 增加 `AEGIS_E2E_NO_SANDBOX=1`
  开关，只有显式设置时才加 `--no-sandbox` 与临时 `--user-data-dir`（默认路径不变）
- 重装依赖后 Electron 二进制不会自动补下载；沙箱又禁止写 `~/Library/Caches`，
  需用 `electron_config_cache=/tmp/... node node_modules/electron/install.js`
- 环境预置了 `ELECTRON_RUN_AS_NODE=1`，启动 Electron 前必须清掉（老坑）
**留给下次**：
- R4 剩余：打包分发与签名（系统通知也依赖正式签名）
- daemon 活着但一直不写握手（卡死）目前只报 `unavailable`，没有重启；
  需先定"启动多久算卡死"，再决定是否 kill
- launchd `KeepAlive` 与监督者可能同时尝试拉起；打包阶段要统一，
  避免两个拉起者互相抢锁、把"抢锁失败"误判成崩溃循环

### 2026-10-19 · 建立开发流水账与强制机制
**里程碑**：工程机制
**改了什么**：
- 新增 `docs/DEVLOG.md`：开发流水账（当前状态快照 + 按时间倒序的记录）
- 新增 `tools/devlog.mjs`：`devlog` 查看 / `devlog:add` 插入模板 / `devlog:check` 校验
- 新增 `tools/pre-commit-hook.mjs`：改了代码却没更新流水账 → 拒绝提交
- `tools/install-hooks.mjs` 改为安装两个 hook（commit-msg + pre-commit）
- `pnpm verify` 增加 `devlog:check`
- `AGENTS.md` 增加"第 0 条：先读流水账、改完写流水账"
- `aegis-task-workflow` 技能的标准流程加入第 ⓪ 步与第 ⑤ 步
- 回填了 R0–R3 共 11 条历史记录（依据真实提交历史与 README 的 F/C 编号）
**为什么**：这个项目跨多个会话推进，最大的风险不是写不出代码，而是**失忆** ——
上一次的临时决定，下一次就变成无从解释的既成事实。靠"记得写文档"必然失败，
所以把它做成机械强制：flow 是「读快照 → 干活 → 写记录 → 提交」，
少一步就提交不了。记录格式刻意要求写"为什么"和"验证"，因为这两项最容易丢。
**验证**：
- 临时仓库验证四种场景：改代码不改流水账 → 拒绝；改代码+更新 → 通过；
  只改文档 → 通过；`AEGIS_SKIP_DEVLOG=1` → 跳过并提示
- 真实仓库验证：`git commit` 确实被拦截并给出可照抄的解决步骤
- `tools/devlog.mjs check` 通过（11 条记录，字段齐全）
**踩到的坑**：`devlog --last 8` 把选项当成了子命令（已改为"首参是选项则按 show 处理"）
**留给下次**：模板里"里程碑/改了什么/为什么/验证"四个字段是硬性要求，
新增字段时记得同步更新 `tools/devlog.mjs` 的 `REQUIRED_FIELDS`

### 2026-10-19 · 系统通知被 macOS 拒绝，改用前台强提醒兜底
**里程碑**：R3 修复
**改了什么**：
- 新增 `apps/desktop/src/attention.ts`：分层提醒（系统通知 → 前台强提醒）
- 系统通知必须收到 `show` 事件才算成功，加 `failed` 与超时兜底
- 启动时用静音探测通知判断真实可用性，结果写入状态接口
- 界面如实展示"系统通知不可用（改用窗口提醒）"及原因
- 修复：通道把分层结果整个对象塞进 `outcome`，导致写库时报
  `cannot be bound to SQLite parameter`
- 修复：退出时窗口已销毁仍调 `webContents.send`，抛 `Object has been destroyed`
  并弹主进程崩溃对话框
- Electron 未捕获异常改为"记录 + 界面提示 + 继续运行"，不再弹模态框
**为什么**：用户报告"发送成功但收不到"。系统日志证明 macOS 拒绝未签名应用投递：
`Entitlement 'com.apple.private.usernotifications.bundle-identifiers' required`。
更严重的是我们一直在**谎报成功** —— `Notification.show()` 失败时不抛异常，
只看"没报错"就返回 success。这是最坏的失败：看起来在工作。
**验证**：`pnpm verify` 295 测试全绿；`pnpm verify:desktop` 10/10；
真实触发提醒后截图确认窗口提醒可见（含"系统通知不可用"说明）。
**踩到的坑**：见 README F25–F27（通知不抛异常、窗口销毁后发送崩溃、默认崩框行为）
**留给下次**：正式解决需要 Apple Developer 签名（R4）。代码已就绪 —— 探测到可用会自动切回系统通知。

### 2026-10-19 · 修复"daemon 尚未就绪"，并让问题可排查
**里程碑**：修复
**改了什么**：
- `ensureClient` 从"读不到握手就抛错"改为最多等 10s 并重试，超时给出带原因的错误
- 界面新增 `daemonReady`：未就绪时禁用需要后端的按钮，显示"后台服务启动中…"
- 初始化顺序调整：先建监督者（立刻能报 starting）再建窗口
- 完整日志写入 `<dataDir>/desktop.log`，终端同时显示 warn/error
- 新增 `AEGIS_E2E_SMOKE` 冒烟动作：冷启动 150ms 后立刻调 testNotify
**为什么**：用户点"测试通知"报"daemon 尚未就绪"。daemon 冷启动要几百毫秒，
而向导第 2 步恰好邀请用户立刻点按钮。另有两个帮凶：失败后永不重试、
`run-desktop` 只转发 error 日志导致无从排查。
**验证**：冷启动 150ms 点击 → `SMOKE_NOTIFY_OK`；`verify:desktop` 增至 10 项
**踩到的坑**：我的 E2E 等待 25 秒才检查，完美避开了冷启动窗口 —— 测试通过但漏掉真实路径
**留给下次**：无

### 2026-10-19 · 一条命令启动，并根除产物污染 src
**里程碑**：工程改进
**改了什么**：
- `tools/dev.mjs`：智能增量构建后启动，`pnpm dev` / `pnpm start` 均可
- 修正 `pnpm start` 指向不存在的 `main.cjs`
- 根因修复：声明生成不再把依赖 `paths` 映射到源码（导致 `.d.ts` 写进 src）
- `TARGETS` 加拓扑排序（原先 scheduler 排在 storage 之前，顺序是错的）
- 桌面壳改用包级子路径导出 `@aegis/daemon/ipc-client`
**为什么**：原本要两步（build + run），忘构建的症状是"界面开着但代码是旧的"，最难察觉。
顺带查清了困扰多轮的问题：**每次构建都会往 src 写 20+ 个 `.d.ts`** —— 之前三次都是手工删掉，
直到它开始破坏"产物是否过期"的判断才被迫正视。
**验证**：src 下 0 个产物；快路径 4.5s 进界面；`pnpm verify` 全绿
**踩到的坑**：见 README F22 / F23。**教训：反复出现的"小脏东西"通常是设计缺陷的症状，不是卫生问题。**
**留给下次**：无

### 2026-10-19 · 首次启动向导与开机自启
**里程碑**：R3
**改了什么**：
- `packages/platform/src/autostart.ts`：macOS LaunchAgent（RunAtLoad + KeepAlive）
- 3 步向导：欢迎（时区说明）→ 通知自检 → 自启 + 「不需要配置模型」
- 完成标记写在数据目录而非 Electron userData
**为什么**：自启的是 **daemon** 而不是界面 —— 用户登录后静默在后台工作，
不弹窗口。完成标记放在数据目录，是为了"重装界面或用 CLI 起过服务都不重复弹向导"。
**验证**：真实安装 → plist 生成 → 探测已启用 → 卸载清理，全链路通过
**踩到的坑**：`AEGIS_CAPTURE_TAB` 用"加载后点击"切换页签不可靠，改为 URL query 决定初始页签
**留给下次**：Windows/Linux 自启（M8）

### 2026-10-19 · R3 桌面外壳：可本地打开使用
**里程碑**：R3
**改了什么**：
- `apps/desktop`：Electron 主进程 + preload（白名单桥）+ renderer（无框架）
- `packages/platform/src/desktop-channel.ts`：daemon 反向调用 Electron 弹通知
- 三块界面（提醒/历史/设置）、托盘常驻、截图回归模式
- `tools/verify-desktop.mjs`：9 项真实启动验证
**为什么**：daemon 是长期居民，UI 是随时可关的观察窗 —— 关闭窗口不退出 daemon。
通知方向必须是 daemon → Electron（决策与呈现分离），详见 ADR-R3-01。
**验证**：`os_notification:success`（此前一直是 permanent_error → cli_fallback）
**踩到的坑**：见 README F18–F21（`ELECTRON_RUN_AS_NODE` 强制 Node 模式、
`electron` 包不能被打包、sandbox 下 preload 必须 CJS、绝对耗时断言会间歇失败）
**留给下次**：系统通知权限问题（下一条记录解决）

### 2026-10-19 · R2 调度引擎：daemon 真的会到点提醒
**里程碑**：R2
**改了什么**：
- `@aegis/recurrence`：RRULE 子集求解器（墙钟语义 + DST）
- `@aegis/scheduler`：materialize / dispatch / deliver / reconcile
- `@aegis/platform`：macOS 双渠道（原生 + osascript 兜底）
- 三个新 DAO（notification / outbox / delivery-attempt）
- CLI：status / add / list / history / test-notify / pause / resume / rm / start / stop
**为什么**：派发权必须由数据库影响行数裁决，绝不依赖内存状态；
时间一律走注入的 Clock，否则"30 天不漏报"无法自动化验证。
**验证**：30 天长跑 4320 条 0 重复；`pnpm verify` 267 测试；
CLI 端到端 `aegis add --in 8s` 真实投递
**踩到的坑**：见 README F10–F17。最严重的是 **DST 空洞破坏严格升序**（出现 -51 分钟间隔），
最终靠"求解器出口统一单调化 + 去重"解决 —— 这不是策略问题，是 DST 的固有限制
**留给下次**：R3

### 2026-09（R1 期间）· 运行时基础
**里程碑**：R1
**改了什么**：存储（SQLite + 迁移 checksum 锁）、凭据（钥匙串）、单实例锁、IPC、审计
**为什么**：先把"可靠运行"的地基打好，再谈业务。迁移只增不改是为了
"老用户库结构与新装一致"。
**验证**：87 → 96 测试（沙箱外跑真实钥匙串用例）；`pnpm verify` 全绿
**踩到的坑**：见 README C-1–C-9（`allowExtension` 建库时给、vec0 主键要 BigInt、
IPC 重连必须重放握手、钥匙串必须 `-w` 且显式指定）
**留给下次**：R2

### 2026-02（R0 期间）· 工程骨架与 6 项技术验证
**里程碑**：R0
**改了什么**：pnpm workspace、9 个包骨架、构建链（tsc + esbuild + d.ts）、
6 个 spike（SQLite/向量、IPC、钥匙串、LaunchAgent、通知、macOS 权限）
**为什么**：先把"技术前提是否成立"验证掉，避免在错误的地基上写业务代码。
**验证**：6/6 通过，结论写入 `R0-spike结论报告.md` 与 README 的 F1–F9
**踩到的坑**：`tsc -b` 项目引用不可用（exports→dist 鸡生蛋）、
esbuild CLI bin 是 shell 脚本不能 `node` 调用、ESM 下不能加 shebang banner
**留给下次**：R1

---

## 怎么用（给 AI/协作者）

### 开始工作前

```bash
# 1. 看当前状态（本文件顶部）+ 最近 3 条
sed -n '1,60p' docs/DEVLOG.md

# 2. 看技术事实与约束
grep -n "^| F\|^| C-" README.md | head -40

# 3. 确认基线是绿的
pnpm verify
```

### 改完代码后

```bash
pnpm devlog:add          # 交互式追加一条（会自动填模板与日期）
pnpm devlog              # 回看最近几条，确认写明白了
```

### 提交时

`git commit` 会由 pre-commit hook 检查：改了代码却没更新本文件 → **拒绝提交**。
这是刻意的 —— 如果流水账可以"下次再补"，那它永远不会被补。

确需跳过（例如只改了注释错别字）：`AEGIS_SKIP_DEVLOG=1 git commit ...`，
但请在提交信息里说明为什么。
