-- Persist palette identity/provenance. Brand + series + diameter + version +
-- code form the product identity; color names are never used for substitution.
ALTER TABLE palettes
  ADD COLUMN IF NOT EXISTS series text NOT NULL DEFAULT 'unspecified',
  ADD COLUMN IF NOT EXISTS material text NOT NULL DEFAULT 'PE',
  ADD COLUMN IF NOT EXISTS source_name text NOT NULL DEFAULT 'user import',
  ADD COLUMN IF NOT EXISTS source_url text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_revision text NOT NULL DEFAULT '1',
  ADD COLUMN IF NOT EXISTS source_license text NOT NULL DEFAULT 'user supplied',
  ADD COLUMN IF NOT EXISTS retired boolean NOT NULL DEFAULT false;

ALTER TABLE palette_colors
  ADD COLUMN IF NOT EXISTS finish text NOT NULL DEFAULT 'solid';

ALTER TABLE palette_colors
  DROP CONSTRAINT IF EXISTS palette_colors_finish_check,
  ADD CONSTRAINT palette_colors_finish_check CHECK (finish IN (
    'solid', 'pearlescent', 'thermochromic', 'translucent', 'transparent',
    'glow-in-the-dark', 'photochromic', 'special'
  ));

-- Rows created before product-line metadata existed use their immutable
-- palette name as the stable series default, matching both runtime stores.
UPDATE palettes
SET series = name
WHERE owner_user_id IS NOT NULL AND series = 'unspecified';

-- Quarantine the historical prototype palette without deleting referenced
-- rows. New reads and writes expose only the five official MARD catalogs;
-- migration evidence remains available for audited remapping.
UPDATE palettes
SET retired = true,
    series = 'legacy-prototype',
    material = 'PE',
    source_name = 'Pindou legacy prototype palette',
    source_url = '',
    source_revision = '2',
    source_license = 'Internal prototype data; not an official MARD dataset'
WHERE id = 'mard-basic-v1';

CREATE TABLE IF NOT EXISTS palette_color_migration_audit (
  id bigserial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  old_palette_id text NOT NULL,
  old_color_code text NOT NULL,
  old_hex text NOT NULL CHECK (old_hex ~ '^#[0-9A-Fa-f]{6}$'),
  new_palette_id text,
  new_color_code text,
  new_hex text CHECK (new_hex IS NULL OR new_hex ~ '^#[0-9A-Fa-f]{6}$'),
  delta_e_2000 numeric(8,4),
  reliable boolean NOT NULL,
  migration_version text NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, old_palette_id, old_color_code, migration_version)
);

ALTER TABLE generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_options_max_colors_check,
  ADD CONSTRAINT generation_jobs_options_max_colors_check CHECK (
    (options ->> 'maxColors') ~ '^[0-9]+$'
    AND (options ->> 'maxColors')::integer BETWEEN 5 AND 32
  );
