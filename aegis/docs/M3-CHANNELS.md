# M3：Webhook 通知渠道

> M3 的第一个“离开电脑也能收到”渠道。启用 Webhook 后，桌面与 Webhook
> 会并行扇出；只有两者都失败才落到 CLI 兜底。

## 配置（UI）

设置 → 通知渠道 → Webhook：

- 勾选「启用 Webhook」
- 填 URL
- 「保存 Webhook」
- 「测试」会立即 POST 一条测试通知

⚠️ 保存后需要重启 daemon/应用才会重建 notifier 链。

也可以直接编辑 `config.json`：

```json
{
  "notify": {
    "channels": ["os_notification", "cli_fallback", "webhook"],
    "webhook": {
      "enabled": true,
      "url": "https://example.com/aegis-hook"
    }
  }
}
```

- 只有 `channels` 包含 `webhook` 且 `webhook.enabled=true`、URL 合法时才启用；
- URL 支持 `http/https`；
- 修改后重启 daemon 生效。

## 投递语义

当桌面 + Webhook 同时启用时：

```text
fanout(os_notification + webhook) → cli_fallback
```

- 桌面与 Webhook **并行发送**，任一个成功就算投递成功；
- 两者都失败才使用 CLI 兜底；
- 如果只启用其中一个，则按普通渠道顺序执行；
- 2xx = success；5xx/网络/超时 = transient；4xx = permanent；
- fanout 全失败时，error 里会列出每个子渠道的结果（不含敏感 URL）。

## Payload

```json
{
  "title": "提醒标题",
  "body": "正文",
  "tag": "可选",
  "sound": true
}
```

不包含数据库 id、凭据、内部路径。

## 安全

- Webhook URL 可能含 token，配置文件以 `0600` 保存；
- 错误信息只包含 `HTTP xxx`/网络类别，不回显完整 URL；
- `probe()` 只校验 URL 格式，**不会**发探测请求（避免误触发用户 webhook）；
- 通知内容会离开本机，请只配置可信端点。

## 当前限制

- 目前只扇出桌面 + Webhook；Bark/Telegram 等尚未接入；
- 保存 Webhook 配置后需要重启 daemon 才会生效；
- 还没有按优先级/类型分流；
- Bark / Telegram / 邮件 / TTS 待做。

## 验证

```bash
pnpm verify
```

`WebhookNotifier` 测试使用本机 HTTP server，覆盖 2xx/4xx/5xx、probe 与 payload。
