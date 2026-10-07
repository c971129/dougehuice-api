-- Persist engagement counters so public feeds never aggregate the complete
-- reactions tables while sorting. ranking_score is database-derived and can
-- therefore be indexed without trusting a client-supplied value.

-- Lock parent first to preserve the application lock order, then block every
-- child-table INSERT/UPDATE/DELETE/TRUNCATE until backfill and trigger install
-- commit. This closes the online-upgrade window where an old transaction could
-- otherwise mutate a reaction after its count had been sampled.
LOCK TABLE community_publications IN ACCESS EXCLUSIVE MODE;
LOCK TABLE community_publication_likes IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE community_publication_favorites IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE community_publications
  ADD COLUMN like_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN favorite_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN ranking_score bigint GENERATED ALWAYS AS (
    like_count * 2 + favorite_count * 3
  ) STORED;

ALTER TABLE community_publications
  DISABLE TRIGGER community_publications_snapshot_immutable;

UPDATE community_publications AS publication
SET like_count = (
      SELECT count(*) FROM community_publication_likes AS current_like
      WHERE current_like.publication_id = publication.id
    ),
    favorite_count = (
      SELECT count(*) FROM community_publication_favorites AS current_favorite
      WHERE current_favorite.publication_id = publication.id
    );

ALTER TABLE community_publications
  ENABLE TRIGGER community_publications_snapshot_immutable;

ALTER TABLE community_publications
  ADD CONSTRAINT community_publications_like_count_check
    CHECK (like_count BETWEEN 0 AND 2147483647),
  ADD CONSTRAINT community_publications_favorite_count_check
    CHECK (favorite_count BETWEEN 0 AND 2147483647);

-- Counter writes are valid only when nested under a database reaction trigger.
-- Direct INSERT cannot predeclare popularity and direct UPDATE cannot forge it.
CREATE FUNCTION enforce_community_publication_engagement_counters() RETURNS trigger AS $$
DECLARE
  write_mode text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.like_count <> 0 OR NEW.favorite_count <> 0 THEN
      RAISE EXCEPTION 'new community publication engagement counters must be zero'
        USING ERRCODE = '23514',
              CONSTRAINT = 'community_publications_engagement_counters_guard';
    END IF;
  ELSIF (NEW.like_count, NEW.favorite_count)
        IS DISTINCT FROM (OLD.like_count, OLD.favorite_count) THEN
    write_mode := current_setting('pindou.community_counter_write', true);
    IF pg_trigger_depth() < 2 OR NOT (
      (write_mode = 'like:increment'
        AND NEW.like_count = OLD.like_count + 1
        AND NEW.favorite_count = OLD.favorite_count)
      OR (write_mode = 'like:decrement'
        AND NEW.like_count = OLD.like_count - 1
        AND NEW.favorite_count = OLD.favorite_count)
      OR (write_mode = 'favorite:increment'
        AND NEW.favorite_count = OLD.favorite_count + 1
        AND NEW.like_count = OLD.like_count)
      OR (write_mode = 'favorite:decrement'
        AND NEW.favorite_count = OLD.favorite_count - 1
        AND NEW.like_count = OLD.like_count)
      OR (write_mode = 'like:reset'
        AND NEW.like_count = 0
        AND NEW.favorite_count = OLD.favorite_count)
      OR (write_mode = 'favorite:reset'
        AND NEW.favorite_count = 0
        AND NEW.like_count = OLD.like_count)
    ) THEN
      RAISE EXCEPTION 'community publication engagement counters are database managed'
        USING ERRCODE = '23514',
              CONSTRAINT = 'community_publications_engagement_counters_guard';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_publications_engagement_counters_guard
BEFORE INSERT OR UPDATE OF like_count, favorite_count ON community_publications
FOR EACH ROW EXECUTE FUNCTION enforce_community_publication_engagement_counters();

-- Keep the immutable snapshot contract intact while explicitly excluding the
-- three database-managed feed counters from snapshot comparisons.
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
  IF (to_jsonb(NEW) - ARRAY[
        'project_id', 'withdrawn_at', 'moderation_status', 'moderation_updated_at',
        'like_count', 'favorite_count', 'ranking_score'
      ]) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'project_id', 'withdrawn_at', 'moderation_status', 'moderation_updated_at',
        'like_count', 'favorite_count', 'ranking_score'
      ]) THEN
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

CREATE FUNCTION update_community_publication_engagement_counter() RETURNS trigger AS $$
DECLARE
  target_publication_id uuid;
  delta bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_publication_id := NEW.publication_id;
    delta := 1;
  ELSIF TG_OP = 'DELETE' THEN
    target_publication_id := OLD.publication_id;
    delta := -1;
  ELSE
    RAISE EXCEPTION 'community publication reactions are immutable; delete and insert instead'
      USING ERRCODE = '55000',
            CONSTRAINT = 'community_publication_reaction_immutable';
  END IF;

  IF TG_TABLE_NAME = 'community_publication_likes' THEN
    PERFORM set_config(
      'pindou.community_counter_write',
      CASE WHEN delta = 1 THEN 'like:increment' ELSE 'like:decrement' END,
      true
    );
    UPDATE community_publications
    SET like_count = like_count + delta
    WHERE id = target_publication_id;
  ELSIF TG_TABLE_NAME = 'community_publication_favorites' THEN
    PERFORM set_config(
      'pindou.community_counter_write',
      CASE WHEN delta = 1 THEN 'favorite:increment' ELSE 'favorite:decrement' END,
      true
    );
    UPDATE community_publications
    SET favorite_count = favorite_count + delta
    WHERE id = target_publication_id;
  ELSE
    RAISE EXCEPTION 'unknown community reaction table' USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('pindou.community_counter_write', '', true);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_community_publication_reaction_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'community publication reactions are immutable; delete and insert instead'
    USING ERRCODE = '55000',
          CONSTRAINT = 'community_publication_reaction_immutable';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reset_community_publication_engagement_counter() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'community_publication_likes' THEN
    PERFORM set_config('pindou.community_counter_write', 'like:reset', true);
    UPDATE community_publications SET like_count = 0 WHERE like_count <> 0;
  ELSIF TG_TABLE_NAME = 'community_publication_favorites' THEN
    PERFORM set_config('pindou.community_counter_write', 'favorite:reset', true);
    UPDATE community_publications SET favorite_count = 0 WHERE favorite_count <> 0;
  ELSE
    RAISE EXCEPTION 'unknown community reaction table' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('pindou.community_counter_write', '', true);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_publication_likes_counter_insert
