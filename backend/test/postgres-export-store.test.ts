import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import type { ExportArtifactRecord, ExportOptions } from "../src/domain/models.js";
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
  "../migrations/0035_project_library.sql",
  "../migrations/0040_worker_lease_scan_indexes.sql",
  "../migrations/0041_remove_superseded_lease_indexes.sql",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

const ownerId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const exportJobId = "00000000-0000-4000-8000-000000000004";
const leaseToken = "00000000-0000-4000-8000-000000000005";
const artifactId = "00000000-0000-4000-8000-000000000006";

function poolFor(database: PGlite): Pool {
  const query = (text: string, values?: unknown[]) =>
    values === undefined ? database.query(text) : database.query(text, values as never[]);
  const client = {
    query,
    release: () => undefined,
  } as unknown as PoolClient;

  return {
    query,
    connect: async () => client,
    end: () => database.close(),
  } as unknown as Pool;
}

async function applyMigrations(database: PGlite): Promise<void> {
  for (const migrationPath of migrationPaths) {
    await database.exec(await readFile(migrationPath, "utf8"));
  }
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

describe("PostgresStore export SQL", () => {
  it("creates, claims, completes, and reads a revision-locked owner-scoped export", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('${ownerId}', '导出拥有者'),
          ('${otherUserId}', '其他用户');
        INSERT INTO palettes(id, name, version)
        VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('test-palette', 'T01', '测试白', '#FFFFFF', 1, 0);
        INSERT INTO projects(id, user_id, name, palette_id, current_revision)
        VALUES ('${projectId}', '${ownerId}', '导出测试图纸', 'test-palette', 1);
        INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
        VALUES (
          '${projectId}', 1, 'palette-code-v1', 2, 2,
          '["T01", null, "T01", null]'::jsonb
        );
      `);

      const options: ExportOptions = {
        paper: "A4",
        orientation: "landscape",
        showCodes: true,
        showGrid: true,
        transparentBackground: false,
      };
      const createdAt = "2026-10-04T10:00:00.000Z";
      const created = await store.createExportJob({
        id: exportJobId,
        userId: ownerId,
        projectId,
        projectRevision: 1,
        format: "pdf",
        fileName: "pattern-r1.pdf",
        options,
        now: createdAt,
      });
      assert.deepEqual(
        {
          id: created.id,
          userId: created.userId,
          projectId: created.projectId,
          projectRevision: created.projectRevision,
          format: created.format,
          fileName: created.fileName,
          options: created.options,
          status: created.status,
          progress: created.progress,
          attemptCount: created.attemptCount,
          artifact: created.artifact,
        },
        {
          id: exportJobId,
          userId: ownerId,
          projectId,
          projectRevision: 1,
          format: "pdf",
          fileName: "pattern-r1.pdf",
          options,
          status: "queued",
          progress: 0,
          attemptCount: 0,
          artifact: null,
        },
      );

      await assert.rejects(
        store.createExportJob({
          id: "00000000-0000-4000-8000-000000000007",
          userId: otherUserId,
          projectId,
          projectRevision: 1,
          format: "png",
          fileName: "not-owner.png",
          options,
          now: createdAt,
        }),
        rejectsWithCode("PROJECT_REVISION_NOT_FOUND"),
      );
      await assert.rejects(
        store.createExportJob({
          id: "00000000-0000-4000-8000-000000000008",
          userId: ownerId,
          projectId,
          projectRevision: 2,
          format: "png",
          fileName: "missing-revision.png",
          options,
          now: createdAt,
        }),
        rejectsWithCode("PROJECT_REVISION_NOT_FOUND"),
      );
      await assert.rejects(
        database.query(
          `INSERT INTO export_jobs(
             id, user_id, project_id, project_revision, format, file_name, options,
             status, progress, attempt_count, max_attempts, available_at, created_at, updated_at
           ) VALUES (
             $1, $2, $3, 99, 'png', 'invalid-revision.png', '{}'::jsonb,
             'queued', 0, 0, 3, $4, $4, $4
           )`,
          ["00000000-0000-4000-8000-000000000009", ownerId, projectId, createdAt],
        ),
        /foreign key constraint/i,
      );

      assert.equal(await store.getExportJob(otherUserId, exportJobId), null);
      assert.deepEqual(await store.listExportJobs(otherUserId, 10), []);
      assert.deepEqual(await store.getExportJobStats(ownerId), { total: 1, succeeded: 0 });
      assert.deepEqual(await store.getExportJobStats(otherUserId), { total: 0, succeeded: 0 });

      await database.query(
        "UPDATE projects SET deleted_at = $2, updated_at = $2 WHERE id = $1",
        [projectId, "2026-10-04T10:00:05.000Z"],
      );
      assert.equal(await store.getProject(ownerId, projectId, 1), null);
      const exportProject = await store.getProjectForExport({
        userId: ownerId,
        projectId,
        projectRevision: 1,
      });
      assert.ok(exportProject);
      assert.equal(exportProject.currentRevision, 1);
      assert.deepEqual(exportProject.grid, {
        encoding: "palette-code-v1",
        width: 2,
        height: 2,
        cells: ["T01", null, "T01", null],
      });
      assert.equal(await store.getProjectForExport({
        userId: otherUserId,
        projectId,
        projectRevision: 1,
      }), null);
      assert.equal(await store.getProjectForExport({
        userId: ownerId,
        projectId,
        projectRevision: 2,
      }), null);

      const claimedAt = "2026-10-04T10:00:10.000Z";
      const claimed = await store.claimNextExportJob({
        now: claimedAt,
        leaseToken,
        leaseMilliseconds: 5 * 60_000,
      });
      assert.ok(claimed);
      assert.equal(claimed.id, exportJobId);
      assert.equal(claimed.status, "running");
      assert.equal(claimed.progress, 5);
      assert.equal(claimed.attemptCount, 1);
      assert.equal(claimed.leaseToken, leaseToken);
      assert.equal(claimed.projectRevision, 1);

      const artifact: ExportArtifactRecord = {
        id: artifactId,
        jobId: exportJobId,
        storageKey: "exports/opaque-artifact-000000000006",
        mimeType: "application/pdf",
        fileName: "pattern-r1.pdf",
        sizeBytes: 4096,
        sha256: "a".repeat(64),
        expiresAt: "2026-10-05T10:01:00.000Z",
        createdAt: "2026-10-04T10:01:00.000Z",
      };
      await store.prepareExportArtifact({
        jobId: exportJobId,
        leaseToken,
        artifact,
        now: "2026-10-04T10:01:00.000Z",
      });
      const completed = await store.completeExportJob({
        jobId: exportJobId,
        leaseToken,
        artifact,
        now: artifact.createdAt,
      });
      assert.equal(completed.status, "succeeded");
      assert.equal(completed.progress, 100);
      assert.equal(completed.leaseToken, null);
      assert.equal(completed.finishedAt, artifact.createdAt);
      assert.deepEqual(completed.artifact, artifact);

      const readBack = await store.getExportJob(ownerId, exportJobId);
      assert.ok(readBack);
      assert.equal(readBack.projectRevision, 1);
      assert.deepEqual(readBack.artifact, artifact);
      const listed = await store.listExportJobs(ownerId, 10);
      assert.equal(listed.length, 1);
      assert.deepEqual(listed[0]?.artifact, artifact);
      assert.deepEqual(await store.listExportJobs(ownerId, 10, 1), []);
      assert.deepEqual(await store.getExportJobStats(ownerId), { total: 1, succeeded: 1 });
    } finally {
      await store.close();
    }
  });

  it("recovers at most 100 expired export leases per claim without starving a fresh queued job", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const queuedJobId = "30000000-0000-4000-8000-000000000001";
    try {
      await applyMigrations(database);
      await database.exec(`
        INSERT INTO users(id, display_name)
        VALUES ('${ownerId}', '批量租约恢复用户');
        INSERT INTO palettes(id, name, version)
        VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('test-palette', 'T01', '测试白', '#FFFFFF', 1, 0);
        INSERT INTO projects(id, user_id, name, palette_id, current_revision)
        VALUES ('${projectId}', '${ownerId}', '批量租约恢复图纸', 'test-palette', 1);
        INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
        VALUES ('${projectId}', 1, 'palette-code-v1', 1, 1, '["T01"]'::jsonb);

        INSERT INTO export_jobs(
          id, user_id, project_id, project_revision, format, file_name, options,
          status, progress, attempt_count, max_attempts, available_at,
          lease_token, lease_expires_at, created_at, updated_at
        )
        SELECT
          ('10000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
          '${ownerId}', '${projectId}', 1, 'png', 'expired-' || value || '.png', '{}'::jsonb,
          'running', 5, 3, 3, clock_timestamp() - interval '2 minutes',
          '20000000-0000-4000-8000-000000000001'::uuid,
          clock_timestamp() - interval '1 minute',
          clock_timestamp() - interval '3 minutes',
          clock_timestamp() - interval '2 minutes'
        FROM generate_series(1, 102) AS value;

        INSERT INTO export_jobs(
          id, user_id, project_id, project_revision, format, file_name, options,
          status, progress, attempt_count, max_attempts, available_at, created_at, updated_at
        ) VALUES (
          '${queuedJobId}', '${ownerId}', '${projectId}', 1, 'png', 'fresh.png', '{}'::jsonb,
          'queued', 0, 0, 3, clock_timestamp() - interval '1 second',
          clock_timestamp(), clock_timestamp()
        );
      `);

      const claimed = await store.claimNextExportJob({
        now: new Date().toISOString(),
        leaseToken: leaseToken,
        leaseMilliseconds: 60_000,
      });
      assert.equal(claimed?.id, queuedJobId);

      const afterFirstClaim = await database.query<{
        failed: number | string;
        expired_running: number | string;
      }>(
        `SELECT
           count(*) FILTER (WHERE status = 'failed' AND error_code = 'EXPORT_LEASE_EXPIRED') AS failed,
           count(*) FILTER (
             WHERE status = 'running' AND id <> $1 AND lease_expires_at <= clock_timestamp()
           ) AS expired_running
         FROM export_jobs`,
        [queuedJobId],
      );
      assert.equal(Number(afterFirstClaim.rows[0]?.failed), 100);
      assert.equal(Number(afterFirstClaim.rows[0]?.expired_running), 2);

      await store.cancelExportJob(ownerId, queuedJobId, new Date().toISOString());
      assert.equal(await store.claimNextExportJob({
        now: new Date().toISOString(),
        leaseToken: "00000000-0000-4000-8000-000000000010",
        leaseMilliseconds: 60_000,
      }), null);
      const afterSecondClaim = await database.query<{ failed: number | string }>(
        "SELECT count(*) AS failed FROM export_jobs WHERE status = 'failed' AND error_code = 'EXPORT_LEASE_EXPIRED'",
      );
      assert.equal(Number(afterSecondClaim.rows[0]?.failed), 102);
    } finally {
      await store.close();
    }
  });
});
