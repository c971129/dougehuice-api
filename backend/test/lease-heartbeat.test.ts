import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import type { GenerationProvider } from "../src/generation/provider.js";
import { processNextGeneration } from "../src/generation/worker.js";
import { processNextExport } from "../src/exports/worker.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";
import type { AppStore } from "../src/repositories/store.js";
import type { StorageObjectContext, StorageProvider } from "../src/storage/storage-provider.js";

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
  "../migrations/0025_generation_preprocessing_options.sql",
  "../migrations/0026_project_completion_photos.sql",
  "../migrations/0027_asset_upload_idempotency.sql",
  "../migrations/0028_custom_palettes.sql",
  "../migrations/0029_web_login_challenges.sql",
  "../migrations/0030_auth_rate_limits.sql",
  "../migrations/0031_auth_palette_hardening.sql",
  "../migrations/0032_palette_owner_immutability.sql",
  "../migrations/0033_asset_consent_events.sql",
  "../migrations/0034_payment_create_recovery.sql",
  "../migrations/0035_project_library.sql",
  "../migrations/0036_inventory_audit_preservation.sql",
  "../migrations/0037_payment_reconciliation.sql",
  "../migrations/0038_payment_reconciliation_self_heal.sql",
  "../migrations/0039_payment_reconciliation_lock_order.sql",
  "../migrations/0040_worker_lease_scan_indexes.sql",
  "../migrations/0041_remove_superseded_lease_indexes.sql",
  "../migrations/0051_mard_palette_catalog.sql",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

const generationJobId = "00000000-0000-4000-8000-000000000901";
const generationLeaseToken = "00000000-0000-4000-8000-000000000902";
const exportJobId = "00000000-0000-4000-8000-000000000903";
const exportLeaseToken = "00000000-0000-4000-8000-000000000904";
const wrongLeaseToken = "00000000-0000-4000-8000-000000000905";

const exportOptions = {
  paper: "A4" as const,
  orientation: "auto" as const,
  showCodes: true,
  showGrid: true,
  transparentBackground: false,
};

const unusedStorage: StorageProvider = {
  ready: async () => undefined,
  put: async (_contents, _context, requestedKey) => ({ storageKey: requestedKey ?? "unused" }),
  get: async () => null,
  delete: async () => undefined,
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

async function applyMigrations(database: PGlite): Promise<void> {
  for (const migrationPath of migrationPaths) {
    await database.exec(await readFile(migrationPath, "utf8"));
  }
}

async function seedLeaseJobs(input: {
  store: AppStore;
  userId: string;
  paletteId: string;
  colorCode: string;
}): Promise<void> {
  const project = await input.store.createProject(input.userId, {
    name: "租约测试图纸",
    paletteId: input.paletteId,
    grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: [input.colorCode] },
  });
  await input.store.createGenerationJob({
    jobId: generationJobId,
    userId: input.userId,
    kind: "pixel",
    paletteId: input.paletteId,
    sourceAssetId: null,
    cost: 1,
    seed: "lease-renewal-test",
    width: 8,
    height: 8,
    now: "2026-10-04T10:00:00.000Z",
  });
  await input.store.createExportJob({
    id: exportJobId,
    userId: input.userId,
    projectId: project.id,
    projectRevision: project.currentRevision,
    format: "png",
    fileName: "lease-renewal.png",
    options: exportOptions,
    now: "2026-10-04T10:00:00.000Z",
  });
}

