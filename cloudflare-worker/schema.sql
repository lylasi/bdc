-- bdc-sync D1 (SQLite) schema (fresh installs)
-- Snapshots stay one JSON row per user. AI provider keys live in their own
-- encrypted table; the managed default catalog is stored as immutable releases.

-- Users / passcode mapping.
-- token_hash: SHA-256(passcode) hex (plaintext passcode is never stored)
-- recovery_hash: SHA-256(recovery code) for self-service reset
-- role: 'user' | 'admin' (first admin is set by the deployer, see README)
CREATE TABLE IF NOT EXISTS users (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE,
  label         TEXT,
  recovery_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  email         TEXT,               -- optional; future OAuth mapping, unique when set
  created_at    TEXT                -- ISO timestamp when created from the admin UI
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users(email) WHERE email IS NOT NULL;

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
