import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { AppError } from "../src/errors.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const ownerId = "00000000-0000-4000-8000-000000000a01";
const otherId = "00000000-0000-4000-8000-000000000a02";

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

async function prepareDatabase(database: PGlite): Promise<void> {
  for (const migration of await loadMigrationFiles()) await database.exec(migration.sql);
  await database.exec(`
    INSERT INTO users(id, display_name) VALUES
      ('${ownerId}', '完工照片用户'),
      ('${otherId}', '其他用户');
    INSERT INTO palettes(id, name, brand, bead_size_mm, verified, version)
    VALUES ('completion-test', '完工测试色卡', '测试', 5, false, 1);
    INSERT INTO palette_colors(
      palette_id, code, name, hex, unit_price_cents, sort_order, available
    ) VALUES
      ('completion-test', 'T01', '红', '#FF0000', 1, 0, true),
      ('completion-test', 'T02', '蓝', '#0000FF', 1, 1, true);
  `);
}

function completionAsset(input: { id: string; storageKey: string; createdAt?: string }) {
  return {
    id: input.id,
    userId: ownerId,
    purpose: "project-completion" as const,
    consentVersion: null,
    sha256: "a".repeat(64),
    mimeType: "image/png" as const,
    sizeBytes: 128,
    width: 4,
    height: 3,
    storageKey: input.storageKey,
    expiresAt: null,
    createdAt: input.createdAt ?? "2026-10-05T10:00:00.000Z",
  };
}

function completionLease(input: {
  token: string;
  acquiredAt?: string;
}) {
  return {
    uploadLeaseToken: input.token,
    uploadLeaseAcquiredAt: input.acquiredAt ?? "2026-10-05T10:00:00.000Z",
  };
}

