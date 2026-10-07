ALTER TABLE generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_status_check;

ALTER TABLE generation_jobs
  ADD COLUMN IF NOT EXISTS source_asset_id uuid,
  ADD COLUMN IF NOT EXISTS width integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS height integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS available_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz;

UPDATE generation_jobs
SET available_at = COALESCE(available_at, created_at),
    updated_at = COALESCE(updated_at, completed_at, created_at),
    progress = CASE WHEN status IN ('completed', 'accepted') THEN 100 ELSE progress END
WHERE available_at IS NULL OR updated_at IS NULL;

ALTER TABLE generation_jobs
  ALTER COLUMN available_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_source_asset_fk;
ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_source_asset_fk
  FOREIGN KEY (source_asset_id) REFERENCES assets(id) ON DELETE RESTRICT;

ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_status_check CHECK (
    status IN (
      'queued', 'preprocessing', 'generating', 'mapping_colors', 'finalizing',
      'retry_wait', 'completed', 'accepted', 'failed', 'canceled'
    )
  ),
  ADD CONSTRAINT generation_jobs_size_check CHECK (
    width BETWEEN 8 AND 64 AND height BETWEEN 8 AND 64
  ),
  ADD CONSTRAINT generation_jobs_progress_check CHECK (progress BETWEEN 0 AND 100),
  ADD CONSTRAINT generation_jobs_attempt_count_check CHECK (attempt_count >= 0),
  ADD CONSTRAINT generation_jobs_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 10),
  ADD CONSTRAINT generation_jobs_lease_state_check CHECK (
    (status IN ('preprocessing', 'generating', 'mapping_colors', 'finalizing')) =
    (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  ADD CONSTRAINT generation_jobs_terminal_progress_check CHECK (
    status NOT IN ('completed', 'accepted') OR progress = 100
  );

CREATE INDEX IF NOT EXISTS generation_jobs_claim_idx
  ON generation_jobs(available_at, created_at, id)
  WHERE status IN ('queued', 'retry_wait');

CREATE INDEX IF NOT EXISTS generation_jobs_expired_lease_idx
  ON generation_jobs(lease_expires_at)
  WHERE status IN ('preprocessing', 'generating', 'mapping_colors', 'finalizing');

CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_generation_event_idx
  ON credit_ledger(reason, reference_id)
  WHERE reason IN ('generation_reserved', 'generation_settled', 'generation_released')
    AND reference_id IS NOT NULL;
