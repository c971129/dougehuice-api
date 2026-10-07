import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { calculateAssetConsentPolicySha256 } from "../src/domain/asset-consent.js";
import { AppError } from "../src/errors.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const ownerId = "00000000-0000-4000-8000-000000002701";
const otherUserId = "00000000-0000-4000-8000-000000002799";
const CONSENT_POLICY_TEXT = {
  processor: "pindou-postgres-test-processor",
  processingPurpose: "将用户提供的图片处理为拼豆图纸",
  retention: "AI 素材最长保留 23 小时，之后进入清理流程",
};
const CONSENT_POLICY = {
  policySha256: calculateAssetConsentPolicySha256("privacy-v1", CONSENT_POLICY_TEXT),
  ...CONSENT_POLICY_TEXT,
};
const CHANGED_CONSENT_POLICY_TEXT = {
  ...CONSENT_POLICY_TEXT,
  retention: "测试中的另一份保留说明",
};
const CHANGED_CONSENT_POLICY = {
  policySha256: calculateAssetConsentPolicySha256("privacy-v1", CHANGED_CONSENT_POLICY_TEXT),
  ...CHANGED_CONSENT_POLICY_TEXT,
};
const LEGACY_POLICY_TEXT = {
  processor: "legacy-unrecorded",
  processingPurpose: "legacy-unrecorded: 历史素材未记录处理用途快照",
  retention: "legacy-unrecorded: 历史素材未记录保留说明快照",
};

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

