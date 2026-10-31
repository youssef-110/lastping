CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  alert_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,               -- secret: it is the ping URL
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- heartbeat | http
  status TEXT NOT NULL DEFAULT 'new',-- new | up | late | down | paused
  period_s INTEGER NOT NULL DEFAULT 3600,
  grace_s INTEGER NOT NULL DEFAULT 300,
  cron TEXT,
  url TEXT,
  interval_s INTEGER NOT NULL DEFAULT 300,
  expect_status INTEGER NOT NULL DEFAULT 200,
  last_ping_at INTEGER,
  due_at INTEGER,
  started_at INTEGER,
  last_duration_ms INTEGER,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checks_due ON checks(kind, due_at) WHERE status != 'paused';
CREATE INDEX IF NOT EXISTS checks_project ON checks(project_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- ping | start | fail | late | down | up | probe_fail | paused | resumed
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_check ON events(check_id, at);

CREATE TABLE IF NOT EXISTS rate (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
