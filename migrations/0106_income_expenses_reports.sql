-- Describe cash receipts that are not tied to an invoice.
-- Invoice-linked payments retain their existing invoice reconciliation rules.
ALTER TABLE payments ADD COLUMN description TEXT;
ALTER TABLE payments ADD COLUMN notes TEXT;
ALTER TABLE expenses ADD COLUMN updated_at TEXT;
ALTER TABLE dashboard_metric_snapshots ADD COLUMN income_cents INTEGER CHECK (income_cents >= 0);
CREATE INDEX payments_business_status_paid_idx ON payments(business_id, status, paid_at);
