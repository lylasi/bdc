CREATE TABLE IF NOT EXISTS vocabulary_capture_settings (
    owner_user_id TEXT PRIMARY KEY,
    default_book_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);
