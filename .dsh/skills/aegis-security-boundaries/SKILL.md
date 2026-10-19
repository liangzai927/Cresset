---
name: aegis-security-boundaries
description: Aegis 的安全与脱敏边界规范。**任何涉及外发数据、模型调用、凭据、钥匙串、文件权限、日志内容的改动都必须加载**。它规定脱敏网关的唯一出口地位与 fail-closed 语义、数据分级 L0–L3 的判定、什么绝不能进日志/审计/数据库、凭据的存取约定、文件权限（0600）与 IPC 鉴权、以及"零绕过"的自查方法。当你写模型调用、日志、审计、读凭据、加 IPC 方法时，加载本技能。
---

# Aegis 安全与脱敏边界

> **一次明文外发不可撤销。** 本项目在 v1.0 不做本地模型，因此脱敏网关是**唯一防线**，
> 而不是"多层防御中的一层"。这决定了这里所有规则都是**硬约束**，没有例外。

## 1. 唯一出口原则（C3 / NFR-SP4）

```
调用方（任何模块）
      ↓ 必须经此
@aegis/redaction-gateway
      ↓
model-provider（M3 才存在）
      ↓
外部模型
```

**机械保证**：

- `packages/redaction-gateway` 是**唯一**允许依赖 `model-provider` 的包（`tools/check-boundaries.mjs` 强制）
- 任何包直接依赖模型 SDK 即门禁失败
- 网关的失败语义是 **fail-closed**：不允许 → **抛错**，绝不"降级放行"

```ts
// ✅ M1 的刻意实现：任何真实外发都硬失败
export class FailClosedGateway {
  async complete(req: OutboundRequest): Promise<never> {
    const { decision } = evaluateOutbound(req, this.#opts);
    if (!decision.allowed) throw new OutboundBlockedError(decision);
    throw new Error("模型外发尚未启用（M1 无外发路径）…");
  }
}
```

## 2. 数据分级（L0–L3）

| 级别 | 定义 | 外发策略 |
| --- | --- | --- |
| **L0 公开** | 已公开文档、开源代码 | 可直接外发 |
| **L1 内部** | 工作内容、代码、内部文档 | 脱敏后可外发 |
| **L2 敏感** | 个人身份信息、客户资料、合同 | **默认不外发**；脱敏后仍敏感则拒答 |
| **L3 机密** | 凭据、私钥、密码、Token、连接串 | **永不出机器**，命中即阻断 |

**默认保守**：无法判定级别 → 按 **L2** 处理（`DEFAULT_DATA_CLASS = "L2"`）。
**级别只升不降**：检测命中只能提升级别，降级必须人工确认。

## 3. 绝不允许出现在日志/审计/数据库的内容

以下内容**任何情况下**都不得写入日志、审计表、数据库或命令行参数：

- 凭据值（API Key、密码、Token、私钥）
- 完整个人信息（身份证、银行卡、手机号、住址）
- 邮件/消息正文原文（L2 及以上）
- 屏幕截图内容

**实现层保障**：

```ts
// 审计接口从类型上就没有承载原文字段 —— 这是刻意的设计约束
export interface AuditEntry {
  actor: string;
  purpose: string;
  destination: string;
  dataClass: string;
  detectorSummary: Array<{ category: string; count: number }>;  // 只有类别与次数
  redactionCount: number;
  policyVersion: string;
  payloadSha256: string;   // 只有哈希
  outcome: "allowed" | "blocked" | "failed";
}
```

写审计/日志前问自己：**"这一字段会不会包含原文？"** 会 → 改成哈希、类别计数或长度。

## 4. 凭据（钥匙串）约定

| 约定 | 说明 |
| --- | --- |
| 值只存系统钥匙串 | 数据库只存**引用**（`credential_ref.keychain_key`） |
| 读取必须带 `-w` | 否则 `security` 会弹 GUI 授权，24/7 无人值守会**永久挂住**（约束 C-5） |
| 必须显式指定钥匙串 | 否则查找/删除会扫整个搜索列表，行为不确定（约束 C-9，实测"delete 报成功但 find 仍能查到"） |
| 钥匙串路径是**最后一个位置参数** | `security` CLI 的语法要求 |
| 服务名从 `@aegis/product` 读 | 禁止硬编码 |
| **凭据值不进日志** | 连调试日志也不行；如需诊断，只打印"长度 + 前后各 2 字符" |

## 5. 文件与 IPC 权限

| 对象 | 权限 | 理由 |
| --- | --- | --- |
| 握手文件 `handshake.json` | `0600` | 内含 IPC token |
| IPC socket 文件 | `0600` | 仅本用户可连 |
| 数据目录 | 用户私有 | 库内含 L2 数据 |
| 锁文件 `daemon.lock` | `0600` | 含 pid，避免信息泄露 |

**token 传递方式**：只写进 0600 的握手文件。**禁止**通过命令行参数或环境变量传递（会出现在 `ps` 输出里）。

**IPC 鉴权语义（C-4）**：每个新连接都是**新的鉴权会话** —— 客户端每次（重）连接必须重放 `sys.hello`；
认证失败立即 `socket.end()`，不给暴力尝试留通道。

## 6. 检测器（脱敏的核心机制）

| 约定 | 说明 |
| --- | --- |
| 召回优先于精确 | 宁可过度脱敏（体验问题），不可漏检（事故）。NFR-SP1：召回率 ≥ 99%，**漏检一个即缺陷** |
| 校验位只用于统计 | 身份证/银行卡的校验位**不用于过滤**，只用于误报统计 |
| 检测器只做本地计算 | 绝不允许调用外部服务做 PII 检测（那本身就是外发） |
| 占位符会话内稳定 | 同一取值映射到同一占位符（`[EMAIL_1]`），否则模型无法理解"同一个对象" |
| 占位符编号按出现顺序 | 保证 `[EMAIL_1]` 一定出现在 `[EMAIL_2]` 之前（R1 修过这个缺陷） |
| 向量也视为数据 | embedding 可被部分还原 → **默认不出机器**（R34） |

## 7. 新增代码时的安全检查清单

写任何涉及数据的代码，过一遍：

- [ ] 这段数据会不会外发？如果会，是否经 `redaction-gateway`？
- [ ] 分级判定是否保守（未知 → L2）？
- [ ] 有没有把原文写进日志/审计/异常消息？
- [ ] 异常消息里会不会带上敏感值？（`throw new Error(\`失败：${secret}\`)` 是典型错误）
- [ ] 新增文件是否需要 0600？
- [ ] 新增 IPC 方法是否在握手之后才可用？
- [ ] 读凭据是否带了 `-w` 和显式钥匙串路径？

## 8. 自查命令

```bash
pnpm boundaries    # 验证"只有网关可依赖 model-provider" + 无包直连模型 SDK
pnpm test          # 含 TC-M0-01 检测器召回率、TC-M0-02 fail-closed、TC-M0-03 审计不落原文
```

**"零绕过"的自我验证**：搜索全仓是否存在绕过网关的网络/模型调用：

```bash
grep -rn "fetch(\|https://\|http://" packages/ apps/ --include="*.ts" | grep -v test
```

任何命中都需要解释 —— 要么改走网关，要么在代码注释里写明"这不是外发"（如本地 UDS）。
