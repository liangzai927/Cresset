# 知识库与 RAG 详细设计（M4）

> 状态：**设计稿，未实施**
> 目标里程碑：**M4b**（PRD §5.2.1：完整 RAG + 上下文压缩；M4a 先做员工核心）
> 版本：**v0.4**（2026-10-21，随 M4 拆分为 M4a/M4b 更新）
> 设计日期：2026-10-21
> 关联文档：
> - `PRD-个人桌面Agent.md` §7.12 知识库与 RAG、§7.13 上下文管理
> - `技术选型与架构设计.md` §4 数据模型、§5.3 知识库与检索、§10 D3/D4
> - `M0+M1详细设计.md` 数据/安全/运行时基础

---

## 1. 结论摘要

本设计把当前 M3 的“FTS5 关键词检索 + 引用问答”升级为完整 RAG：

```text
摄取 → 结构分块 → 本地嵌入 → FTS + 向量混合召回
→ 确定性重排 → 上下文构造 → LLM 生成
→ 引用机械校验 + 支持度校验 → 精确缓存 → 回答
```

核心决策：

| 决策 | 结论 |
| --- | --- |
| RAG 定位 | **M4b** 的准确性基础设施；M4a 先用 M3 的 FTS5 |
| 默认嵌入 | **本地 ONNX，模型随 App 打包；默认不联网下载** |
| 云端嵌入 | 默认关闭；仅 L0/L1 且用户显式授权；按 L2 审计 |
| 向量存储 | SQLite + `sqlite-vec`；BigInt rowid；加载时机遵守 C-1 |
| 默认检索 | BM25 + 向量双路召回 + RRF 融合 |
| 重排 | 先确定性轻量重排；cross-encoder 作为可选增强 |
| 引用 | 结论必须带引用；引用回查原文哈希；失败降级/拒答 |
| 支持度校验 | 逐句检查引用是否真的支持结论；高风险才走模型/NLI |
| 应用缓存 | 只缓存**校验通过**的回答；key 带文档/索引/模型/提示词版本 |
| 模型侧缓存 | 支持 Prompt Cache / 前缀 KV Cache 的服务商启用；不支持则透明降级 |
| 降级 | 模型/向量扩展/reranker 任一失败 → 回退 FTS |
| 摄取范围 | 文档（MD/TXT/Word/RTF/PDF）+ 代码 + **Git 仓库地址** |
| M3 闸门 | 先执行 **2–3 天缩短验收**；通过后记录 7 天观察豁免，再进 M4 |
| 实施时机 | **M3 缩短验收 → M4a 员工核心 → M4b 完整 RAG**；本设计现在评审，不等于现在编码 |

**一句话：** 完整 RAG 的价值不是“多一个向量库”，而是把“找依据、排序、回答、核对、缓存”做成一条可验证的流水线；其中缓存分为**应用答案缓存**和**模型侧前缀/KV 缓存**两层。

### 1.1 已确认产品决策（2026-10-21）

| # | 决策 | 结论 | 影响 |
| --- | --- | --- | --- |
| 1 | RAG 里程碑 | **M4b**（M4a 先用 M3 FTS5） | 不提前进 M3；M4a 不等待本地模型 |
| 2 | 本地 embedding | **ONNX 模型随包，离线可用** | App +100–200MB；需核验模型许可证 |
| 3 | 重排 | **确定性重排默认 + cross-encoder 可选** | 默认零模型成本；准确率不足再开 |
| 4 | Prompt/KV 缓存 | **auto；云端 L2 默认禁止** | 支持则优化首 token；不支持透明降级 |
| 5 | M4 摄取范围 | **MD/TXT/Word/RTF/PDF + 代码 + Git** | Git 需鉴权/增量同步/忽略规则 |
| 6 | 引用支持度失败 | **删除不支持句；核心句失败则拒答** | 避免整段回答被一句话拖垮 |
| 7 | M3 闸门 | **2–3 天缩短验收 + 记录 7 天豁免** | 通过后先进入 M4a，再进入 M4b |
| 8 | 团队作用域 | **M4a/M4b schema 预留 scope/team_id** | M6 不再大改表结构 |

> 这些是产品决策，已冻结。实现细节（模型许可证、解析器、阈值数值）在 M4 Phase 0 继续验证，但不改变上述方向。

---

## 2. 目标与非目标

### 2.1 目标

1. 让知识库问答对自然语言问法有稳定召回，不再因问句成分零命中。
2. 对专有名词、代码标识符、数字保留精确匹配能力。
3. 每条结论可回溯到具体文档、位置和版本。
4. 无依据时明确拒答，不把相似但无关的内容当证据。
5. 引用必须真正支持结论，而不仅是编号合法。
6. 高频问题不重复调用模型。
7. 支持模型能力时启用 Prompt Cache / 前缀 KV Cache，降低首 token 延迟与输入成本。
8. 单个知识库支持 ≥10 万块；检索 P95 <500ms（本地）。
9. 用户端无需安装 Ollama/数据库，打包后开箱可用。
10. 支持本地文档、代码与 Git 仓库的增量摄取。
11. 索引可重建；原文是唯一真相源。
12. 为 M6 团队知识隔离预留 scope/ACL 字段。

### 2.2 非目标

- 不在 M3 提前实现完整 RAG。
- 不做通用互联网搜索。
- 不做自动网页爬虫。
- 不做团队共享的最终权限模型（M6 完成）。
- 不做语义缓存（第一版只做精确缓存）。
- 不假设所有模型都支持 Prompt Cache；不支持时不能报错。
- 不做多模态（图片/音频）检索。
- 不把 embedding 向量导出成可解释知识。
- 不让模型直接修改知识库原文。

