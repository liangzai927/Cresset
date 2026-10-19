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
| 阶段 | **R4 进行中**（自启/崩溃自恢复/ad-hoc 打包已完成），剩余正式签名与公证 |
| 版本 | daemon `0.2.0-r2` ／ 桌面 `0.3.0-r3` |
| 校验 | `pnpm verify` 全绿（309 测试）＋ `pnpm verify:desktop` 11/11 ＋ `pnpm package:verify` 通过 |
| 启动 | `pnpm dev`（智能增量构建后启动；打包产物为 `dist/Aegis.app`） |
| 数据目录 | `~/Library/Application Support/Aegis`（含 `desktop.log`） |
| 已实现 | 提醒创建/重复规则/到点投递/补偿/免打扰/历史/托盘/自启/首次向导/崩溃自恢复/打包（ad-hoc） |
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
