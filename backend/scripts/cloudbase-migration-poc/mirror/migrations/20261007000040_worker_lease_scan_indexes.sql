-- Worker lease recovery must be bounded both in rows updated and in rows read.
-- The id tie-breaker matches claim ordering so equal-expiry backlogs can use an
-- ordered partial index instead of sorting every active job.
CREATE INDEX IF NOT EXISTS generation_jobs_expired_lease_order_idx
  ON generation_jobs(lease_expires_at, id)
  WHERE status IN ('preprocessing', 'generating', 'mapping_colors', 'finalizing');

CREATE INDEX IF NOT EXISTS export_jobs_expired_lease_order_idx
  ON export_jobs(lease_expires_at, id)
  WHERE status = 'running';
