-- Business-owned identity, optional print branding and bank transfer instructions.
-- Store only direct deposit instructions; never collect card numbers or bank passwords.
ALTER TABLE businesses ADD COLUMN contact_name TEXT;
ALTER TABLE businesses ADD COLUMN website_url TEXT;
ALTER TABLE businesses ADD COLUMN logo_data_url TEXT;
ALTER TABLE businesses ADD COLUMN bank_account_name TEXT;
ALTER TABLE businesses ADD COLUMN bank_bsb TEXT;
ALTER TABLE businesses ADD COLUMN bank_account_number TEXT;
ALTER TABLE businesses ADD COLUMN payment_instructions TEXT;
