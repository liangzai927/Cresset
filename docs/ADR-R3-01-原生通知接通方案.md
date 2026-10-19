# R3 架构决策：原生通知如何接通（ADR-R3-01）

> 本文记录 R3 最重要的一个设计取舍。它直接影响"通知会不会响"，是本项目的核心承诺。

## 问题

R0–R2 的实现里，daemon 是**独立进程**，通知渠道只有：

| 渠道 | 状态 |
| --- | --- |
| `os_notification` | 只有接口（`NativeNotifier`），实际不可用 —— 它的发送方是 Electron，但 daemon 不依赖 Electron（刻意的架构隔离） |
| `cli_fallback` | 可用（`osascript display notification`，R0 S5 已验证） |

于是 R2 的每一次投递都是"原生失败 → 降级到 CLI"。功能上能用，但有两个问题：

1. **体验差**：osascript 通知没有图标、没有"打开应用"的交互，也不进通知中心分组
2. **语义退化**：用户会觉得"高级渠道坏了、一直在用兜底"，而实际上这是设计缺口

## 候选方案

### 方案 A：daemon 内嵌 Electron

让 daemon 直接 `require("electron")` 发通知。

- ❌ 直接违背架构约束："daemon 必须能在无 UI 时独立运行"（且 Electron 内 Node 与系统 Node 版本漂移）
- ❌ 打包后 daemon 无法在无 GUI 环境启动
- **否决**

### 方案 B：daemon 经 stdout/日志传递，Electron 解析

Electron 监听 daemon 日志，看到通知事件就自己弹。

- ❌ 日志是**诊断通道**，把它变成业务通道会让"日志格式"变成隐式契约，非常脆弱
- ❌ 无法回传投递结果（daemon 永远不知道通知有没有真的弹出）
- **否决**

### 方案 C：Electron 提供一个本地回调端点，daemon 反向调用（**采纳**）

```
Electron 主进程                           daemon
─────────────────                        ──────
启动时开一个本地 HTTP 服务
  127.0.0.1:<随机端口>
  写 channel.json（端点 + token，0600）
        │
        │  ← daemon 每次投递前读取 channel.json
        │
        │  POST /notify  {title, body, ...}
        │  Authorization: Bearer <token>
        │
  用 Electron Notification 弹出
        │
        │  200 {outcome:"success"}
        ▼
                                   recordAttempt(channel="os_notification")
```

**采纳理由：**

| 维度 | 收益 |
| --- | --- |
| 架构隔离 | daemon 仍然**零 Electron 依赖**；Electron 不启动时该渠道自动不可用（降级到 CLI） |
| 进程关系 | daemon 主动调用 UI，UI 崩溃不影响调度；UI 重启后 daemon 自动用新端点 |
| 可观测 | 投递结果能回传，`delivery_attempt` 记录的是真实结果，不是"我以为成功了" |
| 可测试 | 端点可以注入假实现；daemon 侧的 sender 可用本地 HTTP 服务测试 |
| 安全 | 只监听 `127.0.0.1`、随机端口、Bearer token |

**代价**：多一个本地 HTTP 服务（约 120 行）+ 一个渠道发现机制（读 `channel.json`）。

## 关键设计细节

### 1. 端点发现：`channel.json` 而非固定端口

固定端口会冲突（用户可能开了多个 profile）。做法：

```
<dataDir>/channel.json      # 0600，daemon 可读
{
  "endpoint": "http://127.0.0.1:52341",
  "token": "<随机 32 字节 hex>",
  "pid": 12345,
  "startedAt": 1774...
}
```

**daemon 侧每次投递前重新读它** —— 这样 Electron 重启后换了端口也能立刻生效，不需要重启 daemon。

**探测顺序**（daemon 的 `DynamicNativeNotifier`）：
1. 读 `channel.json`，不存在 → 该渠道不可用（降级到 CLI）
2. 存在但 `pid` 不存活 → 视为陈旧，删除后视为不可用
3. 存在且存活 → 用它

### 2. Token 与权限

- token 随机生成，只写进 0600 的 `channel.json`
- 每次投递带 `Authorization: Bearer <token>`
- 端点**只**监听 `127.0.0.1`（不监听 `0.0.0.0`）
- 校验 `Host` 头，拒绝非本机请求（防 DNS rebinding）
- 并发上限（避免被本地恶意进程刷爆主线程）

### 3. 超时与失败语义

| 情况 | 结果 | 降级 |
| --- | --- | --- |
| HTTP 200 + `success` | 成功 | 不降级 |
| 连接被拒 / 5 秒超时 | `transient_error` 或 `timeout` | 按策略（超时→降级，瞬时→重试） |
| 401 / token 不匹配 | `permanent_error` | 立刻降级到 CLI |
| Electron 正在退出（ECONNRESET） | `transient_error` | 重试，最终降级 |

### 4. 为什么不用 Unix socket

技术上可以（daemon 与 UI 都在本机）。但选 HTTP over loopback 的原因：

- Electron 的 `http` 模块与 Node 一致，没有额外依赖
- 手工调试方便（`curl` 就能测）
- 避免 UDS 路径长度限制（约束已踩过，见 `resolveDataPaths` 的 fallback）

代价是"任何本机进程都能连"——因此 token 是必需的，不是可选的。

## 影响

- `packages/platform` 增加 `DesktopChannelSender`（HTTP 客户端）+ `channel.json` 读写
- `apps/daemon` 的渠道构造改为动态（每次投递探一次），而非启动时固定
- `apps/desktop` 增加 `channel-host.ts`（HTTP 服务 + 权限校验 + Electron 通知）
- 新增约束 **C-10**：`channel.json` 必须 0600，且 daemon 必须校验其 `pid` 存活

## 与 PRD 的一致性

PRD §12.1 要求"通知权限失败则界面常驻警告"。
本方案下 Electron 能在**开始投递前**就知道权限状态（`Notification.isSupported()` + 首次发送的真实结果），
因此界面上可以准确区分：

- "通知渠道正常"
- "原生通道不可用，正在使用 CLI 兜底"（可点击查看原因）
- "全部渠道失败"（红色横幅）

这正是 PRD 要求的"失败必须可见"在 R3 的落地方式。
