-- Auditable inventory mutations and explicit, exactly-once project
-- consumption. This migration depends only on the pre-0022 project,
-- revision, progress, palette, and inventory contracts.
ALTER TABLE projects
  ADD CONSTRAINT projects_id_user_unique UNIQUE (id, user_id);

CREATE TABLE inventory_operations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_type text NOT NULL
    CHECK (transaction_type IN ('calibration', 'manual_adjustment', 'project_consumption')),
  project_id uuid,
  project_revision integer,
  idempotency_reference text NOT NULL
    CHECK (char_length(idempotency_reference) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (id, user_id, project_id, project_revision),
  UNIQUE (user_id, idempotency_reference),
  FOREIGN KEY (project_id, user_id)
    REFERENCES projects(id, user_id) ON DELETE CASCADE,
  CHECK (
    (transaction_type = 'project_consumption' AND project_id IS NOT NULL AND project_revision IS NOT NULL)
    OR
    (transaction_type <> 'project_consumption' AND project_id IS NULL AND project_revision IS NULL)
  )
);

CREATE INDEX inventory_operations_user_created_idx
  ON inventory_operations(user_id, created_at DESC, id DESC);

CREATE INDEX inventory_operations_user_project_created_idx
  ON inventory_operations(user_id, project_id, project_revision, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

CREATE TABLE inventory_project_consumptions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  project_revision integer NOT NULL CHECK (project_revision > 0),
  operation_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id, project_revision),
  UNIQUE (operation_id, user_id),
  FOREIGN KEY (operation_id, user_id)
    REFERENCES inventory_operations(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, user_id, project_id, project_revision)
    REFERENCES inventory_operations(id, user_id, project_id, project_revision) ON DELETE CASCADE,
  FOREIGN KEY (project_id, user_id)
    REFERENCES projects(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, project_revision)
    REFERENCES project_revisions(project_id, revision) ON DELETE CASCADE
);

CREATE INDEX inventory_project_consumptions_project_idx
  ON inventory_project_consumptions(project_id, project_revision);

CREATE TABLE inventory_transactions (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  palette_id text NOT NULL,
  color_code text NOT NULL,
  quantity_before integer NOT NULL CHECK (quantity_before >= 0),
  delta integer NOT NULL,
  quantity_after integer NOT NULL CHECK (quantity_after >= 0),
  location_before text,
  location_after text,
  FOREIGN KEY (operation_id, user_id)
    REFERENCES inventory_operations(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (palette_id, color_code)
    REFERENCES palette_colors(palette_id, code) ON DELETE RESTRICT,
  CHECK (quantity_after::bigint = quantity_before::bigint + delta::bigint),
  CHECK (location_before IS NULL OR char_length(location_before) BETWEEN 1 AND 100),
  CHECK (location_after IS NULL OR char_length(location_after) BETWEEN 1 AND 100),
  UNIQUE (operation_id, palette_id, color_code)
);

CREATE INDEX inventory_transactions_user_operation_idx
  ON inventory_transactions(user_id, operation_id);

CREATE INDEX inventory_transactions_user_palette_idx
  ON inventory_transactions(user_id, palette_id, color_code);
