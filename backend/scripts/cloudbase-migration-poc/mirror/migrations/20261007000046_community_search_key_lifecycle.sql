-- Search keys only serve the public feed. Keep their lifecycle transactionally
-- aligned with effective publication visibility so historical moderation
-- states cannot retain unbounded, permanently unused index entries.

-- Block publication status changes while the trigger function is replaced and
-- legacy keys are pruned. Parent-first locking matches the publication write
-- paths; the child lock prevents direct key-table writes during cleanup.
LOCK TABLE community_publications IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE community_publication_search_keys IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION index_community_publication_search_keys() RETURNS trigger AS $$
BEGIN
  DELETE FROM community_publication_search_keys
  WHERE publication_id = NEW.id;

  IF NEW.moderation_status <> 'published' THEN
    RETURN NEW;
  END IF;

  INSERT INTO community_publication_search_keys(publication_id, kind, key)
  SELECT NEW.id, 'tag', lower(tag)
  FROM unnest(NEW.tags) AS tag
  WHERE char_length(tag) > 0
  ON CONFLICT DO NOTHING;

  INSERT INTO community_publication_search_keys(publication_id, kind, key)
  SELECT DISTINCT NEW.id, 'ngram', substring(field.value FROM position.start FOR gram.length)
  FROM (
    SELECT lower(NEW.title) AS value
    UNION ALL
    SELECT lower(NEW.author_display_name)
    UNION ALL
    SELECT lower(tag) FROM unnest(NEW.tags) AS tag
  ) AS field
  CROSS JOIN LATERAL generate_series(1, LEAST(3, char_length(field.value))) AS gram(length)
  CROSS JOIN LATERAL generate_series(
    1,
    char_length(field.value) - gram.length + 1
  ) AS position(start)
  WHERE char_length(field.value) > 0
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 0045 indexed every historical state. Prune those rows once while preserving
-- already-built keys for currently public publications.
DELETE FROM community_publication_search_keys AS search_key
USING community_publications AS publication
WHERE search_key.publication_id = publication.id
  AND publication.moderation_status <> 'published';

CREATE TRIGGER community_publications_search_keys_moderation
AFTER UPDATE OF moderation_status ON community_publications
FOR EACH ROW
WHEN (OLD.moderation_status IS DISTINCT FROM NEW.moderation_status)
EXECUTE FUNCTION index_community_publication_search_keys();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM community_publication_search_keys AS search_key
    JOIN community_publications AS publication ON publication.id = search_key.publication_id
    WHERE publication.moderation_status <> 'published'
  ) THEN
    RAISE EXCEPTION 'non-public community publications retain search keys after lifecycle migration'
      USING ERRCODE = '23514',
            CONSTRAINT = 'community_publication_search_keys_public_only';
  END IF;
END;
$$;
