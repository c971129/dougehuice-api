-- Preserve root authorship/license across multiple copy generations and make
-- share-alike inheritance a database invariant as well as an application rule.

CREATE FUNCTION community_cells_are_codes_or_null(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS cell(value)
      WHERE jsonb_typeof(cell.value) NOT IN ('string', 'null')
    )
  END;
$$;

ALTER TABLE community_publications
  ADD CONSTRAINT community_publications_cells_scalar_check
    CHECK (community_cells_are_codes_or_null(cells)),
  ADD CONSTRAINT community_publications_thumbnail_cells_scalar_check
    CHECK (community_cells_are_codes_or_null(thumbnail_cells));

ALTER TABLE community_publications
  ADD COLUMN root_source_publication_id uuid
    REFERENCES community_publications(id) ON DELETE RESTRICT,
  ADD COLUMN root_source_attribution jsonb;

-- Existing direct source IDs form an immutable, acyclic chain: a publication
-- can only reference a row that already exists, and 0042 prevents later source
-- mutation. Reconstruct the oldest source rather than treating the direct
-- attribution snapshot as the root for legacy multi-generation publications.
ALTER TABLE community_publications
  DISABLE TRIGGER community_publications_snapshot_immutable;

WITH RECURSIVE lineage(descendant_id, ancestor_id, depth) AS (
  SELECT publication.id, publication.source_publication_id, 1
  FROM community_publications AS publication
  WHERE publication.source_publication_id IS NOT NULL
  UNION ALL
  SELECT lineage.descendant_id, ancestor.source_publication_id, lineage.depth + 1
  FROM lineage
  JOIN community_publications AS ancestor ON ancestor.id = lineage.ancestor_id
  WHERE ancestor.source_publication_id IS NOT NULL
), roots AS (
  SELECT DISTINCT ON (descendant_id) descendant_id, ancestor_id
  FROM lineage
  ORDER BY descendant_id, depth DESC
)
UPDATE community_publications AS publication
SET root_source_publication_id = root.id,
    root_source_attribution = jsonb_build_object(
      'publicationId', root.id::text,
      'title', root.title,
      'author', jsonb_build_object(
        'id', root.author_user_id::text,
        'displayName', root.author_display_name
      ),
      'copyrightStatement', root.copyright_statement,
      'reusePolicy', root.reuse_policy
    )
FROM roots
JOIN community_publications AS root ON root.id = roots.ancestor_id
WHERE publication.id = roots.descendant_id;

ALTER TABLE community_publications
  ENABLE TRIGGER community_publications_snapshot_immutable;

CREATE FUNCTION community_source_attribution_is_valid(value jsonb, expected_id uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN expected_id IS NULL THEN value IS NULL
    WHEN jsonb_typeof(value) <> 'object' THEN false
    ELSE COALESCE(
      value ->> 'publicationId' = expected_id::text
      AND jsonb_typeof(value -> 'title') = 'string'
      AND char_length(value ->> 'title') BETWEEN 1 AND 100
      AND jsonb_typeof(value -> 'author') = 'object'
      AND jsonb_typeof(value -> 'author' -> 'id') = 'string'
      AND (value -> 'author' ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(value -> 'author' -> 'displayName') = 'string'
      AND char_length(value -> 'author' ->> 'displayName') BETWEEN 1 AND 80
      AND jsonb_typeof(value -> 'copyrightStatement') = 'string'
      AND char_length(value ->> 'copyrightStatement') BETWEEN 1 AND 500
      AND value ->> 'reusePolicy' IN (
        'all-rights-reserved', 'attribution', 'attribution-share-alike', 'public-domain'
      ),
      false
    )
  END;
$$;

ALTER TABLE community_publications
  ADD CONSTRAINT community_publications_source_attribution_strict_check
    CHECK (community_source_attribution_is_valid(source_attribution, source_publication_id)),
  ADD CONSTRAINT community_publications_root_source_consistent_check
    CHECK (
      (source_publication_id IS NULL
        AND root_source_publication_id IS NULL
        AND root_source_attribution IS NULL)
      OR
      (source_publication_id IS NOT NULL
        AND root_source_publication_id IS NOT NULL
        AND root_source_publication_id <> id
        AND community_source_attribution_is_valid(
          root_source_attribution,
          root_source_publication_id
        ))
    );

-- Do not silently grandfather rows written by a privileged client under 0042.
-- A failed check deliberately stops the migration so operators can quarantine
-- or correct the inconsistent publication before retrying the transactional
-- migration; retaining a forged credit or downgraded SA license is unsafe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM community_publications AS publication
    JOIN community_publications AS source
      ON source.id = publication.source_publication_id
    WHERE NOT source.allow_copy
       OR publication.source_attribution IS DISTINCT FROM jsonb_build_object(
         'publicationId', source.id::text,
         'title', source.title,
         'author', jsonb_build_object(
           'id', source.author_user_id::text,
           'displayName', source.author_display_name
         ),
         'copyrightStatement', source.copyright_statement,
         'reusePolicy', source.reuse_policy
       )
       OR publication.root_source_publication_id IS DISTINCT FROM COALESCE(
         source.root_source_publication_id,
         source.id
       )
       OR publication.root_source_attribution IS DISTINCT FROM COALESCE(
         source.root_source_attribution,
         jsonb_build_object(
           'publicationId', source.id::text,
           'title', source.title,
           'author', jsonb_build_object(
             'id', source.author_user_id::text,
             'displayName', source.author_display_name
           ),
           'copyrightStatement', source.copyright_statement,
           'reusePolicy', source.reuse_policy
         )
       )
  ) THEN
    RAISE EXCEPTION 'legacy community publication provenance is inconsistent'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH RECURSIVE lineage(descendant_id, ancestor_id, reuse_policy) AS (
      SELECT publication.id, source.id, source.reuse_policy
      FROM community_publications AS publication
      JOIN community_publications AS source
        ON source.id = publication.source_publication_id
      UNION ALL
      SELECT lineage.descendant_id, ancestor.id, ancestor.reuse_policy
      FROM lineage
      JOIN community_publications AS current_source
        ON current_source.id = lineage.ancestor_id
      JOIN community_publications AS ancestor
        ON ancestor.id = current_source.source_publication_id
    )
    SELECT 1
    FROM community_publications AS publication
    WHERE EXISTS (
      SELECT 1 FROM lineage
      WHERE lineage.descendant_id = publication.id
        AND lineage.reuse_policy = 'attribution-share-alike'
    )
      AND NOT (
        publication.allow_copy
        AND publication.reuse_policy = 'attribution-share-alike'
      )
  ) THEN
    RAISE EXCEPTION 'legacy community publication downgraded a share-alike source'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION enforce_community_publication_source_lineage() RETURNS trigger AS $$
