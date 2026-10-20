-- 0003_monitor_notifications.sql
-- M2 监测域：新增 notification.kind='monitor' 与 Skill 冷却表
--
-- ⚠️ SQLite 不能直接修改 CHECK 约束；必须重建 notification 表。
-- 迁移执行器在本迁移期间关闭 foreign_keys（见 db.ts 的 migrate），
-- 因此 delivery_attempt 的 FK 不会被级联删除，重建后仍指向 notification。

CREATE TABLE notification_new (
  id                TEXT PRIMARY KEY,
  occurrence_id     TEXT REFERENCES occurrence(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('reminder','catchup_batch','system_gap','failure','digest','monitor')),
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

INSERT INTO notification_new
  (id, occurrence_id, kind, title, body, priority, scheduled_for, state, dedupe_key, created_at, updated_at)
SELECT
  id, occurrence_id, kind, title, body, priority, scheduled_for, state, dedupe_key, created_at, updated_at
FROM notification;

DROP TABLE notification;
ALTER TABLE notification_new RENAME TO notification;

CREATE UNIQUE INDEX uq_notification_dedupe ON notification(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_notification_state ON notification(state, scheduled_for);

-- ── Skill 冷却：同一 skill + 主体（文件路径/系统）在窗口内只通知一次
CREATE TABLE monitor_cooldown (
  skill_name        TEXT NOT NULL,
  subject           TEXT NOT NULL,
  last_notified_at  INTEGER NOT NULL,
  PRIMARY KEY (skill_name, subject)
);
