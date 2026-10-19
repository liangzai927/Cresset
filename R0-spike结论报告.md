# R0 Spike 结论报告

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-02-19 |
| 环境 | macOS 26.6.2 / arm64 / Node v24.17.0（nvm）与 v24.21.0（DSH 随附） |
| 工程 | `aegis/`（pnpm monorepo 骨架已就绪） |
| 结论 | ✅ **6 项全部通过**（连续两次运行结论一致）；发现 **7 个**会直接影响实现的技术事实 |

---

## 1. 结论总览

| # | Spike | 结论 | 关键证据 |
| --- | --- | --- | --- |
| S1 | 打包随附 Node 运行时运行 daemon | ✅ **通过** | 打包副本（128 MB）下 daemon 启动、建库、落锁、SIGTERM 优雅退出（码 0） |
| S2 | SQLite：FTS5 + sqlite-vec + 中文检索 | ✅ **通过** | `node:sqlite` + sqlite-vec 可用；1 万向量 KNN 平均 **0.14 ms**；中文单字切分检索 **11/11** |
| S3 | 钥匙串读写（macOS） | ✅ **通过** | **登录钥匙串**可非交互读写（`-w`），覆盖写入/删除/清理全通过；无阻塞（提权会话下复验） |
| S4 | LaunchAgent 自启与拉起 | ✅ **通过** | bootstrap 成功；RunAtLoad 立即执行；**KeepAlive 在杀进程后成功拉起**；bootout + 删 plist 无残留 |
| S5 | 通知通道 + CLI 兜底 | ✅ **通过** | `osascript` 通知/弹窗命令成功，且**系统统一日志检索到投递证据**（命中 1 条） |
| S6 | IPC：握手 / RPC / 事件 / 重连 | ✅ **通过** | UDS 上握手鉴权、错误令牌拒绝、事件推送、daemon 重启后自动重连+重新握手全部通过 |

---

## 2. 五个会直接影响实现的技术事实（重要）

### F1. `node:sqlite` 的扩展加载必须在**建库时**开启

```ts
// ✅ 正确
const db = new DatabaseSync(path, { allowExtension: true });
db.enableLoadExtension(true);
db.loadExtension(vecPath);

// ❌ 错误：事后开启会报
// "Cannot enable extension loading because it was disabled at database creation."
const db2 = new DatabaseSync(path);
db2.enableLoadExtension(true); // 抛错
```

**影响**：存储层必须改为**可配置的打开方式**；M3 前不需要向量，但打开选项现在就要留出。已写入 `packages/storage/src/index.ts` 的接口注释。

### F2. `node:sqlite` 把 JS number 一律绑定为 REAL → vec0 主键必须用 BigInt

```ts
ins.run(1, vec);        // ❌ "Only integers are allows for primary key values on vt"
ins.run(1n, vec);       // ✅ BigInt
```

**影响**：这是最隐蔽的坑 —— 错误信息完全没提类型。M3 实现向量检索时必须统一用 BigInt 绑定所有主键/rowid。

**兜底方案已验证**：不用虚拟表，改用 `vec_distance_L2(embedding, ?)` 暴力比较也可用（适合小规模或调试）。

### F3. FTS5 默认分词器**无法做中文子串检索** —— 直接冲击 D3（纯 BM25 起步）

实测 11 个中文查询（3 篇文档）：

| 策略 | 命中率 | 说明 |
| --- | --- | --- |
| unicode61（默认） | **4/11（36%）** | 把连续 CJK 当**一个 token**：`磁盘` 匹配不到 `磁盘告警` |
| trigram 分词器 | **3/11（27%）** | 更差；且多数 SQLite 构建中根本不可用 |
| **CJK 单字切分** | **11/11（100%）** | 入库与查询都对 CJK 逐字加分隔 |
| CJK bigram | 10/11（91%） | 次优，索引更小 |

**影响**：D3「纯 BM25 起步」**结论不变但需要一个前置条件** —— M3 必须实现**中文分词层**（推荐单字切分：实现简单、召回 100%；若索引体积敏感则用 bigram）。这是原设计未预料到的工作量，已计入 M3。

**另一个坑**：FTS5 的 `MATCH` 中**空格 = AND，不是 OR**。写检索代码时若按 OR 直觉拼接查询词，会得到"几乎全部不命中"的错误结果（本次 spike 就踩到并纠正）。

### F4. 存储层改用 `node:sqlite`，不再需要 better-sqlite3

