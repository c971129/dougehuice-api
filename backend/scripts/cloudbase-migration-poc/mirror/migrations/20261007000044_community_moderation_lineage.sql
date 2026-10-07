-- Keep moderation effective across the complete immutable publication lineage.
-- Application transactions serialize a lineage with the same advisory key;
-- these triggers are a final database-write guard, not a cascading updater.

CREATE INDEX community_publications_source_publication_idx
  ON community_publications(source_publication_id)
  WHERE source_publication_id IS NOT NULL;

-- A moderator may terminally remove an already withdrawn tombstone without
-- erasing when the author withdrew it. Replace 0042's anonymous equivalence
-- check with a named forward-compatible constraint.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT constraint_row.conname
  INTO constraint_name
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'community_publications'::regclass
    AND constraint_row.contype = 'c'
    AND pg_get_constraintdef(constraint_row.oid) LIKE '%moderation_status%'
    AND pg_get_constraintdef(constraint_row.oid) LIKE '%withdrawn_at%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE community_publications DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;
END;
$$;

ALTER TABLE community_publications
  ADD CONSTRAINT community_publications_withdrawal_timestamp_check CHECK (
    (moderation_status = 'withdrawn' AND withdrawn_at IS NOT NULL)
    OR moderation_status = 'removed'
    OR (moderation_status NOT IN ('withdrawn', 'removed') AND withdrawn_at IS NULL)
  );

CREATE OR REPLACE FUNCTION enforce_community_publication_snapshot_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     AND NOT (
       OLD.project_id IS NOT NULL
       AND NEW.project_id IS NULL
       AND OLD.moderation_status IN ('withdrawn', 'removed')
     ) THEN
    RAISE EXCEPTION 'community publication project link is immutable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['project_id', 'withdrawn_at', 'moderation_status', 'moderation_updated_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['project_id', 'withdrawn_at', 'moderation_status', 'moderation_updated_at']) THEN
    RAISE EXCEPTION 'community publication snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
     AND NOT (
       OLD.withdrawn_at IS NULL
       AND NEW.withdrawn_at IS NOT NULL
       AND NEW.moderation_status = 'withdrawn'
     ) THEN
    RAISE EXCEPTION 'community publication withdrawal time is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.moderation_status IN ('withdrawn', 'rejected', 'removed')
     AND NEW.moderation_status IS DISTINCT FROM OLD.moderation_status
     AND NOT (
       OLD.moderation_status = 'withdrawn'
       AND NEW.moderation_status = 'removed'
     ) THEN
    RAISE EXCEPTION 'terminal community publications cannot be republished' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE ancestry(descendant_id, ancestor_id) AS (
      SELECT publication.id, publication.source_publication_id
      FROM community_publications AS publication
      WHERE publication.moderation_status = 'published'
        AND publication.source_publication_id IS NOT NULL
      UNION ALL
      SELECT ancestry.descendant_id, ancestor.source_publication_id
      FROM ancestry
      JOIN community_publications AS ancestor ON ancestor.id = ancestry.ancestor_id
      WHERE ancestor.source_publication_id IS NOT NULL
    )
    SELECT 1
    FROM ancestry
    JOIN community_publications AS ancestor ON ancestor.id = ancestry.ancestor_id
    WHERE ancestor.moderation_status IN ('pending_review', 'hidden', 'rejected', 'removed')
       OR (
         ancestor.moderation_status = 'withdrawn'
         AND (
           SELECT event.from_status
           FROM community_moderation_events AS event
           WHERE event.publication_id = ancestor.id
             AND event.to_status = 'withdrawn'
           ORDER BY event.created_at DESC, event.id DESC
           LIMIT 1
         ) IS DISTINCT FROM 'published'
       )
  ) THEN
    RAISE EXCEPTION 'legacy published community descendant bypasses an admin-restricted ancestor'
      USING ERRCODE = '23514',
            CONSTRAINT = 'community_publications_ancestor_moderation_guard';
  END IF;
END;
$$;

CREATE FUNCTION community_lineage_lock(publication_id uuid) RETURNS void AS $$
DECLARE
  lineage_root_id uuid;
  acquired boolean;
