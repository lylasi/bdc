-- Migration: per-user AI settings sync + admin-managed default catalog.
--
-- Apply ONCE to an existing database, AFTER taking a backup:
--   npx wrangler d1 export bdc-sync --remote --output backup-<date>.sql
--   npx wrangler d1 execute bdc-sync --remote --file ./migrations/001_ai_provider_sync.sql
--
-- Then set the first admin by user_id (deployer only):
--   UPDATE users SET role = 'admin' WHERE user_id = '<confirmed-user-id>';
--
-- This migration is intentionally not idempotent for the ALTER TABLE line;
-- re-running it will fail with "duplicate column name: role", which is safe.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin'));

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

CREATE TABLE IF NOT EXISTS ai_default_catalog_releases (
  version          INTEGER PRIMARY KEY CHECK (version >= 1),
  config_json      TEXT NOT NULL,
  credentials_json TEXT NOT NULL,
  mutation_id      TEXT NOT NULL UNIQUE,
  request_digest   TEXT NOT NULL,
  published_by     TEXT NOT NULL,
  published_at     TEXT NOT NULL
);