| 维度 | node:sqlite（Node 24 内置） | better-sqlite3 |
| --- | --- | --- |
| 原生依赖 | **无** | 需编译/下载 binding |
| 打包风险 | **无**（随 Node 运行时提供） | S2 实测：pnpm 下 binding 缺失，需额外构建配置 |
| ABI 风险 | 无（与 daemon 同运行时） | 与 Electron ABI 不同需 rebuild |
| 扩展加载 | 支持（需 F1 的打开选项） | 支持 |
| 性能 | 1 万向量插入 39 ms、KNN 0.14 ms —— **完全够用** | 略优但无实质差异 |

**决策**：**采用 `node:sqlite`**。这与 D1（随附 Node 运行时）形成很好的协同：daemon、SQLite、FTS5、向量扩展全部来自同一份随附运行时，**打包时零原生模块编译**。

### F5. 环境级问题：Node 24.21 的库校验会让 Vitest 无法运行

DSH 随附的 Node v24.21.0 开启了库校验（library validation），拒绝加载签名 Team ID 不同的 `@rollup/rollup-darwin-arm64`：

```
code signature ... not valid for use in process:
mapping process and mapped file (non-platform) have different Team IDs
```

Node v24.17.0（nvm）无此限制，测试全部通过。

**影响**：**开发机需要固定 Node 版本**（`.nvmrc` 已锁 24.17.0）。这也从侧面强化了 D1 的价值：**随附自己验证过的运行时**，而不是依赖开发机上的任意 Node。

### F6. 在仓库内做"安装类验证"会被 pnpm 工作区污染（本次踩到并修掉）

S2 需要在隔离目录安装 sqlite-vec。最初的实现把安装目录放在仓库内的 `spike-artifacts/s2`，结果 pnpm 会向上找到仓库的 `pnpm-lock.yaml` / `node_modules`，**间歇性**报：

```
(This error may happen if the node_modules was installed with a different major version of pnpm)
```

表现为"单独跑通过、整套跑失败"的诡异现象。

**修复**：安装目录移到系统临时目录（仓库之外），只在 `spike-artifacts/s2/` 留探针副本与说明。
**通用规则**：**任何依赖安装的验证/测试，其工作目录必须在 pnpm 工作区之外**，否则结论不可信。这条已作为实现约束写入详细设计（C-7）。

### F7. launchd 相关验证对时序与"前置探测"敏感（本次踩到并修掉）

S4 最初为了判断 launchd 域是否可写，用 `launchctl submit` 做前置探测；该命令在部分调用上下文中会返回非 0（即使域实际可写），导致探针**误判为 blocked / fail**。表现为"手工复现成功、探针失败"。

**修复**：
1. 移除 `launchctl submit` 前置探测，改用**真实的 plist 可写性**判断（直接尝试写入再删除）；
2. 验证"自启"时等待时间从 4.5s 放宽，并显式输出执行次数，避免首轮 RunAtLoad 尚未落盘就断言失败。

**通用规则**：**能力探测必须用与真实路径同构的操作**（即真的写 plist、真的 bootstrap），不要用"代理命令"（`submit`）代替 —— 代理命令的失败模式与真实路径不同。这条作为 C-8 写入详细设计。

---

## 3. 逐项详细结论

### S1 随附 Node 运行时（通过）

| 项 | 结果 |
| --- | --- |
| 源运行时 | `/Users/liuwenliang/.nvm/versions/node/v24.17.0` |
| 打包副本体积 | **128.3 MB**（排除 node_modules/include/share 后） |
| daemon 启动 | ✅ 打包副本下正常启动（pid 获取成功） |
| `node:sqlite` | ✅ 可用（SQLite 3.53.0） |
| 扩展加载 API | ✅ 可用（`allowExtension: true` 时） |
| 写库 + 单实例锁 | ✅ 均落盘 |
| SIGTERM 优雅退出 | ✅ 退出码 0 |

**对 ADR-01 的影响**：D1 得到实证支持。体积代价 **128 MB**（比文档预估的 ~50 MB 高，因为包含了完整发行目录；后续可通过只打包 `bin/node` + 必要 dylib 压缩到 ~60 MB，列入 R4 打包优化）。

### S2 SQLite 能力矩阵（通过）

