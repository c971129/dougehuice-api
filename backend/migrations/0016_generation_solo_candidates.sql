ALTER TABLE generation_candidates
  ADD COLUMN IF NOT EXISTS subject_slot smallint,
  ADD COLUMN IF NOT EXISTS accepted_project_id uuid,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

-- Deterministic/legacy solo jobs already emitted two ordinal candidates. Preserve
-- those completed results by assigning their stable first/second subject slots.
UPDATE generation_candidates AS candidate
SET subject_slot = candidate.ordinal
FROM generation_jobs AS job
WHERE candidate.job_id = job.id
  AND job.kind = 'couple'
  AND job.options ->> 'coupleLayout' = 'solo'
  AND candidate.subject_slot IS NULL
  AND candidate.ordinal IN (1, 2)
  AND (
    SELECT count(*) = 2
      AND min(existing.ordinal) = 1
      AND max(existing.ordinal) = 2
    FROM generation_candidates AS existing
    WHERE existing.job_id = job.id
  );

-- The old task-level pointer did not retain a project id, but it is still a
-- durable signal that this candidate was already adopted.
UPDATE generation_candidates AS candidate
SET accepted_at = COALESCE(job.updated_at, job.completed_at, job.created_at)
FROM generation_jobs AS job
WHERE job.accepted_candidate_id = candidate.id
  AND candidate.accepted_at IS NULL;

ALTER TABLE generation_candidates
  DROP CONSTRAINT IF EXISTS generation_candidates_subject_slot_valid;
ALTER TABLE generation_candidates
  ADD CONSTRAINT generation_candidates_subject_slot_valid
  CHECK (subject_slot IS NULL OR subject_slot IN (1, 2));

ALTER TABLE generation_candidates
  DROP CONSTRAINT IF EXISTS generation_candidates_accepted_project_fk;
ALTER TABLE generation_candidates
  ADD CONSTRAINT generation_candidates_accepted_project_fk
  FOREIGN KEY (accepted_project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE generation_candidates
  DROP CONSTRAINT IF EXISTS generation_candidates_acceptance_state_valid;
ALTER TABLE generation_candidates
  ADD CONSTRAINT generation_candidates_acceptance_state_valid
  CHECK (accepted_project_id IS NULL OR accepted_at IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS generation_candidates_accepted_project_unique_idx
  ON generation_candidates(accepted_project_id)
  WHERE accepted_project_id IS NOT NULL;
