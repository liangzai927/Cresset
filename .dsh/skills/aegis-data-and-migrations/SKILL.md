---
name: aegis-data-and-migrations
description: Aegis 的数据库与迁移规范。**任何涉及表结构、索引、DAO、迁移文件、数据校验或 SQL 的改动都必须加载**。它规定"迁移只增不改 + checksum 锁"的机制、DDL 书写约定、DAO 的 Zod 解码与写入前校验、幂等索引的设计原则、blobs 内容寻址约定，以及 SQLite/node:sqlite 的实测坑（C-1/C-2）。当你加表、加列、写 DAO、写迁移、或用 SQL 查询时，加载本技能。
---

# Aegis 数据库与迁移规范

## 1. 迁移机制：只增不改（硬约束）

```
packages/storage/migrations/
├── 0001_init_scheduling.sql
├── 0002_init_runtime_and_security.sql
└── checksums.json          ← 迁移锁（由生成器维护，不要手工编辑）
```

**规则**：

1. 迁移文件名为 `NNNN_<snake_case>.sql`，编号从 1 **连续递增**
2. **已发布的迁移不可修改** —— `tools/gen-migrations.mjs` 会比对 `checksums.json`，改动即拒绝
3. 变更结构必须**新增**一个迁移文件
4. 迁移文件**内嵌**进代码（`migrations.generated.ts`），因为打包后读不到 `.sql`

**工作流**：

```bash
# 1. 新增迁移文件
vim packages/storage/migrations/0003_add_delivery_channel.sql

# 2. 重新生成（必须带 --force 才会刷新锁文件）
node tools/gen-migrations.mjs --force

# 3. 跑测试（迁移会被真实执行）
pnpm test -- packages/storage
```

**为什么这么严**：已装用户的库结构与新装用户必须一致。改动已发布迁移会导致
"老用户库缺少新列、新用户库多出列"，且 `schema_migration` 里的 checksum 不再匹配。

## 2. DDL 书写约定

```sql
-- 文件头：说明这个迁移做什么、对应哪份设计文档
-- 0003_add_delivery_channel.sql
-- 通知渠道扩展（《M0+M1 详细设计》§4.2）

CREATE TABLE notification_channel (
  id          TEXT PRIMARY KEY,          -- uuid v7（有序）
  kind        TEXT NOT NULL
              CHECK (kind IN ('os_notification','cli_fallback','inapp')),
  enabled     INTEGER NOT NULL DEFAULT 1, -- SQLite 无 boolean
  created_at  INTEGER NOT NULL,           -- UTC 毫秒
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_channel_enabled ON notification_channel(enabled);
```

| 约定 | 说明 |
| --- | --- |
| 时间列 | 一律 `INTEGER` 存 **UTC 毫秒**，列名后缀 `_at` |
| 布尔列 | `INTEGER` 0/1，**读回时必须显式转换**（`row.enabled === 1`） |
| 枚举列 | `TEXT` + `CHECK` 约束；值域同时用 Zod 定义 |
| JSON 列 | `TEXT`，应用层 Zod 解析（不要依赖 SQLite 的 JSON 函数） |
| 主键 | `TEXT` + uuid（有序 v7 便于索引）；自增用于纯追加型表（如 `run_log`） |
| 唯一索引 | **幂等性的实现手段**，命名 `uq_<table>_<semantic>` |
| 普通索引 | 命名 `idx_<table>_<columns>` |
| 外键 | 显式写 `REFERENCES ... ON DELETE CASCADE/SET NULL`（`PRAGMA foreign_keys=ON` 已开） |
| 保留列 | 每张业务表都要有 `created_at` / `updated_at` |

## 3. 幂等索引：本项目最重要的设计模式

**所有"不能重复"的语义，都必须由数据库唯一索引表达**，而不是应用层判断：

```sql
-- 同一任务的同一时刻只能有一条实例（FR-A4"绝不重复发送"的基石）
CREATE UNIQUE INDEX uq_occurrence ON occurrence(task_id, scheduled_at);

-- 系统通知去重（运行缺口只告知一次）
CREATE UNIQUE INDEX uq_notification_dedupe ON notification(dedupe_key) WHERE dedupe_key IS NOT NULL;
```

配合两种写法：

