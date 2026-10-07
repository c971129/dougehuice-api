-- Independent optimistic-lock token for Project product metadata. This is a
-- new migration because 0019_project_metadata.sql has already been applied in
-- production-like environments and its checksum must remain immutable.
ALTER TABLE projects
  ADD COLUMN metadata_revision integer NOT NULL DEFAULT 1;

ALTER TABLE projects
  ADD CONSTRAINT projects_metadata_revision_positive
    CHECK (metadata_revision >= 1);

-- Keep the token correct for every metadata writer, including FK-driven
-- ON DELETE SET NULL updates when an asset is physically removed.
CREATE FUNCTION bump_project_metadata_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.metadata_revision := OLD.metadata_revision + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_metadata_revision_bump
BEFORE UPDATE OF
  mode,
  lifecycle_status,
  source_asset_id,
  preview_asset_id,
  background_mode,
  background_color
ON projects
FOR EACH ROW
EXECUTE FUNCTION bump_project_metadata_revision();

