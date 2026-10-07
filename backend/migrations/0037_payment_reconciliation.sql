-- Durable, database-clock-fenced reconciliation for locally pending payment
-- orders whose provider callback may have been delayed or lost.

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_success_at timestamptz;

-- Preserve the best available audit time for legacy closed orders.
UPDATE payment_orders
SET closed_at = updated_at
WHERE status = 'closed' AND closed_at IS NULL;

ALTER TABLE payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_closed_at_valid;
ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_closed_at_valid
  CHECK (status <> 'closed' OR closed_at IS NOT NULL);

ALTER TABLE payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_late_success_at_valid;
ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_late_success_at_valid
  CHECK (late_success_at IS NULL OR (status = 'succeeded' AND closed_at IS NOT NULL));

CREATE TABLE IF NOT EXISTS payment_reconciliation_jobs (
  order_id uuid PRIMARY KEY REFERENCES payment_orders(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('scheduled', 'running', 'completed')),
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_observed_trade_state text
    CHECK (last_observed_trade_state IS NULL
      OR last_observed_trade_state IN ('NOT_FOUND', 'NOTPAY', 'SUCCESS', 'CLOSED')),
  last_error_code varchar(80),
  last_error_message varchar(500),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK (state <> 'completed' OR (lease_token IS NULL AND lease_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS payment_reconciliation_jobs_scheduled_idx
  ON payment_reconciliation_jobs(available_at, created_at, order_id)
  WHERE state = 'scheduled';

CREATE INDEX IF NOT EXISTS payment_reconciliation_jobs_expired_lease_idx
  ON payment_reconciliation_jobs(lease_expires_at, order_id)
  WHERE state = 'running';

-- Existing pending orders should be checked promptly after this migration.
INSERT INTO payment_reconciliation_jobs(
  order_id, state, available_at, attempt_count,
  lease_token, lease_expires_at, created_at, updated_at
)
SELECT id, 'scheduled', clock_timestamp(), 0,
       NULL, NULL, clock_timestamp(), clock_timestamp()
FROM payment_orders
WHERE status = 'pending'
ON CONFLICT (order_id) DO NOTHING;
