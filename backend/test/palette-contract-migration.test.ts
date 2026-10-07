import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import type { Palette } from "../src/domain/models.js";
import { remapGridPalette } from "../src/domain/palette-remap.js";
import { AppError } from "../src/errors.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const ownerId = "00000000-0000-4000-8000-000000000921";
const otherId = "00000000-0000-4000-8000-000000000922";

function poolFor(database: PGlite): Pool {
  const query = (text: string, values?: unknown[]) =>
    values === undefined ? database.query(text) : database.query(text, values as never[]);
  const client = { query, release: () => undefined } as unknown as PoolClient;
  return {
    query,
    connect: async () => client,
    end: () => database.close(),
  } as unknown as Pool;
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

describe("palette contract migration", () => {
  it("backfills demo provenance and revision palettes while retaining immutability", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      const contract = migrations.find((migration) => migration.version === "0021_palette_contract.sql");
      assert.ok(contract);
      for (const migration of migrations) {
        if (migration.version === contract.version) break;
        await database.exec(migration.sql);
      }
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES ('${ownerId}', '迁移用户');
        INSERT INTO palettes(id, name, version)
        VALUES ('mard-basic-v1', '旧基础色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('mard-basic-v1', 'M01', '旧色', '#FFFFFF', 1, 0);
        INSERT INTO projects(id, user_id, name, palette_id, current_revision)
        VALUES (
          '00000000-0000-4000-8000-000000000923',
          '${ownerId}',
          '迁移作品',
          'mard-basic-v1',
          1
        );
        INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
        VALUES (
          '00000000-0000-4000-8000-000000000923',
          1,
          'palette-code-v1',
          1,
          1,
          '["M01"]'::jsonb
        );
      `);

      await database.exec(contract.sql);
      const palette = await database.query<{
        name: string;
        brand: string;
        bead_size_mm: number | string;
        verified: boolean;
        available: boolean;
      }>(`
        SELECT p.name, p.brand, p.bead_size_mm, p.verified, c.available
        FROM palettes p JOIN palette_colors c ON c.palette_id = p.id
        WHERE p.id = 'mard-basic-v1' AND c.code = 'M01'
      `);
      assert.deepEqual(
        {
          name: palette.rows[0]?.name,
          brand: palette.rows[0]?.brand,
          beadSizeMm: Number(palette.rows[0]?.bead_size_mm),
          verified: palette.rows[0]?.verified,
          available: palette.rows[0]?.available,
        },
        {
          name: "演示基础色卡（非官方数据）",
          brand: "演示数据（非 MARD 官方）",
          beadSizeMm: 5,
          verified: false,
          available: true,
        },
      );

      const revision = await database.query<{ palette_id: string }>(
        `SELECT palette_id FROM project_revisions
         WHERE project_id = '00000000-0000-4000-8000-000000000923' AND revision = 1`,
      );
      assert.equal(revision.rows[0]?.palette_id, "mard-basic-v1");
      await assert.rejects(
        database.exec(`
          UPDATE project_revisions SET width = 2
          WHERE project_id = '00000000-0000-4000-8000-000000000923' AND revision = 1
        `),
        /project revisions are immutable/i,
      );

      await database.exec(`
        INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
        VALUES (
          '00000000-0000-4000-8000-000000000923',
          2,
          'palette-code-v1',
          1,
          1,
          '["M01"]'::jsonb
        )
      `);
      const filled = await database.query<{ palette_id: string }>(
        `SELECT palette_id FROM project_revisions
         WHERE project_id = '00000000-0000-4000-8000-000000000923' AND revision = 2`,
      );
      assert.equal(filled.rows[0]?.palette_id, "mard-basic-v1");
    } finally {
      await database.close();
    }
  });

  it("keeps PostgreSQL remap revisions tenant-safe, historical and atomic", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migration of await loadMigrationFiles()) await database.exec(migration.sql);
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('${ownerId}', '换卡用户'),
          ('${otherId}', '其他用户');
        INSERT INTO palettes(id, name, brand, bead_size_mm, verified, version) VALUES
          ('source-palette', '源色卡', '测试', 5.0, false, 1),
          ('target-palette', '目标色卡', '测试', 2.6, true, 1);
        INSERT INTO palette_colors(
          palette_id, code, name, hex, unit_price_cents, sort_order, available
        ) VALUES
          ('source-palette', 'SR', '源红', '#FF0000', 1, 0, true),
          ('source-palette', 'SB', '源蓝', '#0000FF', 1, 1, true),
          ('target-palette', 'TB', '目标黑', '#000000', 2, 0, true),
          ('target-palette', 'TR', '目标红', '#FE0000', 2, 1, true),
          ('target-palette', 'TU', '禁用红', '#FF0000', 2, 2, false);
      `);
      const sourcePalette = await store.getPalette("source-palette", ownerId) as Palette;
      const targetPalette = await store.getPalette("target-palette", ownerId) as Palette;
      assert.ok(sourcePalette);
      assert.ok(targetPalette);
      assert.equal(targetPalette.beadSizeMm, 2.6);
      assert.equal(targetPalette.verified, true);
      assert.equal(targetPalette.colors.find((color) => color.code === "TU")?.available, false);

      const originalGrid = {
        encoding: "palette-code-v1" as const,
        width: 2,
        height: 2,
        cells: ["SR", "SR", "SB", null],
      };
      const project = await store.createProject(ownerId, {
        name: "Postgres 换卡",
        paletteId: sourcePalette.id,
        grid: originalGrid,
      });
      await database.query(
        "UPDATE projects SET lifecycle_status = 'exported' WHERE id = $1",
        [project.id],
      );
      const remappedGrid = remapGridPalette({
        grid: originalGrid,
        sourcePalette,
        targetPalette,
        maxColors: 1,
        availableColorCodes: null,
      });
      const remapped = await store.remapProjectPalette({
        userId: ownerId,
        projectId: project.id,
        baseRevision: 1,
        paletteId: targetPalette.id,
        grid: remappedGrid,
      });
      assert.equal(remapped.currentRevision, 2);
      assert.equal(remapped.paletteId, "target-palette");
      assert.equal(remapped.lifecycleStatus, "editable");
      assert.equal(remapped.previewAssetId, null);
      assert.deepEqual(
        new Set(remapped.grid.cells.filter((cell): cell is string => cell !== null)),
        new Set(["TR"]),
      );

      const historical = await store.getProject(ownerId, project.id, 1);
      assert.equal(historical?.paletteId, "source-palette");
      assert.deepEqual(historical?.grid, originalGrid);
      const rows = await database.query<{ revision: number; palette_id: string }>(
        `SELECT revision, palette_id FROM project_revisions
         WHERE project_id = $1 ORDER BY revision`,
        [project.id],
      );
      assert.deepEqual(rows.rows, [
        { revision: 1, palette_id: "source-palette" },
        { revision: 2, palette_id: "target-palette" },
      ]);

      await assert.rejects(
        store.remapProjectPalette({
          userId: ownerId,
          projectId: project.id,
          baseRevision: 1,
          paletteId: targetPalette.id,
          grid: remappedGrid,
        }),
        rejectsWithCode("PROJECT_REVISION_CONFLICT"),
      );
      await assert.rejects(
        store.remapProjectPalette({
          userId: otherId,
          projectId: project.id,
          baseRevision: 2,
          paletteId: targetPalette.id,
          grid: remappedGrid,
        }),
        rejectsWithCode("PROJECT_NOT_FOUND"),
      );
      assert.equal((await store.getProject(ownerId, project.id))?.currentRevision, 2);
    } finally {
      await store.close();
    }
  });
});
