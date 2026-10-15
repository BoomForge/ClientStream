-- Keep historical Square audit records untouched; new billing uses PayPal only.
CREATE TABLE paypal_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error TEXT
);
CREATE INDEX paypal_webhook_events_status_idx ON paypal_webhook_events(status, received_at);
