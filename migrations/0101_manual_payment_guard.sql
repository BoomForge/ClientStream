-- Stop concurrent manual payment requests from overpaying an invoice.
-- D1 batches are transactional: an abort rolls back both the payment insert
-- and accompanying invoice aggregate update.
CREATE TRIGGER IF NOT EXISTS manual_payment_no_overpay
BEFORE INSERT ON payments
WHEN NEW.provider = 'manual' AND NEW.status = 'completed' AND NEW.invoice_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM invoices i WHERE i.id = NEW.invoice_id
        AND i.business_id = NEW.business_id AND i.status NOT IN ('paid','void')
        AND i.amount_paid_cents + NEW.amount_cents <= i.total_cents
    ) THEN RAISE(ABORT, 'MANUAL_PAYMENT_CONFLICT')
  END;
END;
