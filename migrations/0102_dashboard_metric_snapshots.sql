-- Store observed dashboard totals, not reconstructed or fabricated historical values.
-- One row per business/local calendar day. Hourly maintenance updates today's observation.
CREATE TABLE dashboard_metric_snapshots (
  business_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  active_clients INTEGER NOT NULL CHECK (active_clients >= 0),
  open_jobs INTEGER NOT NULL CHECK (open_jobs >= 0),
  outstanding_cents INTEGER NOT NULL CHECK (outstanding_cents >= 0),
  expense_cents INTEGER NOT NULL CHECK (expense_cents >= 0),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (business_id, snapshot_date),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);
CREATE INDEX dashboard_snapshots_date_idx ON dashboard_metric_snapshots(snapshot_date);
