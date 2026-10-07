CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('ai-source', 'ai-intermediate')),
  consent_version text NOT NULL CHECK (char_length(consent_version) BETWEEN 1 AND 64),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
  width integer NOT NULL CHECK (width > 0 AND width <= 10000),
  height integer NOT NULL CHECK (height > 0 AND height <= 10000),
  storage_key text NOT NULL UNIQUE CHECK (char_length(storage_key) BETWEEN 16 AND 128),
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (purged_at IS NULL OR deleted_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS assets_user_created_idx
  ON assets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS assets_pending_purge_idx
  ON assets(expires_at, id)
  WHERE purged_at IS NULL;

