-- Keep payment reconciliation repair on the global order -> job lock order.
-- The 0038 INSERT relied on the payment-order foreign key, whose constraint
-- trigger can run after the child row/index has already been written. Runtime
-- repair now explicitly locks candidate orders before inserting child jobs.

CREATE INDEX IF NOT EXISTS payment_reconciliation_jobs_unfinished_scan_idx
  ON payment_reconciliation_jobs(updated_at, order_id)
  WHERE state <> 'completed';

-- A pre-0037 writer can terminalize an order without updating a job that a new
-- worker created during a rolling deployment. Converge existing rows once at
-- migration time. Lock parent orders first so this cleanup is safe even if the
-- deployment gate is accidentally relaxed.
WITH database_clock AS MATERIALIZED (
  SELECT clock_timestamp() AS now_at
), terminal_orders AS MATERIALIZED (
  SELECT payment_order.id,
         payment_order.status,
         payment_order.provider_trade_state,
         database_clock.now_at
  FROM payment_reconciliation_jobs AS job
  JOIN payment_orders AS payment_order ON payment_order.id = job.order_id
  CROSS JOIN database_clock
  WHERE job.state <> 'completed'
    AND payment_order.status <> 'pending'
  ORDER BY job.updated_at, job.order_id
  FOR UPDATE OF payment_order
)
UPDATE payment_reconciliation_jobs AS job
SET state = 'completed',
    lease_token = NULL,
    lease_expires_at = NULL,
    last_observed_trade_state = CASE
      WHEN terminal_order.status = 'succeeded' THEN 'SUCCESS'
      WHEN terminal_order.status = 'closed' THEN 'CLOSED'
      WHEN terminal_order.provider_trade_state IN ('NOT_FOUND', 'NOTPAY', 'SUCCESS', 'CLOSED')
        THEN terminal_order.provider_trade_state
      ELSE job.last_observed_trade_state
    END,
    last_error_code = NULL,
    last_error_message = NULL,
    completed_at = COALESCE(job.completed_at, terminal_order.now_at),
    updated_at = terminal_order.now_at
FROM terminal_orders AS terminal_order
WHERE job.order_id = terminal_order.id
  AND job.state <> 'completed';
