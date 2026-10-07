CREATE TABLE IF NOT EXISTS inventory_items (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  palette_id text NOT NULL,
  color_code text NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  location text CHECK (location IS NULL OR char_length(location) BETWEEN 1 AND 100),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, palette_id, color_code),
  FOREIGN KEY (palette_id, color_code)
    REFERENCES palette_colors(palette_id, code) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS inventory_items_user_palette_idx
  ON inventory_items(user_id, palette_id, color_code);
