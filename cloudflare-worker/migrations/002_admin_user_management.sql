-- Migration: admin user management v1.
--
-- Apply ONCE to an existing database, AFTER taking a backup:
--   npx wrangler d1 export bdc-sync --remote --output backup-<date>.sql
--   npx wrangler d1 execute bdc-sync --remote --file ./migrations/002_admin_user_management.sql
--
-- Adds:
--   users.email       optional, unique when present (future OAuth mapping)
--   users.created_at  set for users created from the admin UI
--   admin_audit_log   who did what to whom; never contains passcodes
--
-- Existing users keep NULL email/created_at. This migration does not change
-- any passcode, recovery code or role.
--
-- Re-running this migration will fail with "duplicate column name", which is
-- safe: it means the columns already exist.

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN created_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users(email) WHERE email IS NOT NULL;

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