async function assertMemoryRenewalSemantics(store: AppStore, userId: string): Promise<void> {
  const generation = await store.claimNextGenerationJob({
    now: "2026-10-04T10:00:01.000Z",
    leaseToken: generationLeaseToken,
    leaseMilliseconds: 9_000,
  });
  assert.ok(generation);
  assert.equal(generation.id, generationJobId);
  assert.equal(generation.leaseExpiresAt, "2026-10-04T10:00:10.000Z");
  assert.equal(await store.renewGenerationJobLease({
    jobId: generationJobId,
    leaseToken: wrongLeaseToken,
    now: "2026-10-04T10:00:02.000Z",
    leaseMilliseconds: 18_000,
  }), false);
  assert.equal(await store.renewGenerationJobLease({
    jobId: generationJobId,
    leaseToken: generationLeaseToken,
    now: "2026-10-04T10:00:02.000Z",
    leaseMilliseconds: 18_000,
  }), true);
  assert.equal((await store.getGenerationJob(userId, generationJobId))?.leaseExpiresAt, "2026-10-04T10:00:20.000Z");
  assert.equal(await store.renewGenerationJobLease({
    jobId: generationJobId,
    leaseToken: generationLeaseToken,
    now: "2026-10-04T10:00:20.000Z",
    leaseMilliseconds: 10_000,
  }), false);
  await store.cancelGenerationJob(userId, generationJobId, "2026-10-04T10:00:21.000Z");
  assert.equal(await store.renewGenerationJobLease({
    jobId: generationJobId,
    leaseToken: generationLeaseToken,
    now: "2026-10-04T10:00:22.000Z",
    leaseMilliseconds: 10_000,
  }), false);

  const exported = await store.claimNextExportJob({
    now: "2026-10-04T10:00:01.000Z",
    leaseToken: exportLeaseToken,
    leaseMilliseconds: 9_000,
  });
  assert.ok(exported);
  assert.equal(exported.id, exportJobId);
  assert.equal(exported.leaseExpiresAt, "2026-10-04T10:00:10.000Z");
  assert.equal(await store.renewExportJobLease({
    jobId: exportJobId,
    leaseToken: wrongLeaseToken,
    now: "2026-10-04T10:00:02.000Z",
    leaseMilliseconds: 18_000,
  }), false);
  assert.equal(await store.renewExportJobLease({
    jobId: exportJobId,
    leaseToken: exportLeaseToken,
    now: "2026-10-04T10:00:02.000Z",
    leaseMilliseconds: 18_000,
  }), true);
  assert.equal((await store.getExportJob(userId, exportJobId))?.leaseExpiresAt, "2026-10-04T10:00:20.000Z");
  assert.equal(await store.renewExportJobLease({
    jobId: exportJobId,
    leaseToken: exportLeaseToken,
    now: "2026-10-04T10:00:20.000Z",
    leaseMilliseconds: 10_000,
  }), false);
  await store.cancelExportJob(userId, exportJobId, "2026-10-04T10:00:21.000Z");
  assert.equal(await store.renewExportJobLease({
    jobId: exportJobId,
    leaseToken: exportLeaseToken,
    now: "2026-10-04T10:00:22.000Z",
    leaseMilliseconds: 10_000,
  }), false);
}

async function databaseNowMillis(database: PGlite): Promise<number> {
  const result = await database.query<{ now_ms: string | number }>(
    "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms",
  );
  return Number(result.rows[0]!.now_ms);
}

function assertDatabaseLeaseWindow(input: {
  expiresAt: string | null;
  databaseBefore: number;
  databaseAfter: number;
  leaseMilliseconds: number;
}): void {
  assert.ok(input.expiresAt);
  const expiresAt = Date.parse(input.expiresAt);
  const toleranceMilliseconds = 1_000;
  assert.ok(
    expiresAt >= input.databaseBefore + input.leaseMilliseconds - toleranceMilliseconds,
    `lease expiry ${input.expiresAt} is earlier than the database-clock duration window`,
  );
  assert.ok(
    expiresAt <= input.databaseAfter + input.leaseMilliseconds + toleranceMilliseconds,
    `lease expiry ${input.expiresAt} is later than the database-clock duration window`,
  );
}

