-- The composite order indexes from 0040 strictly cover these single-column
-- indexes. Removing the older alternatives prevents PostgreSQL from choosing
-- an incremental-sort plan for equal-expiry backlogs.
DROP INDEX IF EXISTS generation_jobs_expired_lease_idx;
DROP INDEX IF EXISTS export_jobs_expired_lease_idx;
