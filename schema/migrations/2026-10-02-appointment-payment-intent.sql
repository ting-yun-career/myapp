-- For databases created before appointments.payment_intent_id existed (db-schema-setup.sql covers fresh ones).
-- Run once per database (ALTER TABLE ADD COLUMN is not idempotent):
--   pnpm exec wrangler d1 execute myapp --local  --file schema/migrations/2026-10-02-appointment-payment-intent.sql
--   pnpm exec wrangler d1 execute myapp --remote --file schema/migrations/2026-10-02-appointment-payment-intent.sql
-- Run it BEFORE deploying the worker that writes the column: that worker's INSERT fails on a database without it.
-- Additive and nullable, so the currently deployed worker keeps working before and after it runs.
ALTER TABLE appointments ADD COLUMN payment_intent_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_payment_intent_id ON appointments(payment_intent_id) WHERE payment_intent_id IS NOT NULL;
