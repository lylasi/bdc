CREATE TABLE IF NOT EXISTS vocabulary_captures (
    owner_user_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_user_id, request_id),
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);
