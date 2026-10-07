ALTER TABLE generation_jobs
  ADD COLUMN IF NOT EXISTS options jsonb;

UPDATE generation_jobs
SET options = jsonb_build_object(
  'crop', jsonb_build_object(
    'ratio', '1:1',
    'freeRatio', 1,
    'rotation', 0,
    'scale', 1,
    'offsetX', 0,
    'offsetY', 0,
    'flipX', false,
    'flipY', false
  ),
  'removeBackground', true,
  'figureStyle', 'chibi-full',
  'coupleLayout', 'together',
  'maxColors', 12,
  'transparentBackground', false,
  'inventoryOnly', false
)
WHERE options IS NULL;

ALTER TABLE generation_jobs
  ALTER COLUMN options SET NOT NULL,
  ADD CONSTRAINT generation_jobs_options_object_check CHECK (jsonb_typeof(options) = 'object'),
  ADD CONSTRAINT generation_jobs_options_max_colors_check CHECK (
    (options ->> 'maxColors') ~ '^[0-9]+$'
    AND (options ->> 'maxColors')::integer BETWEEN 5 AND 24
  );
