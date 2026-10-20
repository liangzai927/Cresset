# M2：监测器与 Skill 告警

> 当前是 M2 的第一条端到端链路：**Monitor 事实 → Skill 规则 → 通知**。
> 纯本地、零 LLM。Web/RSS 监测与 Skill 管理界面后续补。

## 1. 目录约定

Skill 有两种导入方式：

1. **应用内导入（推荐）**：设置 → Skills → 导入 Skill，选择 YAML；文件会写入数据目录的 `skills/`。
2. 手动复制到数据目录：

```bash
DATA="$HOME/Library/Application Support/Aegis"
mkdir -p "$DATA/skills"
cp packages/skills/examples/disk-space-guard.yaml "$DATA/skills/"
cp packages/skills/examples/downloads-change.yaml "$DATA/skills/"
```

导入后，`monitors[].skills` 用相对数据目录的路径引用，例如 `"skills/disk-space-guard.yaml"`。

## 2. 配置监测器

**推荐**：设置 → 监测器 → 添加监测器，选择类型、ID、间隔与已导入 Skill。
保存后会热重载，不需要重启；如果 Skill 的 `trigger.monitor`、路径或权限不匹配，
daemon 会拒绝保存并提示原因。

也可以手动编辑 `~/Library/Application Support/Aegis/config.json` 的 `monitors`：

```json
{
  "version": 1,
  "monitors": [
    {
      "id": "system.host",
      "kind": "system",
      "intervalS": 60,
      "skills": ["skills/disk-space-guard.yaml"]
    },
    {
      "id": "web.news",
      "kind": "web",
      "url": "https://example.com/news",
      "mode": "page",
      "selector": ".headline",
      "intervalS": 120,
      "skills": ["skills/page-change.yaml"]
    },
    {
      "id": "api.status",
      "kind": "web",
      "url": "https://example.com/api/status",
      "mode": "json",
      "jsonPath": "data.status",
      "intervalS": 60,
      "skills": ["skills/page-change.yaml"]
    },
    {
      "id": "rss.example",
      "kind": "web",
      "url": "https://example.com/feed.xml",
      "mode": "rss",
      "intervalS": 300,
      "skills": ["skills/rss-change.yaml"]
    },
    {
      "id": "files.downloads",
      "kind": "files",
      "root": "~/Downloads",
      "patterns": ["**/*.pdf"],
      "ignore": ["**/*.part"],
      "intervalS": 30,
      "stableMs": 2000,
      "skills": ["skills/downloads-change.yaml"]
    }
  ]
}
```

- Skill 的 `trigger.monitor` 必须等于监测器 `id`；
- Skill 必须声明对应权限：`system.read` / `files.read`；
- `root` 里的 `~` 目前不会自动展开，建议写绝对路径；
- 修改配置后重启 Aegis/daemon 生效（应用内添加/启停会热重载，无需重启）。

## 3. 会发生什么

1. daemon 启动时加载并校验 Skill；失败会写 `monitor.skill_*` 日志并跳过该实例；
2. 监测器按 `intervalS` 扫描；
3. 事实进入规则引擎，命中阈值/变化后生成 `kind=monitor` 通知；
4. 通知走 M1 的渠道/免打扰/降级链；
5. `cooldown` 内同一 Skill + 主体不会重复告警，冷却持久化在 `monitor_cooldown`。

## 4. 验证

```bash
# 不启动 daemon 的 dry-run
aegis monitor scan ~/Downloads --glob '**/*.pdf'
aegis monitor system
aegis skill check ~/Library/Application\ Support/Aegis/skills/disk-space-guard.yaml
```

启动后查看：

- 应用「历史」页会多出 `monitor` 通知；
- daemon 日志里的 `monitor.bound` / `monitor.notified` / `monitor.scan_error`；
- 设置 → 监测器 →「停用/启用」可暂停扫描；「立即扫描」可手动触发一次，不等待下一个 interval；
- 连续 3 次扫描失败会生成一条 `failure` 通知（30 分钟窗口内去重），
  并在「历史」页可见；成功一次会清零连续失败计数。

## 5. 当前限制

- 还没有 Skill 管理/导入界面；
- Web 的 `page` 模式支持 CSS 选择器；不填时按"标题 + 可见文本"做变化检测；
- Web 的 `json` 模式支持受限 JSONPath（`a.b[0].c`），不支持过滤器/通配符；
- RSS/Atom 使用 fast-xml-parser 解析 item/entry、guid/id、link/href；
  支持常见命名空间结构，极端自定义 XML 仍需后续验证；
- 文件重命名会在同一轮扫描中按内容指纹配对为 `file.renamed`；
  若两次扫描之间内容又变了，可能退化为删除 + 新增；
- 不做脚本执行、不调模型。
