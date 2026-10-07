-- 0049 aligned durable dimensions with an experimental 4096-side runtime
-- guard. Rendering and generation remain intentionally bounded at the last
-- measured production-safe contracts: projects at 200x200 and generation at
-- 64x64. Keep every durable aggregate consistent with those limits.
ALTER TABLE project_revisions
  DROP CONSTRAINT IF EXISTS project_revisions_width_check,
  DROP CONSTRAINT IF EXISTS project_revisions_height_check,
  ADD CONSTRAINT project_revisions_width_check CHECK (width BETWEEN 1 AND 200),
  ADD CONSTRAINT project_revisions_height_check CHECK (height BETWEEN 1 AND 200);

ALTER TABLE generation_candidates
  DROP CONSTRAINT IF EXISTS generation_candidates_width_check,
  DROP CONSTRAINT IF EXISTS generation_candidates_height_check,
  ADD CONSTRAINT generation_candidates_width_check CHECK (width BETWEEN 1 AND 200),
  ADD CONSTRAINT generation_candidates_height_check CHECK (height BETWEEN 1 AND 200);

ALTER TABLE project_drafts
  DROP CONSTRAINT IF EXISTS project_drafts_width_check,
  DROP CONSTRAINT IF EXISTS project_drafts_height_check,
  ADD CONSTRAINT project_drafts_width_check CHECK (width BETWEEN 1 AND 200),
  ADD CONSTRAINT project_drafts_height_check CHECK (height BETWEEN 1 AND 200);

ALTER TABLE creation_drafts
  DROP CONSTRAINT IF EXISTS creation_drafts_width_check,
  DROP CONSTRAINT IF EXISTS creation_drafts_height_check,
  ADD CONSTRAINT creation_drafts_width_check CHECK (width BETWEEN 1 AND 200),
  ADD CONSTRAINT creation_drafts_height_check CHECK (height BETWEEN 1 AND 200);

ALTER TABLE community_publications
  DROP CONSTRAINT IF EXISTS community_publications_width_check,
  DROP CONSTRAINT IF EXISTS community_publications_height_check,
  ADD CONSTRAINT community_publications_width_check CHECK (width BETWEEN 1 AND 200),
  ADD CONSTRAINT community_publications_height_check CHECK (height BETWEEN 1 AND 200);

ALTER TABLE generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_size_check,
  ADD CONSTRAINT generation_jobs_size_check CHECK (
    width BETWEEN 8 AND 64 AND height BETWEEN 8 AND 64
  );

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_current_bead_count_valid,
  DROP CONSTRAINT IF EXISTS projects_current_color_count_valid,
  ADD CONSTRAINT projects_current_bead_count_valid
    CHECK (current_bead_count BETWEEN 0 AND 40000),
  ADD CONSTRAINT projects_current_color_count_valid
    CHECK (current_color_count BETWEEN 0 AND 40000);
