-- Palette visibility is part of the meaning of every persisted reference.
-- Ownership therefore cannot be reassigned after creation: changing it could
-- retroactively expose or invalidate projects, jobs, drafts, and inventory.

CREATE FUNCTION reject_palette_owner_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    RAISE EXCEPTION 'palette ownership is immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'palettes_owner_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER palettes_owner_immutable
BEFORE UPDATE OF owner_user_id ON palettes
FOR EACH ROW EXECUTE FUNCTION reject_palette_owner_update();