BEGIN
  SELECT COALESCE(root_source_publication_id, id)
  INTO lineage_root_id
  FROM community_publications
  WHERE id = publication_id;

  IF lineage_root_id IS NULL THEN
    lineage_root_id := publication_id;
  END IF;

  SELECT pg_try_advisory_xact_lock(
    hashtext('community-publication-lineage'),
    hashtext(lineage_root_id::text)
  ) INTO acquired;
  IF NOT acquired THEN
    RAISE EXCEPTION 'community publication lineage is busy'
      USING ERRCODE = '40001',
            CONSTRAINT = 'community_publications_lineage_busy';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_community_publication_moderation_lineage() RETURNS trigger AS $$
BEGIN
  -- All post-upgrade publications are born public with no withdrawal time.
  -- Legacy rows already exist before this trigger is installed, so any new
  -- non-null value is necessarily a forged history fact.
  IF TG_OP = 'INSERT' AND NEW.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'new community publication cannot predeclare a withdrawal time'
      USING ERRCODE = '23514',
            CONSTRAINT = 'community_publications_withdrawal_timestamp_insert_guard';
  END IF;

  IF (TG_OP = 'INSERT' AND NEW.moderation_status = 'published')
     OR (TG_OP = 'UPDATE'
       AND OLD.moderation_status IS DISTINCT FROM NEW.moderation_status
       AND NEW.moderation_status IN ('pending_review', 'published', 'hidden', 'rejected', 'removed')) THEN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'community moderation lineage writes require READ COMMITTED isolation'
        USING ERRCODE = '25001',
              CONSTRAINT = 'community_publications_lineage_isolation_guard';
    END IF;
    PERFORM community_lineage_lock(COALESCE(NEW.root_source_publication_id, NEW.id));
  END IF;

  -- A new public snapshot, or an explicit moderator restore, is legal only
  -- while every immutable source ancestor remains published. Withdrawal does
  -- not retroactively hide an existing derivative, but it does prevent a new
  -- derivative or a later restore from laundering an earlier admin block.
  IF NEW.moderation_status = 'published'
     AND (TG_OP = 'INSERT' OR OLD.moderation_status IS DISTINCT FROM NEW.moderation_status)
     AND EXISTS (
       WITH RECURSIVE ancestry(id, source_publication_id, moderation_status) AS (
         SELECT publication.id, publication.source_publication_id, publication.moderation_status
         FROM community_publications AS publication
         WHERE publication.id = NEW.source_publication_id
         UNION ALL
         SELECT ancestor.id, ancestor.source_publication_id, ancestor.moderation_status
         FROM community_publications AS ancestor
         JOIN ancestry ON ancestor.id = ancestry.source_publication_id
       )
       SELECT 1 FROM ancestry
       WHERE moderation_status <> 'published'
     ) THEN
    RAISE EXCEPTION 'community publication has a moderation-restricted ancestor'
      USING ERRCODE = '23514',
            CONSTRAINT = 'community_publications_ancestor_moderation_guard';
  END IF;

  -- Restricted ancestors must not retain a public descendant. The Store
  -- hides public descendants first (leaf-to-root) while holding the lineage
  -- lock. Pending/independently restricted descendants are deliberately left
  -- unchanged and cannot later publish until this ancestor is restored.
  IF TG_OP = 'UPDATE'
     AND OLD.moderation_status IS DISTINCT FROM NEW.moderation_status
     AND NEW.moderation_status IN ('pending_review', 'hidden', 'rejected', 'removed')
     AND EXISTS (
       WITH RECURSIVE descendants(id) AS (
         SELECT publication.id
         FROM community_publications AS publication
         WHERE publication.source_publication_id = NEW.id
         UNION ALL
         SELECT publication.id
         FROM community_publications AS publication
         JOIN descendants ON publication.source_publication_id = descendants.id
       )
       SELECT 1
       FROM descendants
       JOIN community_publications AS publication ON publication.id = descendants.id
       WHERE publication.moderation_status = 'published'
     ) THEN
    RAISE EXCEPTION 'restricted community publication still has a public descendant'
      USING ERRCODE = '23514',
            CONSTRAINT = 'community_publications_descendant_moderation_guard';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_publications_moderation_lineage_insert
BEFORE INSERT ON community_publications
FOR EACH ROW EXECUTE FUNCTION enforce_community_publication_moderation_lineage();

CREATE TRIGGER community_publications_moderation_lineage_update
BEFORE UPDATE OF moderation_status ON community_publications
FOR EACH ROW EXECUTE FUNCTION enforce_community_publication_moderation_lineage();
