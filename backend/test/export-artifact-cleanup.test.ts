import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { ExportArtifactRecord } from "../src/domain/models.js";
import { purgeExpiredExportArtifacts } from "../src/exports/artifact-cleanup.js";
import { processNextExport } from "../src/exports/worker.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import type { StorageObjectContext, StorageProvider } from "../src/storage/storage-provider.js";

const NOW = "2026-10-04T12:00:00.000Z";
const WORKER_KEY = "pindou-test-worker-key-at-least-32-chars";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused",
  databaseSsl: false,
  devAuthEnabled: true,
  corsOrigins: ["http://localhost:5173"],
  sessionTtlDays: 30,
  devStartingCredits: 20,
  assetStorageRoot: join(tmpdir(), "pindou-export-artifact-cleanup-test"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: WORKER_KEY,
};

class CleanupStorage implements StorageProvider {
  readonly objects = new Set<string>();
  readonly deleteAttempts: string[] = [];
  readonly failuresRemaining = new Map<string, number>();

  async ready(): Promise<void> {}

  async put(_contents: Buffer, _context: StorageObjectContext, storageKey = "unused"): Promise<{ storageKey: string }> {
    this.objects.add(storageKey);
    return { storageKey };
  }

  async get(): Promise<Buffer | null> {
    return null;
  }

  async delete(storageKey: string): Promise<void> {
    this.deleteAttempts.push(storageKey);
    const failures = this.failuresRemaining.get(storageKey) ?? 0;
    if (failures > 0) {
      this.failuresRemaining.set(storageKey, failures - 1);
      throw Object.assign(new Error("transient test deletion failure"), { code: "TEST_DELETE_TRANSIENT" });
    }
    this.objects.delete(storageKey);
  }
}

class PutThenThrowStorage extends CleanupStorage {
  override async put(
    _contents: Buffer,
    _context: StorageObjectContext,
    storageKey = "unused",
  ): Promise<{ storageKey: string }> {
    this.objects.add(storageKey);
    throw Object.assign(new Error("storage acknowledgement lost"), { code: "TEST_PUT_ACK_LOST" });
  }
}

interface SeededArtifact {
  id: string;
  storageKey: string;
  expiresAt: string;
}

async function seedSucceededExports(
  store: MemoryStore,
  storage: CleanupStorage,
  artifacts: SeededArtifact[],
): Promise<void> {
  const session = await store.createDevSession({
    displayName: "导出清理测试用户",
    tokenHash: "a".repeat(64),
    expiresAt: "2027-10-04T00:00:00.000Z",
    startingCredits: 0,
  });
  const project = await store.createProject(session.user.id, {
    name: "待清理导出",
    paletteId: "mard-48-v1",
    grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
  });

  for (const [index, seeded] of artifacts.entries()) {
    const sequence = String(index + 1).padStart(12, "0");
    const jobId = `00000000-0000-4000-8000-${sequence}`;
    const leaseToken = `10000000-0000-4000-8000-${sequence}`;
    const createdAt = `2026-10-04T09:0${index}:00.000Z`;
    await store.createExportJob({
      id: jobId,
      userId: session.user.id,
      projectId: project.id,
      projectRevision: project.currentRevision,
      format: "png",
      fileName: `artifact-${index + 1}.png`,
      options: {
        paper: "A4",
        orientation: "auto",
        showCodes: true,
        showGrid: true,
        transparentBackground: false,
      },
      now: createdAt,
    });
    const claimed = await store.claimNextExportJob({
      now: createdAt,
      leaseToken,
      leaseMilliseconds: 3_600_000,
    });
    assert.equal(claimed?.id, jobId);
    const artifact: ExportArtifactRecord = {
      id: seeded.id,
      jobId,
      storageKey: seeded.storageKey,
      mimeType: "image/png",
      fileName: `artifact-${index + 1}.png`,
      sizeBytes: 1,
      sha256: String(index + 1).repeat(64),
      expiresAt: seeded.expiresAt,
      createdAt,
    };
    await store.prepareExportArtifact({ jobId, leaseToken, artifact, now: createdAt });
    await store.completeExportJob({ jobId, leaseToken, artifact, now: createdAt });
    storage.objects.add(seeded.storageKey);
  }
}

