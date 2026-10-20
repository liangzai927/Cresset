# M3：Webhook 通知渠道

> M3 的第一个“离开电脑也能收到”渠道。当前作为**桌面/CLI 都失败后的最后兜底**，
> 不是并行群发。

## 配置

编辑 `config.json`：

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

调度器按渠道顺序尝试：

```text
os_notification → cli_fallback → webhook
```

- 前面的渠道成功，webhook 不会发送；
- 桌面与 CLI 都失败时才 POST webhook；
- 2xx = success；5xx/网络/超时 = transient；4xx = permanent；
- 失败由调度器按现有重试/降级规则处理。

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

- 目前是顺序兜底，不是多端同时推送；
- 没有 UI 配置页（先编辑 config.json）；
- Bark / Telegram / 邮件 / TTS 待做。

## 验证

```bash
pnpm verify
```

`WebhookNotifier` 测试使用本机 HTTP server，覆盖 2xx/4xx/5xx、probe 与 payload。
