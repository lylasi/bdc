-- BDC self-host sync schema.
-- Works on SQLite (node:sqlite) and PostgreSQL.
-- The server applies this file on startup with IF NOT EXISTS, so it is safe to
-- run repeatedly. AI provider credentials/catalog tables are intentionally
-- absent: the self-host server only implements learning-data snapshots.

CREATE TABLE IF NOT EXISTS users (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE,
  label         TEXT,
  recovery_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'))
);

CREATE TABLE IF NOT EXISTS snapshots (
  user_id    TEXT PRIMARY KEY,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  payload    TEXT NOT NULL
);
