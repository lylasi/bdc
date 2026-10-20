
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
