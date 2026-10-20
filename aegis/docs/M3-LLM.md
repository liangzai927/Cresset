# M3：模型（LLM）配置与外发

> M3 的第一条可用链路：**设置 → 钥匙串 → 脱敏网关 → Provider → 审计**。
> 当前只提供“测试连接”探针；业务判断/知识库尚未接入。

## 1. 配置位置

设置 → 模型（LLM）：

| 字段 | 说明 |
| --- | --- |
| 启用 | 关闭时保持纯规则模式 |
| Base URL | OpenAI 兼容地址，如 `https://api.openai.com/v1` |
| 模型 | 如 `gpt-4o-mini` |
| 超时 | 单次请求毫秒数 |
| 最高外发分级 | L0 / L1 / L2；**L3 永远外发不了** |
| 每日调用上限 | 按 UTC 天计数；超限后不再调用 Provider |

API Key：

- 只写入系统钥匙串（service 来自 `@aegis/product`）
- 配置文件、日志、审计、视图都不含明文
- 「测试连接」会发起一次真实外发，发送的是固定公开探针
  `Reply with the single word OK.`

## 2. 安全链

```text
UI → daemon LlmService
   → SecretStore（钥匙串）
   → RedactingModelGateway
       → 分级/检测/占位符
       → OpenAICompatibleProvider
       → 响应占位符还原
   → outbound_audit（哈希/类别/结果）
```

- 策略拒绝时 **Provider 调用次数为 0**
- L3 即使把上限配成 L3 也硬拒绝
- Provider 错误只保留类别/状态码，不携带响应体
- 测试请求的审计可在 `outbound_audit` 查看
- 设置页底部展示最近 20 条外发审计（只有摘要/哈希）

## 3. 规则 + LLM 混合判断

Skill 可以声明可选的 `judge`：

```yaml
judge:
  prompt: 判断这条更新是否值得打断用户
  canSuppress: true
```

行为：

1. 规则先判断到没到 / 变没变（纯本地）
2. 规则命中后，才把通知草稿 + 监测事实交给模型
3. 模型可以：
   - 返回 `notify=false` 抑制噪声（`canSuppress=true` 时）
   - 改写标题/正文/优先级
4. 模型未启用、无 Key、超预算、超时、返回非法 JSON、网关拒绝 → **回退规则文案**
5. 规则确认的通知不会因为模型故障而丢失

LLM 仍然**不参与**“是否按时触发”。

## 4. 当前限制

- 没有成本上限（目前只有调用次数上限）
- `judge` 目前只能通过 YAML 配置，没有可视化编辑器
- 没有知识库

## 5. 验证

```bash
pnpm verify
pnpm package:verify
```

测试使用假 Provider / 本机 HTTP server；**没有真实外网调用**。
