-- Product-level Project metadata. `lifecycle_status` deliberately does not
-- replace the API's legacy list `status`, which is derived from build_progress.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'editable',
  ADD COLUMN IF NOT EXISTS source_asset_id uuid,
  ADD COLUMN IF NOT EXISTS preview_asset_id uuid,
  ADD COLUMN IF NOT EXISTS background_mode text NOT NULL DEFAULT 'white',
  ADD COLUMN IF NOT EXISTS background_color char(7);

ALTER TABLE projects
  ADD CONSTRAINT projects_mode_valid
    CHECK (mode IN ('normal', 'pixel', 'portrait', 'couple')),
  ADD CONSTRAINT projects_lifecycle_status_valid
    CHECK (lifecycle_status IN ('draft', 'generating', 'editable', 'exported', 'published')),
  ADD CONSTRAINT projects_background_valid
    CHECK (
      (background_mode IN ('white', 'transparent') AND background_color IS NULL)
      OR (
        background_mode = 'solid'
        AND background_color ~ '^#[0-9A-Fa-f]{6}$'
      )
    ),
  ADD CONSTRAINT projects_source_asset_tenant_fk
    FOREIGN KEY (source_asset_id, user_id)
    REFERENCES assets(id, user_id) ON DELETE SET NULL (source_asset_id),
  ADD CONSTRAINT projects_preview_asset_tenant_fk
    FOREIGN KEY (preview_asset_id, user_id)
    REFERENCES assets(id, user_id) ON DELETE SET NULL (preview_asset_id);

CREATE INDEX IF NOT EXISTS projects_source_asset_idx
  ON projects(source_asset_id)
  WHERE source_asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS projects_preview_asset_idx
  ON projects(preview_asset_id)
  WHERE preview_asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS projects_user_lifecycle_updated_idx
  ON projects(user_id, lifecycle_status, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
