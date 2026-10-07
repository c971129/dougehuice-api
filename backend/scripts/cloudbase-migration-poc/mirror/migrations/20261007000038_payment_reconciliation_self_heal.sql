-- Support the reconciliation worker's bounded repair scan for pending orders
-- created by pre-0037 API instances during a rolling deployment.
CREATE INDEX IF NOT EXISTS payment_orders_pending_reconciliation_scan_idx
  ON payment_orders(created_at, id)
  WHERE status = 'pending';
