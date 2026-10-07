ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS current_bead_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_color_count integer NOT NULL DEFAULT 0;

UPDATE projects AS project
SET current_bead_count = stats.bead_count,
    current_color_count = stats.color_count
FROM (
  SELECT source.id,
         COUNT(cell.value)::integer AS bead_count,
         COUNT(DISTINCT cell.value)::integer AS color_count
  FROM projects AS source
  JOIN project_revisions AS revision
    ON revision.project_id = source.id AND revision.revision = source.current_revision
  LEFT JOIN LATERAL jsonb_array_elements_text(revision.cells) AS cell(value) ON true
  GROUP BY source.id
) AS stats
WHERE project.id = stats.id;

ALTER TABLE projects
  ADD CONSTRAINT projects_current_bead_count_valid
    CHECK (current_bead_count BETWEEN 0 AND 40000),
  ADD CONSTRAINT projects_current_color_count_valid
    CHECK (current_color_count BETWEEN 0 AND 40000);

CREATE TABLE IF NOT EXISTS user_rate_limits (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 100),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, action)
);

CREATE TABLE IF NOT EXISTS payment_order_slots (
  order_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  out_trade_no varchar(32) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_order_slots_user_expiry_idx
  ON payment_order_slots(user_id, expires_at, order_id);

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS purge_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purge_available_at timestamptz NOT NULL DEFAULT now();

UPDATE assets SET purge_available_at = created_at WHERE purge_attempt_count = 0;

ALTER TABLE assets
  ADD CONSTRAINT assets_purge_attempt_count_valid CHECK (purge_attempt_count >= 0);

ALTER TABLE export_artifacts
  ADD COLUMN IF NOT EXISTS purge_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purge_available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS abandoned_at timestamptz;

UPDATE export_artifacts SET purge_available_at = created_at WHERE purge_attempt_count = 0;
UPDATE export_artifacts SET ready_at = created_at WHERE ready_at IS NULL;

ALTER TABLE export_artifacts
  DROP CONSTRAINT IF EXISTS export_artifacts_job_id_key;

ALTER TABLE export_artifacts
  ADD CONSTRAINT export_artifacts_purge_attempt_count_valid CHECK (purge_attempt_count >= 0);

ALTER TABLE generation_candidates
  ADD CONSTRAINT generation_candidates_id_length_valid
    CHECK (char_length(id) BETWEEN 1 AND 100),
  ADD CONSTRAINT generation_candidates_ordinal_range_valid
    CHECK (ordinal BETWEEN 1 AND 4);

CREATE INDEX IF NOT EXISTS assets_stale_pending_idx
  ON assets(purge_available_at, created_at, id)
  WHERE ready_at IS NULL AND deleted_at IS NULL AND purged_at IS NULL;

CREATE INDEX IF NOT EXISTS assets_purge_expiry_idx
  ON assets(purge_available_at, expires_at, id)
  WHERE deleted_at IS NULL AND purged_at IS NULL;

CREATE INDEX IF NOT EXISTS assets_deleted_purge_idx
  ON assets(purge_available_at, deleted_at, id)
  WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

CREATE INDEX IF NOT EXISTS assets_purged_history_idx
  ON assets(user_id, purged_at, id)
  WHERE purged_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS export_artifacts_purge_schedule_idx
  ON export_artifacts(purge_available_at, expires_at, id)
  WHERE ready_at IS NOT NULL AND purged_at IS NULL;

CREATE INDEX IF NOT EXISTS export_artifacts_pending_publish_idx
  ON export_artifacts(purge_available_at, created_at, id)
  WHERE ready_at IS NULL AND purged_at IS NULL;

DROP INDEX IF EXISTS export_artifacts_pending_purge_idx;

CREATE INDEX IF NOT EXISTS export_artifacts_job_id_idx
  ON export_artifacts(job_id);

CREATE INDEX IF NOT EXISTS export_jobs_project_id_idx
  ON export_jobs(project_id);

CREATE INDEX IF NOT EXISTS generation_jobs_source_asset_id_idx
  ON generation_jobs(source_asset_id)
  WHERE source_asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS generation_jobs_terminal_retention_idx
  ON generation_jobs(user_id, updated_at, id)
  WHERE status IN ('completed', 'accepted', 'failed', 'canceled');

CREATE INDEX IF NOT EXISTS export_jobs_terminal_retention_idx
  ON export_jobs(user_id, updated_at, id)
  WHERE status IN ('succeeded', 'failed', 'canceled');

CREATE INDEX IF NOT EXISTS api_idempotency_user_created_idx
  ON api_idempotency(user_id, created_at, scope, idempotency_key);

CREATE INDEX IF NOT EXISTS payment_effect_claims_user_updated_idx
  ON payment_effect_claims(user_id, updated_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS payment_orders_pending_user_expiry_idx
  ON payment_orders(user_id, payment_expires_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS projects_deleted_retention_idx
  ON projects(user_id, deleted_at, id)
  WHERE deleted_at IS NOT NULL;
