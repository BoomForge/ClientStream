-- Aggregate raw referral clicks by UTC day and explicitly authorised source.
-- No IP addresses, cookies, browser identifiers or customer personal data.
CREATE TABLE siteguard_referral_clicks (
  source TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, day_utc)
);
