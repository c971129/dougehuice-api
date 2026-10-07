ALTER TABLE palettes
  ADD COLUMN owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX palettes_owner_user_id_idx ON palettes(owner_user_id) WHERE owner_user_id IS NOT NULL;
