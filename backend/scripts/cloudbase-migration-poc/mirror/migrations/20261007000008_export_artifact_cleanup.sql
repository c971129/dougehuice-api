ALTER TABLE export_artifacts
  ADD COLUMN IF NOT EXISTS purged_at timestamptz;

DROP INDEX IF EXISTS export_artifacts_expires_idx;
CREATE INDEX export_artifacts_pending_purge_idx
  ON export_artifacts(expires_at, id)
  WHERE purged_at IS NULL;
