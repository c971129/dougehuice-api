-- FR-028 image preprocessing controls live inside the existing immutable
-- generation options JSON. Defaults are merged on the left so any valid
-- values written by an early compatible client win over the defaults.
UPDATE generation_jobs
SET options = '{"brightness":0,"contrast":0,"saturation":0,"dither":false}'::jsonb || options;

UPDATE creation_drafts
SET options = '{"brightness":0,"contrast":0,"saturation":0,"dither":false}'::jsonb || options;

-- Missing keys remain valid during a rolling deployment so an older process
-- can still write its legacy shape. New application code always writes the
-- canonical complete shape; present invalid values fail closed.
ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_options_preprocessing_check CHECK (
    CASE
      WHEN NOT options ? 'brightness' THEN true
      WHEN jsonb_typeof(options -> 'brightness') <> 'number' THEN false
      ELSE (options ->> 'brightness')::numeric = trunc((options ->> 'brightness')::numeric)
        AND (options ->> 'brightness')::numeric BETWEEN -100 AND 100
    END
    AND CASE
      WHEN NOT options ? 'contrast' THEN true
      WHEN jsonb_typeof(options -> 'contrast') <> 'number' THEN false
      ELSE (options ->> 'contrast')::numeric = trunc((options ->> 'contrast')::numeric)
        AND (options ->> 'contrast')::numeric BETWEEN -100 AND 100
    END
    AND CASE
      WHEN NOT options ? 'saturation' THEN true
      WHEN jsonb_typeof(options -> 'saturation') <> 'number' THEN false
      ELSE (options ->> 'saturation')::numeric = trunc((options ->> 'saturation')::numeric)
        AND (options ->> 'saturation')::numeric BETWEEN -100 AND 100
    END
    AND CASE
      WHEN NOT options ? 'dither' THEN true
      ELSE jsonb_typeof(options -> 'dither') = 'boolean'
    END
  );

ALTER TABLE creation_drafts
  ADD CONSTRAINT creation_drafts_options_preprocessing_check CHECK (
    CASE
      WHEN NOT options ? 'brightness' THEN true
      WHEN jsonb_typeof(options -> 'brightness') <> 'number' THEN false
      ELSE (options ->> 'brightness')::numeric = trunc((options ->> 'brightness')::numeric)
        AND (options ->> 'brightness')::numeric BETWEEN -100 AND 100
    END
    AND CASE
      WHEN NOT options ? 'contrast' THEN true
      WHEN jsonb_typeof(options -> 'contrast') <> 'number' THEN false
      ELSE (options ->> 'contrast')::numeric = trunc((options ->> 'contrast')::numeric)
        AND (options ->> 'contrast')::numeric BETWEEN -100 AND 100
    END
    AND CASE
      WHEN NOT options ? 'saturation' THEN true
      WHEN jsonb_typeof(options -> 'saturation') <> 'number' THEN false
      ELSE (options ->> 'saturation')::numeric = trunc((options ->> 'saturation')::numeric)
        AND (options ->> 'saturation')::numeric BETWEEN -100 AND 100
    END
    AND CASE
      WHEN NOT options ? 'dither' THEN true
      ELSE jsonb_typeof(options -> 'dither') = 'boolean'
    END
  );

-- Idempotency replays bypass the normal job mapper. Canonicalize all retained
-- generation responses that contain a job so an old successful response does
-- not lose the new defaults when replayed after the deployment.
UPDATE api_idempotency
SET response_body = jsonb_set(
  response_body,
  '{job,options}',
  '{"brightness":0,"contrast":0,"saturation":0,"dither":false}'::jsonb
    || (response_body #> '{job,options}'),
  false
)
WHERE scope LIKE 'generation-jobs:%'
  AND jsonb_typeof(response_body #> '{job,options}') = 'object';
