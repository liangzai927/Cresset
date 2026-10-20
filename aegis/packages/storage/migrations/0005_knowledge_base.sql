-- 0005_knowledge_base.sql
-- M3 知识库地基：文档、分块、CJK 可检索的 FTS5 索引
--
-- FTS5 的 unicode61 不会把中文词切出来（README F3），因此写入前会把
-- 汉字逐字切分、拉丁词按词切分；查询时同样切分并用 AND 连接。

CREATE TABLE knowledge_document (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  source_path       TEXT NOT NULL UNIQUE,
  source_kind       TEXT NOT NULL DEFAULT 'file'
                    CHECK (source_kind IN ('file','note','external')),
  data_class        TEXT NOT NULL DEFAULT 'L2'
                    CHECK (data_class IN ('L0','L1','L2','L3')),
  content_hash      TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE knowledge_chunk (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES knowledge_document(id) ON DELETE CASCADE,
  ordinal           INTEGER NOT NULL,
  text              TEXT NOT NULL,
  start_offset      INTEGER NOT NULL,
  end_offset        INTEGER NOT NULL,
  UNIQUE(document_id, ordinal)
);
CREATE INDEX idx_knowledge_chunk_doc ON knowledge_chunk(document_id, ordinal);

-- chunk_id 只用于回表；真正检索的是 tokens
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  chunk_id UNINDEXED,
  tokens,
  tokenize = 'unicode61'
);
