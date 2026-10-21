# M3 重要邮件监测配置指南（IMAP）

> 目标：让 Aegis 读取测试邮箱的未读邮件头，按发件人/主题关键词提醒。
> 不读取正文，不下载附件，不把邮件内容当作指令执行。

## 1. 先分清两件事

Aegis 里有两个邮件相关配置：

| 功能 | 协议 | 用途 |
| --- | --- | --- |
| 通知渠道 → 邮件 | SMTP | 把 Aegis 提醒发到你的邮箱 |
| 重要邮件（IMAP） | IMAP | 读取未读邮件，判断是否提醒 |

本文只讲 **IMAP 重要邮件监测**。

SMTP 是发信，IMAP 是收信，不要混用端口/密码。

---

## 2. 推荐用哪个邮箱测试

优先选支持“授权码/应用专用密码”的邮箱：

| 邮箱 | 推荐度 | 原因 |
| --- | --- | --- |
| QQ 邮箱 | ⭐⭐⭐⭐⭐ | 授权码简单，IMAP 稳定 |
| 163 / 126 | ⭐⭐⭐⭐⭐ | 客户端授权密码 |
| Gmail | ⭐⭐⭐⭐ | 需要 2FA + App Password |
| iCloud | ⭐⭐⭐⭐ | 需要 App 专用密码 |
| Outlook / Microsoft 365 | ⚠️ 不推荐 | 多数账户要求 OAuth；Aegis 当前只支持密码认证 |
| 企业自建 IMAP | ⭐⭐⭐ | 取决于服务器是否允许密码登录 |

**建议用测试小号**，不要用主邮箱。

---

## 3. 服务商参数

### QQ 邮箱

```text
IMAP host: imap.qq.com
端口: 993
TLS: 开启
用户名: 你的完整 QQ 邮箱
密码: 授权码（不是 QQ 登录密码）
```

获取授权码：

1. 登录 QQ 邮箱网页版
2. 设置 → 账号
3. 找到 POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务
4. 开启 IMAP/SMTP 服务
5. 生成授权码
6. 把授权码填入 Aegis 的 IMAP 密码

### 163 / 126 邮箱

```text
IMAP host: imap.163.com（126 为 imap.126.com）
端口: 993
TLS: 开启
用户名: 完整邮箱地址
密码: 客户端授权密码
```

获取方式：

1. 登录网页邮箱
2. 设置 → POP3/SMTP/IMAP
3. 开启 IMAP/SMTP
4. 设置客户端授权密码
5. 填入 Aegis

### Gmail

```text
IMAP host: imap.gmail.com
端口: 993
TLS: 开启
用户名: 完整 Gmail 地址
密码: App Password（16 位）
```

前提：

1. Google 账号开启两步验证
2. 安全 → 应用专用密码
3. 生成 16 位密码
4. Workspace 管理员可能禁用 IMAP/应用密码

注意：

- Gmail 的普通登录密码不能用于 IMAP
- 如果找不到“应用专用密码”，通常是没开两步验证或管理员禁用

### iCloud

```text
IMAP host: imap.mail.me.com
端口: 993
TLS: 开启
用户名: 完整 iCloud 邮箱
密码: App 专用密码
```

前提：

1. Apple ID 开启双重认证
2. 登录 Apple ID → 登录与安全 → App 专用密码
3. 生成密码
4. iCloud 邮箱功能已开启

### Outlook / Microsoft 365

```text
IMAP host: outlook.office365.com
端口: 993
TLS: 开启
```

⚠️ 当前 Aegis 只支持用户名+密码认证，不支持 OAuth。

Microsoft 已逐步关闭基本认证；如果你的账户只能 OAuth，Aegis 暂时无法连接。
建议换 QQ/163/Gmail 测试账号。

### 企业/自建 IMAP

需要从 IT 获取：

- host
- port
- 是否 TLS
- 是否允许密码认证
- 是否需要 VPN

不确定时不要猜端口。

---

## 4. 在 Aegis 中配置

打开：

```text
设置 → 重要邮件（IMAP）
```

填写：

```text
启用：勾选

IMAP host：imap.qq.com
端口：993
用户名：你的测试邮箱
邮箱文件夹：INBOX
轮询秒数：60
使用 TLS：勾选

重要发件人：留空（测试主题关键词时）
主题关键词：合同, 面试
规则未命中时用 LLM 判断：不勾选（先用纯规则测试）
```

密码：

```text
IMAP 密码：粘贴授权码/应用密码
→ 点击「保存密码」
```

密码只写入系统钥匙串：

```text
service: com.aegis.credentials
account: email.imap.password
```

不会写进 `config.json`。

保存后点击：

```text
测试连接
```

