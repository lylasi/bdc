-- Username/password login (Phase 2A).
--
-- Existing users keep working with their passcode or login code. Username and
-- password are optional and can be assigned by an administrator. Password
-- hashes are `pbkdf2-sha256$<iterations>$<salt>$<peppered-hash>`; the pepper
-- itself is a Worker secret (PASSWORD_PEPPER) and never lives in D1.
--
-- auth_version lets password changes and account resets invalidate every
-- existing session without relying on deletion alone.

ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN username_normalized TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_updated_at TEXT;
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_normalized
  ON users(username_normalized) WHERE username_normalized IS NOT NULL;

ALTER TABLE user_sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;
