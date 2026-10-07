-- One cloud-resumable creation flow per user before a Project exists.
-- A nullable grid lets setup/crop choices survive before conversion finishes;
-- commit promotes a ready grid into the first immutable project revision.
CREATE UNIQUE INDEX IF NOT EXISTS assets_id_user_unique
  ON assets(id, user_id);

CREATE TABLE IF NOT EXISTS creation_drafts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE,
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('normal', 'pixel', 'portrait', 'couple')),
  setup_step smallint NOT NULL CHECK (setup_step BETWEEN 1 AND 3),
  palette_id text NOT NULL REFERENCES palettes(id),
  source_asset_id uuid,
  width integer NOT NULL CHECK (width BETWEEN 1 AND 200),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 200),
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'object'),
  grid_encoding text,
  grid_cells jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_asset_id, user_id)
    REFERENCES assets(id, user_id) ON DELETE SET NULL (source_asset_id),
  CHECK (
    (grid_encoding IS NULL AND grid_cells IS NULL)
    OR (
      grid_encoding = 'palette-code-v1'
      AND jsonb_typeof(grid_cells) = 'array'
      AND jsonb_array_length(grid_cells) = width * height
    )
  )
);

CREATE INDEX IF NOT EXISTS creation_drafts_updated_idx
  ON creation_drafts(updated_at, user_id);
