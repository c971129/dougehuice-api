-- Persist the complete build-session contract from the product requirements.
-- elapsed_time is expressed in whole seconds. Existing rows predate these
-- fields, so their last update is the only safe start/completion approximation.
ALTER TABLE build_progress
  ADD COLUMN IF NOT EXISTS mode text,
  ADD COLUMN IF NOT EXISTS elapsed_time integer,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE build_progress
SET mode = COALESCE(mode, 'color'),
    elapsed_time = COALESCE(elapsed_time, 0),
    started_at = COALESCE(started_at, updated_at);

UPDATE build_progress AS progress
SET completed_at = progress.updated_at
FROM project_revisions AS revision
WHERE revision.project_id = progress.project_id
  AND revision.revision = progress.project_revision
  AND progress.completed_at IS NULL
  AND cardinality(progress.completed_indices) > 0
  AND cardinality(progress.completed_indices) = (
    SELECT count(*)::integer
    FROM jsonb_array_elements(revision.cells) AS cell(value)
    WHERE cell.value <> 'null'::jsonb
  );

ALTER TABLE build_progress
  ALTER COLUMN mode SET DEFAULT 'color',
  ALTER COLUMN mode SET NOT NULL,
  ALTER COLUMN elapsed_time SET DEFAULT 0,
  ALTER COLUMN elapsed_time SET NOT NULL,
  ALTER COLUMN started_at SET NOT NULL;

ALTER TABLE build_progress
  DROP CONSTRAINT IF EXISTS build_progress_mode_valid,
  DROP CONSTRAINT IF EXISTS build_progress_elapsed_time_valid,
  DROP CONSTRAINT IF EXISTS build_progress_completion_time_valid;

ALTER TABLE build_progress
  ADD CONSTRAINT build_progress_mode_valid
    CHECK (mode IN ('color', 'region', 'row-column')),
  ADD CONSTRAINT build_progress_elapsed_time_valid
    CHECK (elapsed_time BETWEEN 0 AND 2147483647),
  ADD CONSTRAINT build_progress_completion_time_valid
    CHECK (completed_at IS NULL OR completed_at >= started_at);
