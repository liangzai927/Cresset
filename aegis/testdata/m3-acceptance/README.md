# Aegis M3 缩短验收套件（2–3 天）

> 这不是完整的 7 天验收。它用于在 2–3 天内收集“功能可用 + 稳定性冒烟”的证据，
> 由产品负责人显式接受“未覆盖 7 天长期运行”的风险后再决定是否进入 M4。

## 适用前提

- 已安装并可以启动当前 Aegis 开发版
- 已有一个可用的模型 API Key（或明确只测试本地检索）
- 建议使用**独立测试数据目录**，不污染日常数据：

```bash
cd /Users/liuwenliang/lwl/Cresset/aegis
export AEGIS_DATA_DIR="$HOME/Library/Application Support/Aegis-M3-Test"
pnpm dev
```

> 测试结束后可整个删除 `Aegis-M3-Test`；系统钥匙串里的 API Key 不会随之删除。

## 文件清单

```text
testdata/m3-acceptance/
├── README.md                 本文件：操作步骤
├── checklist.md              2–3 天逐项打勾
├── evidence-template.md      问答复核与证据记录
├── questions.md              12 个知识库问题 + 预期来源
├── knowledge/                导入知识库的 5 份文档
├── calendar/m3-week.ics      当日/次日/第三日日程与冲突
├── email/                    3 封测试邮件（内容模板）
└── webhook-server.mjs        本地 Webhook 接收端
```

---

## Day 0：准备（约 45–60 分钟）

### 0.1 启动与备份

如果使用真实数据目录，先备份：

```bash
cp -R "$HOME/Library/Application Support/Aegis" \
      "$HOME/Library/Application Support/Aegis.backup-$(date +%Y%m%d-%H%M)"
```

推荐直接用测试数据目录启动，见上面的 `AEGIS_DATA_DIR`。

### 0.2 配置模型

设置 → 模型（LLM）：

1. 选服务商
2. 填 API Key
3. 连接并获取模型
4. 选模型
5. 允许外发最高分级选 **L2**（知识库和邮件头需要）
6. 保存

如果只想测试检索/引用，不配置模型也可以；但问答环节会显示“无依据”或提示未启用，不能验证生成路径。

### 0.3 配置天气（可选，但建议）

设置 → 天气：

- 启用
- 选择 `上海`、`北京`
- 保存

### 0.4 配置日历

设置 → 日历（ICS）：

- 选择本目录下的 `calendar/m3-week.ics`
- 勾选会前提醒
- 提前 `10` 分钟
- 保存

该文件包含：

- 10:00–10:30 项目周会
- 10:15–10:45 客户电话（与周会冲突）
- 15:00–15:30 发布评审
- 次日 09:30 验收复盘
- 次日全天团建
- 第三日 10:00 收尾

如果当前时间已经晚于 10:00，只有次日/第三日的事件会触发会前提醒。

### 0.5 导入知识库

设置 → 知识库 → 导入文档，逐个导入：

```text
knowledge/01-project-overview.md
knowledge/02-security-and-redaction.md
knowledge/03-operations-runbook.md
knowledge/04-release-checklist.md
knowledge/05-m3-acceptance.md
```

数据分级保留默认 `L2`。

### 0.6 配置 Webhook

开一个终端：

```bash
cd /Users/liuwenliang/lwl/Cresset/aegis
node testdata/m3-acceptance/webhook-server.mjs
```

看到：

```text
webhook 测试服务器：http://127.0.0.1:8787/ok
```

如果提示端口被占用：

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
PORT=8788 node testdata/m3-acceptance/webhook-server.mjs
```

然后把 `http://127.0.0.1:8788/ok` 填到 Aegis Webhook。
不要随意杀掉不认识的进程。

设置 → 通知渠道 → Webhook：

- 启用
- URL 填 `http://127.0.0.1:8787/ok`
- 保存
- 测试（应看到 `Webhook 测试成功`，终端打印 JSON）
- **重启应用/daemon**，让 notifier 链生效

### 0.7 配置早报

设置 → 每日简报：

- 启用
- 时间设为“当前时间 + 3 分钟”
- 先不要开启 LLM 润色（减少变量）
- 保存

到点后应收到 `今日简报` 通知。

### 0.8（可选）配置 IMAP

如果你有测试邮箱：

