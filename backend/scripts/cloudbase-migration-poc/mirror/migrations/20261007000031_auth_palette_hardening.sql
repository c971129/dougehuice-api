-- Make tenant-owned palettes safe at the database boundary, tighten the Web
-- login state machine, and keep anonymous rate-limit state bounded.

DROP INDEX IF EXISTS palettes_owner_user_id_idx;
CREATE INDEX palettes_owner_user_id_idx ON palettes(owner_user_id);
CREATE INDEX auth_rate_limits_updated_at_idx ON auth_rate_limits(updated_at);

ALTER TABLE palette_colors
  ADD CONSTRAINT palette_colors_code_contract
    CHECK (char_length(code) BETWEEN 1 AND 32 AND code = btrim(code)),
  ADD CONSTRAINT palette_colors_name_contract
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 100 AND name = btrim(name));

ALTER TABLE palettes
  ADD CONSTRAINT palettes_name_contract
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 100 AND name = btrim(name));

ALTER TABLE web_login_challenges
  ADD CONSTRAINT web_login_challenges_token_hash_contract
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT web_login_challenges_state_contract
    CHECK (
      (status = 'pending' AND user_id IS NULL AND approved_at IS NULL)
      OR
      (status = 'approved' AND user_id IS NOT NULL AND approved_at IS NOT NULL)
    );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT user_id, palette_id FROM creation_drafts
      UNION ALL SELECT user_id, palette_id FROM generation_jobs
      UNION ALL SELECT user_id, palette_id FROM inventory_items
      UNION ALL SELECT user_id, palette_id FROM inventory_transactions
      UNION ALL SELECT user_id, palette_id FROM projects
    ) AS reference
    JOIN palettes AS palette ON palette.id = reference.palette_id
    WHERE palette.owner_user_id IS NOT NULL
      AND palette.owner_user_id <> reference.user_id
  ) OR EXISTS (
    SELECT 1
    FROM project_revisions AS revision
    JOIN projects AS project ON project.id = revision.project_id
    JOIN palettes AS palette ON palette.id = revision.palette_id
    WHERE palette.owner_user_id IS NOT NULL
      AND palette.owner_user_id <> project.user_id
  ) THEN
    RAISE EXCEPTION 'cross-tenant private palette references must be removed before migration 0031'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION enforce_palette_tenant_visibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM palettes
    WHERE id = NEW.palette_id
      AND (owner_user_id IS NULL OR owner_user_id = NEW.user_id)
  ) THEN
    RAISE EXCEPTION 'palette % is not visible to user %', NEW.palette_id, NEW.user_id
      USING ERRCODE = '23503', CONSTRAINT = 'palette_tenant_visibility';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER creation_drafts_palette_tenant_visibility
BEFORE INSERT OR UPDATE OF user_id, palette_id ON creation_drafts
FOR EACH ROW EXECUTE FUNCTION enforce_palette_tenant_visibility();

CREATE TRIGGER generation_jobs_palette_tenant_visibility
BEFORE INSERT OR UPDATE OF user_id, palette_id ON generation_jobs
FOR EACH ROW EXECUTE FUNCTION enforce_palette_tenant_visibility();

CREATE TRIGGER inventory_items_palette_tenant_visibility
BEFORE INSERT OR UPDATE OF user_id, palette_id ON inventory_items
FOR EACH ROW EXECUTE FUNCTION enforce_palette_tenant_visibility();

CREATE TRIGGER inventory_transactions_palette_tenant_visibility
BEFORE INSERT OR UPDATE OF user_id, palette_id ON inventory_transactions
FOR EACH ROW EXECUTE FUNCTION enforce_palette_tenant_visibility();

CREATE TRIGGER projects_palette_tenant_visibility
BEFORE INSERT OR UPDATE OF user_id, palette_id ON projects
FOR EACH ROW EXECUTE FUNCTION enforce_palette_tenant_visibility();

CREATE FUNCTION enforce_project_revision_palette_visibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM projects AS project
    JOIN palettes AS palette ON palette.id = NEW.palette_id
    WHERE project.id = NEW.project_id
      AND (palette.owner_user_id IS NULL OR palette.owner_user_id = project.user_id)
  ) THEN
    RAISE EXCEPTION 'revision palette % is not visible to project %', NEW.palette_id, NEW.project_id
      USING ERRCODE = '23503', CONSTRAINT = 'project_revision_palette_tenant_visibility';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_revisions_palette_tenant_visibility
BEFORE INSERT ON project_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_project_revision_palette_visibility();
