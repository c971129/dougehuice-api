ALTER TABLE generation_jobs
  ADD COLUMN IF NOT EXISTS parent_job_id uuid;

ALTER TABLE generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_parent_job_fk;
ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_parent_job_fk
  FOREIGN KEY (parent_job_id) REFERENCES generation_jobs(id) ON DELETE RESTRICT;

ALTER TABLE generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_parent_not_self_check;
ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_parent_not_self_check
  CHECK (parent_job_id IS NULL OR parent_job_id <> id);

CREATE INDEX IF NOT EXISTS generation_jobs_parent_idx
  ON generation_jobs(parent_job_id, created_at DESC)
  WHERE parent_job_id IS NOT NULL;
