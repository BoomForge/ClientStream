PRAGMA foreign_keys = ON;

ALTER TABLE businesses ADD COLUMN gst_registered INTEGER NOT NULL DEFAULT 0 CHECK (gst_registered IN (0, 1));
ALTER TABLE businesses ADD COLUMN default_tax_rate_bps INTEGER NOT NULL DEFAULT 1000 CHECK (default_tax_rate_bps >= 0 AND default_tax_rate_bps <= 10000);

CREATE TABLE document_sequences (
  business_id TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('quote','invoice')),
  calendar_year INTEGER NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number > 0),
  PRIMARY KEY (business_id, document_type, calendar_year),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);
