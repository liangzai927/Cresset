# M3：按优先级分流通知

> 不是所有提醒都值得同时发到所有渠道。高强度提醒可以走 Telegram/Bark/TTS，
> 普通提醒只走桌面，低优先级甚至可以只写历史。

## 配置

编辑 `config.json`：

```json
{
  "notify": {
    "channels": ["os_notification", "cli_fallback", "webhook", "telegram", "bark", "tts"],
    "routing": {
      "enabled": true,
      "low": ["os_notification"],
      "normal": ["os_notification", "webhook"],
      "high": ["os_notification", "webhook", "telegram", "bark", "tts"]
    }
  }
}
```

- `enabled=false` 时保持原来的全量 fanout；
- 未配置某个级别 → 回退到当前所有已启用渠道；
- 配置了但渠道不可用 → 不会静默成功，最终由 CLI 兜底；
- 修改后重启 daemon 生效（notifier 链在启动时构建）。

## 优先级来源

| 来源 | 优先级 |
| --- | --- |
| 普通任务 | normal |
| 重要任务 | high |
| 每日简报 | normal |
| 投递失败补发 | high |

## 行为

```text
routing(priority) → 该优先级的并行渠道组 → 全部失败 → cli_fallback
```

组内并行发送，任一个成功即成功；组内全部失败才进入 CLI。
每个子渠道的 delivery_attempt 仍会单独记录。

## 当前限制

- 没有配置 UI（先编辑 config.json）；
- 只按 low/normal/high，不按通知类型（kind）；
- 没有按渠道限流/去重。

## 验证

`RoutingNotifier` 测试覆盖：

- high 只走 high 组
- 未配置级别回退 normal
- 全空 → permanent
