-- bdc-sync D1 (SQLite) schema
-- 取代 Supabase 的 snapshots 同步：每位使用者一列 JSON 快照 + 樂觀鎖版本號。

-- 使用者 / 通行碼映射
-- token_hash：SHA-256(通行碼) 的十六進位字串（不存明文通行碼）
-- recovery_hash：SHA-256(恢復碼)，供「忘記通行碼」自助重置使用
CREATE TABLE IF NOT EXISTS users (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE,
  label         TEXT,
  recovery_hash TEXT
);

-- 每位使用者一列快照
CREATE TABLE IF NOT EXISTS snapshots (
  user_id    TEXT PRIMARY KEY,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  payload    TEXT NOT NULL          -- 整份 App JSON 快照（字串）
);
