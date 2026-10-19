-- 0002_init_runtime_and_security.sql
-- 运行域（自监控）+ 安全域（M0 骨架）（《M0+M1 详细设计》§4.3）

-- ── 心跳（每 60s 一条；支撑"我有一段时间没运行"的检测）
CREATE TABLE heartbeat (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                INTEGER NOT NULL,
  wall_now          INTEGER NOT NULL,
  mono_now          INTEGER NOT NULL,
  pid               INTEGER NOT NULL,
  uptime_s          INTEGER NOT NULL,
  tick_count        INTEGER NOT NULL,
  rss_bytes         INTEGER,
  open_fds          INTEGER
);
CREATE INDEX idx_heartbeat_at ON heartbeat(at DESC);

-- ── 运行缺口
CREATE TABLE run_gap (
  id                TEXT PRIMARY KEY,
  detected_at       INTEGER NOT NULL,
  gap_start         INTEGER NOT NULL,
  gap_end           INTEGER NOT NULL,
  cause             TEXT NOT NULL
                    CHECK (cause IN ('sleep','shutdown','crash','clock_jump','unknown')),
  notified          INTEGER NOT NULL DEFAULT 0
);

-- ── 结构化日志（关键事件；详细日志走 NDJSON 文件）
CREATE TABLE run_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                INTEGER NOT NULL,
  level             TEXT NOT NULL,
  component         TEXT NOT NULL,
  event             TEXT NOT NULL,
  detail            TEXT,
  task_id           TEXT,
  occurrence_id     TEXT
);
CREATE INDEX idx_runlog_at ON run_log(at DESC);

-- ── 外发审计（M0 骨架：只存哈希与检测器摘要，**绝不存原文**）
CREATE TABLE outbound_audit (
  id                TEXT PRIMARY KEY,
  at                INTEGER NOT NULL,
  actor             TEXT NOT NULL,
  purpose           TEXT NOT NULL,
  destination       TEXT NOT NULL,
  data_class        TEXT NOT NULL,
  detectors_hit     TEXT,
  redaction_count   INTEGER NOT NULL DEFAULT 0,
  policy_version    TEXT NOT NULL,
  payload_sha256    TEXT NOT NULL,
  outcome           TEXT NOT NULL
                    CHECK (outcome IN ('allowed','blocked','failed'))
);
CREATE INDEX idx_audit_at ON outbound_audit(at DESC);

-- ── 凭据引用（值在系统钥匙串，库里只存引用）
CREATE TABLE credential_ref (
  id                TEXT PRIMARY KEY,
  keychain_key      TEXT NOT NULL UNIQUE,
  purpose           TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER
);

-- ── 非敏感配置键值
CREATE TABLE app_setting (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL,
  updated_at        INTEGER NOT NULL
);
