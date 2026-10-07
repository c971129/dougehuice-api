-- Retire the historical prototype catalog at the schema boundary. Keeping the
-- row (and its colors) preserves old projects, exports, and audit reads; the
-- named check prevents an older seed process from silently making it selectable
-- again or restoring its pre-retirement version.
UPDATE public.palettes
SET version = GREATEST(version, 3),
    retired = true
WHERE id = 'mard-basic-v1';

ALTER TABLE public.palettes
  ADD CONSTRAINT palettes_mard_basic_retirement_guard CHECK (
    id <> 'mard-basic-v1' OR (retired AND version >= 3)
  );

-- A retired catalog is historical evidence. Permit an exact idempotent row
-- replay, but reject identity/provenance changes and deletion. A deliberate
-- data-governance migration must explicitly replace this trigger.
CREATE FUNCTION public.enforce_retired_palette_row_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.retired THEN
      RAISE EXCEPTION 'retired palette % is immutable', OLD.id
        USING ERRCODE = '23514',
              CONSTRAINT = 'retired_palette_immutable_guard',
              TABLE = TG_TABLE_NAME;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.retired
     AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'retired palette % is immutable', OLD.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'retired_palette_immutable_guard',
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER palettes_retired_immutability_guard
BEFORE UPDATE OR DELETE ON public.palettes
FOR EACH ROW
EXECUTE FUNCTION public.enforce_retired_palette_row_immutability();

