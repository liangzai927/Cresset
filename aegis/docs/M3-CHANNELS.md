# M3：Webhook 通知渠道

> M3 的远程渠道：Webhook 与 Telegram。启用后与桌面通知并行扇出；
> 只有全部失败才落到 CLI 兜底。

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

当桌面 + Webhook + Telegram 同时启用时：

```text
fanout(os_notification + webhook + telegram + bark + tts) → cli_fallback
```

- 所有远程/桌面渠道**并行发送**，任一个成功就算投递成功；
- 全部失败才使用 CLI 兜底；
- 如果只启用其中一个，则按普通渠道顺序执行；
- 2xx = success；5xx/网络/超时 = transient；4xx = permanent；
- fanout 全失败时，error 里会列出每个子渠道的结果（不含敏感 URL/Token）。

## Telegram

设置 → 通知渠道 → Telegram：

- 填 chat_id
- 填 Bot Token（只写入系统钥匙串）
- 保存 Token
- 测试 Telegram（使用已保存的 chat_id + Token）
- 保存通知渠道

Bot Token 存钥匙串 `com.aegis.credentials / notify.telegram.token`，
配置、日志、审计里都没有明文。

## Bark

设置 → 通知渠道 → Bark：

- 服务地址默认 `https://api.day.app`
- 填 Device Key（只写入系统钥匙串）
- 保存 Key
- 测试 Bark
- 保存通知渠道

Device Key 存钥匙串 `com.aegis.credentials / notify.bark.deviceKey`。

## 按优先级分流

默认是全部渠道并行扇出。需要"重要提醒才发远程/语音"时，
在设置页勾选「按优先级分流」，见 [M3-ROUTING.md](M3-ROUTING.md)。

## TTS（macOS say）

设置 → 通知渠道 → 语音播报：

- 勾选启用
- 可填语音名（如 `Tingting`），留空用系统默认
- 「测试播报」会保存设置并朗读一句测试

TTS 完全本地，不产生网络外发。它和桌面/远程渠道一样属于 fanout：
启用后会朗读每一条通过 fanout 的提醒，因此只建议在需要强提醒时开启。

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
