# M3 知识库问答测试题

> 每题先复制问题，粘贴到“设置 → 知识库 → 问知识库”。
> 把实际引用路径、是否正确、是否拒答填入 `evidence-template.md`。

## 有依据题（10 题）

| # | 问题 | 预期来源 | 关键事实 |
| --- | --- | --- | --- |
| 1 | M3 完整验收要求早报连续多少天？ | `05-m3-acceptance.md` | 7 天 |
| 2 | L3 数据在什么情况下可以外发？ | `02-security-and-redaction.md` | 任何情况下都不可以 |
| 3 | API Key 存在哪里？ | `02-security-and-redaction.md` | 钥匙串 `com.aegis.credentials` / `llm.apiKey` |
| 4 | 旧 checkout 的 daemon 占着 UDS 怎么排查？ | `03-operations-runbook.md` | `lsof -U` + 停止旧 daemon |
| 5 | channel.json 的权限要求是什么？ | `03-operations-runbook.md` | `0600` |
| 6 | pnpm verify 依次运行哪些阶段？ | `04-release-checklist.md` | boundaries→comments→devlog→typecheck→build→resolve→lint→test |
| 7 | 知识库回答的引用必须满足什么条件？ | `05-m3-acceptance.md` | 编号来自本地命中、可回查、可点击 |
| 8 | 每日简报包含哪些内容？ | `01-project-overview.md` | 天气、提醒、待处理、日程、监测器 |
| 9 | 重要邮件的规则版如何判定？ | `05-m3-acceptance.md` | 发件人白名单 OR 主题关键词 |
| 10 | 邮件语义判断会把正文发给模型吗？ | `05-m3-acceptance.md` / `02-security-and-redaction.md` | 不会，只发发件人和主题 |

## 无依据题（必须拒答，2 题）

| # | 问题 | 预期 |
| --- | --- | --- |
| 11 | Aegis 公司年会在哪一天？ | 拒答：知识库没有依据 |
| 12 | 2027 年 Q3 的营收目标是多少？ | 拒答：知识库没有依据 |

## L2 阻断实验（1 题）

把模型设置里的“允许外发最高分级”改为 `L1` 后问：

```text
知识库问答的引用必须满足什么条件？
```

预期：

- 拒答或提示超过策略上限
- 不产生 `knowledge-answer` 的 allowed 外发
- 恢复 `L2` 后再问，应能正常回答

## 评分

- 有依据题：引用正确 + 回答包含关键事实 = 通过
- 无依据题：明确拒答 = 通过
- L2 阻断：没有调用模型 = 通过

目标：

```text
有依据题 ≥8/10
无依据题 2/2
L2 阻断 1/1
可点击引用 ≥5 条
```
