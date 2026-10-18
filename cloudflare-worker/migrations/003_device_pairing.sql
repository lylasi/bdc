-- Migration: device pairing + revocable sessions.
--
-- Apply ONCE to an existing database, AFTER taking a backup:
--   npx wrangler d1 export bdc-sync --remote --output backup-<date>.sql
--   npx wrangler d1 execute bdc-sync --remote --file ./migrations/003_device_pairing.sql
--
-- Pairing lets an admin issue a short-lived one-time code. A new device
-- exchanges it for a long-lived session token, so the user does not type the
-- 43-character passcode. The primary passcode in users.token_hash stays valid,
-- and pairing a new device does not log out existing devices.
--
-- Passcode changes/resets delete the user's sessions and unused pairing codes.
-- Re-running this migration is safe because every statement is idempotent.

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
