PRAGMA foreign_keys = ON;

ALTER TABLE reminders ADD COLUMN notified_at TEXT;
ALTER TABLE reminders ADD COLUMN dedupe_key TEXT;

CREATE UNIQUE INDEX reminders_dedupe_idx
  ON reminders(business_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX login_tokens_expiry_idx ON login_tokens(expires_at, consumed_at);
