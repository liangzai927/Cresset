# M3：本地 ICS 日历

> 不接入 Google/CalDAV OAuth，先支持系统日历导出的 `.ics` 文件。
> 文件只被本地读取，不上传，也不进入模型。

## 配置

设置 → 日历（ICS）：

- 选择 `.ics` 文件
- 清除

或 `config.json`：

```json
{
  "calendar": {
    "icsPath": "/Users/me/calendar.ics"
  }
}
```

## 早报中的表现

```text
日程：
· 09:00 周会
· 全天 团建
```

- 只显示开始日期等于“今天”的事件
- 全天事件显示“全天”
- 文件缺失/格式不支持时早报里显示“日历：文件不可读或格式不支持”，
  但不会阻断提醒/监测器部分

## 会前提醒 / 冲突

设置页在日历旁边：

- 「会前提醒」开关
- 提前分钟数（默认 10）

行为：

- 只为非全天、有结束时间、未来 24 小时内的事件生成
- 通知在 `start - N 分钟` 到点，`dedupe_key=calendar:<uid>:<start>` 每天只一次
- 若与另一个事件重叠，正文写「⚠ 与「X」冲突」，优先级提升为 high
- 已经开始的会议不再补发

## 支持范围

- `VEVENT`
- `DTSTART` / `DTEND` / `SUMMARY`
- `YYYYMMDD`（全天）
- `YYYYMMDDTHHMMSS`（本地墙上时间）
- `YYYYMMDDTHHMMSSZ`（UTC 转本地）
- ICS 折行与常见转义

## 不支持

- RRULE 重复规则（请在导出时展开）
- VALARM/attendee/附件
- 多时区事件的精确定位（`TZID` 参数被忽略）
- CalDAV / Google Calendar OAuth

## 验证

`ics-calendar` 测试覆盖普通/全天/UTC 事件、折行、坏行；
`BriefingService` 测试覆盖“配置 ICS 后早报包含日程”。