function assetInput(input: {
  id?: string;
  storageKey?: string;
  createdAt?: string;
  purpose?: "ai-source" | "ai-intermediate";
}) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    id: input.id ?? randomUUID(),
    userId: ownerId,
    purpose: input.purpose ?? "ai-source" as const,
    consentVersion: "privacy-v1",
    sha256: "a".repeat(64),
    mimeType: "image/png" as const,
    sizeBytes: 128,
    width: 4,
    height: 3,
    storageKey: input.storageKey ?? `asset-upload-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    createdAt,
  };
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

async function prepare(database: PGlite): Promise<PostgresStore> {
  for (const migration of await loadMigrationFiles()) await database.exec(migration.sql);
  await database.exec(`
    INSERT INTO users(id, display_name)
    VALUES ('${ownerId}', '素材幂等测试用户');
  `);
  return new PostgresStore(poolFor(database));
}

describe("PostgresStore generic asset upload idempotency", () => {
  it("backfills ready assets and makes tenant-bound consent evidence immutable", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      const consentMigration = migrations.find((migration) => migration.version === "0033_asset_consent_events.sql");
      assert.ok(consentMigration);
      for (const migration of migrations) {
        if (migration.version === consentMigration.version) break;
        await database.exec(migration.sql);
      }
      const legacyAssetId = "00000000-0000-4000-8000-000000003301";
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('${ownerId}', '同意审计迁移用户'),
          ('${otherUserId}', '同意审计其他用户');
        INSERT INTO assets(
          id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
          width, height, storage_key, expires_at, ready_at, created_at
        ) VALUES (
          '${legacyAssetId}', '${ownerId}', 'ai-source', 'privacy-v1',
          '${"3".repeat(64)}', 'image/png', 128, 4, 3,
          'asset-consent-legacy-object', now() + interval '1 day', now(), now() - interval '1 minute'
        );
      `);
      await database.exec(consentMigration.sql);

      const rows = await database.query<{
        user_id: string;
        asset_id: string;
        consent_version: string;
        asset_purpose: string;
        policy_sha256: string;
        processor: string;
        processing_purpose: string;
        retention: string;
        source: string;
      }>(
        `SELECT user_id::text, asset_id::text, consent_version, asset_purpose,
                policy_sha256, processor, processing_purpose, retention, source
         FROM asset_consent_events`,
      );
      assert.deepEqual(rows.rows, [{
        user_id: ownerId,
        asset_id: legacyAssetId,
        consent_version: "privacy-v1",
        asset_purpose: "ai-source",
        policy_sha256: calculateAssetConsentPolicySha256("privacy-v1", LEGACY_POLICY_TEXT),
        processor: LEGACY_POLICY_TEXT.processor,
        processing_purpose: LEGACY_POLICY_TEXT.processingPurpose,
        retention: LEGACY_POLICY_TEXT.retention,
        source: "legacy-asset-backfill",
      }]);

      await assert.rejects(
        database.query(
          "UPDATE asset_consent_events SET consent_version = 'privacy-v2' WHERE asset_id = $1",
          [legacyAssetId],
        ),
        /asset consent events are immutable|asset_consent_events_immutable/i,
      );
      await assert.rejects(
        database.query("DELETE FROM asset_consent_events WHERE asset_id = $1", [legacyAssetId]),
        /asset consent events are immutable|asset_consent_events_immutable/i,
      );
      await assert.rejects(
        database.query(
          `INSERT INTO asset_consent_events(
             id, user_id, asset_id, consent_version, asset_purpose,
             policy_sha256, processor, processing_purpose, retention, source, occurred_at
           ) VALUES ($1, $2, $3, 'privacy-v1', 'ai-source', $4, $5, $6, $7, 'asset-upload', now())`,
          [
            randomUUID(), otherUserId, legacyAssetId,
            CONSENT_POLICY.policySha256, CONSENT_POLICY.processor,
            CONSENT_POLICY.processingPurpose, CONSENT_POLICY.retention,
          ],
        ),
        /asset consent event does not match|asset_consent_events_asset_snapshot_valid/i,
      );

      await database.query("DELETE FROM assets WHERE id = $1", [legacyAssetId]);
      const retained = await database.query<{ asset_id: string }>(
        "SELECT asset_id::text FROM asset_consent_events WHERE asset_id = $1",
        [legacyAssetId],
      );
      assert.equal(retained.rows[0]?.asset_id, legacyAssetId, "asset compaction cannot erase audit evidence");
    } finally {
      await database.close();
    }
  });

  it("publishes an asset and its single consent event in one transaction", async () => {
    const database = new PGlite();
    try {
      const store = await prepare(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '同意审计隔离用户')", [otherUserId]);
      const assetId = "00000000-0000-4000-8000-000000003311";
      const token = "00000000-0000-4000-8000-000000003312";
      const key = "asset-consent-publish-0001";
      await store.reserveAssetUpload({
        userId: ownerId,
        scope: "assets:create",
        idempotencyKey: key,
        requestHash: "4".repeat(64),
        uploadLeaseToken: token,
        uploadLeaseAcquiredAt: new Date().toISOString(),
        asset: assetInput({ id: assetId, storageKey: "asset-consent-publish-object" }),
      });
      assert.deepEqual(await store.listAssetConsentEvents({ userId: ownerId, limit: 10, offset: 0 }), []);

      await assert.rejects(
        store.publishAssetUpload({
          userId: ownerId,
          scope: "assets:create",
          idempotencyKey: key,
          assetId,
          uploadLeaseToken: token,
          readyAt: new Date().toISOString(),
          consentPolicy: { ...CONSENT_POLICY, policySha256: "0".repeat(64) },
        }),
        rejectsWithCode("ASSET_CONSENT_POLICY_HASH_INVALID"),
      );
      assert.equal((await store.getAsset(ownerId, assetId))?.readyAt, null);
      assert.deepEqual(await store.listAssetConsentEvents({ userId: ownerId, limit: 10, offset: 0 }), []);
      await assert.rejects(
        store.publishAssetUpload({
          userId: ownerId,
          scope: "assets:create",
          idempotencyKey: key,
          assetId,
          uploadLeaseToken: token,
          readyAt: new Date().toISOString(),
          consentPolicy: { ...CONSENT_POLICY, processor: ` ${CONSENT_POLICY.processor}` },
        }),
        rejectsWithCode("ASSET_CONSENT_POLICY_TEXT_INVALID"),
      );
      assert.equal((await store.getAsset(ownerId, assetId))?.readyAt, null);
      assert.deepEqual(await store.listAssetConsentEvents({ userId: ownerId, limit: 10, offset: 0 }), []);

      await database.exec(`
        CREATE FUNCTION reject_test_asset_consent_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'forced consent audit failure';
        END;
        $$;
        CREATE TRIGGER aaa_reject_test_asset_consent_insert
        BEFORE INSERT ON asset_consent_events
        FOR EACH ROW EXECUTE FUNCTION reject_test_asset_consent_insert();
      `);
      await assert.rejects(
        store.publishAssetUpload({
          userId: ownerId,
          scope: "assets:create",
          idempotencyKey: key,
          assetId,
          uploadLeaseToken: token,
          readyAt: new Date().toISOString(),
          consentPolicy: CONSENT_POLICY,
        }),
        /forced consent audit failure/i,
      );
      const rolledBack = await database.query<{ ready_at: Date | string | null; event_count: number | string }>(
        `SELECT asset.ready_at,
                (SELECT count(*) FROM asset_consent_events WHERE asset_id = asset.id) AS event_count
         FROM assets AS asset WHERE asset.id = $1`,
        [assetId],
      );
      assert.equal(rolledBack.rows[0]?.ready_at, null);
      assert.equal(Number(rolledBack.rows[0]?.event_count), 0);

      await database.exec(`
        DROP TRIGGER aaa_reject_test_asset_consent_insert ON asset_consent_events;
        DROP FUNCTION reject_test_asset_consent_insert();
      `);
      const published = await store.publishAssetUpload({
        userId: ownerId,
        scope: "assets:create",
        idempotencyKey: key,
        assetId,
        uploadLeaseToken: token,
        readyAt: new Date().toISOString(),
        consentPolicy: CONSENT_POLICY,
      });
      assert.ok(published.readyAt);
      await store.publishAssetUpload({
        userId: ownerId,
        scope: "assets:create",
        idempotencyKey: key,
        assetId,
        uploadLeaseToken: token,
        readyAt: new Date().toISOString(),
        consentPolicy: CONSENT_POLICY,
      });
      await assert.rejects(
        store.publishAssetUpload({
          userId: ownerId,
          scope: "assets:create",
          idempotencyKey: key,
          assetId,
          uploadLeaseToken: token,
          readyAt: new Date().toISOString(),
          consentPolicy: CHANGED_CONSENT_POLICY,
        }),
        rejectsWithCode("ASSET_CONSENT_EVENT_CONFLICT"),
      );

      const events = await store.listAssetConsentEvents({ userId: ownerId, limit: 10, offset: 0 });
      assert.equal(events.length, 1, "publish replay cannot duplicate immutable evidence");
      assert.deepEqual({
        assetId: events[0]?.assetId,
        consentVersion: events[0]?.consentVersion,
        assetPurpose: events[0]?.assetPurpose,
        policySha256: events[0]?.policySha256,
        processor: events[0]?.processor,
        processingPurpose: events[0]?.processingPurpose,
        retention: events[0]?.retention,
        source: events[0]?.source,
      }, {
        assetId,
        consentVersion: "privacy-v1",
        assetPurpose: "ai-source",
        ...CONSENT_POLICY,
        source: "asset-upload",
      });
      assert.deepEqual(
        await store.listAssetConsentEvents({ userId: otherUserId, limit: 10, offset: 0 }),
        [],
      );
    } finally {
      await database.close();
    }
  });

  it("creates the scoped reservation schema and enforces its asset purpose binding", async () => {
    const database = new PGlite();
    try {
      await prepare(database);
      const columns = await database.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'asset_uploads'
         ORDER BY ordinal_position`,
      );
      assert.deepEqual(columns.rows.map((row) => row.column_name), [
        "user_id",
        "scope",
        "idempotency_key",
        "request_hash",
        "asset_id",
        "asset_purpose",
        "upload_lease_token",
        "upload_lease_expires_at",
        "created_at",
      ]);
      const indexes = await database.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'asset_uploads'
         ORDER BY indexname`,
      );
      assert.ok(indexes.rows.some((row) => row.indexname === "asset_uploads_active_lease_idx"));

      await database.exec(`
        INSERT INTO assets(
          id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
          width, height, storage_key, expires_at, created_at
        ) VALUES (
          '00000000-0000-4000-8000-000000002702', '${ownerId}',
          'project-completion', NULL, '${"a".repeat(64)}', 'image/png', 10,
          1, 1, 'asset-upload-purpose-fk', NULL, now()
        );
      `);
      await assert.rejects(
        database.exec(`
          INSERT INTO asset_uploads(
            user_id, scope, idempotency_key, request_hash, asset_id, asset_purpose,
            upload_lease_token, upload_lease_expires_at
          ) VALUES (
            '${ownerId}', 'assets:create', 'asset-invalid-purpose', '${"b".repeat(64)}',
            '00000000-0000-4000-8000-000000002702', 'ai-source',
            '00000000-0000-4000-8000-000000002703', now() + interval '15 minutes'
          )
        `),
        /foreign key|violates.*constraint/i,
      );
    } finally {
      await database.close();
    }
  });

  it("replays one quota-bearing row, isolates scopes, and detects request conflicts", async () => {
    const database = new PGlite();
    try {
      const store = await prepare(database);
      const now = new Date().toISOString();
      const key = "asset-postgres-replay-0001";
      const hash = "c".repeat(64);
      const firstToken = "00000000-0000-4000-8000-000000002711";
      const first = await store.reserveAssetUpload({
        userId: ownerId,
        scope: "assets:create",
        idempotencyKey: key,
        requestHash: hash,
        uploadLeaseToken: firstToken,
        uploadLeaseAcquiredAt: now,
        asset: assetInput({ id: "00000000-0000-4000-8000-000000002712", storageKey: "asset-postgres-object-001" }),
      });
      assert.equal(first.replayed, false);
      const replay = await store.reserveAssetUpload({
        userId: ownerId,
        scope: "assets:create",
        idempotencyKey: key,
        requestHash: hash,
        uploadLeaseToken: "00000000-0000-4000-8000-000000002713",
        uploadLeaseAcquiredAt: new Date().toISOString(),
        asset: assetInput({ id: randomUUID(), storageKey: "unused-postgres-replay-key" }),
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.asset.id, first.asset.id);
      assert.equal(replay.uploadLeaseToken, firstToken, "an active replay shares the winning token");
      await assert.rejects(
        store.reserveAssetUpload({
          userId: ownerId,
          scope: "assets:create",
          idempotencyKey: key,
          requestHash: "d".repeat(64),
          uploadLeaseToken: randomUUID(),
          uploadLeaseAcquiredAt: new Date().toISOString(),
          asset: assetInput({}),
        }),
        rejectsWithCode("IDEMPOTENCY_CONFLICT"),
      );
      const otherScope = await store.reserveAssetUpload({
        userId: ownerId,
        scope: "assets:alternate",
        idempotencyKey: key,
        requestHash: hash,
        uploadLeaseToken: randomUUID(),
        uploadLeaseAcquiredAt: new Date().toISOString(),
        asset: assetInput({ purpose: "ai-intermediate" }),
      });
      assert.notEqual(otherScope.asset.id, first.asset.id);

      const counts = await database.query<{ assets: number | string; product_requests: number | string }>(
        `SELECT
           (SELECT count(*) FROM assets WHERE user_id = '${ownerId}' AND purpose <> 'project-completion') AS assets,
           (SELECT request_count FROM user_rate_limits
             WHERE user_id = '${ownerId}' AND action = 'asset-upload') AS product_requests`,
      );
      assert.equal(Number(counts.rows[0]?.assets), 2);
      assert.equal(Number(counts.rows[0]?.product_requests), 2, "replay and conflict do not consume product quota");

      const published = await store.publishAssetUpload({
        userId: ownerId,
        scope: "assets:create",
        idempotencyKey: key,
        assetId: first.asset.id,
        uploadLeaseToken: firstToken,
        readyAt: new Date().toISOString(),
        consentPolicy: CONSENT_POLICY,
      });
      assert.ok(published.readyAt);
      await database.exec("UPDATE asset_uploads SET created_at = clock_timestamp() - interval '16 minutes', upload_lease_expires_at = clock_timestamp() - interval '1 second' WHERE asset_id = '00000000-0000-4000-8000-000000002712'");
      assert.equal((await store.publishAssetUpload({
        userId: ownerId,
        scope: "assets:create",
        idempotencyKey: key,
        assetId: first.asset.id,
        uploadLeaseToken: firstToken,
        readyAt: new Date().toISOString(),
        consentPolicy: CONSENT_POLICY,
      })).id, first.asset.id, "winning token replays ready state after lease expiry");
      await assert.rejects(
        store.publishAssetUpload({
          userId: ownerId,
          scope: "assets:create",
          idempotencyKey: key,
          assetId: first.asset.id,
          uploadLeaseToken: randomUUID(),
          readyAt: new Date().toISOString(),
          consentPolicy: CONSENT_POLICY,
        }),
        rejectsWithCode("ASSET_UPLOAD_LEASE_LOST"),
      );
    } finally {
      await database.close();
    }
  });

  it("takes over an expired pending lease and fences purge until the new writer is quiescent", async () => {
    const database = new PGlite();
    try {
      const store = await prepare(database);
      const assetId = "00000000-0000-4000-8000-000000002721";
      const key = "asset-postgres-takeover-0001";
      const oldToken = "00000000-0000-4000-8000-000000002722";
      const newToken = "00000000-0000-4000-8000-000000002723";
      const oldCreatedAt = new Date(Date.now() - 16 * 60_000).toISOString();
      await store.reserveAssetUpload({
        userId: ownerId,
        scope: "assets:create",
        idempotencyKey: key,
        requestHash: "e".repeat(64),
        uploadLeaseToken: oldToken,
        uploadLeaseAcquiredAt: oldCreatedAt,
        asset: assetInput({ id: assetId, storageKey: "asset-postgres-object-002", createdAt: oldCreatedAt }),
      });
      await database.exec(`
        UPDATE asset_uploads
        SET created_at = clock_timestamp() - interval '16 minutes',
            upload_lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE asset_id = '${assetId}';
        UPDATE assets
        SET purge_available_at = clock_timestamp() - interval '1 second'
        WHERE id = '${assetId}';
      `);
      assert.deepEqual((await store.listAssetsForPurge(new Date().toISOString(), 10)).map((asset) => asset.id), [assetId]);

      const replay = await store.reserveAssetUpload({
        userId: ownerId,
        scope: "assets:create",
        idempotencyKey: key,
        requestHash: "e".repeat(64),
        uploadLeaseToken: newToken,
        uploadLeaseAcquiredAt: new Date().toISOString(),
        asset: assetInput({}),
      });
      assert.equal(replay.uploadLeaseToken, newToken);
      assert.equal(await store.claimAssetForPurge(ownerId, assetId, new Date().toISOString()), null);
      await assert.rejects(
        store.publishAssetUpload({
          userId: ownerId,
          scope: "assets:create",
          idempotencyKey: key,
          assetId,
          uploadLeaseToken: oldToken,
          readyAt: new Date().toISOString(),
          consentPolicy: CONSENT_POLICY,
        }),
        rejectsWithCode("ASSET_UPLOAD_LEASE_LOST"),
      );
      await store.markAssetDeleted(ownerId, assetId, new Date().toISOString());
      await store.markAssetPurged(assetId, new Date().toISOString());
      assert.equal((await store.getAsset(ownerId, assetId))?.purgedAt, null, "active upload lease fences purge acknowledgement");
      await database.exec(`
        UPDATE asset_uploads
        SET created_at = clock_timestamp() - interval '16 minutes',
            upload_lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE asset_id = '${assetId}'
      `);
      await store.markAssetPurged(assetId, new Date().toISOString());
      assert.ok((await store.getAsset(ownerId, assetId))?.purgedAt);
    } finally {
      await database.close();
    }
  });

  it("uses database time so a future caller clock cannot bypass leases or expire ready assets", async () => {
    const database = new PGlite();
    try {
      const store = await prepare(database);
      const assetId = "00000000-0000-4000-8000-000000002731";
      const leaseToken = "00000000-0000-4000-8000-000000002732";
      const idempotencyKey = "asset-postgres-database-clock-0001";
      const reserved = await store.reserveAssetUpload({
        userId: ownerId,
        scope: "assets:create",
        idempotencyKey,
        requestHash: "f".repeat(64),
        uploadLeaseToken: leaseToken,
        uploadLeaseAcquiredAt: new Date().toISOString(),
        asset: assetInput({ id: assetId, storageKey: "asset-postgres-object-clock" }),
      });
      await database.query(
        `UPDATE assets
         SET created_at = clock_timestamp() - interval '16 minutes',
             purge_available_at = clock_timestamp() - interval '1 second'
         WHERE id = $1`,
        [assetId],
      );
      const futureCallerNow = "2199-01-01T00:00:00.000Z";
      assert.ok(
        !(await store.listAssetsForPurge(futureCallerNow, 10)).some((asset) => asset.id === assetId),
        "an active database lease wins over a cleanup host clock far in the future",
      );
      assert.equal(await store.claimAssetForPurge(ownerId, assetId, futureCallerNow), null);

      await store.publishAssetUpload({
        userId: ownerId,
        scope: "assets:create",
        idempotencyKey,
        assetId,
        uploadLeaseToken: reserved.uploadLeaseToken,
        readyAt: new Date().toISOString(),
        consentPolicy: CONSENT_POLICY,
      });
      await database.query(
        `UPDATE asset_uploads
         SET created_at = clock_timestamp() - interval '16 minutes',
             upload_lease_expires_at = clock_timestamp() - interval '1 second'
         WHERE asset_id = $1`,
        [assetId],
      );
      assert.ok(
        !(await store.listAssetsForPurge(futureCallerNow, 10)).some((asset) => asset.id === assetId),
        "a ready asset whose database expiry is in the future cannot be purged early",
      );
      assert.equal(await store.claimAssetForPurge(ownerId, assetId, futureCallerNow), null);
      await database.query(
        "UPDATE assets SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [assetId],
      );
      assert.equal(
        (await store.claimAssetForPurge(ownerId, assetId, "2000-01-01T00:00:00.000Z"))?.id,
        assetId,
        "database expiry makes the asset claimable regardless of a stale cleanup host clock",
      );
      await store.recordAssetPurgeFailure(assetId, "2199-01-01T00:00:00.000Z");
      const firstBackoff = await database.query<{ remaining_ms: number | string }>(
        `SELECT EXTRACT(EPOCH FROM (purge_available_at - clock_timestamp())) * 1000 AS remaining_ms
         FROM assets WHERE id = $1`,
        [assetId],
      );
      assert.ok(
        Number(firstBackoff.rows[0]?.remaining_ms) > 10_000
          && Number(firstBackoff.rows[0]?.remaining_ms) < 45_000,
        "a future failure timestamp cannot move the first database-managed asset backoff",
      );
      await store.recordAssetPurgeFailure(assetId, "2000-01-01T00:00:00.000Z");
      const secondBackoff = await database.query<{ remaining_ms: number | string }>(
        `SELECT EXTRACT(EPOCH FROM (purge_available_at - clock_timestamp())) * 1000 AS remaining_ms
         FROM assets WHERE id = $1`,
        [assetId],
      );
      assert.ok(
        Number(secondBackoff.rows[0]?.remaining_ms) > 35_000
          && Number(secondBackoff.rows[0]?.remaining_ms) < 75_000,
        "a past failure timestamp cannot expire the second database-managed asset backoff",
      );
    } finally {
      await database.close();
    }
  });
});
