CREATE TABLE web_login_challenges (
  token_hash text PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[0-9]{6}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX web_login_challenges_expires_at_idx ON web_login_challenges(expires_at);
