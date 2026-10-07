ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS ready_at timestamptz;

-- Rows created before the two-phase publish protocol already represented
-- successfully stored objects, so they are safe to mark ready during upgrade.
UPDATE assets
SET ready_at = created_at
WHERE ready_at IS NULL;

ALTER TABLE assets
  DROP CONSTRAINT IF EXISTS assets_ready_after_create;
ALTER TABLE assets
  ADD CONSTRAINT assets_ready_after_create
  CHECK (ready_at IS NULL OR ready_at >= created_at);

CREATE INDEX IF NOT EXISTS assets_user_ready_created_idx
  ON assets(user_id, created_at DESC, id DESC)
  WHERE ready_at IS NOT NULL AND deleted_at IS NULL AND purged_at IS NULL;