-- Every derived-write guard ultimately takes the palette row FOR SHARE. This
-- gives retirement one linearization point: an in-flight write that observed an
-- active palette finishes before retirement, while a writer arriving after the
-- retirement UPDATE waits and then rejects. Parent rows are locked before the
-- palette row, matching the Store's project/job -> palette lock order.
CREATE FUNCTION public.require_active_palette_for_write(
  target_palette_id text,
  source_relation text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  palette_is_retired boolean;
BEGIN
  IF target_palette_id IS NULL THEN
    RETURN;
  END IF;

  SELECT palette.retired
  INTO palette_is_retired
  FROM public.palettes AS palette
  WHERE palette.id = target_palette_id
  FOR SHARE OF palette;

  -- Missing parents/palettes remain the responsibility of the existing FK and
  -- tenant-visibility constraints. This function adds only retirement policy.
  IF FOUND AND palette_is_retired THEN
    RAISE EXCEPTION 'retired palette % rejects new derived write to %',
      target_palette_id, source_relation
      USING ERRCODE = '23514',
            CONSTRAINT = 'retired_palette_write_guard',
            TABLE = source_relation;
  END IF;
END;
$$;

CREATE FUNCTION public.enforce_direct_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.require_active_palette_for_write(NEW.palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_retired_palette_color_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  palette_is_retired boolean;
BEGIN
  SELECT palette.retired
  INTO palette_is_retired
  FROM public.palettes AS palette
  WHERE palette.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.palette_id ELSE OLD.palette_id END
  FOR SHARE OF palette;

  IF FOUND AND palette_is_retired THEN
    RAISE EXCEPTION 'retired palette % colors are immutable',
      CASE WHEN TG_OP = 'INSERT' THEN NEW.palette_id ELSE OLD.palette_id END
      USING ERRCODE = '23514',
            CONSTRAINT = 'retired_palette_color_immutable_guard',
            TABLE = TG_TABLE_NAME;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.palette_id IS DISTINCT FROM OLD.palette_id THEN
    SELECT palette.retired
    INTO palette_is_retired
    FROM public.palettes AS palette
    WHERE palette.id = NEW.palette_id
    FOR SHARE OF palette;
    IF FOUND AND palette_is_retired THEN
      RAISE EXCEPTION 'retired palette % colors are immutable', NEW.palette_id
        USING ERRCODE = '23514',
              CONSTRAINT = 'retired_palette_color_immutable_guard',
              TABLE = TG_TABLE_NAME;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER palette_colors_retired_immutability_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.palette_colors
FOR EACH ROW
EXECUTE FUNCTION public.enforce_retired_palette_color_immutability();

CREATE FUNCTION public.enforce_creation_draft_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Asset retention uses ON DELETE SET NULL. Permit that exact cleanup (and
  -- updated_at-only/no-op bookkeeping), but do not let an old writer attach a
  -- new source asset or change any other derived draft field after retirement.
  IF TG_OP = 'UPDATE'
     AND ROW(
       NEW.user_id,
       NEW.id,
       NEW.draft_revision,
       NEW.name,
       NEW.kind,
       NEW.setup_step,
       NEW.palette_id,
       NEW.width,
       NEW.height,
       NEW.options,
       NEW.grid_encoding,
       NEW.grid_cells
     ) IS NOT DISTINCT FROM ROW(
       OLD.user_id,
       OLD.id,
       OLD.draft_revision,
       OLD.name,
       OLD.kind,
       OLD.setup_step,
       OLD.palette_id,
       OLD.width,
       OLD.height,
       OLD.options,
       OLD.grid_encoding,
       OLD.grid_cells
     )
     AND (
       NEW.source_asset_id IS NOT DISTINCT FROM OLD.source_asset_id
       OR (OLD.source_asset_id IS NOT NULL AND NEW.source_asset_id IS NULL)
     ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.require_active_palette_for_write(NEW.palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

-- Creation-draft autosaves are derivatives. The custom guard above preserves
-- the one retention-driven source-asset cleanup without leaving a rebind gap.
CREATE TRIGGER creation_drafts_retired_palette_guard
BEFORE INSERT OR UPDATE ON public.creation_drafts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_creation_draft_active_palette();

CREATE FUNCTION public.enforce_generation_job_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND ROW(
       NEW.id,
       NEW.user_id,
       NEW.kind,
       NEW.palette_id,
       NEW.cost,
       NEW.seed,
       NEW.source_asset_id,
       NEW.width,
       NEW.height,
       NEW.options,
       NEW.parent_job_id
     ) IS NOT DISTINCT FROM ROW(
       OLD.id,
       OLD.user_id,
       OLD.kind,
       OLD.palette_id,
       OLD.cost,
       OLD.seed,
       OLD.source_asset_id,
       OLD.width,
       OLD.height,
       OLD.options,
       OLD.parent_job_id
     ) THEN
    RETURN NEW;
  END IF;

  -- Retention clears a terminal child's parent pointer before deleting the
  -- parent. Allow only that exact relationship cleanup on retired jobs.
  IF TG_OP = 'UPDATE'
     AND OLD.parent_job_id IS NOT NULL
     AND NEW.parent_job_id IS NULL
     AND ROW(
       NEW.id,
       NEW.user_id,
       NEW.kind,
       NEW.palette_id,
       NEW.cost,
       NEW.seed,
       NEW.source_asset_id,
       NEW.width,
       NEW.height,
       NEW.options
     ) IS NOT DISTINCT FROM ROW(
       OLD.id,
       OLD.user_id,
       OLD.kind,
       OLD.palette_id,
       OLD.cost,
       OLD.seed,
       OLD.source_asset_id,
       OLD.width,
       OLD.height,
       OLD.options
     ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.require_active_palette_for_write(NEW.palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

-- Workers must still be able to fail/cancel/refund an already-existing job;
-- those operational fields are absent. Immutable generation inputs and palette
-- reassignment remain fenced against old writers.
CREATE TRIGGER generation_jobs_retired_palette_guard
BEFORE INSERT OR UPDATE OF
  id,
  user_id,
  kind,
  palette_id,
  cost,
  seed,
  source_asset_id,
  width,
  height,
  options,
  parent_job_id
ON public.generation_jobs
FOR EACH ROW
EXECUTE FUNCTION public.enforce_generation_job_active_palette();

CREATE FUNCTION public.enforce_project_active_palette_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  only_lifecycle_changed boolean;
  only_asset_links_cleared boolean;
  current_revision_palette_id text;
  source_palette_retired boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.require_active_palette_for_write(NEW.palette_id, TG_TABLE_NAME);
    RETURN NEW;
  END IF;

  -- A statement that names guarded columns but leaves their values unchanged
  -- is cleanup/no-op bookkeeping, not a new derivative.
  IF ROW(
       NEW.user_id,
       NEW.name,
       NEW.palette_id,
       NEW.current_revision,
       NEW.current_bead_count,
       NEW.current_color_count,
       NEW.mode,
       NEW.lifecycle_status,
       NEW.source_asset_id,
       NEW.preview_asset_id,
       NEW.background_mode,
       NEW.background_color,
       NEW.tags,
       NEW.device_source
     ) IS NOT DISTINCT FROM ROW(
       OLD.user_id,
       OLD.name,
       OLD.palette_id,
       OLD.current_revision,
       OLD.current_bead_count,
       OLD.current_color_count,
       OLD.mode,
       OLD.lifecycle_status,
       OLD.source_asset_id,
       OLD.preview_asset_id,
       OLD.background_mode,
       OLD.background_color,
       OLD.tags,
       OLD.device_source
     ) THEN
    RETURN NEW;
  END IF;

  -- current_revision is part of the project's palette-bearing summary. An
  -- older writer must not point an active summary back at a historical
  -- retired revision (or at a missing revision) while leaving palette_id
  -- unchanged. Take the destination palette lock before the revision lock,
  -- matching the Store's project -> palette -> revision order.
  IF NEW.current_revision IS DISTINCT FROM OLD.current_revision
     OR NEW.palette_id IS DISTINCT FROM OLD.palette_id THEN
    PERFORM public.require_active_palette_for_write(NEW.palette_id, TG_TABLE_NAME);

    SELECT revision.palette_id
    INTO current_revision_palette_id
    FROM public.project_revisions AS revision
    WHERE revision.project_id = NEW.id
      AND revision.revision = NEW.current_revision
    FOR SHARE OF revision;

    IF current_revision_palette_id IS DISTINCT FROM NEW.palette_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'project %s current revision %s palette must match destination palette %s',
          NEW.id,
          NEW.current_revision,
          NEW.palette_id
        );
    END IF;
  END IF;

  -- Explicit remap-away checks the destination palette. An active destination
  -- permits the accompanying revision/count reset even if the source is retired.
  IF NEW.palette_id IS DISTINCT FROM OLD.palette_id THEN
    SELECT palette.retired
    INTO source_palette_retired
    FROM public.palettes AS palette
    WHERE palette.id = OLD.palette_id;

    IF COALESCE(source_palette_retired, false)
       AND NEW.current_revision <= OLD.current_revision THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'project %s must advance its revision when remapping away from retired palette %s',
          NEW.id,
          OLD.palette_id
        );
    END IF;
    RETURN NEW;
  END IF;

  only_asset_links_cleared :=
    NEW.user_id IS NOT DISTINCT FROM OLD.user_id
    AND NEW.name IS NOT DISTINCT FROM OLD.name
    AND NEW.current_revision IS NOT DISTINCT FROM OLD.current_revision
    AND NEW.current_bead_count IS NOT DISTINCT FROM OLD.current_bead_count
    AND NEW.current_color_count IS NOT DISTINCT FROM OLD.current_color_count
    AND NEW.mode IS NOT DISTINCT FROM OLD.mode
    AND NEW.lifecycle_status IS NOT DISTINCT FROM OLD.lifecycle_status
    AND NEW.background_mode IS NOT DISTINCT FROM OLD.background_mode
    AND NEW.background_color IS NOT DISTINCT FROM OLD.background_color
    AND NEW.tags IS NOT DISTINCT FROM OLD.tags
    AND NEW.device_source IS NOT DISTINCT FROM OLD.device_source
    AND (
      NEW.source_asset_id IS NOT DISTINCT FROM OLD.source_asset_id
      OR (OLD.source_asset_id IS NOT NULL AND NEW.source_asset_id IS NULL)
    )
    AND (
      NEW.preview_asset_id IS NOT DISTINCT FROM OLD.preview_asset_id
      OR (OLD.preview_asset_id IS NOT NULL AND NEW.preview_asset_id IS NULL)
    );
  IF only_asset_links_cleared THEN
    RETURN NEW;
  END IF;

  only_lifecycle_changed :=
    NEW.user_id IS NOT DISTINCT FROM OLD.user_id
    AND NEW.name IS NOT DISTINCT FROM OLD.name
    AND NEW.current_revision IS NOT DISTINCT FROM OLD.current_revision
    AND NEW.current_bead_count IS NOT DISTINCT FROM OLD.current_bead_count
    AND NEW.current_color_count IS NOT DISTINCT FROM OLD.current_color_count
    AND NEW.source_asset_id IS NOT DISTINCT FROM OLD.source_asset_id
    AND NEW.preview_asset_id IS NOT DISTINCT FROM OLD.preview_asset_id
    AND NEW.mode IS NOT DISTINCT FROM OLD.mode
    AND NEW.background_mode IS NOT DISTINCT FROM OLD.background_mode
    AND NEW.background_color IS NOT DISTINCT FROM OLD.background_color
    AND NEW.tags IS NOT DISTINCT FROM OLD.tags
    AND NEW.device_source IS NOT DISTINCT FROM OLD.device_source;

  -- Historical export may finish without creating a new grid, and withdrawing
  -- or moderating a publication must be able to restore its pre-publish state.
  IF only_lifecycle_changed
     AND (
       (NEW.lifecycle_status = 'exported' AND OLD.lifecycle_status <> 'published')
       OR (
         OLD.lifecycle_status = 'published'
         AND NEW.lifecycle_status IN ('editable', 'exported')
       )
     ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.require_active_palette_for_write(NEW.palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

-- Guard old writers that mutate project metadata as well as grid/revision
-- summaries. deleted_at, metadata_revision, and updated_at are intentionally
-- absent: soft deletion and trigger-managed bookkeeping remain available.
CREATE TRIGGER projects_retired_palette_guard
BEFORE INSERT OR UPDATE OF
  user_id,
  name,
  palette_id,
  current_revision,
  current_bead_count,
  current_color_count,
  mode,
  lifecycle_status,
  source_asset_id,
  preview_asset_id,
  background_mode,
  background_color,
  tags,
  device_source
ON public.projects
FOR EACH ROW
EXECUTE FUNCTION public.enforce_project_active_palette_write();

-- Alphabetical trigger order places this after project_revisions_fill_palette,
-- so inserts that omit palette_id are checked against the filled snapshot.
CREATE TRIGGER project_revisions_retired_palette_guard
BEFORE INSERT ON public.project_revisions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_direct_active_palette();

CREATE FUNCTION public.enforce_export_job_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_palette_id text;
BEGIN
  -- Generic writers may include immutable identity columns in a full-row
  -- operational status update. Preserve already-queued historical work when
  -- those values are exact no-ops; any real rebinding still takes the fence.
  IF TG_OP = 'UPDATE'
     AND ROW(
       NEW.id,
       NEW.user_id,
       NEW.project_id,
       NEW.project_revision,
       NEW.format,
       NEW.file_name,
       NEW.options
     ) IS NOT DISTINCT FROM ROW(
       OLD.id,
       OLD.user_id,
       OLD.project_id,
       OLD.project_revision,
       OLD.format,
       OLD.file_name,
       OLD.options
     ) THEN
    RETURN NEW;
  END IF;

  -- Existing queued/running jobs are historical work and may still finish.
  -- A new enqueue or real immutable-input rebinding is fenced. Lock the tenant-owned project and exact
  -- immutable revision before the palette so retirement has one linearization
  -- point and a forged cross-tenant export cannot reach the FK-only schema.
  SELECT revision.palette_id
  INTO target_palette_id
  FROM public.projects AS project
  JOIN public.project_revisions AS revision
    ON revision.project_id = project.id
   AND revision.revision = NEW.project_revision
  WHERE project.id = NEW.project_id
    AND project.user_id = NEW.user_id
    AND project.deleted_at IS NULL
  FOR SHARE OF project, revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'export job must reference an active project revision owned by the same user'
      USING ERRCODE = '23503',
            CONSTRAINT = 'export_jobs_project_revision_owner_fkey',
            TABLE = TG_TABLE_NAME;
  END IF;

  PERFORM public.require_active_palette_for_write(target_palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE TRIGGER export_jobs_retired_palette_guard
BEFORE INSERT OR UPDATE OF
  id,
  user_id,
  project_id,
  project_revision,
  format,
  file_name,
  options
ON public.export_jobs
FOR EACH ROW
EXECUTE FUNCTION public.enforce_export_job_active_palette();

CREATE TRIGGER inventory_items_retired_palette_guard
BEFORE INSERT OR UPDATE ON public.inventory_items
FOR EACH ROW
EXECUTE FUNCTION public.enforce_direct_active_palette();

CREATE TRIGGER inventory_transactions_retired_palette_guard
BEFORE INSERT OR UPDATE ON public.inventory_transactions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_direct_active_palette();

CREATE FUNCTION public.enforce_inventory_operation_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_palette_id text;
BEGIN
  IF NEW.transaction_type <> 'project_consumption' THEN
    RETURN NEW;
  END IF;

  -- A completely empty grid produces no item/ledger rows. Guard the operation
  -- itself so that zero-line consumption cannot bypass the direct-table fence.
  SELECT revision.palette_id
  INTO target_palette_id
  FROM public.project_revisions AS revision
  WHERE revision.project_id = NEW.project_id
    AND revision.revision = NEW.project_revision
  FOR SHARE OF revision;

  PERFORM public.require_active_palette_for_write(target_palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_operations_retired_palette_guard
BEFORE INSERT OR UPDATE OF transaction_type, project_id, project_revision
ON public.inventory_operations
FOR EACH ROW
EXECUTE FUNCTION public.enforce_inventory_operation_active_palette();

CREATE FUNCTION public.enforce_project_draft_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_palette_id text;
BEGIN
  SELECT revision.palette_id
  INTO target_palette_id
  FROM public.project_revisions AS revision
  WHERE revision.project_id = NEW.project_id
    AND revision.revision = NEW.base_project_revision
  FOR SHARE OF revision;

  PERFORM public.require_active_palette_for_write(target_palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_drafts_retired_palette_guard
BEFORE INSERT OR UPDATE ON public.project_drafts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_project_draft_active_palette();

CREATE FUNCTION public.enforce_generation_candidate_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_palette_id text;
BEGIN
  -- ON DELETE SET NULL is retention cleanup, not a new acceptance derivative.
  IF TG_OP = 'UPDATE'
     AND OLD.accepted_project_id IS NOT NULL
     AND NEW.accepted_project_id IS NULL
     AND ROW(
       NEW.id,
       NEW.job_id,
       NEW.ordinal,
       NEW.encoding,
       NEW.width,
       NEW.height,
       NEW.cells,
       NEW.created_at,
       NEW.subject_slot,
       NEW.accepted_at,
       NEW.variant_ordinal,
       NEW.output_slot
     ) IS NOT DISTINCT FROM ROW(
       OLD.id,
       OLD.job_id,
       OLD.ordinal,
       OLD.encoding,
       OLD.width,
       OLD.height,
       OLD.cells,
       OLD.created_at,
       OLD.subject_slot,
       OLD.accepted_at,
       OLD.variant_ordinal,
       OLD.output_slot
     ) THEN
    RETURN NEW;
  END IF;

  SELECT job.palette_id
  INTO target_palette_id
  FROM public.generation_jobs AS job
  WHERE job.id = NEW.job_id
  FOR SHARE OF job;

  PERFORM public.require_active_palette_for_write(target_palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE TRIGGER generation_candidates_retired_palette_guard
BEFORE INSERT OR UPDATE ON public.generation_candidates
FOR EACH ROW
EXECUTE FUNCTION public.enforce_generation_candidate_active_palette();

CREATE FUNCTION public.enforce_project_revision_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_palette_id text;
BEGIN
  SELECT revision.palette_id
  INTO target_palette_id
  FROM public.project_revisions AS revision
  WHERE revision.project_id = NEW.project_id
    AND revision.revision = NEW.project_revision
  FOR SHARE OF revision;

  PERFORM public.require_active_palette_for_write(target_palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE TRIGGER build_progress_retired_palette_guard
BEFORE INSERT OR UPDATE ON public.build_progress
FOR EACH ROW
EXECUTE FUNCTION public.enforce_project_revision_active_palette();

-- Soft deletion remains available for historical photos; inserting or changing
-- any ownership/project/asset binding is a palette-derived write.
CREATE TRIGGER project_completion_photos_retired_palette_guard
BEFORE INSERT OR UPDATE OF
  user_id,
  project_id,
  project_revision,
  asset_id,
  asset_purpose
ON public.project_completion_photos
FOR EACH ROW
EXECUTE FUNCTION public.enforce_project_revision_active_palette();

CREATE FUNCTION public.enforce_community_publication_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_palette_id text;
  snapshot_palette_id text;
  source_palette_id text;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT revision.palette_id
    INTO target_palette_id
    FROM public.project_revisions AS revision
    WHERE revision.project_id = NEW.project_id
      AND revision.revision = NEW.project_revision
    FOR SHARE OF revision;

    -- community_publications intentionally keeps no revision FK so a detached
    -- historical snapshot survives retention. For a malformed new row, still
    -- consult the live project before falling back to the snapshot identity.
    IF target_palette_id IS NULL THEN
      SELECT project.palette_id
      INTO target_palette_id
      FROM public.projects AS project
      WHERE project.id = NEW.project_id
      FOR SHARE OF project;
    END IF;
  END IF;

  PERFORM public.require_active_palette_for_write(target_palette_id, TG_TABLE_NAME);
  snapshot_palette_id := NEW.palette_snapshot ->> 'id';
  IF snapshot_palette_id IS DISTINCT FROM target_palette_id THEN
    PERFORM public.require_active_palette_for_write(snapshot_palette_id, TG_TABLE_NAME);
  END IF;

  -- A forged active destination/snapshot must not launder a retired immutable
  -- source publication. The ordinary copy path is guarded again when it writes
  -- community_project_sources below.
  IF NEW.source_publication_id IS NOT NULL THEN
    SELECT publication.palette_snapshot ->> 'id'
    INTO source_palette_id
    FROM public.community_publications AS publication
    WHERE publication.id = NEW.source_publication_id
    FOR SHARE OF publication;
    PERFORM public.require_active_palette_for_write(source_palette_id, TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

-- Moderation, withdrawal, and FK detachment must continue for old snapshots.
CREATE TRIGGER community_publications_retired_palette_guard
BEFORE INSERT ON public.community_publications
FOR EACH ROW
EXECUTE FUNCTION public.enforce_community_publication_active_palette();

CREATE FUNCTION public.enforce_community_copy_source_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_palette_id text;
BEGIN
  -- Older copy writers clone a publication snapshot into a fresh active
  -- private palette before linking provenance. Checking only the destination
  -- project would therefore launder a retired source through the clone.
  SELECT publication.palette_snapshot ->> 'id'
  INTO target_palette_id
  FROM public.community_publications AS publication
  WHERE publication.id = NEW.source_publication_id
  FOR SHARE OF publication;

  PERFORM public.require_active_palette_for_write(target_palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_project_sources_retired_palette_guard
BEFORE INSERT ON public.community_project_sources
FOR EACH ROW
EXECUTE FUNCTION public.enforce_community_copy_source_active_palette();

CREATE FUNCTION public.enforce_completion_upload_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_palette_id text;
BEGIN
  SELECT revision.palette_id
  INTO target_palette_id
  FROM public.project_completion_photos AS photo
  JOIN public.project_revisions AS revision
    ON revision.project_id = photo.project_id
   AND revision.revision = photo.project_revision
  WHERE photo.id = NEW.photo_id
    AND photo.project_id = NEW.project_id
    AND photo.asset_id = NEW.asset_id
  FOR SHARE OF photo, revision;

  PERFORM public.require_active_palette_for_write(target_palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_completion_photo_uploads_retired_palette_guard
BEFORE INSERT OR UPDATE ON public.project_completion_photo_uploads
FOR EACH ROW
EXECUTE FUNCTION public.enforce_completion_upload_active_palette();

CREATE FUNCTION public.enforce_completion_asset_ready_active_palette()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_palette_id text;
BEGIN
  IF NEW.purpose <> 'project-completion'
     OR OLD.ready_at IS NOT NULL
     OR NEW.ready_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Asset writers already own the asset row. Follow the established
  -- asset -> photo -> revision -> palette order used by publish/purge paths.
  SELECT revision.palette_id
  INTO target_palette_id
  FROM public.project_completion_photos AS photo
  JOIN public.project_revisions AS revision
    ON revision.project_id = photo.project_id
   AND revision.revision = photo.project_revision
  WHERE photo.asset_id = NEW.id
  FOR SHARE OF photo, revision;

  PERFORM public.require_active_palette_for_write(target_palette_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE TRIGGER assets_completion_ready_retired_palette_guard
BEFORE UPDATE OF ready_at ON public.assets
FOR EACH ROW
EXECUTE FUNCTION public.enforce_completion_asset_ready_active_palette();
