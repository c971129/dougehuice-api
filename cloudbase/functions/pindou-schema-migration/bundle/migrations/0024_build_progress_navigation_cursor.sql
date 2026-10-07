-- Persist the active target inside the same optimistic-lock row as build
-- completion, mode, and elapsed time. Existing clients omit this field, so
-- legacy rows and first saves intentionally start with no cursor.
ALTER TABLE build_progress
  ADD COLUMN navigation_cursor jsonb;

ALTER TABLE build_progress
  ADD CONSTRAINT build_progress_navigation_cursor_shape_valid CHECK (
    navigation_cursor IS NULL
    OR (
      jsonb_typeof(navigation_cursor) = 'object'
      AND CASE navigation_cursor ->> 'kind'
        WHEN 'color' THEN
          jsonb_typeof(navigation_cursor -> 'kind') = 'string'
          AND navigation_cursor - 'kind' - 'colorCode' = '{}'::jsonb
          AND navigation_cursor ? 'colorCode'
          AND jsonb_typeof(navigation_cursor -> 'colorCode') = 'string'
          AND char_length(navigation_cursor ->> 'colorCode') BETWEEN 1 AND 80
        WHEN 'region' THEN
          jsonb_typeof(navigation_cursor -> 'kind') = 'string'
          AND navigation_cursor - 'kind' - 'regionIndex' = '{}'::jsonb
          AND navigation_cursor ? 'regionIndex'
          AND jsonb_typeof(navigation_cursor -> 'regionIndex') = 'number'
          AND (navigation_cursor ->> 'regionIndex') ~ '^[0-3]$'
        WHEN 'row-column' THEN
          jsonb_typeof(navigation_cursor -> 'kind') = 'string'
          AND navigation_cursor - 'kind' - 'axis' - 'index' = '{}'::jsonb
          AND navigation_cursor ? 'axis'
          AND navigation_cursor ? 'index'
          AND jsonb_typeof(navigation_cursor -> 'axis') = 'string'
          AND navigation_cursor ->> 'axis' IN ('row', 'column')
          AND jsonb_typeof(navigation_cursor -> 'index') = 'number'
          AND CASE
            WHEN (navigation_cursor ->> 'index') ~ '^(0|[1-9][0-9]{0,9})$'
              THEN (navigation_cursor ->> 'index')::bigint <= 2147483647
            ELSE false
          END
        ELSE false
      END
    )
  ),
  ADD CONSTRAINT build_progress_navigation_cursor_mode_valid CHECK (
    navigation_cursor IS NULL
    OR navigation_cursor ->> 'kind' = mode
  );
