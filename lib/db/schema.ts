/**
 * lib/db/schema.ts
 *
 * SQLite schema for HV.
 *
 * Everything the analysis screens show is derived from these tables, so the
 * schema is written to answer the questions the client asked for directly:
 *
 *   "nakarecord dapat ang mga previous test"   -> sessions, windows
 *   "if nakatulong ba yung verse sa user"      -> verse_feedback
 *   "if okay lang ba si User after mag trigger" -> checkins
 *   "kapag hindi naka connect yung watch"      -> sessions.watch_connected,
 *                                                 samples.source
 */

export const SCHEMA_VERSION = 1;

export const CREATE_STATEMENTS = `
PRAGMA journal_mode = WAL;

-- Raw heart-rate samples, one row per reading accepted from the platform.
CREATE TABLE IF NOT EXISTS samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day          TEXT    NOT NULL,           -- local date, YYYY-MM-DD
  at           INTEGER NOT NULL,           -- epoch ms
  bpm          REAL    NOT NULL,
  source       TEXT    NOT NULL            -- heartsim | healthkit | health-connect
);
CREATE INDEX IF NOT EXISTS idx_samples_day ON samples(day, at);
-- The same reading can arrive twice when a poll overlaps an observer push.
CREATE UNIQUE INDEX IF NOT EXISTS idx_samples_unique ON samples(at, bpm, source);

-- One row per day of monitoring. "Previous tests" in the client's wording.
CREATE TABLE IF NOT EXISTS sessions (
  day               TEXT PRIMARY KEY,      -- YYYY-MM-DD
  started_at        INTEGER,
  ended_at          INTEGER,
  baseline_entropy  REAL,                  -- from the morning segment, null until set
  baseline_set_at   INTEGER,
  max_bpm           REAL,
  max_bpm_at        INTEGER,
  min_bpm           REAL,
  avg_bpm           REAL,
  sample_count      INTEGER NOT NULL DEFAULT 0,
  dominant_state    TEXT,
  dominant_emotion  TEXT,
  -- False when no watch data reached the platform store during the window, so
  -- the UI can say the records are incomplete rather than implying calm.
  watch_connected   INTEGER NOT NULL DEFAULT 0,
  summary_sent_at   INTEGER
);

-- One row per FSM evaluation tick. The full audit trail behind every output.
CREATE TABLE IF NOT EXISTS windows (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  day            TEXT    NOT NULL,
  at             INTEGER NOT NULL,
  entropy        REAL,
  entropy_ratio  REAL,
  entropy_span_ms INTEGER,
  entropy_samples INTEGER,
  mean_bpm       REAL    NOT NULL,
  emotion        TEXT    NOT NULL,
  confidence     REAL    NOT NULL,
  p_stress       REAL    NOT NULL,
  state          TEXT    NOT NULL,
  transitioned   INTEGER NOT NULL DEFAULT 0,
  features_json  TEXT,
  trace_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_windows_day ON windows(day, at);

-- State transitions that produced a notification tier.
CREATE TABLE IF NOT EXISTS episodes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day          TEXT    NOT NULL,
  at           INTEGER NOT NULL,
  from_state   TEXT    NOT NULL,
  to_state     TEXT    NOT NULL,
  tier         INTEGER NOT NULL,
  emotion      TEXT,
  mean_bpm     REAL,
  reason       TEXT,
  resolved_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_episodes_day ON episodes(day, at);

-- Every notification actually delivered.
CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day          TEXT    NOT NULL,
  at           INTEGER NOT NULL,
  kind         TEXT    NOT NULL,   -- tier | daily_summary | checkin | high_bpm
  tier         INTEGER NOT NULL DEFAULT 0,
  state        TEXT,
  emotion      TEXT,
  verse_id     TEXT,
  episode_id   INTEGER REFERENCES episodes(id),
  body         TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_day ON notifications(day, at);

-- Did the verse help? Drives the recommendation analysis.
CREATE TABLE IF NOT EXISTS verse_feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER REFERENCES notifications(id),
  verse_id        TEXT    NOT NULL,
  state           TEXT,
  emotion         TEXT,
  helpful         INTEGER NOT NULL,   -- 1 helpful, 0 not helpful
  note            TEXT,
  at              INTEGER NOT NULL
);

-- Post-emergency wellbeing check-in.
CREATE TABLE IF NOT EXISTS checkins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id  INTEGER REFERENCES episodes(id),
  asked_at    INTEGER NOT NULL,
  answered_at INTEGER,
  response    TEXT,                 -- ok | not_ok | needed_help | null
  note        TEXT
);

-- Emergency contacts, for the Level 3 SMS hand-off.
CREATE TABLE IF NOT EXISTS contacts (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  phone  TEXT NOT NULL
);

-- Key/value settings.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