> 新版本「测试连接」会先自动保存当前表单，再读取服务端配置；
> 但密码仍需点「保存密码」或由测试按钮一并保存。
> 如果界面版本较旧，必须先点「保存监测设置」。

预期：

```text
IMAP 连接成功（INBOX）
```

然后保存监测设置。

> 修改轮询秒数后建议重启应用/daemon，确保新的轮询间隔生效。

---

## 5. 发送测试邮件

最稳的方法：**用测试邮箱给自己发**。

这样不依赖第二个邮箱，也不需要 SMTP 配置。

### 5.1 合同邮件（应提醒）

在网页邮箱新建邮件：

```text
收件人：测试邮箱自己
主题：合同待确认：M3 验收
正文：请确认 M3 验收合同，今天下班前需要回复。
```

发送后**不要打开它**，保持未读。

### 5.2 面试邮件（应提醒）

```text
主题：面试安排：周五 14:00
正文：面试安排在本周五 14:00，请确认会议室。
```

### 5.3 营销邮件（不应提醒）

```text
主题：本周产品推荐与优惠
正文：本周产品推荐，点击查看优惠。
```

### 5.4 检查未读

网页邮箱里确认三封都是**未读**。

⚠️ 重要：

Aegis 轮询时会把处理过的未读邮件标记为 `\Seen`。
所以测试邮箱最好保持干净，只放这三封未读邮件。

不要有其他未读邮件，否则也会被标记已读。

---

## 6. 等待并验证

等待 60–120 秒。

检查 Aegis：

```text
历史 / 通知
```

应出现：

```text
重要邮件：合同待确认：M3 验收
重要邮件：面试安排：周五 14:00
```

不应出现：

```text
重要邮件：本周产品推荐与优惠
```

同时检查：

- 每封只提醒一次
- 邮件已变为已读
- 没有重复通知

如果启用了多个通知渠道，还会走桌面/Webhook 等投递。

---

## 7. 故障排查

### 7.1 测试连接失败

| 提示 | 排查 |
| --- | --- |
| 鉴权失败 / LOGIN failed | 是否用了授权码，而不是登录密码 |
| 连接超时 | host/port/TLS 是否错误，网络/VPN |
| 证书错误 | 是否自建服务器，证书是否有效 |
| 找不到邮箱 | 用户名必须是完整邮箱地址 |

### 7.2 测试连接成功，但没有通知

检查：

1. 监测是否启用
2. 是否重启过 daemon
3. 邮件是否仍然是未读
4. 主题是否包含 `合同` / `面试`
5. 发件人白名单是否误填（留空时只靠关键词）
6. 轮询间隔是否已到
7. 是否有其他未读邮件被先处理

日志关键字：

```text
email_monitor.missing_config
email_monitor.no_password
email_monitor.keychain_failed
email_monitor.poll_failed
email_monitor.llm_undecided
email_monitor.mark_seen_failed
```

### 7.3 邮件被标记已读，但没提醒

说明轮询成功，但规则没有命中：

- 主题关键词不匹配
- 发件人白名单不匹配
- 邮件在 Aegis 启动前已经被其他客户端读过

把邮件重新标为未读，再等下一轮。

### 7.4 重复提醒

正常情况下不会重复：

```text
dedupe_key = email:<uidValidity>:<uid>
```

如果重复，记录 UID/时间，检查是否重新登录导致 UIDVALIDITY 改变。

---

## 8. 安全注意事项

- 使用测试邮箱，不要用主邮箱
- 使用授权码/应用密码，不要用登录密码
- 不要把授权码发到聊天/日志
- 测试完成后可以在邮箱后台撤销授权码
- Aegis 只读取发件人/主题，不读正文
- 开启 LLM 语义判断时，只外发发件人/主题，且按 L2 处理
- `maxOutboundClass=L1` 时 LLM 邮件判断会被阻断，规则匹配仍可本地完成

---

## 9. 验收记录模板

```text
邮箱服务商：
IMAP host：
端口：
TLS：是
用户名：
测试连接：成功 / 失败

合同邮件：命中 / 未命中
面试邮件：命中 / 未命中
营销邮件：命中 / 未命中（应为未命中）
重复通知：有 / 无
轮询时间：
Aegis 通知截图：
```

---

## 10. 相关文件

- 测试邮件模板：
  - `testdata/m3-acceptance/email/urgent-contract.eml`
  - `testdata/m3-acceptance/email/interview.eml`
  - `testdata/m3-acceptance/email/marketing.eml`
- 功能说明：`docs/M3-EMAIL.md`
- 验收清单：`testdata/m3-acceptance/checklist.md`
- 证据模板：`testdata/m3-acceptance/evidence-template.md`