---

## 3. 与里程碑的关系

当前 M3 已有：

- Markdown/TXT/Word/RTF 导入
- 800 字固定分块 + 100 重叠
- FTS5 中文逐字索引
- 问句清洗 + OR 召回 + 覆盖率过滤
- Top 6 片段 + LLM 回答
- 引用编号回查
- 无依据拒答、L2 不外发

M3 的定位是“基础检索 + 引用地基”，不包含：

- 向量/embedding
- 混合检索
- rerank
- 逐句引用支持度校验
- 缓存
- 知识冲突治理

上述内容按 PRD 属于 **M4b**。本设计是 M4b 的开工依据，不是 M3 的补丁，也不在 M4a 内实施。

> 如果产品负责人希望把 RAG 提前到 M3.5，需要单独记录范围变更/豁免；否则必须先完成 M3 验收。

---

## 3A. M3 前置验收决策

2026-10-21 产品负责人确认：

```text
先执行 2–3 天缩短验收（M3-SHORT）
→ 通过后记录“7 天连续观察豁免”
→ 才进入 M4a
```

缩短验收必须覆盖：

- 真实文档问答与可点击引用
- 无依据拒答
- L2 在 L1 上限下不外发
- 至少一个远程渠道真实投递
- 真实邮箱样本
- 24–48 小时稳定性
- `pnpm verify` / `package:verify`

**未执行缩短验收前，M3 仍未验收，M4a/M4b 都不开始。**

---

## 3B. M4a / M4b 边界

PRD v0.9 已把 M4 拆分为两段：

| 阶段 | 内容 | 与本设计的关系 |
| --- | --- | --- |
| **M4a** | 员工/岗位/工作区、工具权限、任务执行、验证、预算、审批、软件调用 | 使用 M3 的 FTS5 + 引用编号校验；**不实现本设计** |
| **M4b** | 完整 RAG + 上下文压缩 | 本设计的实施范围 |

M4a 不等待本地 ONNX / 向量索引，先把员工闭环跑通；M4b 再把知识层升级。

M5 在 M4b 之后，不改变编号。

---

## 4. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                         摄取层                                │
│  文件/代码/笔记 → Parser → 结构分块 → 元数据 → 内容哈希        │
│                     ↓                                        │
│              本地嵌入 Worker（可选）→ 向量                    │
│                     ↓                                        │
│        knowledge_source / knowledge_doc / chunk              │
│        chunk_fts / chunk_vec / embedding_meta                │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                         检索层                                │
│  查询清洗 → 查询改写（可选）→ ACL/分级过滤                     │
│       ├─ FTS5 BM25 Top N                                     │
│       └─ 向量 KNN Top N                                      │
│                 ↓                                            │
│              RRF 融合 / 去重                                 │
│                 ↓                                            │
│        确定性重排（覆盖率/精确词/来源）                        │
│                 ↓                                            │
│        cross-encoder rerank（可选）                          │
│                 ↓                                            │
│              Top K（默认 5–6）                               │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                         回答层                                │
│  上下文拼装（稳定前缀 + 动态片段）→ LLM（可命中 Prompt/KV 缓存）│
│         → JSON 回答 + 引用                                    │
│         ↓                                                    │
│  引用解析：chunk 存在？哈希未变？                              │
│         ↓                                                    │
│  支持度校验：数字/实体/关键词/结论是否在引用片段中              │
│         ↓                                                    │
│  通过 → 精确缓存 → 返回；失败 → 删句/拒答                     │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. 数据模型

### 5.1 兼容原则

当前 M3 已发布表：

```text
knowledge_document
knowledge_chunk
knowledge_fts
```

已发布迁移不可修改。M4 采用：

- 保留现有表名与数据
- 新增表/列（append-only migration）
- 逻辑上映射到 PRD 的 `knowledge_source / knowledge_doc / chunk / chunk_fts / chunk_vec / embedding_meta / citation / knowledge_conflict`

不重命名已发布表，避免破坏 M3 数据和回滚能力。

### 5.2 逻辑模型

#### knowledge_source

一个可重复同步的来源（目录、文件集合、未来的 Git 仓库/网页源）。

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| kind | file / directory / git / web / email / note |
| uri | 来源标识（路径/URL/仓库地址） |
| scope | personal / team / org / external |
| team_id | M6 使用，M4 可为空 |
| default_class | L0–L3 |
| enabled | 是否继续同步 |
| created_at / updated_at | 时间 |

#### knowledge_document

一个逻辑文档版本。

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| source_id | 来源 |
| title | 显示标题 |
| path | 原始文件路径/位置 |
| content_hash | 原文 SHA-256 |
| version | 文档版本号 |
| data_class | L0–L3 |
| generated_by | user / employee / external |
| authority | official / note / external / employee |
| valid_from / valid_to | 有效时间 |
| deleted_at | 软删除 |
| updated_at | 更新时间 |

> 现有 `knowledge_document` 通过迁移补 `source_id`、`version`、`generated_by`、`authority`、`valid_*` 等列；无值按保守默认。

#### chunk

最小检索单元。

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| document_id | 文档 |
| ordinal | 文档内序号 |
| text | 原文片段 |
| content_hash | 片段哈希 |
| start_offset / end_offset | 字符偏移 |
| page / line_start / line_end | PDF/代码位置 |
| heading_path | 标题树，如 `安装 > 配置` |
| token_count | 估算 token |
| data_class | 继承/提升后的分级 |
| created_at | 时间 |

