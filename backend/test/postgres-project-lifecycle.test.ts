import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { AppError } from "../src/errors.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const migrationPaths = [
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
  "../migrations/0013_resource_controls.sql",
  "../migrations/0014_wechat_identity_and_payment_notifications.sql",
  "../migrations/0015_project_drafts.sql",
  "../migrations/0016_generation_solo_candidates.sql",
  "../migrations/0017_creation_drafts.sql",
  "../migrations/0018_build_progress_metadata.sql",
  "../migrations/0019_project_metadata.sql",
  "../migrations/0020_project_metadata_revision.sql",
  "../migrations/0021_palette_contract.sql",
  "../migrations/0022_generation_variants.sql",
  "../migrations/0023_inventory_transactions.sql",
  "../migrations/0024_build_progress_navigation_cursor.sql",
  "../migrations/0028_custom_palettes.sql",
  "../migrations/0035_project_library.sql",
  "../migrations/0051_mard_palette_catalog.sql",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

const userId = "00000000-0000-4000-8000-000000000301";

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

describe("PostgresStore project soft deletion", () => {
  it("writes palette migration evidence atomically with the remapped revision", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES ('${userId}', '色卡迁移审计用户');
        INSERT INTO palettes(id, name, version) VALUES ('legacy-test-palette', '旧测试色卡', 1);
        INSERT INTO palettes(id, name, version) VALUES ('target-test-palette', '新测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('legacy-test-palette', 'OLD', '旧色', '#A868A0', 1, 0);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('target-test-palette', 'NEW', '新色', '#9F7494', 1, 0);
      `);
      const project = await store.createProject(userId, {
        name: "待审计换卡",
        paletteId: "legacy-test-palette",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["OLD"] },
      });
      const remapped = await store.remapProjectPalette({
        userId,
        projectId: project.id,
        baseRevision: project.currentRevision,
        paletteId: "target-test-palette",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["NEW"] },
        migrationAudit: [{
          entityType: "project_revision",
          entityId: `${project.id}:2`,
          oldPaletteId: "legacy-test-palette",
          oldColorCode: "OLD",
          oldHex: "#A868A0",
          newPaletteId: "target-test-palette",
          newColorCode: "NEW",
          newHex: "#9F7494",
          deltaE2000: 6.42,
          reliable: false,
          migrationVersion: "test-migration@1",
        }],
      });
      assert.equal(remapped.currentRevision, 2);
      const evidence = await database.query<{
        entity_type: string;
        entity_id: string;
        old_color_code: string;
        new_color_code: string;
        delta_e_2000: string;
        reliable: boolean;
        migration_version: string;
      }>(
        `SELECT entity_type, entity_id, old_color_code, new_color_code,
                delta_e_2000::text, reliable, migration_version
         FROM palette_color_migration_audit`,
      );
      assert.deepEqual(evidence.rows, [{
        entity_type: "project_revision",
        entity_id: `${project.id}:2`,
        old_color_code: "OLD",
        new_color_code: "NEW",
        delta_e_2000: "6.4200",
        reliable: false,
        migration_version: "test-migration@1",
      }]);
    } finally {
      await store.close();
    }
  });

  it("backfills legacy build rows and constrains the complete progress metadata contract", async () => {
    const database = new PGlite();
    try {
      const buildProgressMigrationIndex = migrationPaths.findIndex((migrationPath) =>
        migrationPath.endsWith("0018_build_progress_metadata.sql"));
      assert.notEqual(buildProgressMigrationIndex, -1);
      for (const migrationPath of migrationPaths.slice(0, buildProgressMigrationIndex)) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES ('${userId}', '旧制作进度用户');
        INSERT INTO palettes(id, name, version) VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('test-palette', 'T01', '测试色', '#FFFFFF', 1, 0);
        INSERT INTO projects(id, user_id, name, palette_id, current_revision)
        VALUES (
          '00000000-0000-4000-8000-000000000302',
          '${userId}',
          '旧制作进度',
          'test-palette',
          1
        );
        INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
        VALUES (
          '00000000-0000-4000-8000-000000000302',
          1,
          'palette-code-v1',
          2,
          2,
          '["T01", null, "T01", null]'::jsonb
        );
        INSERT INTO build_progress(
          project_id, project_revision, progress_revision, completed_indices, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-000000000302',
          1,
          1,
          ARRAY[0, 2],
          '2026-01-02T03:04:05.000Z'
        );
      `);
      await database.exec(await readFile(migrationPaths[buildProgressMigrationIndex]!, "utf8"));

      const result = await database.query<{
        mode: string;
        elapsed_time: number;
        started_at: string | Date;
        completed_at: string | Date | null;
      }>(
        `SELECT mode, elapsed_time, started_at, completed_at
         FROM build_progress
         WHERE project_id = '00000000-0000-4000-8000-000000000302'`,
      );
      const row = result.rows[0];
      assert.equal(row?.mode, "color");
      assert.equal(row?.elapsed_time, 0);
      assert.equal(new Date(row!.started_at).toISOString(), "2026-01-02T03:04:05.000Z");
      assert.equal(new Date(row!.completed_at!).toISOString(), "2026-01-02T03:04:05.000Z");

      await assert.rejects(
        database.exec(`
          UPDATE build_progress SET mode = 'diagonal'
          WHERE project_id = '00000000-0000-4000-8000-000000000302'
        `),
        /build_progress_mode_valid|check constraint/i,
      );
      await assert.rejects(
        database.exec(`
          UPDATE build_progress SET elapsed_time = -1
          WHERE project_id = '00000000-0000-4000-8000-000000000302'
        `),
        /build_progress_elapsed_time_valid|check constraint/i,
      );
    } finally {
      await database.close();
    }
  });

  it("retains revision rows while hiding a deleted project from every store read", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES ('${userId}', '软删除用户');
        INSERT INTO palettes(id, name, version) VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('test-palette', 'T01', '测试色', '#FFFFFF', 1, 0);
      `);
      const project = await store.createProject(userId, {
        name: "待删除作品",
        paletteId: "test-palette",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["T01"] },
      });
      const listed = await store.listProjects({ userId, limit: 20, offset: 0 });
      assert.equal(listed.length, 1);
      assert.deepEqual(
        {
          width: listed[0]?.width,
          height: listed[0]?.height,
          colorCount: listed[0]?.colorCount,
          beadCount: listed[0]?.beadCount,
          completedBeadCount: listed[0]?.completedBeadCount,
          status: listed[0]?.status,
        },
        { width: 1, height: 1, colorCount: 1, beadCount: 1, completedBeadCount: 0, status: "draft" },
      );
      assert.equal(await store.deleteProject(userId, project.id), true);
      assert.equal(await store.deleteProject(userId, project.id), false);
      assert.deepEqual(await store.listProjects({ userId, limit: 20, offset: 0 }), []);
      assert.equal(await store.getProject(userId, project.id), null);
      assert.equal(await store.getBuildProgress(userId, project.id), null);

      const rows = await database.query<{ deleted_at: string | Date | null; revisions: number }>(
        `SELECT p.deleted_at, COUNT(r.*)::integer AS revisions
         FROM projects p JOIN project_revisions r ON r.project_id = p.id
         WHERE p.id = $1 GROUP BY p.deleted_at`,
        [project.id],
      );
      assert.ok(rows.rows[0]?.deleted_at);
      assert.equal(rows.rows[0]?.revisions, 1);
    } finally {
      await store.close();
    }
  });

  it("rejects marking transparent grid cells as completed", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES ('${userId}', '进度校验用户');
        INSERT INTO palettes(id, name, version) VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('test-palette', 'T01', '测试色', '#FFFFFF', 1, 0);
      `);
      const project = await store.createProject(userId, {
        name: "含空白格作品",
        paletteId: "test-palette",
        grid: { encoding: "palette-code-v1", width: 2, height: 2, cells: ["T01", null, "T01", null] },
      });
      await assert.rejects(
        store.saveBuildProgress({
          userId,
          projectId: project.id,
          projectRevision: 1,
          baseProgressRevision: 0,
          completedIndices: [0, 1],
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "INVALID_COMPLETED_INDICES");
          return true;
        },
      );
      const saved = await store.saveBuildProgress({
        userId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 0,
        completedIndices: [2, 0, 2],
      });
      assert.deepEqual(saved.completedIndices, [0, 2]);
      assert.equal(saved.mode, "color");
      assert.equal(saved.elapsedTime, 0);
      assert.ok(saved.startedAt);
      assert.ok(saved.completedAt);

      const reopened = await store.saveBuildProgress({
        userId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 1,
        mode: "region",
        completedIndices: [0],
        elapsedTime: 45,
      });
      assert.equal(reopened.mode, "region");
      assert.equal(reopened.elapsedTime, 45);
      assert.equal(reopened.startedAt, saved.startedAt);
      assert.equal(reopened.completedAt, null);

      await assert.rejects(
        store.saveBuildProgress({
          userId,
          projectId: project.id,
          projectRevision: 1,
          baseProgressRevision: 2,
          completedIndices: [0],
          elapsedTime: 44,
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "BUILD_PROGRESS_ELAPSED_TIME_REGRESSION");
          return true;
        },
      );
    } finally {
      await store.close();
    }
  });

  it("round-trips and validates build navigation cursors in the progress transaction", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES ('${userId}', '导航游标用户');
        INSERT INTO palettes(id, name, version) VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES
          ('test-palette', 'T01', '测试一', '#FFFFFF', 1, 0),
          ('test-palette', 'T02', '测试二', '#000000', 1, 1),
          ('test-palette', 'T03', '未使用色', '#FF0000', 1, 2);
      `);
      const project = await store.createProject(userId, {
        name: "可恢复制作导航",
        paletteId: "test-palette",
        grid: {
          encoding: "palette-code-v1",
          width: 3,
          height: 2,
          cells: ["T01", "T02", "T01", "T02", null, "T02"],
        },
      });

      assert.equal((await store.getBuildProgress(userId, project.id))?.navigationCursor, null);
      const color = await store.saveBuildProgress({
        userId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 0,
        mode: "color",
        navigationCursor: { kind: "color", colorCode: "T01" },
        completedIndices: [0],
        elapsedTime: 10,
      });
      assert.deepEqual(color.navigationCursor, { kind: "color", colorCode: "T01" });
      assert.deepEqual(
        (await store.getBuildProgress(userId, project.id))?.navigationCursor,
        { kind: "color", colorCode: "T01" },
      );

      const legacyOmission = await store.saveBuildProgress({
        userId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 1,
        completedIndices: [0, 2],
        elapsedTime: 20,
      });
      assert.deepEqual(legacyOmission.navigationCursor, { kind: "color", colorCode: "T01" });

      const switched = await store.saveBuildProgress({
        userId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 2,
        mode: "region",
        completedIndices: [0, 2],
        elapsedTime: 30,
      });
      assert.equal(switched.navigationCursor, null);

      const region = await store.saveBuildProgress({
        userId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 3,
        mode: "region",
        navigationCursor: { kind: "region", regionIndex: 3 },
        completedIndices: [0, 2],
        elapsedTime: 40,
      });
      assert.deepEqual(region.navigationCursor, { kind: "region", regionIndex: 3 });
      assert.deepEqual(
        (await store.getBuildProgress(userId, project.id))?.navigationCursor,
        { kind: "region", regionIndex: 3 },
      );

      const cleared = await store.saveBuildProgress({
        userId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 4,
        navigationCursor: null,
        completedIndices: [0, 2],
        elapsedTime: 50,
      });
      assert.equal(cleared.navigationCursor, null);

      const rowColumn = await store.saveBuildProgress({
        userId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 5,
        mode: "row-column",
        navigationCursor: { kind: "row-column", axis: "row", index: 0 },
        completedIndices: [0, 2],
        elapsedTime: 60,
      });
      assert.deepEqual(rowColumn.navigationCursor, { kind: "row-column", axis: "row", index: 0 });
      assert.deepEqual(
        (await store.getBuildProgress(userId, project.id))?.navigationCursor,
        { kind: "row-column", axis: "row", index: 0 },
      );

      await assert.rejects(
        store.saveBuildProgress({
          userId,
          projectId: project.id,
          projectRevision: 1,
          baseProgressRevision: 6,
          mode: "color",
          navigationCursor: { kind: "color", colorCode: "T03" },
          completedIndices: [0, 2],
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "BUILD_NAVIGATION_COLOR_NOT_FOUND");
          return true;
        },
      );
      await assert.rejects(
        store.saveBuildProgress({
          userId,
          projectId: project.id,
          projectRevision: 1,
          baseProgressRevision: 6,
          mode: "region",
          navigationCursor: { kind: "region", regionIndex: 4 },
          completedIndices: [0, 2],
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "BUILD_NAVIGATION_CURSOR_OUT_OF_RANGE");
          return true;
        },
      );
      await assert.rejects(
        store.saveBuildProgress({
          userId,
          projectId: project.id,
          projectRevision: 1,
          baseProgressRevision: 6,
          mode: "row-column",
          navigationCursor: { kind: "row-column", axis: "column", index: 3 },
          completedIndices: [0, 2],
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "BUILD_NAVIGATION_CURSOR_OUT_OF_RANGE");
          return true;
        },
      );
      await assert.rejects(
        store.saveBuildProgress({
          userId,
          projectId: project.id,
          projectRevision: 1,
          baseProgressRevision: 6,
          mode: "color",
          navigationCursor: { kind: "region", regionIndex: 0 },
          completedIndices: [0, 2],
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "BUILD_NAVIGATION_CURSOR_MODE_MISMATCH");
          return true;
        },
      );
      await assert.rejects(
        store.saveBuildProgress({
          userId,
          projectId: project.id,
          projectRevision: 1,
          baseProgressRevision: 5,
          completedIndices: [0, 2],
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "BUILD_PROGRESS_REVISION_CONFLICT");
          return true;
        },
      );

      const completedTargetAndAdvanced = await store.saveBuildProgress({
        userId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 6,
        mode: "row-column",
        navigationCursor: { kind: "row-column", axis: "row", index: 1 },
        completedIndices: [0, 1, 2],
        elapsedTime: 70,
      });
      assert.deepEqual(completedTargetAndAdvanced.completedIndices, [0, 1, 2]);
      assert.deepEqual(
        completedTargetAndAdvanced.navigationCursor,
        { kind: "row-column", axis: "row", index: 1 },
      );

      await assert.rejects(
        database.exec(`
          UPDATE build_progress
          SET navigation_cursor = '{"kind":"region","regionIndex":0}'::jsonb
          WHERE project_id = '${project.id}'
        `),
        /build_progress_navigation_cursor_mode_valid|check constraint/i,
      );
      await assert.rejects(
        database.exec(`
          UPDATE build_progress
          SET navigation_cursor = '{"kind":"row-column","axis":"row","index":1,"extra":true}'::jsonb
          WHERE project_id = '${project.id}'
        `),
        /build_progress_navigation_cursor_shape_valid|check constraint/i,
      );
    } finally {
      await store.close();
    }
  });

  it("treats an empty persisted build as started and touches project recency", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES ('${userId}', '空进度用户');
        INSERT INTO palettes(id, name, version) VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('test-palette', 'T01', '测试色', '#FFFFFF', 1, 0);
      `);
      const project = await store.createProject(userId, {
        name: "进入制作但未放豆",
        paletteId: "test-palette",
        grid: { encoding: "palette-code-v1", width: 2, height: 1, cells: ["T01", "T01"] },
      });
      await database.query(
        "UPDATE projects SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = $1",
        [project.id],
      );

      const progress = await store.saveBuildProgress({
        userId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 0,
        completedIndices: [],
      });
      const listed = await store.listProjects({ userId, limit: 10, offset: 0 });
      assert.equal(listed[0]?.status, "in_progress");
      assert.equal(listed[0]?.completedBeadCount, 0);
      assert.equal(listed[0]?.updatedAt, progress.updatedAt);
      assert.deepEqual(await store.getProjectStatusStats(userId), {
        total: 1,
        draft: 0,
        inProgress: 1,
        completed: 0,
      });
    } finally {
      await store.close();
    }
  });

  it("persists many working-draft saves as one row and commits one project revision", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES ('${userId}', '草稿用户');
        INSERT INTO palettes(id, name, version) VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('test-palette', 'T01', '测试色', '#FFFFFF', 1, 0);
      `);
      const project = await store.createProject(userId, {
        name: "原稿",
        paletteId: "test-palette",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["T01"] },
      });
      let draftRevision = 0;
      for (let index = 0; index < 20; index += 1) {
        const draft = await store.saveProjectDraft({
          userId,
          projectId: project.id,
          baseProjectRevision: 1,
          baseDraftRevision: draftRevision,
          ...(index === 0 ? { name: "已编辑" } : {}),
          grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["T01"] },
        });
        draftRevision = draft.draftRevision;
      }
      assert.equal(draftRevision, 20);
      assert.equal((await store.getProject(userId, project.id))?.currentRevision, 1);
      assert.equal((await store.listProjects({ userId, limit: 10, offset: 0 }))[0]?.hasDraft, true);
      const draftRows = await database.query<{ count: number | string }>(
        "SELECT count(*) AS count FROM project_drafts WHERE project_id = $1",
        [project.id],
      );
      assert.equal(Number(draftRows.rows[0]?.count), 1);

      const committed = await store.commitProjectDraft({
        userId,
        projectId: project.id,
        baseProjectRevision: 1,
        draftRevision,
      });
      assert.equal(committed.currentRevision, 2);
      assert.equal(committed.name, "已编辑");
      assert.equal(await store.getProjectDraft(userId, project.id), null);
      const revisionRows = await database.query<{ count: number | string }>(
        "SELECT count(*) AS count FROM project_revisions WHERE project_id = $1",
        [project.id],
      );
      assert.equal(Number(revisionRows.rows[0]?.count), 2);
    } finally {
      await store.close();
    }
  });

  it("computes project summaries and exact status counts in SQL with bounded pages", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES ('${userId}', '汇总用户');
        INSERT INTO palettes(id, name, version) VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('test-palette', 'T01', '测试色', '#FFFFFF', 1, 0);
      `);
      const draft = await store.createProject(userId, {
        name: "未开始",
        paletteId: "test-palette",
        grid: { encoding: "palette-code-v1", width: 2, height: 1, cells: ["T01", null] },
      });
      const inProgress = await store.createProject(userId, {
        name: "制作中",
        paletteId: "test-palette",
        grid: { encoding: "palette-code-v1", width: 2, height: 1, cells: ["T01", "T01"] },
      });
      const completed = await store.createProject(userId, {
        name: "已完成",
        paletteId: "test-palette",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["T01"] },
      });
      await store.saveBuildProgress({
        userId,
        projectId: inProgress.id,
        projectRevision: 1,
        baseProgressRevision: 0,
        completedIndices: [0],
      });
      await store.saveBuildProgress({
        userId,
        projectId: completed.id,
        projectRevision: 1,
        baseProgressRevision: 0,
        completedIndices: [0],
      });

      assert.deepEqual(await store.getProjectStatusStats(userId), {
        total: 3,
        draft: 1,
        inProgress: 1,
        completed: 1,
      });
      const firstPage = await store.listProjects({ userId, limit: 2, offset: 0 });
      const secondPage = await store.listProjects({ userId, limit: 2, offset: 2 });
      assert.equal(firstPage.length, 2);
      assert.equal(secondPage.length, 1);
      const all = [...firstPage, ...secondPage];
      assert.deepEqual(new Set(all.map((project) => project.id)), new Set([draft.id, inProgress.id, completed.id]));
      assert.deepEqual(
        Object.fromEntries(all.map((project) => [project.name, {
          colorCount: project.colorCount,
          beadCount: project.beadCount,
          completedBeadCount: project.completedBeadCount,
          status: project.status,
        }])),
        {
          "未开始": { colorCount: 1, beadCount: 1, completedBeadCount: 0, status: "draft" },
          "制作中": { colorCount: 1, beadCount: 2, completedBeadCount: 1, status: "in_progress" },
          "已完成": { colorCount: 1, beadCount: 1, completedBeadCount: 1, status: "completed" },
        },
      );

      assert.equal(await store.deleteProject(userId, draft.id), true);
      assert.deepEqual(await store.getProjectStatusStats(userId), {
        total: 2,
        draft: 0,
        inProgress: 1,
        completed: 1,
      });
    } finally {
      await store.close();
    }
  });
});
