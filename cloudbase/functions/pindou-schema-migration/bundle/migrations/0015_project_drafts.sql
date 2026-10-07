-- Frequent editor autosaves live in one mutable working row per project.
-- Only an explicit commit copies the row into immutable project_revisions.
CREATE TABLE IF NOT EXISTS project_drafts (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  base_project_revision integer NOT NULL CHECK (base_project_revision > 0),
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  encoding text NOT NULL CHECK (encoding = 'palette-code-v1'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 200),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 200),
  cells jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, base_project_revision)
    REFERENCES project_revisions(project_id, revision) ON DELETE CASCADE,
  CHECK (jsonb_typeof(cells) = 'array'),
  CHECK (jsonb_array_length(cells) = width * height)
);

CREATE INDEX IF NOT EXISTS project_drafts_updated_idx
  ON project_drafts(updated_at, project_id);