async function assertPostgresRenewalSemantics(
  store: AppStore,
  database: PGlite,
  userId: string,
): Promise<void> {
  const claimDuration = 60_000;
  const generationBefore = await databaseNowMillis(database);
  const generation = await store.claimNextGenerationJob({
    now: "2199-10-04T10:00:01.000Z",
    leaseToken: generationLeaseToken,
    leaseMilliseconds: claimDuration,
  });
  const generationAfter = await databaseNowMillis(database);
  assert.ok(generation);
  assert.equal(generation.id, generationJobId);
  assertDatabaseLeaseWindow({
    expiresAt: generation.leaseExpiresAt,
    databaseBefore: generationBefore,
    databaseAfter: generationAfter,
    leaseMilliseconds: claimDuration,
  });
  assert.equal(await store.claimNextGenerationJob({
    now: "2199-10-04T10:01:00.000Z",
    leaseToken: wrongLeaseToken,
    leaseMilliseconds: claimDuration,
  }), null, "a forged future caller clock must not steal a live generation lease");
  assert.equal(await store.renewGenerationJobLease({
    jobId: generationJobId,
    leaseToken: wrongLeaseToken,
    now: "1900-01-01T00:00:00.000Z",
    leaseMilliseconds: 120_000,
  }), false);

  const generationRenewBefore = await databaseNowMillis(database);
  assert.equal(await store.renewGenerationJobLease({
    jobId: generationJobId,
    leaseToken: generationLeaseToken,
    now: "2199-10-04T10:02:00.000Z",
    leaseMilliseconds: 120_000,
  }), true);
  const generationRenewAfter = await databaseNowMillis(database);
  assertDatabaseLeaseWindow({
    expiresAt: (await store.getGenerationJob(userId, generationJobId))?.leaseExpiresAt ?? null,
    databaseBefore: generationRenewBefore,
    databaseAfter: generationRenewAfter,
    leaseMilliseconds: 120_000,
  });
  await database.query(
    "UPDATE generation_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [generationJobId],
  );
  assert.equal(await store.renewGenerationJobLease({
    jobId: generationJobId,
    leaseToken: generationLeaseToken,
    now: "1900-01-01T00:00:00.000Z",
    leaseMilliseconds: 120_000,
  }), false, "a forged past caller clock must not renew an expired generation lease");
  await store.cancelGenerationJob(userId, generationJobId, new Date().toISOString());

  const exportBefore = await databaseNowMillis(database);
  const exported = await store.claimNextExportJob({
    now: "2199-10-04T10:00:01.000Z",
    leaseToken: exportLeaseToken,
    leaseMilliseconds: claimDuration,
  });
  const exportAfter = await databaseNowMillis(database);
  assert.ok(exported);
  assert.equal(exported.id, exportJobId);
  assertDatabaseLeaseWindow({
    expiresAt: exported.leaseExpiresAt,
    databaseBefore: exportBefore,
    databaseAfter: exportAfter,
    leaseMilliseconds: claimDuration,
  });
  assert.equal(await store.claimNextExportJob({
    now: "2199-10-04T10:01:00.000Z",
    leaseToken: wrongLeaseToken,
    leaseMilliseconds: claimDuration,
  }), null, "a forged future caller clock must not steal a live export lease");
  assert.equal(await store.renewExportJobLease({
    jobId: exportJobId,
    leaseToken: wrongLeaseToken,
    now: "1900-01-01T00:00:00.000Z",
    leaseMilliseconds: 120_000,
  }), false);

  const exportRenewBefore = await databaseNowMillis(database);
  assert.equal(await store.renewExportJobLease({
    jobId: exportJobId,
    leaseToken: exportLeaseToken,
    now: "2199-10-04T10:02:00.000Z",
    leaseMilliseconds: 120_000,
  }), true);
  const exportRenewAfter = await databaseNowMillis(database);
  assertDatabaseLeaseWindow({
    expiresAt: (await store.getExportJob(userId, exportJobId))?.leaseExpiresAt ?? null,
    databaseBefore: exportRenewBefore,
    databaseAfter: exportRenewAfter,
    leaseMilliseconds: 120_000,
  });
  await database.query(
    "UPDATE export_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [exportJobId],
  );
  assert.equal(await store.renewExportJobLease({
    jobId: exportJobId,
    leaseToken: exportLeaseToken,
    now: "1900-01-01T00:00:00.000Z",
    leaseMilliseconds: 120_000,
  }), false, "a forged past caller clock must not renew an expired export lease");
  await store.cancelExportJob(userId, exportJobId, new Date().toISOString());
}

describe("worker lease renewal stores", () => {
  it("renews only live matching MemoryStore generation and export leases", async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "内存租约测试用户",
      tokenHash: "9".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 5,
    });
    await seedLeaseJobs({ store, userId: session.user.id, paletteId: "mard-48-v1", colorCode: "H2" });
    await assertMemoryRenewalSemantics(store, session.user.id);
  });

  it("uses PostgreSQL database time for live matching generation and export leases", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const userId = "00000000-0000-4000-8000-000000000911";
    const paletteId = "lease-heartbeat-palette";
    try {
      await applyMigrations(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '数据库租约测试用户')", [userId]);
      await database.query("INSERT INTO palettes(id, name, version) VALUES ($1, '租约测试色卡', 1)", [paletteId]);
      await database.query(
        "INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order) VALUES ($1, 'T01', '测试色', '#FFFFFF', 1, 0)",
        [paletteId],
      );
      await database.query(
        "INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES ($1, 5, $2)",
        [userId, "2026-10-04T10:00:00.000Z"],
      );
      await seedLeaseJobs({ store, userId, paletteId, colorCode: "T01" });
      await assertPostgresRenewalSemantics(store, database, userId);
    } finally {
      await store.close();
    }
  });
});