现有 `knowledge_chunk` 通过迁移补 `content_hash`、`heading_path`、`page`、`line_*`；当前回填可由原文重算。

#### chunk_fts

沿用现有 FTS5；保持“汉字逐字 + 拉丁词”的索引方式。

M4 增强：

- 查询侧使用“清洗 + OR + 覆盖率”
- 不再把整句所有字符做 AND
- FTS 仍然保留，作为精确词/降级通道

#### chunk_vec

`sqlite-vec` 虚表：

```sql
-- 逻辑示意，具体 DDL 在 M4 迁移中定稿
CREATE VIRTUAL TABLE chunk_vec USING vec0(
  embedding FLOAT[512]
);

CREATE TABLE chunk_vec_map (
  rowid     INTEGER PRIMARY KEY,
  chunk_id  TEXT NOT NULL UNIQUE
);
```

约束：

- `rowid` 用 **BigInt** 绑定（C-2）
- 建库时必须 `allowExtension: true`（C-1）
- 一条 chunk 对应一条向量
- 换模型/维度必须新建索引，不能原地混用

#### embedding_meta

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| provider | local-onnx / cloud |
| model | 模型名 |
| dim | 维度 |
| model_version | 模型版本/哈希 |
| index_version | 索引代次 |
| created_at | 时间 |
| active | 当前是否用于检索 |

每个索引代次只允许一个 active embedding_meta；切换时双写/重建，成功后原子切换。

#### citation

回答引用的持久化记录。

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| answer_id / run_id | 回答 |
| chunk_id | 引用片段 |
| document_version | 文档版本 |
| content_hash | 片段哈希 |
| quote_start / quote_end | 引用子串位置 |
| verified | 0/1 |
| invalid_reason | 文件已删/哈希变化/越权 |
| created_at | 时间 |

#### knowledge_conflict

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| topic | 冲突主题 |
| chunk_a / chunk_b | 两个片段 |
| status | open / resolved / ignored |
| resolution | 采用哪个版本/人工裁决 |
| resolved_by / resolved_at | 裁决人/时间 |

#### rag_cache

| 字段 | 说明 |
| --- | --- |
| key | 规范化问题 + 版本组合的哈希 |
| question_norm | 规范化问题 |
| scope/filters | 作用域/过滤条件 |
| doc_versions_hash | 文档版本集合哈希 |
| embedding_index_version | 向量索引代次 |
| model / prompt_version / reranker_version | 组合版本 |
| answer_json | 回答 + 引用 |
| created_at / expires_at | TTL |
| hit_count | 命中次数 |

---

## 6. 摄取与分块

### 6.1 摄取管道

```text
选择来源
→ 解析（保留标题/表格/代码块/页码）
→ 清洗（去样板、统一换行）
→ 内容哈希
→ 结构分块
→ 元数据/分级
→ 脱敏预处理（外发嵌入时）
→ 嵌入（本地）
→ 入库
→ FTS + 向量索引
```

### 6.2 解析器

M4b 首批：

- Markdown / TXT
- Word `.docx` / RTF（现有 textutil）
- PDF（按页解析，保留页码）
- 代码（按文件/函数边界；先支持常见语言，AST 解析失败回退段落）
- Git 仓库（见 6.2.1）

后续：

- 网页/RSS
- 邮件/日历作为知识源

#### 6.2.1 Git 仓库来源（M4b）

目标：用户填一个 HTTPS Git URL，Aegis 拉取仓库文档与代码并建立索引。

##### 克隆位置

```text
<dataDir>/knowledge/repos/<sha256(repoUrl)>/
```

不把仓库放进用户原目录，也不依赖系统 Git 配置。

##### 拉取策略

- M4b 只支持 **HTTPS**（SSH 后续）
- 默认 `--depth 1` 浅克隆
- 只使用配置的 ref（默认默认分支）
- 不执行仓库 hooks
- 不递归 submodule
- 不启用 Git LFS（遇到 LFS 指针按普通文本跳过）
- 记录 `last_commit` / `last_synced_at` / `ref`

##### 更新

```text
fetch --depth 1 origin <ref>
→ 比较 last_commit
→ 只解析变更文件
→ 新增/更新 chunk
→ 删除文件软删除
→ 记录新 commit
```

拉取失败时保留旧索引并显示错误，不破坏已有知识。

##### 过滤

- 文件类型白名单：md/txt/docx/rtf/pdf + 代码扩展
- 忽略 `.git/`、`node_modules/`、`dist/`、`build/`、`vendor/`、二进制/大文件
- 单文件大小上限
- 单仓库文件数/总大小上限
- symlink 必须解析后仍在仓库根内，防止路径穿越

##### 鉴权与安全

- 私有仓库 token 存系统钥匙串，不写进 URL/配置/日志
- token 不出现在进程命令行（避免使用 `https://token@...`）
- 仓库内容是不可信数据：只当资料，不执行、不安装、不运行
- 不自动信任仓库里的 `.gitmodules`、hooks、脚本

##### 验收

- 公开仓库可导入
- 私有仓库 token 鉴权成功
- 第二次同步只重建变化文件
- 删除文件后引用标记失效
- 超大仓库被明确拒绝而不是卡死

### 6.3 分块策略

原则：

1. 结构优先：标题层级、段落、代码块、表格
2. 表格与代码块**整体不切**
3. 目标 400–800 tokens，重叠 10–15%
4. 每块保留标题路径、页码/行号、字符偏移
5. 超长代码函数可切，但保留函数名/文件路径

