-- Keep PostgreSQL's durable grid contract aligned with the runtime/OpenAPI
-- infrastructure guard. Existing rows already satisfy these wider checks.
ALTER TABLE project_revisions
  DROP CONSTRAINT IF EXISTS project_revisions_width_check,
  DROP CONSTRAINT IF EXISTS project_revisions_height_check,
  ADD CONSTRAINT project_revisions_width_check CHECK (width BETWEEN 1 AND 4096),
  ADD CONSTRAINT project_revisions_height_check CHECK (height BETWEEN 1 AND 4096);

ALTER TABLE generation_candidates
  DROP CONSTRAINT IF EXISTS generation_candidates_width_check,
  DROP CONSTRAINT IF EXISTS generation_candidates_height_check,
  ADD CONSTRAINT generation_candidates_width_check CHECK (width BETWEEN 1 AND 4096),
  ADD CONSTRAINT generation_candidates_height_check CHECK (height BETWEEN 1 AND 4096);

ALTER TABLE project_drafts
  DROP CONSTRAINT IF EXISTS project_drafts_width_check,
  DROP CONSTRAINT IF EXISTS project_drafts_height_check,
  ADD CONSTRAINT project_drafts_width_check CHECK (width BETWEEN 1 AND 4096),
  ADD CONSTRAINT project_drafts_height_check CHECK (height BETWEEN 1 AND 4096);

ALTER TABLE creation_drafts
  DROP CONSTRAINT IF EXISTS creation_drafts_width_check,
  DROP CONSTRAINT IF EXISTS creation_drafts_height_check,
  ADD CONSTRAINT creation_drafts_width_check CHECK (width BETWEEN 1 AND 4096),
  ADD CONSTRAINT creation_drafts_height_check CHECK (height BETWEEN 1 AND 4096);

ALTER TABLE community_publications
  DROP CONSTRAINT IF EXISTS community_publications_width_check,
  DROP CONSTRAINT IF EXISTS community_publications_height_check,
  ADD CONSTRAINT community_publications_width_check CHECK (width BETWEEN 1 AND 4096),
  ADD CONSTRAINT community_publications_height_check CHECK (height BETWEEN 1 AND 4096);
