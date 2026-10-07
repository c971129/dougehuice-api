-- Immutable, privacy-safe community publication snapshots. Publications copy
-- only the revision grid and bounded display metadata; private asset IDs and
-- object-storage keys are deliberately absent.

CREATE FUNCTION community_cells_use_palette(palette jsonb, value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT COALESCE(jsonb_typeof(palette) = 'object'
    AND jsonb_typeof(palette -> 'colors') = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS cell(value)
      WHERE cell.value <> 'null'::jsonb
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(palette -> 'colors') AS color(value)
          WHERE jsonb_typeof(color.value -> 'code') = 'string'
            AND color.value ->> 'code' = cell.value #>> '{}'
        )
    ), false);
$$;

CREATE FUNCTION community_grid_stats_match(value jsonb, expected_colors integer, expected_beads integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT expected_beads = (
      SELECT count(*)::integer FROM jsonb_array_elements(value) AS cell(value)
      WHERE cell.value <> 'null'::jsonb
    )
    AND expected_colors = (
      SELECT count(DISTINCT cell.value)::integer FROM jsonb_array_elements(value) AS cell(value)
      WHERE cell.value <> 'null'::jsonb
    );
$$;

CREATE TABLE community_publications (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  project_revision integer NOT NULL CHECK (project_revision > 0),
  -- Deliberately not a cascading FK: published authorship is an audit fact.
  -- The immutable display-name snapshot keeps attribution after account erasure.
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_display_name text NOT NULL CHECK (char_length(author_display_name) BETWEEN 1 AND 80),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  category text NOT NULL CHECK (category IN (
    'general', 'portrait', 'couple', 'pet', 'scenery', 'pixel-art', 'other'
  )),
  tags text[] NOT NULL DEFAULT '{}' CHECK (project_tags_are_valid(tags)),
  mode text NOT NULL CHECK (mode IN ('normal', 'pixel', 'portrait', 'couple')),
  palette_snapshot jsonb NOT NULL CHECK (jsonb_typeof(palette_snapshot) = 'object'),
  background_mode text NOT NULL CHECK (background_mode IN ('white', 'transparent', 'solid')),
  background_color char(7),
  encoding text NOT NULL CHECK (encoding = 'palette-code-v1'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 200),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 200),
  cells jsonb NOT NULL CHECK (
    jsonb_typeof(cells) = 'array' AND jsonb_array_length(cells) = width * height
  ),
  thumbnail_width integer NOT NULL CHECK (thumbnail_width BETWEEN 1 AND 32),
  thumbnail_height integer NOT NULL CHECK (thumbnail_height BETWEEN 1 AND 32),
  thumbnail_cells jsonb NOT NULL CHECK (
    jsonb_typeof(thumbnail_cells) = 'array'
    AND jsonb_array_length(thumbnail_cells) = thumbnail_width * thumbnail_height
  ),
  color_count integer NOT NULL CHECK (color_count >= 0),
  bead_count integer NOT NULL CHECK (bead_count > 0),
  copyright_statement text NOT NULL CHECK (char_length(copyright_statement) BETWEEN 1 AND 500),
  allow_copy boolean NOT NULL,
  reuse_policy text NOT NULL CHECK (reuse_policy IN (
    'all-rights-reserved', 'attribution', 'attribution-share-alike', 'public-domain'
  )),
  source_publication_id uuid REFERENCES community_publications(id) ON DELETE RESTRICT,
  -- Immutable, denormalized attribution keeps copied-work credit stable even
  -- when the source author later changes their profile or withdraws the work.
  source_attribution jsonb,
  pre_publish_lifecycle_status text NOT NULL CHECK (
    pre_publish_lifecycle_status IN ('editable', 'exported')
  ),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  moderation_status text NOT NULL DEFAULT 'published' CHECK (moderation_status IN (
    'pending_review', 'published', 'withdrawn', 'hidden', 'rejected', 'removed'
  )),
  moderation_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  CHECK ((background_mode = 'solid') = (background_color IS NOT NULL)),
  CHECK (background_color IS NULL OR background_color ~ '^#[0-9A-F]{6}$'),
  CHECK (source_publication_id IS NULL OR source_publication_id <> id),
  CHECK (
    (allow_copy AND reuse_policy <> 'all-rights-reserved')
    OR (NOT allow_copy AND reuse_policy = 'all-rights-reserved')
  ),
  CHECK ((moderation_status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK (community_cells_use_palette(palette_snapshot, cells)),
  CHECK (community_cells_use_palette(palette_snapshot, thumbnail_cells)),
  CHECK (community_grid_stats_match(cells, color_count, bead_count)),
  CHECK (
    (source_publication_id IS NULL AND source_attribution IS NULL)
    OR COALESCE((
      source_publication_id IS NOT NULL
      AND jsonb_typeof(source_attribution) = 'object'
      AND source_attribution ->> 'publicationId' = source_publication_id::text
      AND jsonb_typeof(source_attribution -> 'title') = 'string'
      AND char_length(source_attribution ->> 'title') BETWEEN 1 AND 100
      AND jsonb_typeof(source_attribution -> 'author') = 'object'
      AND jsonb_typeof(source_attribution -> 'author' -> 'id') = 'string'
      AND jsonb_typeof(source_attribution -> 'author' -> 'displayName') = 'string'
      AND char_length(source_attribution -> 'author' ->> 'displayName') BETWEEN 1 AND 80
      AND jsonb_typeof(source_attribution -> 'copyrightStatement') = 'string'
      AND char_length(source_attribution ->> 'copyrightStatement') BETWEEN 1 AND 500
      AND source_attribution ->> 'reusePolicy' IN (
        'all-rights-reserved', 'attribution', 'attribution-share-alike', 'public-domain'
      )
    ), false)
  )
);

CREATE UNIQUE INDEX community_publications_active_project_idx
  ON community_publications(project_id)
  WHERE project_id IS NOT NULL AND moderation_status IN ('pending_review', 'published', 'hidden');
CREATE INDEX community_publications_latest_idx
  ON community_publications(published_at DESC, id DESC)
  WHERE moderation_status = 'published';
CREATE INDEX community_publications_category_latest_idx
  ON community_publications(category, published_at DESC, id DESC)
  WHERE moderation_status = 'published';
CREATE INDEX community_publications_tags_gin_idx
  ON community_publications USING gin(tags)
  WHERE moderation_status = 'published';
CREATE INDEX community_publications_author_latest_idx
  ON community_publications(author_user_id, published_at DESC, id DESC);

CREATE FUNCTION enforce_community_publication_snapshot_immutable() RETURNS trigger AS $$
BEGIN
  -- A withdrawn project's private row is eventually retention-purged. Its FK
  -- may then null project_id, while every public snapshot field stays frozen.
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     AND NOT (
       OLD.project_id IS NOT NULL
       AND NEW.project_id IS NULL
       AND OLD.moderation_status = 'withdrawn'
     ) THEN
    RAISE EXCEPTION 'community publication project link is immutable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['project_id', 'withdrawn_at', 'moderation_status', 'moderation_updated_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['project_id', 'withdrawn_at', 'moderation_status', 'moderation_updated_at']) THEN
    RAISE EXCEPTION 'community publication snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.moderation_status IN ('withdrawn', 'rejected', 'removed')
     AND NEW.moderation_status IS DISTINCT FROM OLD.moderation_status THEN
    RAISE EXCEPTION 'withdrawn community publications cannot be republished' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_publications_snapshot_immutable
BEFORE UPDATE ON community_publications
FOR EACH ROW EXECUTE FUNCTION enforce_community_publication_snapshot_immutable();

CREATE TABLE community_publication_likes (
  publication_id uuid NOT NULL REFERENCES community_publications(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (publication_id, user_id)
);
CREATE INDEX community_publication_likes_user_created_idx
  ON community_publication_likes(user_id, created_at DESC, publication_id);

CREATE TABLE community_publication_favorites (
  publication_id uuid NOT NULL REFERENCES community_publications(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (publication_id, user_id)
);
CREATE INDEX community_publication_favorites_user_created_idx
  ON community_publication_favorites(user_id, created_at DESC, publication_id);

CREATE TABLE community_author_follows (
  follower_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (follower_user_id, author_user_id),
  CHECK (follower_user_id <> author_user_id)
);
CREATE INDEX community_author_follows_author_idx
  ON community_author_follows(author_user_id, created_at DESC, follower_user_id);

CREATE TABLE community_publication_reports (
  id uuid PRIMARY KEY,
  publication_id uuid NOT NULL REFERENCES community_publications(id) ON DELETE RESTRICT,
  -- Reports are retained evidence; deleting an account must not cascade them.
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (reason IN ('copyright', 'privacy', 'illegal', 'spam', 'other')),
  details text CHECK (details IS NULL OR char_length(details) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX community_publication_reports_open_reporter_idx
  ON community_publication_reports(publication_id, reporter_user_id)
  WHERE status IN ('pending', 'reviewing');
CREATE INDEX community_publication_reports_status_created_idx
  ON community_publication_reports(status, created_at, id);

-- Private project provenance: only server-side copy flow may write this row.
-- Public responses expose the source publication ID from the publication
-- snapshot, never the copier's private project ID.
CREATE TABLE community_project_sources (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  source_publication_id uuid NOT NULL REFERENCES community_publications(id) ON DELETE RESTRICT,
  copied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION reject_community_project_source_update() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM projects WHERE id = OLD.project_id
  ) THEN
    -- The only legitimate deletion is the FK cascade after the private
    -- project itself has been removed at the end of its retention window.
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'community project provenance is immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER community_project_sources_immutable
BEFORE UPDATE OR DELETE ON community_project_sources
FOR EACH ROW EXECUTE FUNCTION reject_community_project_source_update();

ALTER TABLE users
  ADD COLUMN community_role text NOT NULL DEFAULT 'member'
  CHECK (community_role IN ('member', 'moderator', 'admin'));

CREATE TABLE community_moderation_events (
  id uuid PRIMARY KEY,
  publication_id uuid NOT NULL REFERENCES community_publications(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  from_status text NOT NULL CHECK (from_status IN (
    'pending_review', 'published', 'withdrawn', 'hidden', 'rejected', 'removed'
  )),
  to_status text NOT NULL CHECK (to_status IN (
    'pending_review', 'published', 'withdrawn', 'hidden', 'rejected', 'removed'
  )),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX community_moderation_events_publication_created_idx
  ON community_moderation_events(publication_id, created_at, id);

CREATE FUNCTION reject_community_moderation_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'community moderation events are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER community_moderation_events_append_only
BEFORE UPDATE OR DELETE ON community_moderation_events
FOR EACH ROW EXECUTE FUNCTION reject_community_moderation_event_mutation();

CREATE TABLE community_report_events (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES community_publication_reports(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  from_status text NOT NULL CHECK (from_status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  to_status text NOT NULL CHECK (to_status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX community_report_events_report_created_idx
  ON community_report_events(report_id, created_at, id);

CREATE TRIGGER community_report_events_append_only
BEFORE UPDATE OR DELETE ON community_report_events
FOR EACH ROW EXECUTE FUNCTION reject_community_moderation_event_mutation();