禁止：

- 固定 800 字硬切导致语义截断
- 把标题和正文分离到不同块
- 把表格拆成无表头的行

### 6.4 增量与删除

- 内容哈希相同 → 跳过
- 内容变化 → 新版本 + 软删除旧 chunk
- 文件删除 → 文档软删除，chunk 不再参与检索；citation 标记失效
- 重建索引不阻塞主流程；旧索引可继续服务

### 6.5 分级

- 来源默认 L2（未知）
- 文件/目录可指定 L0–L3
- 分级只能升，不能由模型/员工下调
- L3 不参与任何外部 embedding
- 云端 embedding 只允许 L0/L1，且显式授权

---

## 7. Embedding

### 7.1 Provider 接口

```ts
interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

实现：

1. `LocalOnnxEmbeddingProvider`（默认）
2. `CloudEmbeddingProvider`（默认关闭）
3. `NullEmbeddingProvider`（只 FTS；降级）

### 7.2 本地模型

建议：

- 模型：`bge-small-zh-v1.5`（中文小模型，512 维）
- 量化：INT8 / ONNX
- 运行：ONNX Runtime（CPU）
- 打包：模型随 App 放入 `Resources/models/`
- 校验：启动时校验模型文件哈希；缺失/损坏 → 自动回退 FTS

选择理由：

- 中文语义尚可
- 体积/内存可控
- 不需要联网
- 不把知识内容发给第三方

### 7.3 本地嵌入进程

不能直接在 daemon 主循环里跑大模型：

```text
daemon
  └─ embedding worker（worker_threads / 独立进程）
       ├─ 加载模型
       ├─ 批量嵌入队列
       ├─ 超时/取消
       └─ 空闲卸载（可选）
