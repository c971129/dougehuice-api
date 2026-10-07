-- Palette provenance and physical bead contract. The historical
-- `mard-basic-v1` identifier is kept only for compatibility; its values were
-- prototype/demo data and must not be presented as an official MARD 96 set.
ALTER TABLE palettes
  ADD COLUMN brand text NOT NULL DEFAULT '未标注',
  ADD COLUMN bead_size_mm numeric(6, 3) NOT NULL DEFAULT 5.000,
  ADD COLUMN verified boolean NOT NULL DEFAULT false;

ALTER TABLE palettes
  ADD CONSTRAINT palettes_brand_nonempty CHECK (char_length(btrim(brand)) BETWEEN 1 AND 100),
  ADD CONSTRAINT palettes_bead_size_valid CHECK (bead_size_mm > 0 AND bead_size_mm <= 20);

ALTER TABLE palette_colors
  ADD COLUMN available boolean NOT NULL DEFAULT true;

UPDATE palettes
SET name = '演示基础色卡（非官方数据）',
    brand = '演示数据（非 MARD 官方）',
    bead_size_mm = 5.000,
    verified = false
WHERE id = 'mard-basic-v1';

-- A revision must retain the palette that gives its stable color codes
-- meaning. This makes palette remapping reversible and keeps historical
-- material summaries valid after the project switches to another palette.
ALTER TABLE project_revisions
  ADD COLUMN palette_id text REFERENCES palettes(id);

-- The existing immutability trigger deliberately rejects UPDATEs. Disable it
-- only for this one-time snapshot backfill, then restore the exact invariant.
DROP TRIGGER project_revisions_immutable ON project_revisions;

UPDATE project_revisions AS revision
SET palette_id = project.palette_id
FROM projects AS project
WHERE project.id = revision.project_id;

CREATE TRIGGER project_revisions_immutable
BEFORE UPDATE ON project_revisions
FOR EACH ROW
EXECUTE FUNCTION reject_project_revision_update();

ALTER TABLE project_revisions
  ALTER COLUMN palette_id SET NOT NULL;

CREATE FUNCTION fill_project_revision_palette()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.palette_id IS NULL THEN
    SELECT palette_id INTO NEW.palette_id FROM projects WHERE id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_revisions_fill_palette
BEFORE INSERT ON project_revisions
FOR EACH ROW
EXECUTE FUNCTION fill_project_revision_palette();
