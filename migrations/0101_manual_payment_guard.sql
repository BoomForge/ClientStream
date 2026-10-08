-- Previous trigger declaration could not be parsed by remote Cloudflare D1.
-- Safe forward-only marker; atomic payment guards live in src/invoices.ts.
-- This migration was not applied to remote D1 before the parser failure.
SELECT 1;
