-- 0004_llm_usage.sql
-- M3 模型调用预算：按 UTC 天记录调用次数，防止失控
--
-- 只记录计数，不记录请求内容、模型输出或凭据。

CREATE TABLE llm_usage (
  day_key           INTEGER NOT NULL,
  purpose           TEXT NOT NULL,
  calls             INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (day_key, purpose)
);
