-- Bring resumable creation drafts under the same 5..32 color-count contract
-- as generation jobs. Historical or rolling-deployment rows may omit the key
-- or contain a value that the public API would reject; repair those rows using
-- the selected built-in product preset, with the custom-palette default of 16.
UPDATE creation_drafts
SET options = jsonb_set(
  options,
  '{maxColors}',
  to_jsonb(CASE palette_id
    WHEN 'mard-48-v1' THEN 16
    WHEN 'mard-72-v1' THEN 16
    WHEN 'mard-144-v1' THEN 24
    WHEN 'mard-221-v1' THEN 24
    WHEN 'mard-291-v1' THEN 32
    ELSE 16
  END),
  true
)
WHERE CASE
  WHEN NOT options ? 'maxColors' THEN true
  WHEN jsonb_typeof(options -> 'maxColors') <> 'number' THEN true
  ELSE (options ->> 'maxColors')::numeric <> trunc((options ->> 'maxColors')::numeric)
    OR (options ->> 'maxColors')::numeric NOT BETWEEN 5 AND 32
END;

ALTER TABLE creation_drafts
  DROP CONSTRAINT IF EXISTS creation_drafts_options_max_colors_check,
  ADD CONSTRAINT creation_drafts_options_max_colors_check CHECK (
    CASE
      WHEN NOT options ? 'maxColors' THEN false
      WHEN jsonb_typeof(options -> 'maxColors') <> 'number' THEN false
      ELSE (options ->> 'maxColors')::numeric = trunc((options ->> 'maxColors')::numeric)
        AND (options ->> 'maxColors')::numeric BETWEEN 5 AND 32
    END
  );
