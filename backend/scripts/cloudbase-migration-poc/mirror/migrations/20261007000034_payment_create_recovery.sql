-- Durable recovery journal for the ambiguous boundary between WeChat JSAPI
-- prepay creation and the local payment/idempotency transaction.

ALTER TABLE payment_order_slots
  ADD COLUMN IF NOT EXISTS attempt_no integer NOT NULL DEFAULT 1;

ALTER TABLE payment_order_slots
  DROP CONSTRAINT IF EXISTS payment_order_slots_attempt_no_valid;
ALTER TABLE payment_order_slots
  ADD CONSTRAINT payment_order_slots_attempt_no_valid CHECK (attempt_no > 0);

CREATE TABLE IF NOT EXISTS payment_order_attempts (
  order_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  out_trade_no varchar(32) NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('reserved', 'creating', 'created', 'closed')),
  recovery_ciphertext text,
  provider_reference_sha256 char(64),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, attempt_no),
  CHECK (provider_reference_sha256 IS NULL OR provider_reference_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (recovery_ciphertext IS NULL OR char_length(recovery_ciphertext) BETWEEN 16 AND 2048),
  CHECK (state <> 'created' OR (recovery_ciphertext IS NOT NULL AND provider_reference_sha256 IS NOT NULL))
);

-- Existing completed local orders have no recoverable prepay envelope. Their
-- immutable merchant-order identity is still useful for notification lookup.
INSERT INTO payment_order_attempts(
  order_id, user_id, attempt_no, out_trade_no, state,
  recovery_ciphertext, provider_reference_sha256, expires_at, created_at, updated_at
)
SELECT id, user_id, 1, out_trade_no, 'closed', NULL, NULL,
       payment_expires_at, created_at, updated_at
FROM payment_orders
ON CONFLICT (order_id, attempt_no) DO NOTHING;

-- A legacy slot means a provider call may already have started; classify it as
-- ambiguous rather than assuming it is safe to repeat.
INSERT INTO payment_order_attempts(
  order_id, user_id, attempt_no, out_trade_no, state,
  recovery_ciphertext, provider_reference_sha256, expires_at, created_at, updated_at
)
SELECT order_id, user_id, attempt_no, out_trade_no, 'creating', NULL, NULL,
       expires_at, created_at, updated_at
FROM payment_order_slots
ON CONFLICT (order_id, attempt_no) DO NOTHING;

CREATE INDEX IF NOT EXISTS payment_order_attempts_user_created_idx
  ON payment_order_attempts(user_id, created_at DESC, order_id, attempt_no DESC);
CREATE INDEX IF NOT EXISTS payment_order_attempts_order_latest_idx
  ON payment_order_attempts(order_id, attempt_no DESC);

-- Never keep a plaintext prepay_id in the financial order or idempotency row.
-- New responses are reconstructed from the authenticated ciphertext above.
UPDATE payment_orders
SET provider_reference = 'redacted:' || id::text
WHERE provider_reference NOT LIKE 'sha256:%'
  AND provider_reference NOT LIKE 'redacted:%';

UPDATE api_idempotency
SET response_body = response_body - 'paymentParams'
WHERE scope = 'payment-orders:create'
  AND response_body ? 'paymentParams';

CREATE OR REPLACE FUNCTION guard_payment_order_attempt_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.order_id IS DISTINCT FROM NEW.order_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.attempt_no IS DISTINCT FROM NEW.attempt_no
    OR OLD.out_trade_no IS DISTINCT FROM NEW.out_trade_no
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'payment order attempt identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_order_attempt_identity_immutable ON payment_order_attempts;
CREATE TRIGGER payment_order_attempt_identity_immutable
BEFORE UPDATE ON payment_order_attempts
FOR EACH ROW EXECUTE FUNCTION guard_payment_order_attempt_identity();

