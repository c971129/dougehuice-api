import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

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
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

const userId = "00000000-0000-4000-8000-000000000801";
const projectId = "00000000-0000-4000-8000-000000000802";
const jobIds = [
  "00000000-0000-4000-8000-000000000811",
  "00000000-0000-4000-8000-000000000812",
  "00000000-0000-4000-8000-000000000813",
  "00000000-0000-4000-8000-000000000814",
  "00000000-0000-4000-8000-000000000815",
] as const;
const artifactIds = [
  "00000000-0000-4000-8000-000000000821",
  "00000000-0000-4000-8000-000000000822",
  "00000000-0000-4000-8000-000000000823",
  "00000000-0000-4000-8000-000000000824",
  "00000000-0000-4000-8000-000000000825",
] as const;

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

describe("PostgresStore export artifact cleanup SQL", () => {
  it("lists only expired unpurged artifacts in stable order and marks them once", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }

      const cleanupIndexes = await database.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'export_artifacts'
           AND indexname IN (
             'export_artifacts_pending_publish_idx',
             'export_artifacts_purge_schedule_idx'
           )
         ORDER BY indexname`,
      );
      assert.deepEqual(cleanupIndexes.rows, [
        { indexname: "export_artifacts_pending_publish_idx" },
        { indexname: "export_artifacts_purge_schedule_idx" },
      ]);

      await database.exec(`
        INSERT INTO users(id, display_name)
        VALUES ('${userId}', '导出清理测试用户');
        INSERT INTO palettes(id, name, version)
        VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('test-palette', 'T01', '测试白', '#FFFFFF', 1, 0);
        INSERT INTO projects(id, user_id, name, palette_id, current_revision)
        VALUES ('${projectId}', '${userId}', '导出清理测试图纸', 'test-palette', 1);
        INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
        VALUES ('${projectId}', 1, 'palette-code-v1', 1, 1, '["T01"]'::jsonb);

        INSERT INTO export_jobs(
          id, user_id, project_id, project_revision, format, file_name, options,
          status, progress, available_at, created_at, updated_at
        ) VALUES
          ('${jobIds[0]}', '${userId}', '${projectId}', 1, 'pdf', 'early.pdf', '{}'::jsonb,
           'queued', 0, '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z'),
          ('${jobIds[1]}', '${userId}', '${projectId}', 1, 'pdf', 'same-a.pdf', '{}'::jsonb,
           'queued', 0, '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z'),
          ('${jobIds[2]}', '${userId}', '${projectId}', 1, 'pdf', 'same-b.pdf', '{}'::jsonb,
           'queued', 0, '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z'),
          ('${jobIds[3]}', '${userId}', '${projectId}', 1, 'pdf', 'future.pdf', '{}'::jsonb,
           'queued', 0, '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z'),
          ('${jobIds[4]}', '${userId}', '${projectId}', 1, 'pdf', 'already-purged.pdf', '{}'::jsonb,
           'queued', 0, '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z');

        INSERT INTO export_artifacts(
          id, job_id, storage_key, mime_type, file_name, size_bytes, sha256,
          expires_at, purged_at, created_at, purge_available_at, ready_at
        ) VALUES
          ('${artifactIds[0]}', '${jobIds[0]}', 'exports/early', 'application/pdf', 'early.pdf', 101,
           repeat('a', 64), '2026-10-04T09:00:00.000Z', NULL, '2026-10-04T08:01:00.000Z', '2026-10-04T08:01:00.000Z', '2026-10-04T08:01:00.000Z'),
          ('${artifactIds[1]}', '${jobIds[1]}', 'exports/same-a', 'application/pdf', 'same-a.pdf', 102,
           repeat('b', 64), '2026-10-04T10:00:00.000Z', NULL, '2026-10-04T08:02:00.000Z', '2026-10-04T08:02:00.000Z', '2026-10-04T08:02:00.000Z'),
          ('${artifactIds[2]}', '${jobIds[2]}', 'exports/same-b', 'application/pdf', 'same-b.pdf', 103,
           repeat('c', 64), '2026-10-04T10:00:00.000Z', NULL, '2026-10-04T08:03:00.000Z', '2026-10-04T08:03:00.000Z', '2026-10-04T08:03:00.000Z'),
          ('${artifactIds[3]}', '${jobIds[3]}', 'exports/future', 'application/pdf', 'future.pdf', 104,
           repeat('d', 64), '2026-10-04T11:00:00.000Z', NULL, '2026-10-04T08:04:00.000Z', '2026-10-04T08:04:00.000Z', '2026-10-04T08:04:00.000Z'),
          ('${artifactIds[4]}', '${jobIds[4]}', 'exports/already-purged', 'application/pdf', 'already-purged.pdf', 105,
           repeat('e', 64), '2026-10-04T08:30:00.000Z', '2026-10-04T09:30:00.000Z', '2026-10-04T08:05:00.000Z', '2026-10-04T08:05:00.000Z', '2026-10-04T08:05:00.000Z');
      `);
      await database.exec(`
        WITH database_clock AS MATERIALIZED (
          SELECT clock_timestamp() AS now_at
        )
        UPDATE export_artifacts AS artifact
        SET expires_at = CASE artifact.id
              WHEN '${artifactIds[0]}' THEN database_clock.now_at - interval '90 minutes'
              WHEN '${artifactIds[1]}' THEN database_clock.now_at - interval '30 minutes'
              WHEN '${artifactIds[2]}' THEN database_clock.now_at - interval '30 minutes'
              WHEN '${artifactIds[3]}' THEN database_clock.now_at + interval '30 minutes'
              ELSE database_clock.now_at - interval '2 hours'
            END,
            purge_available_at = database_clock.now_at - interval '1 minute'
        FROM database_clock;
      `);

      const now = new Date().toISOString();
      const limited = await store.listExportArtifactsForPurge(now, 2);
      assert.deepEqual(limited.map(({ id }) => id), [artifactIds[0], artifactIds[1]]);
      assert.deepEqual(
        limited.map(({ jobId, userId: owner, storageKey, mimeType, fileName, sizeBytes, sha256 }) => ({
          jobId,
          owner,
          storageKey,
          mimeType,
          fileName,
          sizeBytes,
          sha256,
        })),
        [
          {
            jobId: jobIds[0],
            owner: userId,
            storageKey: "exports/early",
            mimeType: "application/pdf",
            fileName: "early.pdf",
            sizeBytes: 101,
            sha256: "a".repeat(64),
          },
          {
            jobId: jobIds[1],
            owner: userId,
            storageKey: "exports/same-a",
            mimeType: "application/pdf",
            fileName: "same-a.pdf",
            sizeBytes: 102,
            sha256: "b".repeat(64),
          },
        ],
      );

      assert.deepEqual(
        (await store.listExportArtifactsForPurge(now, 10)).map(({ id }) => id),
        [artifactIds[0], artifactIds[1], artifactIds[2]],
      );

      const claimed = await store.claimExportArtifactForPurge(artifactIds[0], now);
      assert.equal(claimed?.id, artifactIds[0]);
      assert.deepEqual(
        (await store.listExportArtifactsForPurge(now, 10)).map(({ id }) => id),
        [artifactIds[1], artifactIds[2]],
      );
      await store.recordExportArtifactPurgeFailure(artifactIds[0], "2199-01-01T00:00:00.000Z");
      const firstBackoff = await database.query<{ remaining_ms: number | string }>(
        `SELECT EXTRACT(EPOCH FROM (purge_available_at - clock_timestamp())) * 1000 AS remaining_ms
         FROM export_artifacts WHERE id = $1`,
        [artifactIds[0]],
      );
      assert.ok(
        Number(firstBackoff.rows[0]?.remaining_ms) > 10_000
          && Number(firstBackoff.rows[0]?.remaining_ms) < 45_000,
        "a future failure timestamp cannot move the first database-managed backoff",
      );
      assert.deepEqual(
        (await store.listExportArtifactsForPurge(now, 10)).map(({ id }) => id),
        [artifactIds[1], artifactIds[2]],
      );
      assert.deepEqual(
        (await store.listExportArtifactsForPurge("2199-01-01T00:00:00.000Z", 10)).map(({ id }) => id),
        [artifactIds[1], artifactIds[2]],
        "the caller clock cannot skip the database-managed retry backoff",
      );
      await store.recordExportArtifactPurgeFailure(artifactIds[0], "2000-01-01T00:00:00.000Z");
      const secondBackoff = await database.query<{ remaining_ms: number | string }>(
        `SELECT EXTRACT(EPOCH FROM (purge_available_at - clock_timestamp())) * 1000 AS remaining_ms
         FROM export_artifacts WHERE id = $1`,
        [artifactIds[0]],
      );
      assert.ok(
        Number(secondBackoff.rows[0]?.remaining_ms) > 35_000
          && Number(secondBackoff.rows[0]?.remaining_ms) < 75_000,
        "a past failure timestamp cannot expire the second database-managed backoff",
      );
      await database.query(
        "UPDATE export_artifacts SET purge_available_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [artifactIds[0]],
      );
      assert.deepEqual(
        (await store.listExportArtifactsForPurge(now, 10)).map(({ id }) => id),
        [artifactIds[0], artifactIds[1], artifactIds[2]],
      );

      const firstPurgedAt = "2026-10-04T10:31:00.000Z";
      await store.markExportArtifactPurged(artifactIds[0], firstPurgedAt);
      await store.markExportArtifactPurged(artifactIds[0], "2026-10-04T10:32:00.000Z");

      assert.deepEqual(
        (await store.listExportArtifactsForPurge(now, 10)).map(({ id }) => id),
        [artifactIds[1], artifactIds[2]],
      );
      const marked = await database.query<{ purged_at: Date | string }>(
        "SELECT purged_at FROM export_artifacts WHERE id = $1",
        [artifactIds[0]],
      );
      assert.equal(new Date(marked.rows[0]?.purged_at ?? 0).toISOString(), firstPurgedAt);

      const raceJobId = "00000000-0000-4000-8000-000000000816";
      const raceArtifactId = "00000000-0000-4000-8000-000000000826";
      const raceLeaseToken = "00000000-0000-4000-8000-000000000836";
      await database.query(
        `INSERT INTO export_jobs(
           id, user_id, project_id, project_revision, format, file_name, options,
           status, progress, attempt_count, lease_token, lease_expires_at,
           available_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 1, 'png', 'race.png', '{}'::jsonb,
           'running', 50, 1, $4, clock_timestamp() - interval '1 minute',
           '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z', '2026-10-04T08:00:00.000Z'
         )`,
        [raceJobId, userId, projectId, raceLeaseToken],
      );
      await database.query(
        `INSERT INTO export_artifacts(
           id, job_id, storage_key, mime_type, file_name, size_bytes, sha256,
           expires_at, created_at, purge_available_at, ready_at
         ) VALUES (
           $1, $2, 'exports/pending-race', 'image/png', 'race.png', 10, $3,
            clock_timestamp() + interval '7 days', clock_timestamp() - interval '2 hours',
            clock_timestamp() - interval '1 minute', NULL
         )`,
        [raceArtifactId, raceJobId, "f".repeat(64)],
      );
      assert.equal((await store.claimExportArtifactForPurge(raceArtifactId, now))?.id, raceArtifactId);
      await assert.rejects(
        store.completeExportJob({
          jobId: raceJobId,
          leaseToken: raceLeaseToken,
          artifact: {
            id: raceArtifactId,
            jobId: raceJobId,
            storageKey: "exports/pending-race",
            mimeType: "image/png",
            fileName: "race.png",
            sizeBytes: 10,
            sha256: "f".repeat(64),
            expiresAt: "2026-10-11T08:00:00.000Z",
            createdAt: "2026-10-04T08:00:00.000Z",
          },
          now,
        }),
        (error: unknown) => typeof error === "object" && error !== null
          && "code" in error && error.code === "EXPORT_LEASE_LOST",
      );
      const abandoned = await database.query<{ abandoned_at: Date | string | null }>(
        "SELECT abandoned_at FROM export_artifacts WHERE id = $1",
        [raceArtifactId],
      );
      assert.ok(abandoned.rows[0]?.abandoned_at, "claiming a stale pending artifact records database abandonment time");

      const clockJobId = "00000000-0000-4000-8000-000000000817";
      const clockArtifactId = "00000000-0000-4000-8000-000000000827";
      await database.query(
        `INSERT INTO export_jobs(
           id, user_id, project_id, project_revision, format, file_name, options,
           status, progress, attempt_count, lease_token, lease_expires_at,
           available_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 1, 'png', 'clock.png', '{}'::jsonb,
           'running', 50, 1, '00000000-0000-4000-8000-000000000837',
           clock_timestamp() + interval '15 minutes',
           clock_timestamp(), clock_timestamp(), clock_timestamp()
         )`,
        [clockJobId, userId, projectId],
      );
      await database.query(
        `INSERT INTO export_artifacts(
           id, job_id, storage_key, mime_type, file_name, size_bytes, sha256,
           expires_at, created_at, purge_available_at, ready_at
         ) VALUES (
           $1, $2, 'exports/clock', 'image/png', 'clock.png', 10, $3,
           clock_timestamp() + interval '1 day', clock_timestamp() - interval '2 hours',
           clock_timestamp() - interval '1 minute', NULL
         )`,
        [clockArtifactId, clockJobId, "9".repeat(64)],
      );
      const futureCallerNow = "2199-01-01T00:00:00.000Z";
      assert.ok(
        !(await store.listExportArtifactsForPurge(futureCallerNow, 100)).some(({ id }) => id === clockArtifactId),
        "a stale pending artifact remains protected while its database job lease is active",
      );
      assert.equal(await store.claimExportArtifactForPurge(clockArtifactId, futureCallerNow), null);
      await database.query(
        `UPDATE export_jobs
         SET lease_expires_at = clock_timestamp() - interval '1 second'
         WHERE id = $1`,
        [clockJobId],
      );
      assert.ok(
        (await store.listExportArtifactsForPurge("2000-01-01T00:00:00.000Z", 100))
          .some(({ id }) => id === clockArtifactId),
        "the database makes the stale artifact eligible after its job lease expires",
      );
      assert.equal(
        (await store.claimExportArtifactForPurge(clockArtifactId, "2000-01-01T00:00:00.000Z"))?.id,
        clockArtifactId,
      );
      assert.ok(
        !(await store.listExportArtifactsForPurge(futureCallerNow, 100)).some(({ id }) => id === artifactIds[3]),
        "a ready artifact whose database expiry is in the future cannot be purged early",
      );
      assert.equal(await store.claimExportArtifactForPurge(artifactIds[3], futureCallerNow), null);
    } finally {
      await store.close();
    }
  });
});
