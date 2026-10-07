-- Keep generation_candidates as the backwards-compatible flat output list,
-- while making each row's owning plan and semantic output position explicit.
ALTER TABLE generation_candidates
  ADD COLUMN variant_ordinal integer,
  ADD COLUMN output_slot text;

-- Legacy couple/solo jobs already stored subject 1 + subject 2 as two rows of
-- one logical plan. Every other historical row represented one combined plan.
UPDATE generation_candidates AS candidate
SET variant_ordinal = CASE
      WHEN job.kind = 'couple'
        AND job.options ->> 'coupleLayout' = 'solo'
        AND candidate.subject_slot IN (1, 2)
      THEN 1
      ELSE candidate.ordinal
    END,
    output_slot = CASE candidate.subject_slot
      WHEN 1 THEN 'subject-1'
      WHEN 2 THEN 'subject-2'
      ELSE 'combined'
    END
FROM generation_jobs AS job
WHERE job.id = candidate.job_id;

ALTER TABLE generation_candidates
  ALTER COLUMN variant_ordinal SET NOT NULL,
  ALTER COLUMN output_slot SET NOT NULL,
  ADD CONSTRAINT generation_candidates_variant_ordinal_valid
    CHECK (variant_ordinal > 0),
  ADD CONSTRAINT generation_candidates_output_slot_valid
    CHECK (output_slot IN ('combined', 'left', 'right', 'subject-1', 'subject-2')),
  ADD CONSTRAINT generation_candidates_output_subject_valid
    CHECK (
      (output_slot = 'subject-1' AND subject_slot = 1)
      OR (output_slot = 'subject-2' AND subject_slot = 2)
      OR (output_slot IN ('combined', 'left', 'right') AND subject_slot IS NULL)
    );

CREATE UNIQUE INDEX generation_candidates_variant_output_unique_idx
  ON generation_candidates(job_id, variant_ordinal, output_slot);

CREATE INDEX generation_candidates_job_variant_idx
  ON generation_candidates(job_id, variant_ordinal, ordinal);
