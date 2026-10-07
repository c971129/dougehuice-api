-- Searchable project-library metadata and immutable revision provenance.
-- Legacy rows are explicitly marked `unknown`; inventing a client source for
-- data written before provenance existed would be misleading.

CREATE FUNCTION project_tags_are_valid(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(value) <= 20
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(value) AS tag
      WHERE char_length(tag) NOT BETWEEN 1 AND 32
         OR tag <> btrim(tag)
         OR regexp_replace(tag, '[[:space:]]+', ' ', 'g') <> tag
    )
    AND cardinality(value) = (
      SELECT count(DISTINCT lower(tag))::integer FROM unnest(value) AS tag
    );
$$;

ALTER TABLE projects
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN device_source text NOT NULL DEFAULT 'unknown';

ALTER TABLE projects
  ADD CONSTRAINT projects_tags_valid CHECK (project_tags_are_valid(tags)),
  ADD CONSTRAINT projects_device_source_valid
    CHECK (device_source IN ('mini-program', 'web', 'api', 'unknown'));

CREATE INDEX projects_user_mode_updated_idx
  ON projects(user_id, mode, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX projects_tags_gin_idx
  ON projects USING gin(tags)
  WHERE deleted_at IS NULL;

CREATE INDEX projects_user_lower_name_idx
  ON projects(user_id, lower(name), updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Temporarily remove the immutability trigger solely to backfill the new
-- revision timestamp from the already immutable creation timestamp.
DROP TRIGGER project_revisions_immutable ON project_revisions;

ALTER TABLE project_revisions
  ADD COLUMN device_source text NOT NULL DEFAULT 'unknown',
  ADD COLUMN updated_at timestamptz;

UPDATE project_revisions SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE project_revisions
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now(),
  ADD CONSTRAINT project_revisions_device_source_valid
    CHECK (device_source IN ('mini-program', 'web', 'api', 'unknown'));

CREATE TRIGGER project_revisions_immutable
BEFORE UPDATE ON project_revisions
FOR EACH ROW EXECUTE FUNCTION reject_project_revision_update();

CREATE INDEX project_revisions_project_created_idx
  ON project_revisions(project_id, revision DESC);

-- Tags and client provenance are project metadata and must participate in the
-- same optimistic-lock token as the pre-existing metadata fields.
DROP TRIGGER projects_metadata_revision_bump ON projects;

CREATE TRIGGER projects_metadata_revision_bump
BEFORE UPDATE OF
  mode,
  lifecycle_status,
  source_asset_id,
  preview_asset_id,
  background_mode,
  background_color,
  tags,
  device_source
ON projects
FOR EACH ROW
EXECUTE FUNCTION bump_project_metadata_revision();
