CREATE TABLE auth_rate_limits (
  key_hash char(64) NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 100),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_hash, action)
);