describe("export artifact cleanup", () => {
  it("purges and marks expired artifacts, retains future ones, and retries isolated deletion failures", async () => {
    const store = new MemoryStore();
    const storage = new CleanupStorage();
    const failedOnce = {
      id: "20000000-0000-4000-8000-000000000001",
      storageKey: "exports/expired-delete-fails-once",
      expiresAt: "2026-10-04T10:00:00.000Z",
    };
    const deleted = {
      id: "20000000-0000-4000-8000-000000000002",
      storageKey: "exports/expired-delete-succeeds",
      expiresAt: "2026-10-04T11:00:00.000Z",
    };
    const future = {
      id: "20000000-0000-4000-8000-000000000003",
      storageKey: "exports/future-retained",
      expiresAt: "2026-10-04T13:00:00.000Z",
    };
    await seedSucceededExports(store, storage, [failedOnce, deleted, future]);
    storage.failuresRemaining.set(failedOnce.storageKey, 1);

    const marked: Array<{ artifactId: string; purgedAt: string }> = [];
    const markExportArtifactPurged = store.markExportArtifactPurged.bind(store);
    store.markExportArtifactPurged = async (artifactId, purgedAt) => {
      await markExportArtifactPurged(artifactId, purgedAt);
      marked.push({ artifactId, purgedAt });
    };

    const first = await purgeExpiredExportArtifacts({ store, storage, now: NOW, limit: 1 });
    assert.deepEqual(first, {
      scanned: 1,
      purged: 0,
      failed: 1,
      failures: [{ artifactId: failedOnce.id, code: "TEST_DELETE_TRANSIENT", retryable: true }],
    });
    assert.equal(storage.objects.has(failedOnce.storageKey), true);
    assert.equal(storage.objects.has(deleted.storageKey), true);
    assert.equal(storage.objects.has(future.storageKey), true);
    assert.deepEqual(marked, []);
    assert.deepEqual(
      (await store.listExportArtifactsForPurge(NOW, 10)).map((artifact) => artifact.id),
      [deleted.id],
    );

    const fairProgress = await purgeExpiredExportArtifacts({ store, storage, now: NOW, limit: 1 });
    assert.deepEqual(fairProgress, { scanned: 1, purged: 1, failed: 0, failures: [] });
    assert.equal(storage.objects.has(deleted.storageKey), false);
    assert.deepEqual(marked, [{ artifactId: deleted.id, purgedAt: NOW }]);

    const retry = await purgeExpiredExportArtifacts({ store, storage, now: NOW, limit: 1 });
    assert.deepEqual(retry, { scanned: 0, purged: 0, failed: 0, failures: [] });
    const retryAt = "2026-10-04T12:00:30.000Z";
    const afterBackoff = await purgeExpiredExportArtifacts({ store, storage, now: retryAt, limit: 1 });
    assert.deepEqual(afterBackoff, { scanned: 1, purged: 1, failed: 0, failures: [] });
    assert.equal(storage.objects.has(failedOnce.storageKey), false);
    assert.equal(storage.objects.has(future.storageKey), true);
    assert.deepEqual(marked, [
      { artifactId: deleted.id, purgedAt: NOW },
      { artifactId: failedOnce.id, purgedAt: retryAt },
    ]);
    assert.deepEqual(await store.listExportArtifactsForPurge(NOW, 10), []);
    assert.deepEqual(
      (await store.listExportArtifactsForPurge("2026-10-04T14:00:00.000Z", 10)).map((artifact) => artifact.id),
      [future.id],
    );
    assert.deepEqual(storage.deleteAttempts, [
      failedOnce.storageKey,
      deleted.storageKey,
      failedOnce.storageKey,
    ]);
  });

  it("makes a stale pending claim irreversible and retries deletion without losing its key", async () => {
    const store = new MemoryStore();
    const storage = new CleanupStorage();
    const session = await store.createDevSession({
      displayName: "发布竞态测试用户",
      tokenHash: "b".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    const project = await store.createProject(session.user.id, {
      name: "发布竞态",
      paletteId: "mard-48-v1",
      grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
    });
    const jobId = "30000000-0000-4000-8000-000000000001";
    const leaseToken = "30000000-0000-4000-8000-000000000002";
    const artifact: ExportArtifactRecord = {
      id: "30000000-0000-4000-8000-000000000003",
      jobId,
      storageKey: "exports/stale-pending-race",
      mimeType: "image/png",
      fileName: "race.png",
      sizeBytes: 1,
      sha256: "f".repeat(64),
      expiresAt: "2026-10-11T09:00:00.000Z",
      createdAt: "2026-10-04T09:00:00.000Z",
    };
    await store.createExportJob({
      id: jobId,
      userId: session.user.id,
      projectId: project.id,
      projectRevision: project.currentRevision,
      format: "png",
      fileName: artifact.fileName,
      options: { paper: "A4", orientation: "auto", showCodes: true, showGrid: true, transparentBackground: false },
      now: artifact.createdAt,
    });
    await store.claimNextExportJob({
      now: artifact.createdAt,
      leaseToken,
      leaseMilliseconds: 3_600_000,
    });
    await store.prepareExportArtifact({ jobId, leaseToken, artifact, now: artifact.createdAt });
    storage.objects.add(artifact.storageKey);
    storage.failuresRemaining.set(artifact.storageKey, 1);

    const cleanupAt = "2026-10-04T09:16:00.000Z";
    const first = await purgeExpiredExportArtifacts({ store, storage, now: cleanupAt, limit: 1 });
    assert.equal(first.failed, 1);
    await assert.rejects(
      store.completeExportJob({ jobId, leaseToken, artifact, now: cleanupAt }),
      (error: unknown) => typeof error === "object" && error !== null
        && "code" in error && error.code === "EXPORT_ARTIFACT_NOT_PREPARED",
    );
    assert.equal(storage.objects.has(artifact.storageKey), true);

    const retried = await purgeExpiredExportArtifacts({
      store,
      storage,
      now: "2026-10-04T09:16:30.000Z",
      limit: 1,
    });
    assert.equal(retried.purged, 1);
    assert.equal(storage.objects.has(artifact.storageKey), false);
  });

  it("tracks bytes left by a final-attempt put acknowledgement loss and later purges them", async () => {
    const store = new MemoryStore();
    const storage = new PutThenThrowStorage();
    const session = await store.createDevSession({
      displayName: "最终重试测试用户",
      tokenHash: "c".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    const project = await store.createProject(session.user.id, {
      name: "最终重试",
      paletteId: "mard-48-v1",
      grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
    });
    const jobId = "30000000-0000-4000-8000-000000000011";
    const createdAt = "2026-10-04T09:00:00.000Z";
    await store.createExportJob({
      id: jobId,
      userId: session.user.id,
      projectId: project.id,
      projectRevision: project.currentRevision,
      format: "png",
      fileName: "final-attempt.png",
      options: { paper: "A4", orientation: "auto", showCodes: true, showGrid: true, transparentBackground: false },
      now: createdAt,
    });
    for (const suffix of ["012", "013"]) {
      const leaseToken = `30000000-0000-4000-8000-000000000${suffix}`;
      await store.claimNextExportJob({
        now: createdAt,
        leaseToken,
        leaseMilliseconds: 3_600_000,
      });
      await store.failExportJob({
        jobId,
        leaseToken,
        code: "TEST_RETRY",
        message: "retry",
        retryable: true,
        availableAt: createdAt,
        now: createdAt,
      });
    }

    const failed = await processNextExport({ store, storage, now: new Date(createdAt) });
    assert.equal(failed?.status, "failed");
    assert.equal(storage.objects.size, 1);
    const pending = await store.listExportArtifactsForPurge("2026-10-04T09:16:00.000Z", 10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.storageKey, [...storage.objects][0]);

    const purged = await purgeExpiredExportArtifacts({
      store,
      storage,
      now: "2026-10-04T09:16:00.000Z",
      limit: 10,
    });
    assert.equal(purged.purged, 1);
    assert.equal(storage.objects.size, 0);
  });

  it("requires the internal worker key before invoking the purge route", async () => {
    const store = new MemoryStore();
    const storage = new CleanupStorage();
    let listCalls = 0;
    const listExportArtifactsForPurge = store.listExportArtifactsForPurge.bind(store);
    store.listExportArtifactsForPurge = async (now, limit) => {
      listCalls += 1;
      return listExportArtifactsForPurge(now, limit);
    };
    const app = await buildApp({ config, store, storage, logger: false });
    await app.ready();
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/v1/internal/export-artifacts/purge-expired",
        payload: {},
      });
      assert.equal(missing.statusCode, 401, missing.body);
      assert.equal(missing.json().error.code, "INTERNAL_AUTH_REQUIRED");

      const wrong = await app.inject({
        method: "POST",
        url: "/api/v1/internal/export-artifacts/purge-expired",
        headers: { "x-internal-worker-key": "wrong" },
        payload: { limit: 7 },
      });
      assert.equal(wrong.statusCode, 401, wrong.body);
      assert.equal(wrong.json().error.code, "INTERNAL_AUTH_REQUIRED");
      assert.equal(listCalls, 0);

      const authorized = await app.inject({
        method: "POST",
        url: "/api/v1/internal/export-artifacts/purge-expired",
        headers: { "x-internal-worker-key": WORKER_KEY },
        payload: { limit: 7 },
      });
      assert.equal(authorized.statusCode, 200, authorized.body);
      assert.deepEqual(authorized.json(), { scanned: 0, purged: 0, failed: 0, failures: [] });
      assert.equal(listCalls, 1);
    } finally {
      await app.close();
    }
  });
});
