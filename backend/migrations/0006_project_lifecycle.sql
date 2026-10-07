ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS projects_user_active_updated_idx
  ON projects(user_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
