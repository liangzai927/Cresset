-- 0001_init_scheduling.sql
-- 调度域 + 通知域（《M0+M1 详细设计》§4.1 / §4.2）
--
-- 约定：
--   - 时间统一存 UTC 毫秒（INTEGER）
--   - 枚举存 TEXT（可读、可迁移），值域由应用层 Zod 校验
--   - JSON 存 TEXT

-- ── 提醒任务
CREATE TABLE task (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  notes             TEXT,
  priority          TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('normal','important')),
  enabled           INTEGER NOT NULL DEFAULT 1,
  -- 重复规则（NULL = 一次性）
  rrule             TEXT,
  dtstart_wall      TEXT NOT NULL,
  tzid              TEXT NOT NULL DEFAULT 'system',
  until_wall        TEXT,
  count_limit       INTEGER,
  fired_count       INTEGER NOT NULL DEFAULT 0,
  catchup_window_s  INTEGER NOT NULL DEFAULT 43200,
  snooze_default_s  INTEGER NOT NULL DEFAULT 600,
  dnd_override      TEXT NOT NULL DEFAULT 'inherit'
                    CHECK (dnd_override IN ('inherit','allow','block')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX idx_task_enabled ON task(enabled, deleted_at) WHERE deleted_at IS NULL;

-- ── 触发实例：幂等性的唯一裁决点
CREATE TABLE occurrence (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  scheduled_at      INTEGER NOT NULL,
  scheduled_wall    TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending','claimed','delivered','failed','skipped','unknown')),
  claim_token       TEXT,
  claim_expires_at  INTEGER,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  delivered_at      INTEGER,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
-- ★★ 幂等基石：同一任务的同一时刻只能有一条实例
CREATE UNIQUE INDEX uq_occurrence ON occurrence(task_id, scheduled_at);
CREATE INDEX idx_occurrence_due ON occurrence(state, scheduled_at);
CREATE INDEX idx_occurrence_task ON occurrence(task_id, scheduled_at DESC);

-- ── 通知
CREATE TABLE notification (
  id                TEXT PRIMARY KEY,
  occurrence_id     TEXT REFERENCES occurrence(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('reminder','catchup_batch','system_gap','failure','digest')),
  title             TEXT NOT NULL,
  body              TEXT,
  priority          TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low','normal','high','urgent')),
  scheduled_for     INTEGER NOT NULL,
  state             TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending','delivering','delivered','failed','suppressed')),
  dedupe_key        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_notification_dedupe ON notification(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_notification_state ON notification(state, scheduled_for);

-- ── 每个渠道的投递尝试（审计 + 重试依据）
CREATE TABLE delivery_attempt (
  id                TEXT PRIMARY KEY,
  notification_id   TEXT NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL,
  attempt_no        INTEGER NOT NULL,
  outcome           TEXT NOT NULL
                    CHECK (outcome IN ('success','transient_error','permanent_error','timeout')),
  error             TEXT,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER
);
CREATE INDEX idx_attempt_notification ON delivery_attempt(notification_id, attempt_no);

-- ── Outbox：外部副作用与数据库事务解耦
CREATE TABLE outbox (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  topic             TEXT NOT NULL,
  payload           TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending','inflight','done','dead')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER NOT NULL,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_outbox_ready ON outbox(state, next_attempt_at);

-- ── 稍后提醒
CREATE TABLE snooze (
  id                TEXT PRIMARY KEY,
  origin_occurrence TEXT NOT NULL REFERENCES occurrence(id) ON DELETE CASCADE,
  until_at          INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  consumed          INTEGER NOT NULL DEFAULT 0
);
