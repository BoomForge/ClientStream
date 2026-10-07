ALTER TABLE login_tokens ADD COLUMN token_type TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS login_tokens_type_expiry_idx
  ON login_tokens(token_type, expires_at);
