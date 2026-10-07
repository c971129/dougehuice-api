-- Community is outside the first-release scope. Preserve migration history,
-- restore affected private projects, then remove the retired public subsystem.

UPDATE projects AS project
SET lifecycle_status = COALESCE((
      SELECT publication.pre_publish_lifecycle_status
      FROM community_publications AS publication
      WHERE publication.project_id = project.id
      ORDER BY publication.published_at DESC, publication.id DESC
      LIMIT 1
    ), 'exported'),
    metadata_revision = metadata_revision + 1,
    updated_at = clock_timestamp()
WHERE project.lifecycle_status = 'published';

-- Retired endpoints must not keep replayable public snapshots or consume the
-- bounded idempotency/rate-limit history of otherwise active users. The one
-- non-community prefix is the historical publish route, whose project ID was
-- normalized to the canonical lowercase UUID form before the scope was built.
-- Ordinary project mutations could also have cached a project snapshot while
-- it was published; remove only responses carrying that retired lifecycle so a
-- replay cannot contradict the authoritative restoration above. The payment
-- creation scope is a durable financial anchor and is never removed by response
-- shape, even if future or historical payloads contain similarly named fields.
DELETE FROM public.api_idempotency
WHERE scope LIKE 'community:%'
   OR scope ~ '^projects:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:publish$'
   OR (
     scope <> 'payment-orders:create'
     AND response_body #>> '{project,lifecycleStatus}' = 'published'
   );

DELETE FROM public.user_rate_limits
WHERE action IN ('community-publish', 'community-engagement', 'community-report');

DELETE FROM public.auth_rate_limits
WHERE action IN ('community-publication-list', 'community-publication-detail');

DROP TABLE IF EXISTS community_report_events CASCADE;
DROP TABLE IF EXISTS community_moderation_events CASCADE;
DROP TABLE IF EXISTS community_publication_search_keys CASCADE;
DROP TABLE IF EXISTS community_publication_likes CASCADE;
DROP TABLE IF EXISTS community_publication_favorites CASCADE;
DROP TABLE IF EXISTS community_author_follows CASCADE;
DROP TABLE IF EXISTS community_publication_reports CASCADE;
DROP TABLE IF EXISTS community_project_sources CASCADE;
DROP TABLE IF EXISTS community_publications CASCADE;

ALTER TABLE users DROP COLUMN IF EXISTS community_role;

DROP FUNCTION IF EXISTS index_community_publication_search_keys();
DROP FUNCTION IF EXISTS reset_community_publication_engagement_counter();
DROP FUNCTION IF EXISTS reject_community_publication_reaction_update();
DROP FUNCTION IF EXISTS update_community_publication_engagement_counter();
DROP FUNCTION IF EXISTS enforce_community_publication_engagement_counters();
DROP FUNCTION IF EXISTS enforce_community_publication_moderation_lineage();
DROP FUNCTION IF EXISTS community_lineage_lock(uuid);
DROP FUNCTION IF EXISTS enforce_community_publication_source_lineage();
DROP FUNCTION IF EXISTS community_source_attribution_is_valid(jsonb, uuid);
DROP FUNCTION IF EXISTS community_cells_are_codes_or_null(jsonb);
DROP FUNCTION IF EXISTS reject_community_moderation_event_mutation();
DROP FUNCTION IF EXISTS reject_community_project_source_update();
DROP FUNCTION IF EXISTS enforce_community_publication_snapshot_immutable();
DROP FUNCTION IF EXISTS enforce_community_publication_active_palette();
DROP FUNCTION IF EXISTS enforce_community_copy_source_active_palette();
DROP FUNCTION IF EXISTS community_grid_stats_match(jsonb, integer, integer);
DROP FUNCTION IF EXISTS community_cells_use_palette(jsonb, jsonb);

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_lifecycle_status_valid;
ALTER TABLE projects
  ADD CONSTRAINT projects_lifecycle_status_valid
  CHECK (lifecycle_status IN ('draft', 'generating', 'editable', 'exported'));
