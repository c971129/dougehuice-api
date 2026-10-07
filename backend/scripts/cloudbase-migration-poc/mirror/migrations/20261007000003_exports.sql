CREATE TABLE IF NOT EXISTS export_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  project_revision integer NOT NULL CHECK (project_revision > 0),
  format text NOT NULL CHECK (format IN ('png', 'pdf')),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 120),
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'object'),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'canceled')),
  progress integer NOT NULL CHECK (progress BETWEEN 0 AND 100),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at timestamptz NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  result_artifact_id uuid,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (project_id, project_revision)
    REFERENCES project_revisions(project_id, revision) ON DELETE CASCADE,
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'succeeded') = (progress = 100 AND result_artifact_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS export_jobs_user_created_idx
  ON export_jobs(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS export_jobs_claim_idx
  ON export_jobs(available_at, created_at, id)
  WHERE status IN ('queued', 'retry_wait');
CREATE INDEX IF NOT EXISTS export_jobs_expired_lease_idx
  ON export_jobs(lease_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS export_artifacts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES export_jobs(id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'application/pdf')),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 124),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS export_artifacts_expires_idx ON export_artifacts(expires_at);

ALTER TABLE export_jobs
  DROP CONSTRAINT IF EXISTS export_jobs_result_artifact_fk;
ALTER TABLE export_jobs
  ADD CONSTRAINT export_jobs_result_artifact_fk
  FOREIGN KEY (result_artifact_id) REFERENCES export_artifacts(id);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY,
  topic text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_events_unpublished_idx
  ON outbox_events(available_at, id)
  WHERE published_at IS NULL;
