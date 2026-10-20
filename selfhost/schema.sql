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

-- ─────────────────────────────────────────────────────────────────────────────
-- 文章逐篇儲存（第一階段）
--
-- 每篇文章一筆資料列，擁有人以 users.user_id 關聯（label 可改名、token_hash 會
-- 輪替，兩者都不可作為文章身份）。文章新增／修改／刪除都會同步寫入
-- article_changes，客戶端以 (owner_user_id, seq) 游標增量同步，不依裝置時鐘。
-- analysis_json 保存共用的分析結果；單篇大小與每人總量由應用層限制。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS articles (
  owner_user_id     TEXT NOT NULL,
  id                TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  body              TEXT NOT NULL,
  analysis_json     TEXT,
  source_type       TEXT NOT NULL DEFAULT 'paste',
  source_url        TEXT,
  revision          INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  legacy_article_id TEXT,
  last_mutation_id  TEXT,
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_user_id, id),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_articles_owner_updated
  ON articles(owner_user_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_owner_legacy
  ON articles(owner_user_id, legacy_article_id)
  WHERE legacy_article_id IS NOT NULL;

-- 每位使用者單調遞增的變更序號；游標即最後一次看到的 seq。
CREATE TABLE IF NOT EXISTS article_changes (
  owner_user_id TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  article_id    TEXT NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('create', 'upsert', 'delete', 'restore')),
  revision      INTEGER NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, seq),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_article_changes_article
  ON article_changes(owner_user_id, article_id);

-- 每位使用者的文章儲存狀態：下一個 seq、已清理的游標下限、舊快照寫入閘門。
CREATE TABLE IF NOT EXISTS article_state (
  owner_user_id        TEXT PRIMARY KEY,
  next_seq             INTEGER NOT NULL DEFAULT 1,
  pruned_before        INTEGER NOT NULL DEFAULT 0,
  legacy_write_blocked INTEGER NOT NULL DEFAULT 0,
  migrated_at          TEXT,
  updated_at           TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 逐項閱讀資料（學習條目、文章文件、詞書、關聯、會話、消息）
--
-- 每個實體一列；data_json 保存經 shared/reading-protocol.mjs 白名單驗證後的
-- 欄位。reading_changes 提供服務端序號游標；reading_mutations 永久保存
-- mutationId 的結果，舊 ack 重送不會再套用一次。文章仍使用 articles 表。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reading_entities (
  owner_user_id    TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at       TEXT,
  data_json        TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_mutation_id TEXT,
  PRIMARY KEY (owner_user_id, entity_type, entity_id),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_reading_entities_owner_type
  ON reading_entities(owner_user_id, entity_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS reading_changes (
  owner_user_id TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  revision      INTEGER NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, seq),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_reading_changes_entity
  ON reading_changes(owner_user_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS reading_mutations (
  owner_user_id TEXT NOT NULL,
  mutation_id   TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  request_json  TEXT NOT NULL,
  result_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, mutation_id),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS reading_state (
  owner_user_id        TEXT PRIMARY KEY,
  next_seq             INTEGER NOT NULL DEFAULT 1,
  legacy_write_blocked INTEGER NOT NULL DEFAULT 0,
  migrated_at          TEXT,
  updated_at           TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);