describe("PostgresStore project completion photos", () => {
  it("enforces purpose/lifecycle FKs and tombstones assets before a project is physically deleted", async () => {
    const database = new PGlite();
    try {
      await prepareDatabase(database);
      const projectId = "00000000-0000-4000-8000-000000000a10";
      const completionAssetId = "00000000-0000-4000-8000-000000000a11";
      const aiAssetId = "00000000-0000-4000-8000-000000000a12";
      await database.exec(`
        INSERT INTO projects(
          id, user_id, name, palette_id, current_revision,
          current_bead_count, current_color_count
        ) VALUES ('${projectId}', '${ownerId}', '物理清理作品', 'completion-test', 1, 1, 1);
        INSERT INTO project_revisions(
          project_id, revision, encoding, width, height, cells, palette_id
        ) VALUES ('${projectId}', 1, 'palette-code-v1', 1, 1, '["T01"]'::jsonb, 'completion-test');
        INSERT INTO assets(
          id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
          width, height, storage_key, expires_at, ready_at, created_at
        ) VALUES
          (
            '${completionAssetId}', '${ownerId}', 'project-completion', NULL,
            '${"a".repeat(64)}', 'image/png', 10, 1, 1,
            'completion-storage-key-001', NULL, now(), now()
          ),
          (
            '${aiAssetId}', '${ownerId}', 'ai-source', 'privacy-v1',
            '${"b".repeat(64)}', 'image/png', 10, 1, 1,
            'completion-storage-key-002', now() + interval '1 day', now(), now()
          );
        INSERT INTO project_completion_photos(
          id, user_id, project_id, project_revision, asset_id
        ) VALUES (
          '00000000-0000-4000-8000-000000000a13', '${ownerId}', '${projectId}', 1, '${completionAssetId}'
        );
        INSERT INTO project_completion_photo_uploads(
          user_id, project_id, idempotency_key, request_hash, photo_id, asset_id,
          upload_lease_token, upload_lease_expires_at
        ) VALUES (
          '${ownerId}', '${projectId}', 'physical-delete-key', '${"c".repeat(64)}',
          '00000000-0000-4000-8000-000000000a13', '${completionAssetId}',
          '00000000-0000-4000-8000-000000000a16', now() + interval '15 minutes'
        );
      `);

      await assert.rejects(
        database.exec(`
          INSERT INTO assets(
            id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
            width, height, storage_key, expires_at, created_at
          ) VALUES (
            '00000000-0000-4000-8000-000000000a14', '${ownerId}', 'project-completion',
            'privacy-v1', '${"d".repeat(64)}', 'image/png', 10, 1, 1,
            'completion-storage-key-003', now() + interval '1 day', now()
          )
        `),
        /assets_purpose_lifecycle_valid|check constraint/i,
      );
      await assert.rejects(
        database.exec(`
          INSERT INTO project_completion_photos(
            id, user_id, project_id, project_revision, asset_id
          ) VALUES (
            '00000000-0000-4000-8000-000000000a15', '${ownerId}', '${projectId}', 1, '${aiAssetId}'
          )
        `),
        /foreign key|project_completion_photos_asset_id_user_id_asset_purpose_fkey/i,
      );

      const otherProjectId = "00000000-0000-4000-8000-000000000a17";
      const otherCompletionAssetId = "00000000-0000-4000-8000-000000000a18";
      const unrelatedCompletionAssetId = "00000000-0000-4000-8000-000000000a19";
      const otherPhotoId = "00000000-0000-4000-8000-000000000a1a";
      await database.exec(`
        INSERT INTO projects(
          id, user_id, name, palette_id, current_revision,
          current_bead_count, current_color_count
        ) VALUES ('${otherProjectId}', '${ownerId}', '另一个作品', 'completion-test', 1, 1, 1);
        INSERT INTO project_revisions(
          project_id, revision, encoding, width, height, cells, palette_id
        ) VALUES ('${otherProjectId}', 1, 'palette-code-v1', 1, 1, '["T01"]'::jsonb, 'completion-test');
        INSERT INTO assets(
          id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
          width, height, storage_key, expires_at, ready_at, created_at
        ) VALUES
          ('${otherCompletionAssetId}', '${ownerId}', 'project-completion', NULL,
           '${"e".repeat(64)}', 'image/png', 10, 1, 1, 'completion-storage-key-004', NULL, NULL, now()),
          ('${unrelatedCompletionAssetId}', '${ownerId}', 'project-completion', NULL,
           '${"f".repeat(64)}', 'image/png', 10, 1, 1, 'completion-storage-key-005', NULL, NULL, now());
        INSERT INTO project_completion_photos(
          id, user_id, project_id, project_revision, asset_id
        ) VALUES ('${otherPhotoId}', '${ownerId}', '${otherProjectId}', 1, '${otherCompletionAssetId}');
      `);
      await assert.rejects(
        database.exec(`
          INSERT INTO project_completion_photo_uploads(
            user_id, project_id, idempotency_key, request_hash, photo_id, asset_id,
            upload_lease_token, upload_lease_expires_at
          ) VALUES (
            '${ownerId}', '${projectId}', 'cross-project-upload', '${"1".repeat(64)}',
            '${otherPhotoId}', '${otherCompletionAssetId}',
            '00000000-0000-4000-8000-000000000a1b', now() + interval '15 minutes'
          )
        `),
        /foreign key|project_completion_photo_uploads_photo_id_user_id_project_id_asset_id/i,
      );
      await assert.rejects(
        database.exec(`
          INSERT INTO project_completion_photo_uploads(
            user_id, project_id, idempotency_key, request_hash, photo_id, asset_id,
            upload_lease_token, upload_lease_expires_at
          ) VALUES (
            '${ownerId}', '${otherProjectId}', 'wrong-photo-asset', '${"2".repeat(64)}',
            '${otherPhotoId}', '${unrelatedCompletionAssetId}',
            '00000000-0000-4000-8000-000000000a1c', now() + interval '15 minutes'
          )
        `),
        /foreign key|project_completion_photo_uploads_photo_id_user_id_project_id_asset_id/i,
      );

      const physicalDeleteLease = await database.query<{ upload_lease_expires_at: Date | string }>(
        "SELECT upload_lease_expires_at FROM project_completion_photo_uploads WHERE asset_id = $1",
        [completionAssetId],
      );
      await database.query("DELETE FROM projects WHERE id = $1", [projectId]);
      const asset = await database.query<{
        deleted_at: Date | string | null;
        purged_at: Date | string | null;
        purge_available_at: Date | string;
      }>("SELECT deleted_at, purged_at, purge_available_at FROM assets WHERE id = $1", [completionAssetId]);
      assert.ok(asset.rows[0]?.deleted_at, "project deletion must tombstone its encrypted object");
      assert.equal(asset.rows[0]?.purged_at, null, "the purge worker still owns physical deletion");
      assert.ok(
        new Date(asset.rows[0]!.purge_available_at).getTime()
          >= new Date(physicalDeleteLease.rows[0]!.upload_lease_expires_at).getTime(),
        "physical deletion must carry the writer fence after the upload row cascades",
      );
      const bindings = await database.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM project_completion_photos
         WHERE project_id = $1`,
        [projectId],
      );
      const uploads = await database.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM project_completion_photo_uploads
         WHERE project_id = $1`,
        [projectId],
      );
      assert.equal(bindings.rows[0]?.count, 0);
      assert.equal(uploads.rows[0]?.count, 0);
    } finally {
      await database.close();
    }
  });

  it("reserves, replays, publishes and isolates revision-bound photos transactionally", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await prepareDatabase(database);
      const project = await store.createProject(ownerId, {
        name: "Postgres 完工作品",
        paletteId: "completion-test",
        grid: {
          encoding: "palette-code-v1",
          width: 2,
          height: 2,
          cells: ["T01", "T02", null, "T01"],
        },
      });
      await assert.rejects(
        store.reserveProjectCompletionPhotoUpload({
          photoId: "00000000-0000-4000-8000-000000000a20",
          userId: ownerId,
          projectId: project.id,
          projectRevision: 1,
          idempotencyKey: "postgres-incomplete-photo",
          requestHash: "1".repeat(64),
          ...completionLease({ token: "00000000-0000-4000-8000-000000000a40" }),
          asset: completionAsset({
            id: "00000000-0000-4000-8000-000000000a21",
            storageKey: "postgres-completion-asset-01",
          }),
        }),
        rejectsWithCode("PROJECT_BUILD_NOT_COMPLETED"),
      );
      await store.saveBuildProgress({
        userId: ownerId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 0,
        completedIndices: [0, 1, 3],
        elapsedTime: 50,
      });

      const reservationInput = {
        photoId: "00000000-0000-4000-8000-000000000a22",
        userId: ownerId,
        projectId: project.id,
        projectRevision: 1,
        idempotencyKey: "postgres-completion-photo-01",
        requestHash: "2".repeat(64),
        ...completionLease({ token: "00000000-0000-4000-8000-000000000a41" }),
        asset: completionAsset({
          id: "00000000-0000-4000-8000-000000000a23",
          storageKey: "postgres-completion-asset-02",
        }),
      };
      const reserved = await store.reserveProjectCompletionPhotoUpload(reservationInput);
      assert.equal(reserved.replayed, false);
      assert.equal(reserved.photo.asset.readyAt, null);
      assert.equal(reserved.photo.asset.expiresAt, null);
      assert.equal(reserved.photo.asset.consentVersion, null);
      const replay = await store.reserveProjectCompletionPhotoUpload({
        ...reservationInput,
        photoId: "00000000-0000-4000-8000-000000000a24",
        asset: completionAsset({
          id: "00000000-0000-4000-8000-000000000a25",
          storageKey: "postgres-completion-asset-03",
        }),
        ...completionLease({
          token: "00000000-0000-4000-8000-000000000a42",
          acquiredAt: "2026-10-05T10:00:01.000Z",
        }),
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.photo.id, reserved.photo.id);
      assert.equal(replay.photo.asset.id, reserved.photo.asset.id);
      assert.equal(replay.uploadLeaseToken, reserved.uploadLeaseToken, "an active same-key lease stays single-flight");
      await assert.rejects(
        store.reserveProjectCompletionPhotoUpload({ ...reservationInput, requestHash: "3".repeat(64) }),
        rejectsWithCode("IDEMPOTENCY_CONFLICT"),
      );

      const published = await store.publishProjectCompletionPhoto({
        userId: ownerId,
        projectId: project.id,
        photoId: reserved.photo.id,
        assetId: reserved.photo.asset.id,
        uploadLeaseToken: reserved.uploadLeaseToken,
        readyAt: reserved.photo.asset.createdAt,
      });
      assert.ok(published.asset.readyAt);
      await database.query(
        `UPDATE project_completion_photo_uploads
         SET created_at = clock_timestamp() - interval '2 hours',
             upload_lease_expires_at = clock_timestamp() - interval '1 minute'
         WHERE photo_id = $1`,
        [reserved.photo.id],
      );
      const concurrentPublishReplay = await store.publishProjectCompletionPhoto({
        userId: ownerId,
        projectId: project.id,
        photoId: reserved.photo.id,
        assetId: reserved.photo.asset.id,
        uploadLeaseToken: reserved.uploadLeaseToken,
        readyAt: reserved.photo.asset.createdAt,
      });
      assert.equal(concurrentPublishReplay.id, published.id, "the winning token replays ready state after lease expiry");
      await assert.rejects(
        store.publishProjectCompletionPhoto({
          userId: ownerId,
          projectId: project.id,
          photoId: reserved.photo.id,
          assetId: reserved.photo.asset.id,
          uploadLeaseToken: "00000000-0000-4000-8000-000000000aff",
          readyAt: reserved.photo.asset.createdAt,
        }),
        rejectsWithCode("COMPLETION_PHOTO_UPLOAD_LEASE_LOST"),
      );
      assert.equal((await store.listProjectCompletionPhotos({
        userId: ownerId,
        projectId: project.id,
        projectRevision: 1,
        limit: 20,
        offset: 0,
        now: "2026-10-05T10:00:02.000Z",
      })).length, 1);
      assert.deepEqual(await store.listProjectCompletionPhotos({
        userId: ownerId,
        projectId: project.id,
        projectRevision: 2,
        limit: 20,
        offset: 0,
        now: "2026-10-05T10:00:02.000Z",
      }), []);
      assert.equal(await store.getProjectCompletionPhoto({
        userId: otherId,
        projectId: project.id,
        photoId: published.id,
        now: "2026-10-05T10:00:02.000Z",
      }), null);

      const expiredLease = completionLease({
        token: "00000000-0000-4000-8000-000000000a44",
        acquiredAt: "2026-10-05T08:00:00.000Z",
      });
      const takeoverInput = {
        photoId: "00000000-0000-4000-8000-000000000a45",
        userId: ownerId,
        projectId: project.id,
        projectRevision: 1,
        idempotencyKey: "postgres-completion-takeover",
        requestHash: "5".repeat(64),
        ...expiredLease,
        asset: completionAsset({
          id: "00000000-0000-4000-8000-000000000a46",
          storageKey: "postgres-completion-asset-takeover",
          createdAt: "2026-10-05T08:00:00.000Z",
        }),
      };
      const expiredReservation = await store.reserveProjectCompletionPhotoUpload(takeoverInput);
      await database.query(
        `UPDATE project_completion_photo_uploads
         SET created_at = clock_timestamp() - interval '2 hours',
             upload_lease_expires_at = clock_timestamp() - interval '1 minute'
         WHERE photo_id = $1`,
        [expiredReservation.photo.id],
      );
      await database.query(
        `UPDATE assets
         SET created_at = clock_timestamp() - interval '2 hours',
             purge_available_at = clock_timestamp() - interval '1 minute'
         WHERE id = $1`,
        [expiredReservation.photo.asset.id],
      );
      const staleScanAt = new Date(Date.now() + 1_000).toISOString();
      const staleScan = await store.listAssetsForPurge(staleScanAt, 100);
      assert.ok(
        staleScan.some((asset) => asset.id === expiredReservation.photo.asset.id),
        "an expired abandoned upload must be visible to the purge scan before takeover",
      );
      await assert.rejects(
        store.publishProjectCompletionPhoto({
          userId: ownerId,
          projectId: project.id,
          photoId: expiredReservation.photo.id,
          assetId: expiredReservation.photo.asset.id,
          uploadLeaseToken: expiredReservation.uploadLeaseToken,
          readyAt: staleScanAt,
        }),
        rejectsWithCode("COMPLETION_PHOTO_UPLOAD_LEASE_LOST"),
      );
      const takeover = await store.reserveProjectCompletionPhotoUpload({
        ...takeoverInput,
        ...completionLease({
          token: "00000000-0000-4000-8000-000000000a47",
          acquiredAt: "2026-10-05T09:00:01.000Z",
        }),
      });
      assert.equal(takeover.uploadLeaseToken, "00000000-0000-4000-8000-000000000a47");
      assert.equal(
        await store.claimAssetForPurge(
          ownerId,
          takeover.photo.asset.id,
          new Date(Date.now() + 2_000).toISOString(),
        ),
        null,
        "a stale scan must lose after replay atomically renews the upload lease and asset touch",
      );
      await assert.rejects(
        store.publishProjectCompletionPhoto({
          userId: ownerId,
          projectId: project.id,
          photoId: takeover.photo.id,
          assetId: takeover.photo.asset.id,
          uploadLeaseToken: expiredReservation.uploadLeaseToken,
          readyAt: new Date(Date.now() + 3_000).toISOString(),
        }),
        rejectsWithCode("COMPLETION_PHOTO_UPLOAD_LEASE_LOST"),
      );
      const takeoverPublished = await store.publishProjectCompletionPhoto({
        userId: ownerId,
        projectId: project.id,
        photoId: takeover.photo.id,
        assetId: takeover.photo.asset.id,
        uploadLeaseToken: takeover.uploadLeaseToken,
        readyAt: new Date(Date.now() + 4_000).toISOString(),
      });
      assert.ok(takeoverPublished.asset.readyAt);

      const firstPhotoPage = await store.listProjectCompletionPhotos({
        userId: ownerId,
        projectId: project.id,
        projectRevision: 1,
        limit: 1,
        offset: 0,
        now: "2026-10-05T10:00:05.000Z",
      });
      const secondPhotoPage = await store.listProjectCompletionPhotos({
        userId: ownerId,
        projectId: project.id,
        projectRevision: 1,
        limit: 1,
        offset: 1,
        now: "2026-10-05T10:00:05.000Z",
      });
      assert.deepEqual(
        [...firstPhotoPage, ...secondPhotoPage].map((photo) => photo.id),
        [published.id, takeoverPublished.id],
        "Postgres LIMIT/OFFSET pages must be stable and ordered newest first",
      );
      assert.deepEqual(await store.listProjectCompletionPhotos({
        userId: otherId,
        projectId: project.id,
        projectRevision: 1,
        limit: 1,
        offset: 0,
        now: "2026-10-05T10:00:05.000Z",
      }), [], "another user's page must not reveal the project's photos");

      const pending = await store.reserveProjectCompletionPhotoUpload({
        photoId: "00000000-0000-4000-8000-000000000a26",
        userId: ownerId,
        projectId: project.id,
        projectRevision: 1,
        idempotencyKey: "postgres-completion-photo-02",
        requestHash: "4".repeat(64),
        ...completionLease({ token: "00000000-0000-4000-8000-000000000a43" }),
        asset: completionAsset({
          id: "00000000-0000-4000-8000-000000000a27",
          storageKey: "postgres-completion-asset-04",
          createdAt: "2026-10-05T10:00:03.000Z",
        }),
      });
      const leaseBeforeTerminal = await database.query<{ upload_lease_expires_at: Date | string }>(
        "SELECT upload_lease_expires_at FROM project_completion_photo_uploads WHERE photo_id = $1",
        [pending.photo.id],
      );
      await store.updateProjectGrid({
        userId: ownerId,
        projectId: project.id,
        baseRevision: 1,
        grid: project.grid,
      });
      await assert.rejects(
        store.publishProjectCompletionPhoto({
          userId: ownerId,
          projectId: project.id,
          photoId: pending.photo.id,
          assetId: pending.photo.asset.id,
          uploadLeaseToken: pending.uploadLeaseToken,
          readyAt: "2026-10-05T10:00:04.000Z",
        }),
        rejectsWithCode("PROJECT_COMPLETION_STATE_CHANGED"),
      );
      const tombstoned = await store.getProjectCompletionPhoto({
        userId: ownerId,
        projectId: project.id,
        photoId: pending.photo.id,
        now: "2026-10-05T10:00:05.000Z",
        includeDeleted: true,
      });
      assert.ok(tombstoned?.deletedAt);
      assert.ok(tombstoned?.asset.deletedAt);
      const leaseAfterTerminal = await database.query<{ upload_lease_expires_at: Date | string }>(
        "SELECT upload_lease_expires_at FROM project_completion_photo_uploads WHERE photo_id = $1",
        [pending.photo.id],
      );
      assert.equal(
        new Date(leaseAfterTerminal.rows[0]!.upload_lease_expires_at).getTime(),
        new Date(leaseBeforeTerminal.rows[0]!.upload_lease_expires_at).getTime(),
        "terminal publish must preserve the original writer fence",
      );

      await store.markAssetPurged(pending.photo.asset.id, "2026-10-05T10:00:05.000Z");
      const fenced = await store.getProjectCompletionPhoto({
        userId: ownerId,
        projectId: project.id,
        photoId: pending.photo.id,
        now: "2026-10-05T10:00:05.000Z",
        includeDeleted: true,
      });
      assert.equal(fenced?.asset.purgedAt, null, "an active upload lease fences purge acknowledgement");
      await database.query(
        `UPDATE project_completion_photo_uploads
         SET created_at = clock_timestamp() - interval '2 hours',
             upload_lease_expires_at = clock_timestamp() - interval '1 minute'
         WHERE photo_id = $1`,
        [pending.photo.id],
      );
      await store.markAssetPurged(pending.photo.asset.id, new Date().toISOString());
      const purgeFailureAt = "2199-01-01T00:00:00.000Z";
      await store.recordAssetPurgeFailure(pending.photo.asset.id, purgeFailureAt);
      const reopened = await store.getProjectCompletionPhoto({
        userId: ownerId,
        projectId: project.id,
        photoId: pending.photo.id,
        now: purgeFailureAt,
        includeDeleted: true,
      });
      assert.equal(reopened?.asset.purgedAt, null, "a late cleanup failure reopens an acknowledged purge");
      assert.ok(
        !(await store.listAssetsForPurge("2199-01-01T00:00:00.000Z", 100))
          .some((asset) => asset.id === pending.photo.asset.id),
        "the cleanup caller clock cannot skip the database-managed retry backoff",
      );
      await database.query(
        `UPDATE assets
         SET purge_available_at = clock_timestamp() - interval '1 second'
         WHERE id = $1`,
        [pending.photo.asset.id],
      );
      assert.ok(
        (await store.listAssetsForPurge(new Date().toISOString(), 100))
          .some((asset) => asset.id === pending.photo.asset.id),
        "the purge worker can retry the reopened encrypted object after database backoff",
      );

      const deleted = await store.deleteProjectCompletionPhoto({
        userId: ownerId,
        projectId: project.id,
        photoId: published.id,
        deletedAt: "2026-10-05T10:00:06.000Z",
      });
      assert.ok(deleted?.deletedAt);
      assert.ok(deleted?.asset.deletedAt);
    } finally {
      await store.close();
    }
  });

  it("returns a stable terminal replay after the project is soft-deleted", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await prepareDatabase(database);
      const project = await store.createProject(ownerId, {
        name: "软删重放作品",
        paletteId: "completion-test",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["T01"] },
      });
      await store.saveBuildProgress({
        userId: ownerId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 0,
        completedIndices: [0],
        elapsedTime: 1,
      });
      const input = {
        photoId: "00000000-0000-4000-8000-000000000a48",
        userId: ownerId,
        projectId: project.id,
        projectRevision: 1,
        idempotencyKey: "soft-delete-replay-key",
        requestHash: "6".repeat(64),
        ...completionLease({ token: "00000000-0000-4000-8000-000000000a49" }),
        asset: completionAsset({
          id: "00000000-0000-4000-8000-000000000a4a",
          storageKey: "soft-delete-replay-asset",
          createdAt: "2020-01-01T00:00:00.000Z",
        }),
      };
      await store.reserveProjectCompletionPhotoUpload(input);
      assert.equal(await store.deleteProject(ownerId, project.id), true);
      await assert.rejects(
        store.reserveProjectCompletionPhotoUpload({
          ...input,
          ...completionLease({
            token: "00000000-0000-4000-8000-000000000a4b",
            acquiredAt: "2026-10-05T10:01:00.000Z",
          }),
        }),
        rejectsWithCode("COMPLETION_PHOTO_UPLOAD_UNAVAILABLE"),
      );
    } finally {
      await store.close();
    }
  });

  it("keeps durable completion capacity independent from the 20-item AI asset quota", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await prepareDatabase(database);
      for (let index = 0; index < 20; index += 1) {
        await store.createAsset({
          id: `00000000-0000-4000-8000-${(1000 + index).toString().padStart(12, "0")}`,
          userId: ownerId,
          purpose: "ai-source",
          consentVersion: "privacy-v1",
          sha256: index.toString(16).padStart(64, "0"),
          mimeType: "image/png",
          sizeBytes: 10,
          width: 1,
          height: 1,
          storageKey: `ai-quota-storage-${index.toString().padStart(3, "0")}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
          createdAt: `2026-10-05T10:${index.toString().padStart(2, "0")}:00.000Z`,
        });
      }
      await assert.rejects(
        store.createAsset({
          id: "00000000-0000-4000-8000-000000009999",
          userId: ownerId,
          purpose: "ai-source",
          consentVersion: "privacy-v1",
          sha256: "f".repeat(64),
          mimeType: "image/png",
          sizeBytes: 10,
          width: 1,
          height: 1,
          storageKey: "ai-quota-storage-overflow",
          expiresAt: "2099-01-01T00:00:00.000Z",
          createdAt: "2026-10-05T11:00:00.000Z",
        }),
        rejectsWithCode("ASSET_QUOTA_EXCEEDED"),
      );
      const completion = await store.createAsset(completionAsset({
        id: "00000000-0000-4000-8000-000000000a30",
        storageKey: "independent-completion-quota",
        createdAt: "2026-10-05T11:00:01.000Z",
      }));
      assert.equal(completion.purpose, "project-completion");
      assert.equal(completion.expiresAt, null);
    } finally {
      await store.close();
    }
  });
});
