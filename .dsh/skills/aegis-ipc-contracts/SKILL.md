---
name: aegis-ipc-contracts
description: Aegis 的进程间契约规范（daemon↔UI 的 JSON-RPC 与事件）。**新增/修改 IPC 方法、事件、或契约 schema 时加载**。它规定契约的单一真相源位置、方法命名与错误码约定、事件命名、协议版本协商、以及必须遵守的鉴权语义（C-4：新连接 = 新鉴权会话，重连必须重放握手）。当你要让 UI 调用一个新能力、推送一个新事件、或调试 E_AUTH / E_METHOD_NOT_FOUND 时，加载本技能。
---

# Aegis IPC 契约规范

## 1. 契约的唯一真相源

```
packages/ipc-contract/src/index.ts     ← 方法与事件的 Zod 定义（两侧共享）
packages/contracts/src/index.ts        ← 被引用的领域类型（Task/Occurrence/…）
```

**规则**：daemon 与 UI 都从这里导入类型；**禁止**各自定义一份结构。
契约变更必须同步快照测试 —— 两侧版本漂移是这类系统最典型的故障。

## 2. 传输与协议

| 项 | 约定 |
| --- | --- |
| 传输 | macOS/Linux：**UDS**；Windows：**NamedPipe** |
| 分帧 | **NDJSON**（一行一个 JSON），避免粘包解析复杂度 |
| 协议 | **JSON-RPC 2.0**：请求-响应 + 单向 notification（事件推送） |
| 鉴权 | 首帧必须是 `sys.hello` 且 token 匹配，否则 `socket.end()` |
| 权限 | socket 文件 `0600`；token 只写进 `0600` 的握手文件 |
| 版本 | `hello` 返回 `protocolVersion`；不匹配时客户端抛 `ProtocolMismatchError`（不要静默错乱） |

## 3. ★ 鉴权语义（C-4，R0 S6 实测得出）

> **每个新连接都是新的鉴权会话。** 服务端**不会**把上一个连接的鉴权状态带到新连接上。

因此：

```
客户端每次（重）连接后都必须重放 sys.hello
```

**这条已经内聚在 `IpcClient` 里**：调用方登记握手参数（`setHandshake` 或在构造时给 token），
`connect()` 时自动重放。**新增客户端实现时必须遵守**，否则重连后所有调用都会被 `E_AUTH` 拒绝
（R0 S6 第一次跑就是这么失败的）。

## 4. 方法命名与类型

| 前缀 | 用途 | 例子 |
| --- | --- | --- |
| `sys.` | 系统/生命周期 | `sys.hello`、`sys.health`、`sys.shutdown` |
| `task.` | 提醒任务 | `task.list`、`task.create`、`task.snooze` |
| `notify.` | 通知 | `notify.history`、`notify.test` |
| `ctrl.` | 全局控制 | `ctrl.pauseAll`、`ctrl.resumeAll` |
| `dnd.` | 免打扰 | `dnd.get`、`dnd.set` |
| `platform.` | 平台能力 | `platform.permissionStatus`、`platform.autostartSet` |
| `backup.` | 备份迁移 | `backup.export`、`backup.import` |
| `diag.` | 诊断 | `diag.recentLogs` |

**新增方法时必须同时定义**：

- `params` 的 Zod schema（**严格模式 `.strict()`**，拒绝未知字段）
- `result` 的 Zod schema（用**视图类型**如 `TaskView`，而不是数据库行类型）
- 是否需要在握手之后（当前除 `sys.hello` 外全部需要）

## 5. 事件命名与语义

| 事件 | 何时推 |
| --- | --- |
| `task.changed` | 任务创建/更新/删除/触发 |
| `occurrence.changed` | 实例状态变化 |
| `notification.fired` | 通知已投递 |
| `notification.failed` | **投递失败（必须暴露，不许静默）** |
| `runtime.gap` | 检测到运行缺口（我停过一段时间） |
| `runtime.degraded` | 进入降级状态（附原因） |
| `budget.updated` | 预算消耗变化（M4 起使用，M1 恒为 0） |

**事件是单向的**（daemon → UI），没有返回值。UI 不得通过事件回传状态。

## 6. 错误码

```ts
export const RpcErrorCode = {
  E_PROTOCOL: -32000,          // 协议版本不匹配
  E_AUTH: -32001,              // 未握手 / token 错误
  E_METHOD_NOT_FOUND: -32601,  // 未知方法
  E_INVALID_PARAMS: -32602,    // 参数校验失败
  E_INTERNAL: -32603,          // 服务端内部错误
} as const;
```

**约定**：`error.message` 里带上错误码（如 `"E_AUTH: 认证失败"`），便于客户端用字符串匹配；
但客户端**应当**优先用 `error.code` 判断。

## 7. 新增一个 IPC 方法的完整清单

- [ ] 在 `packages/ipc-contract` 的 `RPC_METHODS` 加 `params` / `result` schema
- [ ] 若涉及新视图结构，同时定义 `XxxViewSchema`（**不要直接暴露数据库行**）
- [ ] 在 `apps/daemon` 的 `IpcServer.methods` 注册 handler
- [ ] handler 内**必须**：先做参数校验（Zod，服务端不信任客户端）、再执行业务、错误转成领域错误
- [ ] 若会改变状态，考虑是否需要 `broadcast` 事件通知其他客户端
- [ ] 写测试：正常调用 + 未握手被拒 + 非法参数 + 未知方法
- [ ] 更新本技能 §4/§5 的表格
- [ ] 若是破坏性变更（改字段名/语义）→ 提升 `PROTOCOL_VERSION` 并在 commit body 说明

## 8. 调试常见错误

| 现象 | 原因 | 排查 |
| --- | --- | --- |
| `E_AUTH: 请先握手` | 未在连接后重放 hello | 确认客户端在**每次** connect 后都握手 |
| 连接被立即关闭 | token 错误 | 检查握手文件是否最新（daemon 重启会重新生成） |
| `E_METHOD_NOT_FOUND` | 方法未注册 / 拼写错 | 对照 `RPC_METHODS` |
| 请求超时 | handler 未返回 / 死锁 | 看 daemon 日志的 `ipc.handler_error` |
| 重连后全部 E_AUTH | **C-4 违规**（未重放握手） | 见 §3 |
| `ProtocolMismatchError` | daemon 与 UI 版本不一致 | 提示用户重启/升级，不要静默降级 |
