import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { loadMigrationFiles } from "../src/migrate.js";

const ownerId = "00000000-0000-4000-8000-000000003601";
const otherId = "00000000-0000-4000-8000-000000003602";
const purgedProjectId = "00000000-0000-4000-8000-000000003603";
const activeProjectId = "00000000-0000-4000-8000-000000003604";
const operationId = "00000000-0000-4000-8000-000000003605";

describe("0036 inventory audit preservation migration", () => {
  it("retains audit facts after project purge while validating new references at write time", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      const migration0036 = migrations.find(
        (migration) => migration.version === "0036_inventory_audit_preservation.sql",
      );
      assert.ok(migration0036);
      for (const migration of migrations) {
        if (migration.version === migration0036.version) break;
        await database.exec(migration.sql);
      }

      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('${ownerId}', '库存审计拥有者'),
          ('${otherId}', '库存审计其他用户');
        INSERT INTO palettes(id, name, version, brand, bead_size_mm, verified)
        VALUES ('inventory-audit-palette', '库存审计色卡', 1, '测试', 5, true);
        INSERT INTO palette_colors(
          palette_id, code, name, hex, unit_price_cents, sort_order, available
        ) VALUES ('inventory-audit-palette', 'A01', '审计色', '#FFFFFF', 1, 0, true);
        INSERT INTO projects(id, user_id, name, palette_id, current_revision)
        VALUES (
          '${purgedProjectId}', '${ownerId}', '随后清除的私密项目',
          'inventory-audit-palette', 1
        );
        INSERT INTO project_revisions(
          project_id, revision, encoding, width, height, cells, palette_id
        ) VALUES (
          '${purgedProjectId}', 1, 'palette-code-v1', 1, 1,
          '["A01"]'::jsonb, 'inventory-audit-palette'
        );
        INSERT INTO inventory_operations(
          id, user_id, transaction_type, project_id, project_revision,
          idempotency_reference, created_at
        ) VALUES (
          '${operationId}', '${ownerId}', 'project_consumption',
          '${purgedProjectId}', 1, 'audit:consume:once',
          '2026-10-05T01:00:00.000Z'
        );
        INSERT INTO inventory_project_consumptions(
          user_id, project_id, project_revision, operation_id, consumed_at
        ) VALUES (
          '${ownerId}', '${purgedProjectId}', 1, '${operationId}',
          '2026-10-05T01:00:00.000Z'
        );
        INSERT INTO inventory_transactions(
          id, operation_id, user_id, palette_id, color_code,
          quantity_before, delta, quantity_after, location_before, location_after
        ) VALUES (
          '00000000-0000-4000-8000-000000003606', '${operationId}', '${ownerId}',
          'inventory-audit-palette', 'A01', 2, -1, 1, '盒一', '盒一'
        );
      `);

      await database.exec(migration0036.sql);

      const functionConfig = await database.query<{ proconfig: string[] | null }>(`
        SELECT proconfig
        FROM pg_proc
        WHERE proname = 'validate_inventory_operation_project_reference'
      `);
      assert.ok(functionConfig.rows[0]?.proconfig?.includes("search_path=pg_catalog, public"));

      const projectForeignKeys = await database.query<{ conname: string }>(`
        SELECT conname
        FROM pg_constraint
        WHERE conname IN (
          'inventory_operations_project_id_user_id_fkey',
          'inventory_project_consumptions_project_id_user_id_fkey',
          'inventory_project_consumptions_project_id_project_revision_fkey'
        )
      `);
      assert.deepEqual(projectForeignKeys.rows, []);

      await database.query("DELETE FROM projects WHERE id = $1", [purgedProjectId]);
      const retained = await database.query<{
        project_count: number;
        revision_count: number;
        operation_count: number;
        marker_count: number;
        transaction_count: number;
        reference_count: number;
      }>(`
        SELECT
          (SELECT count(*)::integer FROM projects WHERE id = '${purgedProjectId}') AS project_count,
          (SELECT count(*)::integer FROM project_revisions WHERE project_id = '${purgedProjectId}') AS revision_count,
          (SELECT count(*)::integer FROM inventory_operations WHERE id = '${operationId}') AS operation_count,
          (SELECT count(*)::integer FROM inventory_project_consumptions WHERE operation_id = '${operationId}') AS marker_count,
          (SELECT count(*)::integer FROM inventory_transactions WHERE operation_id = '${operationId}') AS transaction_count,
          (SELECT count(*)::integer FROM inventory_operations
             WHERE user_id = '${ownerId}' AND idempotency_reference = 'audit:consume:once') AS reference_count
      `);
      assert.deepEqual(retained.rows[0], {
        project_count: 0,
        revision_count: 0,
        operation_count: 1,
        marker_count: 1,
        transaction_count: 1,
        reference_count: 1,
      });

      await database.exec(`
        INSERT INTO projects(id, user_id, name, palette_id, current_revision)
        VALUES (
          '${activeProjectId}', '${ownerId}', '仍存在的项目',
          'inventory-audit-palette', 1
        );
        INSERT INTO project_revisions(
          project_id, revision, encoding, width, height, cells, palette_id
        ) VALUES (
          '${activeProjectId}', 1, 'palette-code-v1', 1, 1,
          '["A01"]'::jsonb, 'inventory-audit-palette'
        );
      `);

      await assert.rejects(
        database.query(
          `INSERT INTO inventory_operations(
             id, user_id, transaction_type, project_id, project_revision, idempotency_reference
           ) VALUES ($1, $2, 'project_consumption', $3, 1, 'audit:forged-owner')`,
          ["00000000-0000-4000-8000-000000003607", otherId, activeProjectId],
        ),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "23503");
          return true;
        },
      );
      await assert.rejects(
        database.query(
          `INSERT INTO inventory_operations(
             id, user_id, transaction_type, project_id, project_revision, idempotency_reference
           ) VALUES ($1, $2, 'project_consumption', $3, 2, 'audit:missing-revision')`,
          ["00000000-0000-4000-8000-000000003608", ownerId, activeProjectId],
        ),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "23503");
          return true;
        },
      );

      await database.query("DELETE FROM users WHERE id = $1", [ownerId]);
      const erasedWithUser = await database.query<{
        operation_count: number;
        marker_count: number;
        transaction_count: number;
      }>(`
        SELECT
          (SELECT count(*)::integer FROM inventory_operations WHERE user_id = '${ownerId}') AS operation_count,
          (SELECT count(*)::integer FROM inventory_project_consumptions WHERE user_id = '${ownerId}') AS marker_count,
          (SELECT count(*)::integer FROM inventory_transactions WHERE user_id = '${ownerId}') AS transaction_count
      `);
      assert.deepEqual(erasedWithUser.rows[0], {
        operation_count: 0,
        marker_count: 0,
        transaction_count: 0,
      });
    } finally {
      await database.close();
    }
  });
});
