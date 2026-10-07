import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { AppError } from "../src/errors.js";
import type { ExportArtifactRecord } from "../src/domain/models.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const ownerId = "00000000-0000-4000-8000-000000000831";
const otherId = "00000000-0000-4000-8000-000000000832";
const legacyProjectId = "00000000-0000-4000-8000-000000000833";
const sourceAssetId = "00000000-0000-4000-8000-000000000834";
const previewAssetId = "00000000-0000-4000-8000-000000000835";
const pendingPreviewAssetId = "00000000-0000-4000-8000-000000000836";
const otherSourceAssetId = "00000000-0000-4000-8000-000000000837";
const exportJobId = "00000000-0000-4000-8000-000000000838";
const exportArtifactId = "00000000-0000-4000-8000-000000000839";
const exportLeaseToken = "00000000-0000-4000-8000-000000000840";

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

describe("PostgresStore project metadata", () => {
  it("backfills legacy rows and enforces ready tenant-safe asset references", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      const migrations = await loadMigrationFiles();
      const metadataMigration = migrations.find((migration) => migration.version === "0019_project_metadata.sql");
      const metadataRevisionMigration = migrations.find(
        (migration) => migration.version === "0020_project_metadata_revision.sql",
      );
      const paletteContractMigration = migrations.find(
        (migration) => migration.version === "0021_palette_contract.sql",
      );
      const projectLibraryMigration = migrations.find(
        (migration) => migration.version === "0035_project_library.sql",
      );
      assert.ok(metadataMigration);
      assert.ok(metadataRevisionMigration);
      assert.ok(paletteContractMigration);
      assert.ok(projectLibraryMigration);
      for (const migration of migrations) {
        if (migration.version === metadataMigration.version) break;
        await database.exec(migration.sql);
      }
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('${ownerId}', '作品元数据用户'),
          ('${otherId}', '其他作品用户');
        INSERT INTO palettes(id, name, version) VALUES ('metadata-palette', '元数据色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('metadata-palette', 'P01', '测试色', '#FFFFFF', 1, 0);
        INSERT INTO projects(id, user_id, name, palette_id, current_revision)
        VALUES ('${legacyProjectId}', '${ownerId}', '旧作品', 'metadata-palette', 1);
        INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
        VALUES ('${legacyProjectId}', 1, 'palette-code-v1', 1, 1, '["P01"]'::jsonb);
      `);
      await database.exec(metadataMigration.sql);
      await database.exec(metadataRevisionMigration.sql);
      await database.exec(paletteContractMigration.sql);
      await database.exec(projectLibraryMigration.sql);

      const legacy = await store.getProject(ownerId, legacyProjectId);
      assert.ok(legacy);
      assert.deepEqual({
        mode: legacy.mode,
        lifecycleStatus: legacy.lifecycleStatus,
        metadataRevision: legacy.metadataRevision,
        sourceAssetId: legacy.sourceAssetId,
        previewAssetId: legacy.previewAssetId,
        backgroundMode: legacy.backgroundMode,
        backgroundColor: legacy.backgroundColor,
      }, {
        mode: "normal",
        lifecycleStatus: "editable",
        metadataRevision: 1,
        sourceAssetId: null,
        previewAssetId: null,
        backgroundMode: "white",
        backgroundColor: null,
      });

      await database.query(
        `INSERT INTO assets(
           id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
           width, height, storage_key, expires_at, ready_at, created_at
         ) VALUES
           ($1, $5, 'ai-source', 'privacy-v1', $7, 'image/png', 10, 10, 10,
            'metadata-owner-source-key', '2030-01-01', now(), now()),
           ($2, $5, 'ai-intermediate', 'privacy-v1', $8, 'image/png', 10, 10, 10,
            'metadata-owner-preview-key', '2030-01-01', now(), now()),
           ($3, $5, 'ai-intermediate', 'privacy-v1', $9, 'image/png', 10, 10, 10,
            'metadata-pending-preview-key', '2030-01-01', NULL, now()),
           ($4, $6, 'ai-source', 'privacy-v1', $10, 'image/png', 10, 10, 10,
            'metadata-other-source-key', '2030-01-01', now(), now())`,
        [
          sourceAssetId,
          previewAssetId,
          pendingPreviewAssetId,
          otherSourceAssetId,
          ownerId,
          otherId,
          "a".repeat(64),
          "b".repeat(64),
          "c".repeat(64),
          "d".repeat(64),
        ],
      );
      const grid = { encoding: "palette-code-v1" as const, width: 1, height: 1, cells: ["P01"] };
      const created = await store.createProject(ownerId, {
        name: "带引用作品",
        paletteId: "metadata-palette",
        grid,
        mode: "portrait",
        sourceAssetId,
        previewAssetId,
        backgroundMode: "solid",
        backgroundColor: "#aabbcc",
      });
      assert.equal(created.mode, "portrait");
      assert.equal(created.lifecycleStatus, "editable");
      assert.equal(created.metadataRevision, 1);
      assert.equal(created.sourceAssetId, sourceAssetId);
      assert.equal(created.previewAssetId, previewAssetId);
      assert.equal(created.backgroundColor, "#AABBCC");

      await store.createExportJob({
        id: exportJobId,
        userId: ownerId,
        projectId: created.id,
        projectRevision: 1,
        format: "png",
        fileName: "metadata.png",
        options: {
          paper: "A4",
          orientation: "auto",
          showCodes: true,
          showGrid: true,
          transparentBackground: false,
        },
        now: "2026-10-04T10:00:00.000Z",
      });
      assert.ok(await store.claimNextExportJob({
        now: "2026-10-04T10:00:01.000Z",
        leaseToken: exportLeaseToken,
        leaseMilliseconds: 5 * 60_000,
      }));
      const artifact: ExportArtifactRecord = {
        id: exportArtifactId,
        jobId: exportJobId,
        storageKey: "metadata-export-artifact-key",
        mimeType: "image/png",
        fileName: "metadata.png",
        sizeBytes: 128,
        sha256: "e".repeat(64),
        expiresAt: "2030-10-05T10:00:02.000Z",
        createdAt: "2026-10-04T10:00:02.000Z",
      };
      await store.prepareExportArtifact({
        jobId: exportJobId,
        leaseToken: exportLeaseToken,
        artifact,
        now: artifact.createdAt,
      });
      await store.completeExportJob({
        jobId: exportJobId,
        leaseToken: exportLeaseToken,
        artifact,
        now: artifact.createdAt,
      });
      const afterExport = await store.getProject(ownerId, created.id);
      assert.equal(afterExport?.lifecycleStatus, "exported");
      assert.equal(afterExport?.metadataRevision, 2);

      const validCopy = await store.copyProject({
        userId: ownerId,
        projectId: created.id,
        name: "有效素材副本",
      });
      assert.ok(validCopy);
      assert.equal(validCopy.lifecycleStatus, "editable");
      assert.equal(validCopy.sourceAssetId, sourceAssetId);
      assert.equal(validCopy.previewAssetId, previewAssetId);
      assert.deepEqual(validCopy.grid, grid);

      await assert.rejects(
        store.createProject(ownerId, {
          name: "跨租户引用",
          paletteId: "metadata-palette",
          grid,
          sourceAssetId: otherSourceAssetId,
        }),
        rejectsWithCode("PROJECT_SOURCE_ASSET_NOT_FOUND"),
      );
      await assert.rejects(
        store.updateProjectMetadata({
          userId: ownerId,
          projectId: created.id,
          baseRevision: 1,
          baseMetadataRevision: 2,
          previewAssetId: pendingPreviewAssetId,
        }),
        rejectsWithCode("PROJECT_PREVIEW_ASSET_NOT_FOUND"),
      );
      await assert.rejects(
        database.query("UPDATE projects SET source_asset_id = $2 WHERE id = $1", [created.id, otherSourceAssetId]),
        /projects_source_asset_tenant_fk|foreign key/i,
      );

      const updated = await store.updateProjectMetadata({
        userId: ownerId,
        projectId: created.id,
        baseRevision: 1,
        baseMetadataRevision: 2,
        lifecycleStatus: "exported",
        backgroundMode: "transparent",
      });
      assert.equal(updated.lifecycleStatus, "exported");
      assert.equal(updated.metadataRevision, 3);
      assert.equal(updated.backgroundMode, "transparent");
      assert.equal(updated.backgroundColor, null);

      await assert.rejects(
        store.updateProjectMetadata({
          userId: ownerId,
          projectId: created.id,
          baseRevision: 1,
          baseMetadataRevision: 2,
          mode: "couple",
        }),
        rejectsWithCode("PROJECT_METADATA_REVISION_CONFLICT"),
      );

      await database.query(
        `UPDATE assets
         SET created_at = clock_timestamp() - interval '2 days',
             ready_at = clock_timestamp() - interval '2 days',
             expires_at = clock_timestamp() - interval '1 minute'
         WHERE id = ANY($1::uuid[])`,
        [[sourceAssetId, previewAssetId]],
      );
      const expiredAssetCopy = await store.copyProject({
        userId: ownerId,
        projectId: created.id,
        name: "过期素材副本",
      });
      assert.ok(expiredAssetCopy);
      assert.equal(expiredAssetCopy.lifecycleStatus, "editable");
      assert.equal(expiredAssetCopy.sourceAssetId, null);
      assert.equal(expiredAssetCopy.previewAssetId, null);
      assert.deepEqual(expiredAssetCopy.grid, grid);
      assert.equal(await store.copyProject({ userId: otherId, projectId: created.id }), null);

      await database.query("DELETE FROM assets WHERE id = $1", [previewAssetId]);
      const afterPreviewDelete = await store.getProject(ownerId, created.id);
      assert.equal(afterPreviewDelete?.previewAssetId, null);
      assert.equal(afterPreviewDelete?.metadataRevision, 4);
      await store.markAssetDeleted(ownerId, sourceAssetId, "2026-10-04T12:00:00.000Z");
      const afterSourceDelete = await store.getProject(ownerId, created.id);
      assert.equal(afterSourceDelete?.sourceAssetId, null);
      assert.equal(afterSourceDelete?.metadataRevision, 5);

      await assert.rejects(
        database.query(
          "UPDATE projects SET background_mode = 'white', background_color = '#112233' WHERE id = $1",
          [created.id],
        ),
        /projects_background_valid|check constraint/i,
      );
    } finally {
      await store.close();
    }
  });
});
