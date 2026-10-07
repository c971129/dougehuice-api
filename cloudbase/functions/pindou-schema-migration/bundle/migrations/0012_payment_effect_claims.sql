CREATE TABLE IF NOT EXISTS payment_effect_claims (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, idempotency_key),
  CHECK (lease_expires_at >= updated_at)
);

CREATE INDEX IF NOT EXISTS payment_effect_claims_expiry_idx
  ON payment_effect_claims(lease_expires_at);
