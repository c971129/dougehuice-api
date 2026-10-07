-- Private finished-work photos. They reuse the encrypted asset pipeline but
-- are reachable only through project-scoped APIs and are pinned to an
-- immutable project revision.
ALTER TABLE assets
  DROP CONSTRAINT IF EXISTS assets_purpose_check,
  DROP CONSTRAINT IF EXISTS assets_purpose_valid;

ALTER TABLE assets
  ADD CONSTRAINT assets_purpose_valid
    CHECK (purpose IN ('ai-source', 'ai-intermediate', 'project-completion'));

ALTER TABLE assets
  ALTER COLUMN consent_version DROP NOT NULL,
  ALTER COLUMN expires_at DROP NOT NULL;

ALTER TABLE assets
  ADD CONSTRAINT assets_purpose_lifecycle_valid CHECK (
    (
      purpose = 'project-completion'
      AND consent_version IS NULL
      AND expires_at IS NULL
    )
    OR (
      purpose IN ('ai-source', 'ai-intermediate')
      AND consent_version IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > created_at
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS assets_id_user_purpose_unique
  ON assets(id, user_id, purpose);

CREATE TABLE project_completion_photos (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  project_revision integer NOT NULL CHECK (project_revision > 0),
  asset_id uuid NOT NULL UNIQUE,
  asset_purpose text NOT NULL DEFAULT 'project-completion'
    CHECK (asset_purpose = 'project-completion'),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, user_id),
  UNIQUE (id, user_id, project_id, asset_id, asset_purpose),
  FOREIGN KEY (project_id, user_id)
    REFERENCES projects(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, project_revision)
    REFERENCES project_revisions(project_id, revision) ON DELETE CASCADE,
  FOREIGN KEY (asset_id, user_id, asset_purpose)
    REFERENCES assets(id, user_id, purpose) ON DELETE CASCADE,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE INDEX project_completion_photos_user_project_created_idx
  ON project_completion_photos(user_id, project_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX project_completion_photos_project_revision_created_idx
  ON project_completion_photos(project_id, project_revision, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- The upload reservation is the durable idempotency boundary. Metadata is
-- committed before bytes are written, so an interrupted write is visible to
-- the existing stale-pending purge worker and a retry can safely resume the
-- same storage key.
CREATE TABLE project_completion_photo_uploads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  photo_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  project_completion_purpose text NOT NULL DEFAULT 'project-completion'
    CHECK (project_completion_purpose = 'project-completion'),
  upload_lease_token uuid NOT NULL,
  upload_lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id, idempotency_key),
  UNIQUE (photo_id),
  UNIQUE (asset_id),
  FOREIGN KEY (project_id, user_id)
    REFERENCES projects(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (
    photo_id, user_id, project_id, asset_id, project_completion_purpose
  ) REFERENCES project_completion_photos(
    id, user_id, project_id, asset_id, asset_purpose
  ) ON DELETE CASCADE,
  FOREIGN KEY (asset_id, user_id, project_completion_purpose)
    REFERENCES assets(id, user_id, purpose) ON DELETE CASCADE,
  CHECK (upload_lease_expires_at >= created_at)
);

CREATE INDEX project_completion_photo_uploads_active_lease_idx
  ON project_completion_photo_uploads(asset_id, upload_lease_expires_at);

-- A project is normally soft-deleted first. This trigger also makes direct or
-- retention-driven physical deletion safe: encrypted objects stay tracked by
-- assets and retain any active writer fence before the binding rows cascade
-- away. The purge worker may only finalize the object after that fence ends.
CREATE FUNCTION tombstone_project_completion_assets_before_project_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE assets AS asset
  SET deleted_at = COALESCE(asset.deleted_at, clock_timestamp()),
      purge_available_at = CASE
        WHEN EXISTS (
          SELECT 1
          FROM project_completion_photo_uploads AS upload
          WHERE upload.asset_id = asset.id
        ) THEN GREATEST(
          asset.purge_available_at,
          (
            SELECT upload.upload_lease_expires_at
            FROM project_completion_photo_uploads AS upload
            WHERE upload.asset_id = asset.id
          )
        )
        ELSE LEAST(asset.purge_available_at, clock_timestamp())
      END
  FROM project_completion_photos AS photo
  WHERE photo.project_id = OLD.id
    AND photo.asset_id = asset.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER projects_completion_assets_tombstone
BEFORE DELETE ON projects
FOR EACH ROW
EXECUTE FUNCTION tombstone_project_completion_assets_before_project_delete();
