-- Durable idempotency boundary for generic POST /assets uploads. The asset row
-- and this reservation are committed before encrypted bytes are written so a
-- process crash can resume the same stable object key without charging quota a
-- second time.
CREATE TABLE asset_uploads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 100),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  asset_id uuid NOT NULL UNIQUE,
  asset_purpose text NOT NULL CHECK (asset_purpose IN ('ai-source', 'ai-intermediate')),
  upload_lease_token uuid NOT NULL,
  upload_lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, idempotency_key),
  FOREIGN KEY (asset_id, user_id, asset_purpose)
    REFERENCES assets(id, user_id, purpose) ON DELETE CASCADE,
  CHECK (upload_lease_expires_at >= created_at)
);

CREATE INDEX asset_uploads_active_lease_idx
  ON asset_uploads(asset_id, upload_lease_expires_at);