AFTER INSERT ON community_publication_likes
FOR EACH ROW EXECUTE FUNCTION update_community_publication_engagement_counter();
CREATE TRIGGER community_publication_likes_counter_delete
AFTER DELETE ON community_publication_likes
FOR EACH ROW EXECUTE FUNCTION update_community_publication_engagement_counter();
CREATE TRIGGER community_publication_likes_immutable_update
BEFORE UPDATE ON community_publication_likes
FOR EACH ROW EXECUTE FUNCTION reject_community_publication_reaction_update();
CREATE TRIGGER community_publication_likes_counter_truncate
AFTER TRUNCATE ON community_publication_likes
FOR EACH STATEMENT EXECUTE FUNCTION reset_community_publication_engagement_counter();

CREATE TRIGGER community_publication_favorites_counter_insert
AFTER INSERT ON community_publication_favorites
FOR EACH ROW EXECUTE FUNCTION update_community_publication_engagement_counter();
CREATE TRIGGER community_publication_favorites_counter_delete
AFTER DELETE ON community_publication_favorites
FOR EACH ROW EXECUTE FUNCTION update_community_publication_engagement_counter();
CREATE TRIGGER community_publication_favorites_immutable_update
BEFORE UPDATE ON community_publication_favorites
FOR EACH ROW EXECUTE FUNCTION reject_community_publication_reaction_update();
CREATE TRIGGER community_publication_favorites_counter_truncate
AFTER TRUNCATE ON community_publication_favorites
FOR EACH STATEMENT EXECUTE FUNCTION reset_community_publication_engagement_counter();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM community_publications AS publication
    WHERE publication.like_count <> (
        SELECT count(*) FROM community_publication_likes AS current_like
        WHERE current_like.publication_id = publication.id
      )
       OR publication.favorite_count <> (
        SELECT count(*) FROM community_publication_favorites AS current_favorite
        WHERE current_favorite.publication_id = publication.id
      )
  ) THEN
    RAISE EXCEPTION 'community publication engagement counter backfill mismatch'
      USING ERRCODE = '23514',
            CONSTRAINT = 'community_publications_engagement_counters_guard';
  END IF;
END;
$$;

CREATE INDEX community_publications_ranked_idx
  ON community_publications(ranking_score DESC, published_at DESC, id DESC)
  WHERE moderation_status = 'published';
CREATE INDEX community_publication_likes_user_publication_idx
  ON community_publication_likes(user_id, publication_id);
CREATE INDEX community_publication_favorites_user_publication_idx
  ON community_publication_favorites(user_id, publication_id);

-- Portable substring prefiltering. pg_trgm is intentionally avoided because
-- the embedded PGlite contract does not ship that extension. Exact tag keys
-- and bounded 1/2/3-character n-grams preserve the existing substring
-- semantics once the Store performs its final position(...) verification.
CREATE TABLE community_publication_search_keys (
  publication_id uuid NOT NULL REFERENCES community_publications(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('tag', 'ngram')),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 32),
  PRIMARY KEY (publication_id, kind, key)
);

CREATE INDEX community_publication_search_keys_lookup_idx
  ON community_publication_search_keys(kind, key, publication_id);

CREATE FUNCTION index_community_publication_search_keys() RETURNS trigger AS $$
BEGIN
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

INSERT INTO community_publication_search_keys(publication_id, kind, key)
SELECT publication.id, 'tag', lower(tag)
FROM community_publications AS publication
CROSS JOIN LATERAL unnest(publication.tags) AS tag
WHERE char_length(tag) > 0
ON CONFLICT DO NOTHING;

INSERT INTO community_publication_search_keys(publication_id, kind, key)
SELECT DISTINCT publication.id, 'ngram',
       substring(field.value FROM position.start FOR gram.length)
FROM community_publications AS publication
CROSS JOIN LATERAL (
  SELECT lower(publication.title) AS value
  UNION ALL
  SELECT lower(publication.author_display_name)
  UNION ALL
  SELECT lower(tag) FROM unnest(publication.tags) AS tag
) AS field
CROSS JOIN LATERAL generate_series(1, LEAST(3, char_length(field.value))) AS gram(length)
CROSS JOIN LATERAL generate_series(
  1,
  char_length(field.value) - gram.length + 1
) AS position(start)
WHERE char_length(field.value) > 0
ON CONFLICT DO NOTHING;

CREATE TRIGGER community_publications_search_keys_insert
AFTER INSERT ON community_publications
FOR EACH ROW EXECUTE FUNCTION index_community_publication_search_keys();
