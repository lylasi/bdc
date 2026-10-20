-- bdc-sync D1 (SQLite) schema (fresh installs)
-- Snapshots stay one JSON row per user. AI provider keys live in their own
-- encrypted table; the managed default catalog is stored as immutable releases.

-- Users / passcode mapping.
-- token_hash: SHA-256(passcode) hex (plaintext passcode is never stored)
-- recovery_hash: SHA-256(recovery code) for self-service reset
-- role: 'user' | 'admin' (first admin is set by the deployer, see README)
CREATE TABLE IF NOT EXISTS users (
  token_hash          TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL UNIQUE,
  label               TEXT,
  recovery_hash       TEXT,
  role                TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  email               TEXT,               -- optional; future OAuth mapping, unique when set
  created_at          TEXT,               -- ISO timestamp when created from the admin UI
  username            TEXT,
  username_normalized TEXT,
  password_hash       TEXT,               -- pbkdf2-sha256$<iterations>$<salt>$<hash>
  password_updated_at TEXT,
  auth_version        INTEGER NOT NULL DEFAULT 1,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users(email) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_normalized
  ON users(username_normalized) WHERE username_normalized IS NOT NULL;

-- Admin user-management audit trail. Never contains passcodes or plaintext PII.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id  TEXT NOT NULL,
  action         TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  detail_json    TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created
  ON admin_audit_log(created_at DESC);

-- Device pairing: a short-lived one-time code is exchanged for a long-lived
-- session token. Passcodes remain valid; pairing does not log out other devices.
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  device_label TEXT,
  auth_version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_pairing_codes_user
  ON pairing_codes(user_id, expires_at);

-- One snapshot row per user.
CREATE TABLE IF NOT EXISTS snapshots (
  user_id    TEXT PRIMARY KEY,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  payload    TEXT NOT NULL          -- full App JSON snapshot (string)
);

-- Per-user personal AI provider keys (AES-256-GCM, AAD-scoped).
CREATE TABLE IF NOT EXISTS user_ai_credentials (
  user_id          TEXT NOT NULL,
  provider_id      TEXT NOT NULL,
  binding_json     TEXT NOT NULL,
  key_ciphertext   TEXT,
  nonce            TEXT,
  key_version      INTEGER,
  version          INTEGER NOT NULL CHECK (version >= 1),
  deleted          INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  last_mutation_id TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, provider_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  CHECK (
    (deleted = 0 AND key_ciphertext IS NOT NULL
      AND nonce IS NOT NULL AND key_version IS NOT NULL)
    OR
    (deleted = 1 AND key_ciphertext IS NULL
      AND nonce IS NULL AND key_version IS NULL)
  )
);

-- Whole-catalog releases maintained by admins. Rows are immutable.
CREATE TABLE IF NOT EXISTS ai_default_catalog_releases (
  version         INTEGER PRIMARY KEY CHECK (version >= 1),
  config_json     TEXT NOT NULL,
  credentials_json TEXT NOT NULL,
  mutation_id     TEXT NOT NULL UNIQUE,
  request_digest  TEXT NOT NULL,
  published_by    TEXT NOT NULL,
  published_at    TEXT NOT NULL
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
