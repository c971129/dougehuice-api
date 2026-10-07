import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const beforePaths = [
  "../migrations/0001_foundation.sql",
  "../migrations/0002_private_assets.sql",
  "../migrations/0003_exports.sql",
  "../migrations/0004_payments.sql",
  "../migrations/0005_inventory.sql",
  "../migrations/0006_project_lifecycle.sql",
  "../migrations/0007_generation_worker.sql",
  "../migrations/0008_export_artifact_cleanup.sql",
  "../migrations/0009_generation_options.sql",
  "../migrations/0010_generation_redraw.sql",
  "../migrations/0011_asset_readiness.sql",
  "../migrations/0012_payment_effect_claims.sql",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));
const resourceControlsPath = fileURLToPath(new URL("../migrations/0013_resource_controls.sql", import.meta.url));

describe("resource controls migration", () => {
  it("backfills current project metrics and creates durable limiter/index state", async () => {
    const database = new PGlite();
    try {
      for (const migrationPath of beforePaths) await database.exec(await readFile(migrationPath, "utf8"));
      await database.exec(`
        INSERT INTO users(id, display_name)
        VALUES ('00000000-0000-4000-8000-000000001301', '资源迁移用户');
        INSERT INTO palettes(id, name, version) VALUES ('resource-palette', '资源色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order) VALUES
          ('resource-palette', 'R01', '红', '#FF0000', 1, 0),
          ('resource-palette', 'R02', '蓝', '#0000FF', 1, 1);
        INSERT INTO projects(id, user_id, name, palette_id, current_revision)
        VALUES (
          '00000000-0000-4000-8000-000000001302',
          '00000000-0000-4000-8000-000000001301',
          '迁移前作品', 'resource-palette', 1
        );
        INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
        VALUES (
          '00000000-0000-4000-8000-000000001302', 1,
          'palette-code-v1', 2, 2, '["R01", null, "R02", "R01"]'::jsonb
        );
      `);

      await database.exec(await readFile(resourceControlsPath, "utf8"));
      const project = await database.query<{ current_bead_count: number; current_color_count: number }>(
        `SELECT current_bead_count, current_color_count FROM projects
         WHERE id = '00000000-0000-4000-8000-000000001302'`,
      );
      assert.deepEqual(project.rows[0], { current_bead_count: 3, current_color_count: 2 });

      const limiter = await database.query<{ limiter_exists: boolean; slots_exist: boolean }>(
        `SELECT to_regclass('user_rate_limits') IS NOT NULL AS limiter_exists,
                to_regclass('payment_order_slots') IS NOT NULL AS slots_exist`,
      );
      assert.deepEqual(limiter.rows[0], { limiter_exists: true, slots_exist: true });
      const indexes = await database.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE indexname IN (
           'assets_stale_pending_idx',
           'assets_purge_expiry_idx',
           'assets_deleted_purge_idx',
           'assets_purged_history_idx',
           'generation_jobs_terminal_retention_idx',
           'export_jobs_terminal_retention_idx',
           'export_artifacts_purge_schedule_idx',
           'export_artifacts_pending_publish_idx',
           'export_artifacts_job_id_idx',
           'export_jobs_project_id_idx',
           'generation_jobs_source_asset_id_idx',
           'api_idempotency_user_created_idx',
           'payment_effect_claims_user_updated_idx',
           'payment_orders_pending_user_expiry_idx',
           'payment_order_slots_user_expiry_idx',
           'projects_deleted_retention_idx'
         )
         ORDER BY indexname`,
      );
      assert.deepEqual(indexes.rows.map((row) => row.indexname), [
        "api_idempotency_user_created_idx",
        "assets_deleted_purge_idx",
        "assets_purge_expiry_idx",
        "assets_purged_history_idx",
        "assets_stale_pending_idx",
        "export_artifacts_job_id_idx",
        "export_artifacts_pending_publish_idx",
        "export_artifacts_purge_schedule_idx",
        "export_jobs_project_id_idx",
        "export_jobs_terminal_retention_idx",
        "generation_jobs_source_asset_id_idx",
        "generation_jobs_terminal_retention_idx",
        "payment_effect_claims_user_updated_idx",
        "payment_order_slots_user_expiry_idx",
        "payment_orders_pending_user_expiry_idx",
        "projects_deleted_retention_idx",
      ]);
    } finally {
      await database.close();
    }
  });
});