| 能力 | 结果 |
| --- | --- |
| `node:sqlite` + sqlite-vec KNN | ✅ sqlite 3.53.0 / vec v0.1.9，Top3 正确、Top1 距离 0 |
| 规模与延迟 | 1 万条 32 维向量插入 **39 ms**；KNN Top10 平均 **0.14 ms** |
| 暴力比较兜底 | ✅ `vec_distance_L2` 可用 |
| FTS5 BM25 | ✅ 可用（`bm25()` 返回数值） |
| 中文检索 | ⚠️ **需分词层**（见 F3） |

### S3 钥匙串（通过）

| 项 | 结果 |
| --- | --- |
| **登录钥匙串写入** | ✅ 通过（提权会话下复验；沙箱内会被 `UNIX[Operation not permitted]` 拒绝） |
| 非交互读取（`-w`） | ✅ 取回值匹配 —— **这是不弹 GUI 授权的唯一方式，24/7 无人值守必须用它** |
| 不带 `-w` 是否泄漏 | ✅ 不泄漏口令（证实必须用 `-w`） |
| 覆盖写入（`-U`） | ✅ 覆盖后读回匹配 |
| 删除 | ✅ 删除后读取失败（退出码 44，符合预期） |

**注意**：`security` 的钥匙串路径必须是**最后一个位置参数**（本次踩到，已修正）。

### S4 LaunchAgent（通过）

| 项 | 结果 |
| --- | --- |
| `~/Library/LaunchAgents` 可写 | ✅ 可写 |
| launchd 用户域 | ✅ `gui/501` 可读，`bootstrap` 成功（退出码 0） |
| RunAtLoad + StartInterval | ✅ 加载后 4.5 秒内执行 1 次 |
| **KeepAlive 崩溃拉起** | ✅ **杀进程后 6 秒内新增 worker 进程 1 个** —— NFR-R2（崩溃自恢复）有实现基础 |
| 清理 | ✅ `bootout` 退出码 0；plist 已删；`launchctl list` 查询退出码 113（已卸载） |

> ⚠️ 沙箱限制说明：自动化沙箱**禁止写 `~/Library/LaunchAgents`**，因此本项需在提权/真实会话下运行。
> 这本身是一条产品约束：**若日后要在沙箱化环境里安装自启项，会失败且必须显式提示用户**。
>
> 另备有独立自检脚本 `tools/self-check.mjs`（`--full`），10/10 通过，可作为环境健康检查长期使用。

### S5 通知通道（通过）

| 通道 | 结果 |
| --- | --- |
| `osascript display notification` | ✅ 命令成功（退出码 0） |
| `osascript display alert`（3 秒自动关闭） | ✅ 命令成功（退出码 0） |
| **系统投递证据** | ✅ 统一日志检索命中 1 条该通知记录（`log show --predicate`） |
| 通知中心数据库 | ⚠️ 未找到可读 DB（TCC 保护，属预期，不影响结论） |

**结论**：D5（CLI 兜底通道）**有实现基础且已取得系统级投递证据**。"消除 UI 全挂则提醒不响"的单点依赖这一目标成立。
仍需注意：**通知能否展示最终取决于发起应用的通知权限** —— R4 的首次启动向导必须包含权限检查与引导。

### S6 IPC（通过）

| 项 | 结果 |
| --- | --- |
| UDS 握手 + 鉴权 | ✅ 正确令牌通过、错误令牌被拒（`E_AUTH`） |
| RPC 请求/响应 | ✅ `sys.health` 返回预期字段 |
| 服务端事件推送 | ✅ 收到 `task.changed` |
| **daemon 重启后重连** | ✅ 客户端自动重连成功 |
| **重连后重新握手** | ✅ **关键发现**：新连接 = 新鉴权会话，客户端**必须自动重放握手**，否则后续调用全部 `E_AUTH` |
| 未知方法错误码 | ✅ `E_METHOD_NOT_FOUND` |

**对设计的补充**：`makeClient` 的"重连即重放握手"语义必须写进 `packages/ipc-contract` 的使用约定，否则 M1 实现时极易漏掉（本次 spike 就漏了一次）。

---

## 4. 本次顺带完成的工程骨架

