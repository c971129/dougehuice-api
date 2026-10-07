-- Preserve the append-only inventory audit after a project and its private
-- revisions are physically purged. The retained project UUID/revision are
-- opaque audit facts only; no project name, grid, tags, or asset metadata is
-- copied into the inventory tables.

CREATE FUNCTION public.validate_inventory_operation_project_reference()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.transaction_type = 'project_consumption' THEN
    PERFORM 1
    FROM public.projects AS project
    JOIN public.project_revisions AS revision
      ON revision.project_id = project.id
     AND revision.revision = NEW.project_revision
    WHERE project.id = NEW.project_id
      AND project.user_id = NEW.user_id
      AND project.deleted_at IS NULL
    FOR KEY SHARE OF project, revision;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'inventory project consumption must reference an active project revision owned by the same user'
        USING ERRCODE = '23503',
              CONSTRAINT = 'inventory_operations_project_revision_owner_fkey',
              TABLE = 'inventory_operations';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_operations_project_reference_check
BEFORE INSERT OR UPDATE OF
  user_id,
  transaction_type,
  project_id,
  project_revision
ON public.inventory_operations
FOR EACH ROW
EXECUTE FUNCTION public.validate_inventory_operation_project_reference();

-- The trigger above preserves write-time ownership and revision validation.
-- Removing only the live-project foreign keys lets later project deletion
-- retain the operation, exactly-once marker, and per-color ledger rows.
ALTER TABLE public.inventory_project_consumptions
  DROP CONSTRAINT inventory_project_consumptions_project_id_user_id_fkey,
  DROP CONSTRAINT inventory_project_consumptions_project_id_project_revision_fkey;

ALTER TABLE public.inventory_operations
  DROP CONSTRAINT inventory_operations_project_id_user_id_fkey;