DECLARE
  direct_source community_publications%ROWTYPE;
  expected_direct_attribution jsonb;
  expected_root_publication_id uuid;
  expected_root_attribution jsonb;
  share_alike_required boolean;
BEGIN
  IF NEW.source_publication_id IS NULL THEN
    IF NEW.source_attribution IS NOT NULL
       OR NEW.root_source_publication_id IS NOT NULL
       OR NEW.root_source_attribution IS NOT NULL THEN
      RAISE EXCEPTION 'community publication source lineage is inconsistent'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO direct_source
  FROM community_publications
  WHERE id = NEW.source_publication_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'community publication source does not exist'
      USING ERRCODE = '23503';
  END IF;
  IF NOT direct_source.allow_copy THEN
    RAISE EXCEPTION 'community publication source does not permit copying'
      USING ERRCODE = '23514';
  END IF;

  expected_direct_attribution := jsonb_build_object(
    'publicationId', direct_source.id::text,
    'title', direct_source.title,
    'author', jsonb_build_object(
      'id', direct_source.author_user_id::text,
      'displayName', direct_source.author_display_name
    ),
    'copyrightStatement', direct_source.copyright_statement,
    'reusePolicy', direct_source.reuse_policy
  );
  expected_root_publication_id := COALESCE(
    direct_source.root_source_publication_id,
    direct_source.id
  );
  expected_root_attribution := COALESCE(
    direct_source.root_source_attribution,
    expected_direct_attribution
  );

  IF NEW.source_attribution IS DISTINCT FROM expected_direct_attribution
     OR NEW.root_source_publication_id IS DISTINCT FROM expected_root_publication_id
     OR NEW.root_source_attribution IS DISTINCT FROM expected_root_attribution THEN
    RAISE EXCEPTION 'community publication source attribution does not match immutable lineage'
      USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE lineage(id, source_publication_id, reuse_policy) AS (
    SELECT publication.id, publication.source_publication_id, publication.reuse_policy
    FROM community_publications AS publication
    WHERE publication.id = NEW.source_publication_id
    UNION ALL
    SELECT ancestor.id, ancestor.source_publication_id, ancestor.reuse_policy
    FROM community_publications AS ancestor
    JOIN lineage ON ancestor.id = lineage.source_publication_id
  )
  SELECT COALESCE(bool_or(reuse_policy = 'attribution-share-alike'), false)
  INTO share_alike_required
  FROM lineage;

  IF share_alike_required
     AND NOT (
       NEW.allow_copy
       AND NEW.reuse_policy = 'attribution-share-alike'
     ) THEN
    RAISE EXCEPTION 'share-alike source requires attribution-share-alike publication'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_publications_source_lineage
BEFORE INSERT ON community_publications
FOR EACH ROW EXECUTE FUNCTION enforce_community_publication_source_lineage();

-- Moderation/report actor IDs are retained audit facts and therefore restrict
-- account deletion just like publication authors and reporters.
ALTER TABLE community_moderation_events
  ADD CONSTRAINT community_moderation_events_actor_user_fk
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE community_report_events
  ADD CONSTRAINT community_report_events_actor_user_fk
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;