describe("worker lease heartbeats", () => {
  it("aborts generation provider work after losing its heartbeat lease and keeps the job non-terminal", { timeout: 2_000 }, async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "生成心跳测试用户",
      tokenHash: "8".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 5,
    });
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000921",
      userId: session.user.id,
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      cost: 1,
      seed: "heartbeat-abort-provider",
      width: 1,
      height: 1,
      now: "2026-10-04T11:00:00.000Z",
    });
    let providerCalled = false;
    let providerAborted = false;
    const provider: GenerationProvider = {
      kind: "heartbeat-blocking-test",
      generate: async ({ signal }) => {
        providerCalled = true;
        return new Promise((resolve, reject) => {
          const abort = () => {
            providerAborted = true;
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    };
    store.renewGenerationJobLease = async () => false;

    const result = await processNextGeneration({
      store,
      storage: unusedStorage,
      provider,
      now: new Date("2026-10-04T11:00:00.000Z"),
      leaseMilliseconds: 1_000,
      heartbeatIntervalMilliseconds: 5,
    });

    assert.equal(providerCalled, true);
    assert.equal(providerAborted, true);
    assert.equal(result?.id, job.id);
    assert.equal(result?.status, "generating");
    assert.equal(result?.progress, 45);
    assert.equal(result?.candidates.length, 0);
    const persisted = await store.getGenerationJob(session.user.id, job.id);
    assert.equal(persisted?.status, "generating");
    assert.equal(persisted?.completedAt, null);
    const ledger = await store.listCreditLedger(session.user.id, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_settled").length, 0);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_released").length, 0);
  });

  it("propagates a process shutdown signal into generation provider work", { timeout: 2_000 }, async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "生成停止信号测试用户",
      tokenHash: "4".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 5,
    });
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000926",
      userId: session.user.id,
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      cost: 1,
      seed: "shutdown-abort-provider",
      width: 1,
      height: 1,
      now: "2026-10-04T11:15:00.000Z",
    });
    const shutdown = new AbortController();
    const shutdownReason = new Error("WORKER_SHUTTING_DOWN");
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let observedReason: unknown;
    const provider: GenerationProvider = {
      kind: "shutdown-blocking-test",
      generate: async ({ signal }) => {
        resolveStarted();
        return new Promise((_resolve, reject) => {
          const abort = () => {
            observedReason = signal.reason;
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    };

    const processing = processNextGeneration({
      store,
      storage: unusedStorage,
      provider,
      now: new Date("2026-10-04T11:15:00.000Z"),
      heartbeatIntervalMilliseconds: 60_000,
      signal: shutdown.signal,
    });
    await started;
    shutdown.abort(shutdownReason);
    const result = await processing;

    assert.equal(observedReason, shutdownReason);
    assert.equal(result?.id, job.id);
    assert.equal(result?.status, "generating");
    assert.equal(result?.completedAt, null);
    const ledger = await store.listCreditLedger(session.user.id, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_settled").length, 0);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_released").length, 0);
  });

  it("aborts a generation source read after losing its heartbeat lease and never calls the provider", { timeout: 2_000 }, async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "生成源图读取中断测试用户",
      tokenHash: "5".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 5,
    });
    const sourceContents = Buffer.from("heartbeat-source-contents");
    const assetId = "00000000-0000-4000-8000-000000000924";
    await store.createAsset({
      id: assetId,
      userId: session.user.id,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: createHash("sha256").update(sourceContents).digest("hex"),
      mimeType: "image/png",
      sizeBytes: sourceContents.length,
      width: 1,
      height: 1,
      storageKey: "heartbeat-source-object-924",
      expiresAt: "2026-10-05T11:00:00.000Z",
      createdAt: "2026-10-04T10:59:00.000Z",
    });
    await store.markAssetReady(session.user.id, assetId, "2026-10-04T10:59:01.000Z");
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000925",
      userId: session.user.id,
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: assetId,
      cost: 1,
      seed: "heartbeat-abort-source-read",
      width: 1,
      height: 1,
      now: "2026-10-04T11:00:00.000Z",
    });
    let resolveReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    let storageSignalObserved = false;
    let storageAborted = false;
    const storage: StorageProvider = {
      ...unusedStorage,
      get: async (_storageKey, _context, signal) => {
        storageSignalObserved = signal !== undefined;
        assert.ok(signal);
        resolveReadStarted();
        return new Promise((_resolve, reject) => {
          const abort = () => {
            storageAborted = true;
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    };
    let providerCalled = false;
    const provider: GenerationProvider = {
      kind: "must-not-run-after-source-abort",
      generate: async () => {
        providerCalled = true;
        return [];
      },
    };
    store.renewGenerationJobLease = async () => {
      await readStarted;
      return false;
    };

    const result = await processNextGeneration({
      store,
      storage,
      provider,
      now: new Date("2026-10-04T11:00:00.000Z"),
      leaseMilliseconds: 1_000,
      heartbeatIntervalMilliseconds: 5,
    });

    assert.equal(storageSignalObserved, true);
    assert.equal(storageAborted, true);
    assert.equal(providerCalled, false);
    assert.equal(result?.id, job.id);
    assert.equal(result?.status, "preprocessing");
    assert.equal(result?.progress, 15);
    assert.equal(result?.candidates.length, 0);
    const persisted = await store.getGenerationJob(session.user.id, job.id);
    assert.equal(persisted?.status, "preprocessing");
    assert.equal(persisted?.completedAt, null);
    const ledger = await store.listCreditLedger(session.user.id, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_settled").length, 0);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_released").length, 0);
  });

  it("passes the heartbeat signal into export rendering and stops before storage after lease loss", { timeout: 2_000 }, async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "导出渲染中断测试用户",
      tokenHash: "6".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    const project = await store.createProject(session.user.id, {
      name: "导出渲染中断图纸",
      paletteId: "mard-48-v1",
      grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
    });
    const job = await store.createExportJob({
      id: "00000000-0000-4000-8000-000000000923",
      userId: session.user.id,
      projectId: project.id,
      projectRevision: project.currentRevision,
      format: "pdf",
      fileName: "heartbeat-render-abort.pdf",
      options: exportOptions,
      now: "2026-10-04T11:30:00.000Z",
    });
    let rendererSignalObserved = false;
    let rendererAborted = false;
    let storageCalled = false;
    store.renewExportJobLease = async () => false;

    const result = await processNextExport({
      store,
      storage: {
        ...unusedStorage,
        put: async () => {
          storageCalled = true;
          return { storageKey: "unexpected" };
        },
      },
      render: async ({ signal }) => {
        rendererSignalObserved = signal !== undefined;
        assert.ok(signal);
        return new Promise((_resolve, reject) => {
          const abort = () => {
            rendererAborted = true;
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
      now: new Date("2026-10-04T11:30:00.000Z"),
      leaseMilliseconds: 1_000,
      heartbeatIntervalMilliseconds: 5,
    });

    assert.equal(rendererSignalObserved, true);
    assert.equal(rendererAborted, true);
    assert.equal(storageCalled, false);
    assert.equal(result?.id, job.id);
    assert.equal(result?.status, "running");
    assert.equal(result?.artifact, null);
    const persisted = await store.getExportJob(session.user.id, job.id);
    assert.equal(persisted?.status, "running");
    assert.equal(persisted?.finishedAt, null);
  });

  it("propagates a process shutdown signal into export rendering", { timeout: 2_000 }, async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "导出停止信号测试用户",
      tokenHash: "3".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    const project = await store.createProject(session.user.id, {
      name: "导出停止信号图纸",
      paletteId: "mard-48-v1",
      grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
    });
    const job = await store.createExportJob({
      id: "00000000-0000-4000-8000-000000000927",
      userId: session.user.id,
      projectId: project.id,
      projectRevision: project.currentRevision,
      format: "pdf",
      fileName: "shutdown-render-abort.pdf",
      options: exportOptions,
      now: "2026-10-04T11:45:00.000Z",
    });
    const shutdown = new AbortController();
    const shutdownReason = new Error("WORKER_SHUTTING_DOWN");
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let observedReason: unknown;
    let storageCalled = false;

    const processing = processNextExport({
      store,
      storage: {
        ...unusedStorage,
        put: async () => {
          storageCalled = true;
          return { storageKey: "unexpected" };
        },
      },
      render: async ({ signal }) => {
        assert.ok(signal);
        resolveStarted();
        return new Promise((_resolve, reject) => {
          const abort = () => {
            observedReason = signal.reason;
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
      now: new Date("2026-10-04T11:45:00.000Z"),
      heartbeatIntervalMilliseconds: 60_000,
      signal: shutdown.signal,
    });
    await started;
    shutdown.abort(shutdownReason);
    const result = await processing;

    assert.equal(observedReason, shutdownReason);
    assert.equal(storageCalled, false);
    assert.equal(result?.id, job.id);
    assert.equal(result?.status, "running");
    assert.equal(result?.finishedAt, null);
    assert.equal(result?.artifact, null);
  });

  it("does not reject a PostgreSQL export lease because the worker clock is ahead", { timeout: 15_000 }, async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const userId = "00000000-0000-4000-8000-000000000931";
    const paletteId = "worker-clock-palette";
    try {
      await applyMigrations(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, 'Worker 时钟测试用户')", [userId]);
      await database.query("INSERT INTO palettes(id, name, version) VALUES ($1, 'Worker 时钟色卡', 1)", [paletteId]);
      await database.query(
        "INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order) VALUES ($1, 'T01', '测试色', '#FFFFFF', 1, 0)",
        [paletteId],
      );
      await database.query(
        "INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES ($1, 5, clock_timestamp())",
        [userId],
      );
      await seedLeaseJobs({ store, userId, paletteId, colorCode: "T01" });

      const result = await processNextExport({
        store,
        storage: unusedStorage,
        now: new Date("2199-10-04T12:00:00.000Z"),
        leaseMilliseconds: 60_000,
        heartbeatIntervalMilliseconds: 3_600_000,
        render: async () => ({
          contents: Buffer.from("clock-safe-export"),
          mimeType: "image/png",
          fileName: "clock-safe.png",
          sha256: "a".repeat(64),
          pageCount: 1,
        }),
      });

      assert.equal(result?.id, exportJobId);
      assert.equal(result?.status, "succeeded", JSON.stringify(result));
      assert.ok(result?.artifact);
    } finally {
      await store.close();
    }
  });

  it("deletes an export object written before heartbeat lease loss and does not complete the job", { timeout: 2_000 }, async () => {
    class DelayedStorage implements StorageProvider {
      readonly objects = new Map<string, Buffer>();
      readonly deleteAttempts: string[] = [];
      objectWritten = false;
      heartbeatSignalObserved = false;

      async ready(): Promise<void> {}

      async put(
        contents: Buffer,
        _context: StorageObjectContext,
        requestedKey = "export-heartbeat-object",
        signal?: AbortSignal,
      ): Promise<{ storageKey: string }> {
        this.heartbeatSignalObserved = signal !== undefined;
        this.objects.set(requestedKey, Buffer.from(contents));
        this.objectWritten = true;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { storageKey: requestedKey };
      }

      async get(): Promise<Buffer | null> {
        return null;
      }

      async delete(storageKey: string): Promise<void> {
        this.deleteAttempts.push(storageKey);
        this.objects.delete(storageKey);
      }
    }

    const store = new MemoryStore();
    const storage = new DelayedStorage();
    const session = await store.createDevSession({
      displayName: "导出心跳测试用户",
      tokenHash: "7".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    const project = await store.createProject(session.user.id, {
      name: "导出心跳图纸",
      paletteId: "mard-48-v1",
      grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
    });
    const job = await store.createExportJob({
      id: "00000000-0000-4000-8000-000000000922",
      userId: session.user.id,
      projectId: project.id,
      projectRevision: project.currentRevision,
      format: "png",
      fileName: "heartbeat-cleanup.png",
      options: exportOptions,
      now: "2026-10-04T12:00:00.000Z",
    });
    const renew = store.renewExportJobLease.bind(store);
    store.renewExportJobLease = async (input) => storage.objectWritten ? false : renew(input);

    const result = await processNextExport({
      store,
      storage,
      now: new Date("2026-10-04T12:00:00.000Z"),
      leaseMilliseconds: 1_000,
      heartbeatIntervalMilliseconds: 5,
    });

    assert.equal(storage.objectWritten, true);
    assert.equal(storage.heartbeatSignalObserved, true);
    assert.equal(storage.objects.size, 0);
    assert.equal(storage.deleteAttempts.length, 1);
    assert.equal(result?.id, job.id);
    assert.equal(result?.status, "running");
    assert.equal(result?.artifact, null);
    const persisted = await store.getExportJob(session.user.id, job.id);
    assert.equal(persisted?.status, "running");
    assert.equal(persisted?.finishedAt, null);
    assert.equal(persisted?.artifact, null);
  });
});
