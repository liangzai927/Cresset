# M3：天气（Open-Meteo）

> 早报里的天气来自 Open-Meteo，无需 API Key。只发送经纬度，
> 不发送提醒内容、邮件或知识库文本。

## 配置

设置 → 天气：

- 启用
- 纬度 / 经度
- 地点名（只用于显示）

等价配置：

```json
{
  "weather": {
    "enabled": true,
    "latitude": 31.23,
    "longitude": 121.47,
    "locationName": "上海"
  }
}
```

## 早报表现

```text
天气（上海）：晴 12–20°C
今天有 3 个提醒：
...
```

## 可靠性

- 缓存 30 分钟
- 请求 8 秒超时
- 失败时保留旧缓存
- 没有缓存时天气行直接缺席，不阻断简报
- 日志只记录失败类别，不记录坐标以外的内容

## 验证

- 解析 Open-Meteo daily 字段
- 失败返回 null 不抛错
- WMO weather_code → 中文
- BriefingService 包含天气行
