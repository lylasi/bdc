-- Migration: 文章逐篇儲存（第一階段）。
--
-- 套用一次到既有資料庫，套用前請先備份（生產環境另行處理，本工作區不執行）：
--   npx （SQLite：複製 selfhost/data/bdc-sync.sqlite；PostgreSQL：pg_dump）
--   npx wrangler d1 execute bdc-sync --remote --file ./migrations/004_article_storage.sql
--
-- 這個遷移只新增資料表與索引，不改動 users / snapshots，也不搬動任何既有資料：
-- 文章是由新版客戶端以 POST /articles/import 逐篇匯入（冪等），完成後伺服器
-- 會擋下舊快照的文章群組寫入，其他群組的同步照常。
--
-- 所有語句皆為 IF NOT EXISTS，可重複執行。

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

CREATE TABLE IF NOT EXISTS article_state (
  owner_user_id        TEXT PRIMARY KEY,
  next_seq             INTEGER NOT NULL DEFAULT 1,
  pruned_before        INTEGER NOT NULL DEFAULT 0,
  legacy_write_blocked INTEGER NOT NULL DEFAULT 0,
  migrated_at          TEXT,
  updated_at           TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);