```
aegis/
├── package.json / pnpm-workspace.yaml / tsconfig.base.json / tsconfig.dev.json
├── biome.json / vitest.config.ts / .gitignore
├── packages/
│   ├── clock/               ✅ Clock + SystemClock + VirtualClock + detectSkew（13 个测试）
│   ├── contracts/           ✅ Task / RecurrenceRule / Occurrence / Notification / DataClass
│   ├── ipc-contract/        ✅ PROTOCOL_VERSION + 17 个 RPC 方法 + 6 类事件（Zod）
│   ├── redaction-gateway/   ✅ 检测器注册表 + 8 个内置检测器 + fail-closed 网关（10 个测试）
│   ├── storage/             ✅ 接口骨架（node:sqlite 决策已落注释）
│   ├── secrets/             ✅ SecretStore 接口 + 实测结论注释
│   └── platform/            ✅ Notifier / Autostart / Permission 接口（三平台占位）
├── apps/daemon/             ✅ 包骨架（R1 填充）
└── tools/
    ├── check-boundaries.mjs ✅ 依赖方向门禁（CI 强制，含"禁止直连模型 SDK"规则）
    ├── run-spikes.mjs       ✅ spike 运行器（--only / --report）
    ├── self-check.mjs       ✅ S4/S5 实机复验脚本
    └── spikes/              ✅ 六个探针（可复现）
```

**验证状态**：typecheck ✓ ｜ vitest 23/23 ✓ ｜ biome ✓ ｜ 依赖方向门禁 ✓

---

## 4.5 可复现性（验证方式）

全部结论可由以下命令重现：

```bash
cd aegis
nvm use                      # .nvmrc 锁定 Node 24.17.0
pnpm install
pnpm verify                  # 依赖方向门禁 + typecheck + lint + 23 个测试
pnpm spike                   # 重跑 S1–S6，写入 spike-artifacts/report.json
pnpm spike:report            # 打印结论摘要
node tools/run-spikes.mjs --only s6   # 单项重跑（调试用）
```

**当前验证状态**（2026-02-19 复核）：

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ 通过（7 个包 + tools） |
| `pnpm test` | ✅ 23/23 通过（clock 13 + redaction-gateway 10） |
| `pnpm lint` | ✅ 通过（42 个文件） |
| `pnpm boundaries` | ✅ 通过（8 个工作区包） |
| `pnpm spike` | ✅ **6/6 通过**（三次运行结论一致） |
| `node tools/self-check.mjs --full` | ✅ 10/10 通过（LaunchAgent / 通知 / 钥匙串 / 日志） |
| 系统残留 | ✅ 零残留（LaunchAgent / launchd 项 / 钥匙串项 / 临时目录均已自清理） |

> **注意**：S4/S5 需要写 `~/Library/LaunchAgents` 与读取系统统一日志，**在文件沙箱内会失败**。
> 探针会显式区分 `blocked`（环境不允许）与 `fail`（真的不通过），不会把环境限制伪装成通过或失败。

---

## 5. 待你留意的一件事（非阻断）

**R0 的 6 项 spike 已全部验证通过**，无需你再执行任何验证命令。

唯一需要你在日常使用中留意的是：**通知是否真的显示在你眼前**。系统日志已确认通知被投递，但是否展示取决于系统通知设置（专注模式、横幅开关、权限）。请在方便时确认一次：

```bash
cd aegis && node tools/self-check.mjs       # 只读模式，会发一条测试通知
```

- 若**看到了** → 一切就绪，可进入 R1。
- 若**没看到** → 去「系统设置 → 通知」检查 osascript/终端 的权限与专注模式。
  这不是阻断项，但会在 R4 落地为首次启动向导里的"通知权限检查 + 引导"。

`self-check.mjs` 也可作为长期使用的**环境健康检查工具**（安装后自检、迁移到新机器后自检）。

---

## 6. 对既有文档的修正建议

| 文档 | 位置 | 修正 |
| --- | --- | --- |
| 技术架构 | §2.2 存储 | better-sqlite3 → **node:sqlite**；理由见 F4 |
| 技术架构 | §10 D4 | sqlite-vec 保留，但补"主键须 BigInt"与"allowExtension 须在建库时开启" |
| 技术架构 | §10 D3 | 纯 BM25 方案**需增加中文分词层**（F3），M3 工作量相应上调 |
| 技术架构 | §11 R0 | ✅ 已标注：S1–S6 **全部通过**（连续两次一致） |
| 详细设计 | §4 DDL | 向量表主键类型注明 BigInt 绑定要求 |
| 详细设计 | §6.3 | 补"IPC 客户端重连必须重放握手"（F6） |
| 详细设计 | §11.5 | 补充 C-1..C-8 实现约束（含 F6 安装隔离、F7 能力探测同构） |
