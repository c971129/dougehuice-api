-- 0051 bounded generation_jobs.options.maxColors but compared its text
-- representation, so a JSON string such as {"maxColors":"16"} could satisfy
-- the constraint and later fail the runtime JSONB deserializer. The historical
-- check also evaluated to SQL NULL for a missing key or JSON null, which a
-- PostgreSQL CHECK accepts. Runtime reads treated a missing key as 16, so keep
-- that compatibility value for both missing and null rows while normalizing
-- integer strings before enforcing the same strict JSON-number contract used
-- by creation_drafts.
UPDATE generation_jobs
SET options = jsonb_set(
  options,
  '{maxColors}',
  CASE
    WHEN jsonb_typeof(options -> 'maxColors') = 'string'
      THEN to_jsonb((options ->> 'maxColors')::integer)
    ELSE '16'::jsonb
  END,
  true
)
WHERE NOT options ? 'maxColors'
   OR jsonb_typeof(options -> 'maxColors') = 'null'
   OR (
     jsonb_typeof(options -> 'maxColors') = 'string'
     AND (options ->> 'maxColors') ~ '^[0-9]+$'
     AND (options ->> 'maxColors')::integer BETWEEN 5 AND 32
   );

ALTER TABLE generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_options_max_colors_check,
  ADD CONSTRAINT generation_jobs_options_max_colors_check CHECK (
    CASE
      WHEN NOT options ? 'maxColors' THEN false
      WHEN jsonb_typeof(options -> 'maxColors') <> 'number' THEN false
      ELSE (options ->> 'maxColors')::numeric = trunc((options ->> 'maxColors')::numeric)
        AND (options ->> 'maxColors')::numeric BETWEEN 5 AND 32
    END
  );