```

约束：

- 索引任务后台执行，不阻塞 tick
- 单批大小有限（例如 16–32）
- 超时/内存上限
- 失败不影响 FTS 检索
- 模型加载失败有可见状态

### 7.4 云端嵌入（可选）

仅在用户显式开启时：

- 只允许 L0/L1
- 必须经脱敏网关
- 记录 `outbound_audit`
- 不发送 L2/L3
- 维度/模型版本写入 `embedding_meta`
- 关闭后索引不可混用

### 7.5 版本与重建

- 文档哈希不变但模型变了 → 必须重建向量
- 索引代次 `index_version` 递增
- 重建期间旧索引可读
- 完成后原子切换 active 索引
- 缓存 key 包含 `embedding_index_version`

---

## 8. 向量索引

- `sqlite-vec` 与主库同文件
- 建库 `allowExtension: true`
- `rowid` 使用 BigInt
- 只索引 `chunk_vec_map` 中存在的 chunk
- 删除文档时同步删除 map/vector
- 索引重建可删除 `chunk_vec` 与 map 后重灌
- 向量自身视为 L2 数据，不导出、不跨库复制

降级：

- 扩展加载失败 → `NullEmbeddingProvider` + FTS
- 维度不匹配 → 拒绝启用，提示重建
- 向量查询失败 → FTS 结果继续

---

## 9. 检索与重排

### 9.1 查询处理

1. 规范化：全半角、大小写、空白
2. 问句清洗（沿用并增强 M3 修复）
3. 可选查询改写：
   - 拆关键词
   - 补同义词
   - 多轮检索（概念→细节）
4. 保留原查询，用于 FTS 精确匹配
5. 过滤条件先于排序：
   - scope/team
   - data_class ≤ 当前允许
   - source kind
   - 时间/有效性
   - 排除软删除/越权

### 9.2 双路召回

```text
FTS Top 50
向量 Top 50
```

参数可配置：

```json
{
  "ftsTop": 50,
  "vecTop": 50,
  "rrfK": 60,
  "rerankTop": 30,
  "finalTop": 6
}
```

### 9.3 RRF 融合

```text
score = Σ 1 / (k + rank_i)
```

- 同 chunk 去重
- 保留 FTS 精确词命中标记
- 保留向量相似度分数
- 低分/低覆盖率过滤

### 9.4 重排

#### Stage 1：确定性重排（默认开启）

- 查询词覆盖率
- 精确短语/代码标识符命中
- 标题/heading_path 命中
- 来源权威度
- 新鲜度
- employee 生成内容降权（FR-G99）

#### Stage 2：cross-encoder（可选）

- 本地 reranker，例如 bge-reranker 小模型
- 只对 Top 20–30 重排
- 默认关闭；在“准确率优先”配置下开启
- 失败 → 保留 Stage 1 顺序
- 额外体积/延迟必须计入预算

#### 为什么先做确定性重排

当前 M3 的失败主要是“召回零命中/泛字误命中”，不是排序模型不够强。

先做确定性重排可以：

- 零模型成本
- 可解释
- 不增加打包体积
- 为 cross-encoder 提供稳定候选

### 9.5 上下文构造

- 默认 Top 5–6 块
- 按 token 预算裁剪（例如 4k）
- 去重叠
- 每块带编号、标题、来源
- 明确分隔“资料”和“指令”
- 不把检索内容当系统指令（prompt injection 防护）

---

## 10. 生成、引用与拒答

### 10.1 回答协议

```json
{
  "found": true,
  "answer": "...",
  "claims": [
    {
      "text": "...",
      "citations": [1, 2]
    }
  ],
  "citations": [
    {
      "index": 1,
      "quote": "原文中的支持句"
    }
  ]
}
```

要求：

- 每个 claim 至少一个 citation
- citation 只能引用本次上下文编号
- quote 必须能在对应 chunk 中找到
- 找不到 → 该 claim 不可信

### 10.2 机械校验（必须）

1. citation 编号存在
2. chunk_id 存在
3. 文档未被删除
4. chunk 内容哈希未变
5. quote 是 chunk 的子串
6. 数字/日期/专有名词出现在引用片段
7. 越权/分级不允许 → 拒绝

失败：

- 单条 claim → 删除该 claim
- 关键 claim → 整体拒答
- 引用失效 → `citation.invalid_reason`

### 10.3 支持度校验（逐句）

低成本版（默认）：

- 提取 claim 中的实体/数字/关键词
- 检查是否出现在引用 chunk
- 覆盖率低于阈值 → 不支持

增强版（可选）：

- 本地 NLI / cross-encoder 判断 entailment
- 或小模型 verifier
- 仅高风险/关键结论使用，避免每题增加延迟

### 10.4 拒答

- 检索为空
- 重排后最高分低于阈值
- 引用全部失效
- 核心 claim 无支持
- L2 超过外发上限
- 模型返回非法 JSON
- 模型返回无有效引用

回答模板：

```text
知识库里没有找到足够依据，无法确认。
可以：扩大检索范围 / 指定文档 / 提供资料。
```

### 10.5 引用失效

文件被删除/修改：

- citation 标记 `invalid_reason`
- UI 显示“引用已失效”
- 不自动用新版本替换旧引用；需重新检索

---

## 11. 精确缓存

### 11.1 只缓存校验通过的回答

```text
生成 → 机械校验 → 支持度校验 → 通过 → 写缓存
```

不合格回答绝不入缓存。

### 11.2 Key

```text
normalized_question
+ scope/filters
+ document_version_set_hash
+ embedding_provider/model/index_version
+ prompt_version
+ reranker_version
+ llm_model
```

### 11.3 失效

- 文档新增/更新/删除
- 索引重建
- embedding 模型切换
- prompt 版本变化
- reranker 版本变化
- 权限/分级变化
- TTL 到期（默认 24h，可配置）

### 11.4 不做什么

第一版不做：

- 语义缓存
- 跨用户共享
- 跨 team 共享
- 缓存含 L3 的回答

---

## 11A. 模型侧前缀缓存与 KV 缓存

> 这一节与应用层 `rag_cache` 是两件不同的事，必须分开设计。

### 11A.1 两种缓存的分工

| 层 | 作用 | 命中后省掉什么 | 数据在哪 |
| --- | --- | --- | --- |
| 应用精确缓存 `rag_cache` | 同一问题 + 同一版本，直接复用答案 | 检索、模型、校验全跳过 | 本机 SQLite |
| Prompt Cache / 前缀缓存 | 复用稳定前缀的 prefill 计算 | 不重复计算系统提示/资料前缀 | 服务商或本地推理运行时 |
| KV Cache | 推理运行时缓存注意力 K/V | prefill 计算 | 本地/服务商内部 |

关键区别：

```text
应用缓存命中 → 不调用模型
Prompt/KV 缓存命中 → 仍然调用模型，但首 token 更快、输入更便宜
```

两者不能互相替代。

### 11A.2 目标

- 模型/服务商支持时，自动启用前缀缓存
- 不支持时，请求照常成功，不出现 400/报错
- 稳定前缀尽可能字节级一致，提高缓存命中
- 记录缓存命中指标，能量化收益
- 云端缓存遵守数据分级/保留策略

### 11A.3 Provider 能力模型

```ts
interface PromptCacheCapability {
  /** none：不支持；automatic：服务商自动识别；explicit：请求里必须显式标记 */
  mode: "none" | "automatic" | "explicit";
  /** 是否支持稳定前缀复用 */
  prefix: boolean;
  /** 是否支持显式 TTL/缓存断点 */
  ttl?: boolean;
  /** 是否有缓存计费/命中字段 */
  usageFields?: string[];
}
```

Provider 适配器负责：

- 声明能力
- 把统一的请求结构映射到服务商参数
- 解析 usage 中的 cached tokens
- 不支持时忽略参数，或重试去掉缓存参数

不在业务层写死某一家 API 的字段名。

### 11A.4 请求结构：稳定前缀 + 动态后缀

为了提高前缀命中，Prompt 必须稳定排序：

```text
[稳定前缀]
  1. 系统规则（安全、引用格式、拒答规则）
  2. 输出 JSON Schema
  3. 固定示例（如有）
  4. 固定工具/能力说明

[动态后缀]
  5. 本次检索片段
  6. 用户问题
  7. 运行时元数据（时间、scope）
```

规则：

- 稳定前缀必须字节级一致
- 不要把时间戳、随机请求 id、检索结果放在最前面
- 不要在前缀里放会变化的文档内容
- 同一模型/同一 prompt_version 下复用
- 动态片段使用明确边界，避免 prompt injection

### 11A.5 服务商差异

不同服务商的机制不同，设计上只承诺能力抽象：

| 类型 | 典型机制 | 应用侧动作 |
| --- | --- | --- |
| OpenAI 兼容 | 自动前缀缓存 / 部分支持 cache key | 保持稳定前缀；能力探测 |
| Anthropic | 显式 cache_control 断点 | 适配器在稳定前缀末尾打断点 |
| DeepSeek | 上下文缓存（自动） | 保持稳定前缀 |
| Gemini | 显式 context cache | 适配器创建/引用缓存 |
| 本地 ONNX/llama.cpp/vLLM | 运行时 prefix cache / KV cache | 稳定前缀；运行时自行复用 |

具体参数以服务商当前 API 为准；**不把未验证的字段写进通用请求**。

### 11A.6 与应用缓存的关系

调用顺序：

```text
规范化问题
→ 查 rag_cache（精确）
   ├─ 命中 → 返回
   └─ 未命中
       → 检索
       → 构造稳定前缀 + 动态后缀
       → 模型调用（服务商可能命中 Prompt/KV 缓存）
       → 引用校验
       → 写 rag_cache
