-- One checkout creation at a time per business to avoid duplicate subscriptions
-- from multiple tabs, retries or simultaneous clicks.
CREATE TABLE paypal_checkout_claims (
  business_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX subscriptions_one_paypal_per_business
  ON subscriptions(business_id) WHERE provider = 'paypal';