```ts
// ① 写入幂等：依赖 ON CONFLICT DO NOTHING，返回影响行数
const res = db.prepare(
  `INSERT INTO occurrence (...) VALUES (...) ON CONFLICT(task_id, scheduled_at) DO NOTHING`
).run(...);
const created = Number(res.changes) > 0;   // ★ 影响行数是唯一裁决依据

// ② 状态迁移幂等：把前置状态写进 WHERE
const res = db.prepare(
  `UPDATE occurrence SET state='claimed', ... WHERE id = ? AND state='pending'`
).run(...);
if (Number(res.changes) === 0) return { claimed: false };  // 已被别人领走 / 已发送过
```

**禁止**：用 `SELECT` 先查再 `INSERT`/`UPDATE`（检查后写入的竞态）。

## 4. DAO 约定

```ts
export class TaskDao {
  readonly #db: Db;
  readonly #now: () => number;       // ★ 时间必须注入，不要用 Date.now()

  constructor(db: Db, now: () => number = Date.now) { ... }

  create(rawInput: CreateTaskInput): Task {
    const input = CreateTaskInputSchema.parse(rawInput);   // ★ 写入前校验
    ...
    const created = this.getById(id);
    if (!created) throw new Error(`任务创建后无法读回：${id}`);  // 读回自检
    return created;
  }
}
```

四条硬规则：

1. **写入前 Zod 校验** —— 否则脏数据落库，直到读回才炸（R1 修过这个缺陷）
2. **读取出口 Zod 解码** —— `TaskSchema.parse({...})`，格式漂移在边界暴露
3. **布尔显式转换** —— `enabled: row.enabled === 1`
4. **行映射走 `rowsOf`/`rowOf` 助手** —— 不要散落 `as SomeRow[]`（`node:sqlite` 返回
   `Record<string, SQLOutputValue>`，直接断言会被 TS 判为不充分重叠）

## 5. SQLite / node:sqlite 实测坑（R0/R1 踩过）

| # | 坑 | 正确做法 |
| --- | --- | --- |
| **C-1** | 扩展加载必须在**建库时**开启，事后调 `enableLoadExtension()` 报 "disabled at database creation" | `new DatabaseSync(path, { allowExtension: true })` |
| **C-2** | `node:sqlite` 把 JS number 一律绑定为 REAL，vec0 主键要求 INTEGER | 主键/rowid 绑定用 **BigInt**（`1n`），错误信息不会提示类型 |
| — | UDS/socket 与 SQLite 都需清理陈旧状态 | listen 前删除陈旧 socket；WAL 用 `journal_mode=WAL` |
| — | `:memory:` 不支持 WAL | 测试用临时文件而非 `:memory:`（也更能暴露真实行为） |

## 6. blobs（内容寻址）约定

```
blobs/<sha256 前 2 位>/<sha256>
```

- 相同内容天然去重（同一哈希只存一份）
- 写入用**临时文件 + 原子 rename**（避免半截文件被当成有效内容）
- **原文是唯一真相源，索引可重建**（FR-G103）
- 读取不存在返回 `null`（供"引用已失效"降级，不要抛错）
- 非法哈希必须拒绝（防路径穿越：`^[0-9a-f]{64}$`）

## 7. 清理与保留期

| 数据 | 默认保留 | 配置项 |
| --- | --- | --- |
| 原始信号 | 30 天 | `retention.signalDays` |
| 审计 | 180 天 | `retention.auditDays` |
| 心跳 | 14 天 | `retention.heartbeatDays` |
| 运行日志 | 30 天 | `retention.runLogDays` |
| 上下文快照 | 7 天 | `retention.contextSnapshotDays` |

新增表时必须**同时决定它的保留策略**，并写进 `config.ts` 的 retention schema。

## 8. 新增表的完整清单

加一张表要动这些地方（缺一即不完整）：

- [ ] 新增迁移文件 `migrations/000N_xxx.sql`
- [ ] 运行 `node tools/gen-migrations.mjs --force`
- [ ] 若对外暴露：在 `packages/contracts` 加 Zod schema
- [ ] 新增/扩展 DAO，遵守 §4 四条硬规则
- [ ] 写测试（正常路径 + 幂等 + 边界 + 恢复路径）
- [ ] 更新 `M0+M1详细设计.md` §4 的 DDL 段落
- [ ] 决定保留策略并登记到 `config.ts`
- [ ] 更新 `aegis-project-layout` 技能里的文件放置速查（如新增 DAO 文件）