```

- 应用缓存优先，因为完全不调用模型
- Prompt Cache 只优化“必须调用”的那部分
- 两者 key 都包含 prompt_version/model/index_version

### 11A.7 安全与数据保留

Prompt Cache 可能意味着**内容在服务商侧保留一段时间**。

因此：

- 本地模型/本地运行时：可以使用，数据不出机器
- 云端 Prompt Cache：
  - 只允许当前外发策略允许的数据
  - L2/L3 默认不启用，除非用户显式授权且符合策略
  - 记录 `outbound_audit`，说明启用了缓存
  - 不把缓存 key 当租户隔离手段
  - 不跨用户复用
- 服务商 TTL/保留策略必须可配置/可关闭
- 关闭缓存后，下一次请求自然 miss，不能影响正确性

### 11A.8 指标

统一归一化：

```text
prompt_cache_hit_tokens
prompt_cache_miss_tokens
cache_creation_input_tokens
cache_read_input_tokens
ttft_ms
input_tokens
output_tokens
```

用途：

- 命中率
- 首 token 延迟
- 输入成本
- 估算节省

无法从服务商获得字段时：

- 标记 `cache_metrics_unavailable`
- 不伪造命中率

### 11A.9 失败与降级

- 服务商不支持缓存参数 → 去掉参数重试一次
- 缓存创建失败 → 正常请求，记录 warning
- TTL 过期 → 正常 miss
- 模型切换 → 旧缓存自然失效
- 缓存参数导致 400 → 禁用该 provider 的 prompt cache 能力
- 不允许因为缓存失败导致回答失败

### 11A.10 测试

- 能力探测：支持/不支持/未知
- 稳定前缀快照：同样输入字节级一致
- 动态内容不进入前缀
- 不支持参数时回退
- usage 字段解析
- L2 云端缓存授权路径
- 关闭缓存后结果仍正确
- 指标记录不包含正文

---

## 12. 权限、安全与隐私

### 12.1 检索前过滤

必须先按 scope/team/data_class 过滤，再做相似度排序。

不能：

```text
先向量召回，再把越权结果丢掉
```

因为越权内容已经进入候选/日志/模型上下文。

### 12.2 数据分级

- 知识库默认 L2
- 向量视为 L2 数据
- L3 不参与外部 embedding/云端 rerank
- 云端 embedding 只允许 L0/L1 + 显式授权
- 检索片段送模型前必须过脱敏网关

### 12.3 Prompt injection

导入文档是不可信数据：

- 检索内容放进“资料”区块，不放进系统指令
- 不允许文档内容改变工具权限
- 文档内的“忽略之前指令”只当普通文本
- 高风险动作仍需人工确认

### 12.4 日志/审计

- 不记录正文/向量/完整 prompt
- 记录 purpose、topK、命中文档 id、分级、哈希、耗时
- 外发审计记录 `rag-answer` / `rag-embedding-cloud`
- 支持按 doc/chunk 追溯引用

---

## 13. 知识冲突与来源可信度

### 13.1 冲突检测

同一 topic/标题/接口名出现多版本：

- 同一文档新旧版本
- 不同来源的同名文档
- 员工生成内容与正式文档

### 13.2 处理

1. 优先新版本
2. 优先权威来源
3. 仍冲突 → 提示用户裁决
4. 裁决结果写入 `knowledge_conflict`
5. 不自动删除旧版本

### 13.3 来源权重

```text
正式交付物 > 手工笔记 > 外部公开资料 > 员工生成内容
```

员工生成内容：

- `generated_by=employee`
- 默认 `authority=employee`
- 检索降权
- 不得作为唯一依据

---

## 14. 增量、重建与迁移

### 14.1 迁移策略

M4 新迁移（示例编号，实际按顺序）：

```text
0006_rag_sources_and_metadata.sql
0007_chunk_vectors.sql
0008_rag_cache_and_citations.sql
```

原则：

- 已发布迁移不改
- 只加表/加列/加索引
- 旧数据可继续 FTS 检索
- 向量回填异步执行
- 回填失败保留 FTS

### 14.2 重建

```text
停用向量索引（active=false）
→ 删除/重建 chunk_vec + map
→ 重新分块/嵌入
→ 校验数量/维度
→ 原子切换 active
```

- 重建期间 FTS 可用
- 重建不阻塞调度
- 记录进度/错误

### 14.3 容量

- 目标 10 万块
- 向量 512 维 float32 ≈ 2KB/块 ≈ 200MB（10 万）
- 原文/索引/数据库总大小需监控
- 容量告警阈值

---

## 15. 性能目标

| 指标 | 目标 |
| --- | --- |
| 本地检索 P95 | <500ms |
| 缓存命中 | <20ms |
| 向量嵌入（批量） | 后台执行，不阻塞 tick |
| 首次索引 | 可见进度，可取消 |
| 内存增量 | 模型/索引可控，有上限 |
| 100k 块检索 | 仍满足 P95 目标 |

延迟预算：

```text
查询清洗/过滤   <20ms
FTS 召回        <50ms
向量 KNN        <100ms
RRF/重排        <50ms
模型生成        主要成本
校验/缓存       <50ms
```

降级路径：

```text
向量不可用 → FTS + 确定性重排
reranker 不可用 → 保留 RRF/确定性排序
缓存异常 → 实时回答
```

---

## 16. 配置、API 与界面

### 16.1 配置

```json
{
  "rag": {
    "enabled": true,
    "embedding": {
      "provider": "local",
      "model": "bge-small-zh-v1.5",
      "dim": 512
    },
    "retrieval": {
      "ftsTop": 50,
      "vecTop": 50,
      "rrfK": 60,
      "rerank": "heuristic",
      "finalTop": 6
    },
    "citation": {
      "requireClaims": true,
      "supportCheck": "lexical"
    },
    "cache": {
      "enabled": true,
      "ttlS": 86400
    },
    "promptCache": {
      "mode": "auto",
      "allowCloudL2": false
    }
  }
}
```

### 16.2 IPC

新增/扩展：

```text
knowledge.import        现有
knowledge.reindex       新增：重建向量/索引
knowledge.stats         新增：文档/块/索引/模型状态
knowledge.search        扩展：筛选/混合检索
knowledge.answer        扩展：RAG 选项
knowledge.cancel        新增：取消索引任务
rag.status              新增：模型/索引/缓存健康
```

### 16.3 界面

设置 → 知识库：

- 文档列表
- 导入
- 索引状态
- 模型状态（本地/未加载/失败）
- 重建索引
- 缓存开关/TTL
- 检索诊断（可选，显示 FTS/向量候选数和耗时）

问答：

- 引用可点击
- 引用失效标记
- 无依据提示
- “仅本地检索”/“混合检索”状态
- 不显示模型内部推理

---

## 17. 打包与运行

### 17.1 用户端

目标：**不需要安装 Ollama/Python/数据库**。

打包内容：

```text
Aegis.app/Contents/Resources/
├── app/
├── daemon/
├── models/
│   └── bge-small-zh-v1.5/
├── node/bin/node
└── node_modules/（sqlite-vec、onnxruntime 等）
```

### 17.2 开发侧

必须处理：

- ONNX Runtime 原生库按架构打包
- sqlite-vec 扩展加载
- 模型文件哈希校验
- 原生库签名/公证（正式版）
- 模型许可证可再分发
- App 体积预计 +100–200MB
- daemon 内存增加，需懒加载/空闲卸载

### 17.3 降级

模型缺失/损坏/平台不支持：

```text
RAG 混合检索不可用
→ 自动只用 FTS
→ 界面显示“语义检索未启用”
→ 不影响导入/引用/拒答
```

---

## 18. 测试与评估

### 18.1 单元测试

- 分块：标题/代码/表格/超长
- 哈希/增量/软删除
- FTS 查询清洗
- RRF 融合/去重
- 过滤/分级/scope
- 缓存 key/失效
- 引用哈希/quote 校验
- 支持度校验
- 冲突检测
- 降级路径

### 18.2 集成测试

- 临时 SQLite + 假 embedding provider（确定性向量）
- 导入→索引→检索→回答→引用→缓存
- 文档更新后缓存失效
- 删除文档后引用失效
- 向量扩展不可用回退 FTS
- 10 万块规模压测（合成数据）

### 18.3 评估集

至少 30–50 题：

| 类型 | 数量 |
| --- | --- |
| 精确关键词/代码标识符 | 8 |
| 自然语言语义 | 10 |
| 多文档归纳 | 6 |
| 无依据（应拒答） | 8 |
| 新旧版本冲突 | 4 |
| 引用失效/权限 | 4 |
| Prompt injection | 3 |

指标：

```text
Recall@5 / Recall@10
MRR
引用支持率
无依据拒答率
回答正确率（人工）
P50/P95 延迟
缓存命中率
索引时间
```

### 18.4 通过门槛

- 语义题 Recall@5 ≥ 85%
- 精确题 Recall@5 ≥ 95%
- 无依据拒答率 ≥ 95%
- 引用支持率 ≥ 95%
- 引用可点击打开正确来源 ≥ 95%
- 检索 P95 <500ms
- 无严重越权/外发

---

## 19. 实施阶段

> 按 M4b 排期；M3 未验收 / M4a 未完成前不开始。

### Phase 0：评估与基线（M4b 准备）

- 20–50 题评估集
- 测当前 FTS baseline
- 确认模型/打包方案
- ADR

### Phase 1：数据与摄取（M4b）

- 新迁移
- source/doc/chunk 元数据
- 结构分块
- 增量/软删除
- FTS 兼容
- 文件/目录来源
- Git 来源（HTTPS、浅克隆、增量同步、私有仓库 token）

### Phase 2：本地嵌入（M4b）

- EmbeddingProvider
- ONNX worker
- 模型打包/校验
- 索引/重建
- 降级

### Phase 3：混合检索（M4b）

- 双路召回
- RRF
- 过滤
- 确定性重排
- topK/压缩

### Phase 4：引用与缓存（M4b）

- claim 协议
- 机械校验
- 支持度校验
- citation 表
- 精确缓存/失效
- Prompt Cache 能力探测/稳定前缀
- 缓存指标
- 拒答路径

### Phase 5：界面与验收（M4b）

- 索引状态/重建
- 引用失效 UI
- 评估
- 打包
- 验收

### Phase 6（可选）

- cross-encoder rerank
- 查询改写 LLM
- 网页/RSS 来源
- PDF 高级解析
- 冲突治理 UI

---

## 20. 验收清单

- [ ] 5 类文档（MD/TXT/DOCX/RTF/PDF）可导入
- [ ] Git 仓库可导入并增量同步
- [ ] 私有仓库 token 不进配置/日志
- [ ] 仓库更新只重建变化文件
- [ ] 10 万块规模索引可建立
- [ ] 混合检索可开关
- [ ] 向量不可用时自动回退 FTS
- [ ] 30+ 评估题达到门槛
- [ ] 每个结论有可点击引用
- [ ] 引用哈希/quote 校验通过
- [ ] 无依据/低分明确拒答
- [ ] L2 在 L1 上限下不外发
- [ ] L3/越权内容检索不到
- [ ] 文档更新后缓存失效
- [ ] 模型支持 Prompt Cache 时请求命中/可观测
- [ ] 不支持 Prompt Cache 时请求仍成功
- [ ] 云端 Prompt Cache 遵守分级/授权/审计
- [ ] 删除文档后引用标记失效
- [ ] 索引重建不阻塞调度
- [ ] 打包产物离线可用（模型随包）
- [ ] 无 Ollama/Python/外部数据库依赖
- [ ] 正式签名/公证路径明确

---

## 21. 风险与开放问题

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| ONNX Runtime 打包复杂 | 安装失败/体积 | 分架构构建、启动自检、FTS 降级 |
| 模型许可证 | 不能分发 | 选可再分发模型，记录许可证 |
| sqlite-vec 原生扩展 | 加载失败 | 建库时 allowExtension；启动探测；FTS 降级 |
| 本地模型内存/CPU | 24/7 不稳 | worker、批处理、懒加载、上限 |
| 向量维度/模型切换 | 旧索引不可用 | 索引代次/重建/原子切换 |
| 缓存陈旧 | 错误复用 | 文档/索引/模型/prompt 版本 key |
| 服务商 Prompt Cache 保留数据 | 隐私 | 本地优先；云端 L2 需授权；记录审计/TTL |
| 服务商字段不兼容 | 请求失败 | 能力探测；去掉参数重试；禁用该能力 |
| reranker 增加延迟 | 体验下降 | 默认轻量重排，cross-encoder 可选 |
| 引用校验误杀 | 回答变少 | 分级阈值、只对关键句严格 |
| Prompt injection | 越权/错误 | 资料区隔离、无工具权限、人工确认 |
| Git/PDF 解析质量 | 分块差 | 分阶段、可回退 |
| Git 私有仓库鉴权 | 无法同步/泄露 | 钥匙串 token、HTTPS、无 token URL |
| 超大仓库/子模块 | 卡死/超时 | 大小上限、浅克隆、不递归 submodule |

### 已关闭的产品决策

- RAG 在 M4 实施
- 本地 ONNX 随包，离线可用
- 确定性重排默认，cross-encoder 可选
- Prompt Cache `auto`，云端 L2 默认禁止
- M4 摄取：MD/TXT/Word/RTF/PDF + 代码 + Git
- 引用支持度失败：删句；核心失败拒答
- M3 先走 2–3 天缩短验收，记录 7 天豁免
- M4 schema 预留 scope/team_id

### 仍需在 M4b Phase 0 验证的技术项

1. 本地模型最终选型与许可证（候选 bge-small-zh-v1.5）
2. cross-encoder 具体模型与默认开关
3. PDF 解析器/质量
4. Git 私有仓库 token 的具体钥匙串 key 与 UI
5. 引用支持度阈值的数值标定
6. sqlite-vec/ONNX 在打包产物中的实测
7. M4 是否包含代码 AST 解析，还是先按文件/段落

---

## 22. 与现有 M3 代码的衔接

| 现有 | M4 处理 |
| --- | --- |
| `KnowledgeBase.ingest/list/search/remove` | 扩展 source/version/metadata，不破坏现有 IPC |
| `searchForQuestion` 清洗+OR+覆盖率 | 保留为 FTS 通道；混合检索时作为候选源 |
| `LlmService.answer` | 改为调用 `RagService.answer`；保留拒答/网关/审计 |
| `knowledge_document/chunk/fts` | 保留；新增表/列 |
| 引用回查 | 扩展为 citation 表 + 哈希/quote 校验 |
| 800 字分块 | M4 新文档使用结构分块；旧文档可后台重建 |
| 现有 M3 测试 | 全部保留；新增 RAG 测试 |

**迁移原则：** 先双读/双写，稳定后切换默认；任何阶段都必须保留 FTS 可用路径。

---

## 23. 设计结论

完整 RAG 是一个**检索质量 + 证据安全 + 性能缓存**的组合工程，不是“加一个向量库”。

本设计的关键取舍：

1. 本地 embedding 默认、随包分发、离线可用
2. FTS 永不删除，始终作为精确匹配与降级通道
3. 混合召回后先做确定性重排，cross-encoder 可选
4. 引用校验分为“机械校验”和“支持度校验”两层
5. 只缓存校验通过的回答，key 带完整版本
6. 所有失败路径回退 FTS，不阻塞提醒/调度
7. 按 M4 实施，不提前进 M3

下一步：

1. 执行 M3 缩短验收并记录 7 天豁免
2. 完成 M4a 单员工核心闭环
3. 完成 Phase 0 的 ONNX / sqlite-vec / PDF / Git spike
4. 建 30–50 题评估集
5. 冻结 DDL 与 API
6. 开 M4b Phase 0

在这些完成前，不开始 RAG 编码。