- 设置 → 重要邮件（IMAP）
- 填 host/port/用户名/密码
- 发件人白名单留空
- 关键词填 `合同, 面试`
- 启用
- 测试连接

没有测试邮箱可跳过；仅记录“未验证”。

---

## Day 1：功能验证（约 60–90 分钟）

按 `questions.md` 逐题提问，把结果写入 `evidence-template.md`。

必须覆盖：

- [ ] 5 个有依据问题，答案带可点击引用
- [ ] 2 个无依据问题，明确拒答且不调用模型
- [ ] 1 次 L2 被 L1 上限阻断的实验
- [ ] Webhook 至少 1 条真实投递
- [ ] 日历会前提醒 + 冲突提示
- [ ] 早报包含天气/日程/提醒
- [ ] 如启用 IMAP：3 封邮件中命中 2 封、营销邮件不提醒

### L2 阻断实验

1. 设置 → 模型 → 允许外发最高分级改为 `L1`
2. 保存
3. 问一个需要文档依据的问题
4. 预期：拒答/提示“超过策略上限”，**不调用模型**
5. 改回 `L2` 并保存

把前后截图或提示文本记入 evidence。

---

## Day 2：稳定性与第二次早报（约 30 分钟）

- [ ] 应用/daemon 仍在运行
- [ ] 收到第二次早报（次日）
- [ ] 无重复早报
- [ ] 无 daemon 崩溃/重启循环
- [ ] Webhook 无异常重复
- [ ] 邮件轮询无重复通知
- [ ] 再跑 2 个问题，结果稳定

### 生成报告

```bash
cd /Users/liuwenliang/lwl/Cresset/aegis
AEGIS_DATA_DIR="$HOME/Library/Application Support/Aegis-M3-Test" pnpm m3:report
```

检查 `docs/acceptance/m3-report.md`。

---

## Day 3：收尾（约 30 分钟）

- [ ] 24–48 小时无严重故障
- [ ] 早报至少 2 天
- [ ] 证据表完整
- [ ] `pnpm m3:report` 已生成
- [ ] 产品负责人确认豁免 7 天观察
- [ ] 在 `docs/acceptance/M3.md` 记录“缩短验收通过/未通过”

---

## 通过标准（缩短版）

| 项 | 通过条件 |
| --- | --- |
| 知识库问答 | 10 题中 ≥8 题引用正确；无依据题全部拒答 |
| 引用 | 至少 5 条可点击并打开正确文件 |
| L2 阻断 | L1 上限下不调用模型，提示可见 |
| Webhook | 至少 1 条真实 success |
| 日历 | 会前提醒 + 冲突提示至少各 1 次 |
| 早报 | 连续 2 天生成，内容含天气/日程/提醒 |
| IMAP（如启用） | 合同/面试命中，营销不命中 |
| 稳定性 | 24–48 小时无崩溃、无重复早报 |
| 门禁 | `pnpm verify` + `package:verify` 通过 |

## 明确未覆盖

- 7 天长期运行
- 系统睡眠/唤醒、跨时区、DST
- 30 天数据库增长
- 真实用户收件箱的误报率
- 正式签名/公证
- PDF / Git 导入

这些必须在 M4 期间补测，或作为技术债记录。

---

## 邮件样本怎么用

`email/` 下是内容模板，不会自动发送。把对应主题/正文用你的邮箱发到测试 IMAP 收件箱：

```text
urgent-contract.eml  → 主题含“合同”
interview.eml        → 主题含“面试”
marketing.eml        → 主题不含关键词
```

发件人白名单留空，规则用主题关键词；这样不依赖固定发件地址。

如果安装 `swaks`，可参考：

```bash
swaks --to "$TEST_EMAIL" --from "$YOUR_EMAIL" \
  --server "$SMTP_HOST" --auth-user "$SMTP_USER" --auth-password "$SMTP_PASS" --tls \
  --header "Subject: 合同待确认：M3 验收" \
  --body "请确认 M3 验收合同。"
```

没有 `swaks` 就用邮箱客户端手动发。

---

## Webhook 预期输出

```json
{
  "title": "Aegis Webhook 测试",
  "body": "这是一条来自 Aegis 的 Webhook 连通性测试。"
}
```

如果终端无输出：

- 确认服务仍在运行
- 确认 URL 是 `http://127.0.0.1:8787/ok`
- 确认保存后重启过 daemon
- 查看设置页 Webhook 提示
