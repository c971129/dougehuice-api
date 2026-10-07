CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS palettes (
  id text PRIMARY KEY,
  name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS palette_colors (
  palette_id text NOT NULL REFERENCES palettes(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  hex char(7) NOT NULL CHECK (hex ~ '^#[0-9A-Fa-f]{6}$'),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  sort_order integer NOT NULL,
  PRIMARY KEY (palette_id, code),
  UNIQUE (palette_id, sort_order)
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  palette_id text NOT NULL REFERENCES palettes(id),
  current_revision integer NOT NULL CHECK (current_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_user_updated_idx ON projects(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_revisions (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  encoding text NOT NULL CHECK (encoding = 'palette-code-v1'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 200),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 200),
  cells jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, revision),
  CHECK (jsonb_typeof(cells) = 'array'),
  CHECK (jsonb_array_length(cells) = width * height)
);

CREATE OR REPLACE FUNCTION reject_project_revision_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project revisions are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_revisions_immutable ON project_revisions;
CREATE TRIGGER project_revisions_immutable
BEFORE UPDATE ON project_revisions
FOR EACH ROW EXECUTE FUNCTION reject_project_revision_update();

CREATE TABLE IF NOT EXISTS build_progress (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  project_revision integer NOT NULL,
  progress_revision integer NOT NULL CHECK (progress_revision > 0),
  completed_indices integer[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, project_revision)
    REFERENCES project_revisions(project_id, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS credit_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance integer NOT NULL CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta integer NOT NULL,
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  reason text NOT NULL,
  reference_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_ledger_user_created_idx ON credit_ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('normal', 'pixel', 'portrait', 'couple')),
  status text NOT NULL CHECK (status IN ('completed', 'accepted', 'failed')),
  palette_id text NOT NULL REFERENCES palettes(id),
  cost integer NOT NULL CHECK (cost >= 0),
  seed text NOT NULL,
  accepted_candidate_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS generation_jobs_user_created_idx ON generation_jobs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_candidates (
  id text PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  encoding text NOT NULL CHECK (encoding = 'palette-code-v1'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 200),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 200),
  cells jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, ordinal),
  CHECK (jsonb_typeof(cells) = 'array'),
  CHECK (jsonb_array_length(cells) = width * height)
);

ALTER TABLE generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_accepted_candidate_fk;
ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_accepted_candidate_fk
  FOREIGN KEY (accepted_candidate_id) REFERENCES generation_candidates(id);

CREATE TABLE IF NOT EXISTS api_idempotency (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  status_code integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, idempotency_key)
);

