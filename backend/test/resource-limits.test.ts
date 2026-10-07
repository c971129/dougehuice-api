import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import {
  MAX_ACTIVE_ASSET_BYTES_PER_USER,
  MAX_ACTIVE_PROJECTS_PER_USER,
  MAX_GENERATION_CANDIDATE_CELLS_PER_USER,
  MAX_PENDING_PAYMENT_ORDERS_PER_USER,
  MAX_PROJECT_HISTORY_PER_USER,
  MAX_PROJECT_REVISION_CELLS_PER_USER,
  MAX_PROJECT_REVISIONS,
  MAX_UNPURGED_EXPORT_ARTIFACT_BYTES_PER_USER,
  MAX_UNPURGED_EXPORT_ARTIFACTS_PER_USER,
} from "../src/domain/resource-limits.js";
import { AppError } from "../src/errors.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";
import type { AppStore } from "../src/repositories/store.js";

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
  "../migrations/0034_payment_create_recovery.sql",
  "../migrations/0035_project_library.sql",
  "../migrations/0037_payment_reconciliation.sql",
  "../migrations/0038_payment_reconciliation_self_heal.sql",
  "../migrations/0039_payment_reconciliation_lock_order.sql",
  "../migrations/0058_credit_product_pricing.sql",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

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

async function exercisePendingPaymentLimit(store: AppStore, userId: string, idBase: number): Promise<void> {
  const product = await store.getCreditProduct("ai-9", 1);
  assert.ok(product);
  const orderIds = Array.from(
    { length: MAX_PENDING_PAYMENT_ORDERS_PER_USER + 1 },
    (_, index) => uuid(idBase + index),
  );
  for (let index = 0; index < MAX_PENDING_PAYMENT_ORDERS_PER_USER; index += 1) {
    await store.createPaymentOrder({
      id: orderIds[index]!,
      userId,
      product,
      outTradeNo: `PDLIMIT${(idBase + index).toString().padStart(12, "0")}`,
      providerReference: `provider-pending-limit-${idBase + index}`,
      paymentExpiresAt: "2199-10-05T10:00:00.000Z",
      now: "2026-10-04T10:00:00.000Z",
    });
  }
  await assert.rejects(store.createPaymentOrder({
    id: orderIds[MAX_PENDING_PAYMENT_ORDERS_PER_USER]!,
    userId,
    product,
    outTradeNo: `PDLIMIT${(idBase + MAX_PENDING_PAYMENT_ORDERS_PER_USER).toString().padStart(12, "0")}`,
    providerReference: `provider-pending-limit-${idBase + MAX_PENDING_PAYMENT_ORDERS_PER_USER}`,
    paymentExpiresAt: "2199-10-05T10:00:00.000Z",
    now: "2026-10-04T10:00:00.000Z",
  }), rejectsWithCode("PAYMENT_PENDING_LIMIT_EXCEEDED"));

  await store.applyPaymentSuccess({
    orderId: orderIds[0]!,
    observedOutTradeNo: `PDLIMIT${idBase.toString().padStart(12, "0")}`,
    eventKey: `pending-limit-success-${idBase}`,
    providerTransactionId: `wx-pending-limit-${idBase}`,
    providerTradeState: "SUCCESS",
    paidAt: "2026-10-04T10:01:00.000Z",
    observedAt: "2026-10-04T10:01:00.000Z",
    source: "fake",
  });
  const replacement = await store.createPaymentOrder({
    id: orderIds[MAX_PENDING_PAYMENT_ORDERS_PER_USER]!,
    userId,
    product,
    outTradeNo: `PDLIMIT${(idBase + MAX_PENDING_PAYMENT_ORDERS_PER_USER).toString().padStart(12, "0")}`,
    providerReference: `provider-pending-limit-${idBase + MAX_PENDING_PAYMENT_ORDERS_PER_USER}`,
    paymentExpiresAt: "2199-10-05T10:00:00.000Z",
    now: "2026-10-04T10:02:00.000Z",
  });
  assert.equal(replacement.status, "pending");
}

async function exerciseOperationalHistoryRetention(
  store: AppStore,
  userId: string,
  paletteId: string,
  idBase: number,
): Promise<void> {
  const oldGenerationId = uuid(idBase);
  await store.createGenerationJob({
    jobId: oldGenerationId,
    userId,
    kind: "normal",
    paletteId,
    sourceAssetId: null,
    cost: 0,
    seed: `old-generation-${idBase}`,
    width: 8,
    height: 8,
    now: "2020-01-01T00:00:00.000Z",
  });
  await store.cancelGenerationJob(userId, oldGenerationId, "2020-01-01T00:01:00.000Z");

  const project = await store.createProject(userId, {
    name: `历史清理作品 ${idBase}`,
    paletteId,
    grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["Q01"] },
  });
  const oldExportId = uuid(idBase + 1);
  await store.createExportJob({
    id: oldExportId,
    userId,
    projectId: project.id,
    projectRevision: 1,
    format: "png",
    fileName: "旧导出",
    options: {
      paper: "A4",
      orientation: "auto",
      showCodes: true,
      showGrid: true,
      transparentBackground: false,
    },
    now: "2020-01-01T00:00:00.000Z",
  });
  await store.cancelExportJob(userId, oldExportId, "2020-01-01T00:01:00.000Z");

  await store.createGenerationJob({
    jobId: uuid(idBase + 2),
    userId,
    kind: "normal",
    paletteId,
    sourceAssetId: null,
    cost: 0,
    seed: `current-generation-${idBase}`,
    width: 8,
    height: 8,
    now: "2026-10-04T12:00:00.000Z",
  });
  await store.createExportJob({
    id: uuid(idBase + 3),
    userId,
    projectId: project.id,
    projectRevision: 1,
    format: "png",
    fileName: "当前导出",
    options: {
      paper: "A4",
      orientation: "auto",
      showCodes: true,
      showGrid: true,
      transparentBackground: false,
    },
    now: "2026-10-04T12:00:00.000Z",
  });
  assert.equal(await store.getGenerationJob(userId, oldGenerationId), null);
  assert.equal(await store.getExportJob(userId, oldExportId), null);
}

async function exerciseAssetHistoryRetention(
  store: AppStore,
  userId: string,
  paletteId: string,
  idBase: number,
): Promise<void> {
  const unreferencedId = uuid(idBase);
  const referencedId = uuid(idBase + 1);
  const oldCreatedAt = "2020-01-01T00:00:00.000Z";
  for (const [index, assetId] of [unreferencedId, referencedId].entries()) {
    await store.createAsset({
      id: assetId,
      userId,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: String(index + 1).repeat(64),
      mimeType: "image/png",
      sizeBytes: 1,
      width: 8,
      height: 8,
      storageKey: `asset-history-${idBase}-${index}`,
      expiresAt: "2199-01-01T00:00:00.000Z",
      createdAt: oldCreatedAt,
    });
    await store.markAssetReady(userId, assetId, "2020-01-01T00:00:01.000Z");
  }
  const jobId = uuid(idBase + 2);
  await store.createGenerationJob({
    jobId,
    userId,
    kind: "portrait",
    paletteId,
    sourceAssetId: referencedId,
    cost: 0,
    seed: `asset-history-${idBase}`,
    width: 8,
    height: 8,
    now: "2020-01-01T00:01:00.000Z",
  });
  await store.cancelGenerationJob(userId, jobId, "2020-01-01T00:02:00.000Z");
  for (const assetId of [unreferencedId, referencedId]) {
    await store.markAssetDeleted(userId, assetId, "2020-01-01T00:03:00.000Z");
    await store.markAssetPurged(assetId, "2020-01-01T00:04:00.000Z");
  }
  await store.createAsset({
    id: uuid(idBase + 3),
    userId,
    purpose: "ai-source",
    consentVersion: "privacy-v1",
    sha256: "f".repeat(64),
    mimeType: "image/png",
    sizeBytes: 1,
    width: 8,
    height: 8,
    storageKey: `asset-history-${idBase}-current`,
    expiresAt: "2026-10-05T00:00:00.000Z",
    createdAt: "2026-10-04T12:00:00.000Z",
  });
  assert.equal(await store.getAsset(userId, unreferencedId), null);
  assert.equal((await store.getAsset(userId, referencedId))?.purgedAt, "2020-01-01T00:04:00.000Z");
}

async function exerciseExportArtifactPhysicalQuota(
  store: AppStore,
  userId: string,
  paletteId: string,
  idBase: number,
): Promise<void> {
  const project = await store.createProject(userId, {
    name: `导出物理配额 ${idBase}`,
    paletteId,
    grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: [paletteId === "mard-48-v1" ? "H2" : "Q01"] },
  });
  const jobId = uuid(idBase);
  const leaseToken = uuid(idBase + 1);
  const createdAt = "2026-10-04T10:00:00.000Z";
  await store.createExportJob({
    id: jobId,
    userId,
    projectId: project.id,
    projectRevision: project.currentRevision,
    format: "png",
    fileName: "物理配额.png",
    options: { paper: "A4", orientation: "auto", showCodes: true, showGrid: true, transparentBackground: false },
    now: createdAt,
  });
  await store.claimNextExportJob({
    now: createdAt,
    leaseToken,
    leaseMilliseconds: 3_600_000,
  });
  const preparedIds: string[] = [];
  const prepare = async (id: string, sizeBytes: number, storageKey: string): Promise<void> => {
    await store.prepareExportArtifact({
      jobId,
      leaseToken,
      now: createdAt,
      artifact: {
        id,
        jobId,
        storageKey,
        mimeType: "image/png",
        fileName: "物理配额.png",
        sizeBytes,
        sha256: "a".repeat(64),
        expiresAt: "2026-10-11T10:00:00.000Z",
        createdAt,
      },
    });
  };
  for (let index = 0; index < MAX_UNPURGED_EXPORT_ARTIFACTS_PER_USER; index += 1) {
    const id = uuid(idBase + 10 + index);
    preparedIds.push(id);
    await prepare(id, 1, `export-quota-${idBase}-count-${index}`);
  }
  const overflowId = uuid(idBase + 500);
  await assert.rejects(
    prepare(overflowId, 1, `export-quota-${idBase}-count-overflow`),
    rejectsWithCode("EXPORT_ARTIFACT_STORAGE_LIMIT_EXCEEDED"),
  );
  await store.markExportArtifactPurged(preparedIds[0]!, "2026-10-04T10:01:00.000Z");
  await prepare(overflowId, 1, `export-quota-${idBase}-count-overflow`);
  for (const id of [...preparedIds.slice(1), overflowId]) {
    await store.markExportArtifactPurged(id, "2026-10-04T10:01:00.000Z");
  }

  const maxSingleArtifactBytes = 64 * 1024 * 1024;
  const artifactCountAtByteLimit = MAX_UNPURGED_EXPORT_ARTIFACT_BYTES_PER_USER / maxSingleArtifactBytes;
  for (let index = 0; index < artifactCountAtByteLimit; index += 1) {
    await prepare(
      uuid(idBase + 700 + index),
      maxSingleArtifactBytes,
      `export-quota-${idBase}-bytes-${index}`,
    );
  }
  await assert.rejects(
    prepare(uuid(idBase + 800), 1, `export-quota-${idBase}-bytes-overflow`),
    rejectsWithCode("EXPORT_ARTIFACT_STORAGE_LIMIT_EXCEEDED"),
  );
}

async function exerciseActiveLimits(store: AppStore, userId: string, paletteId: string): Promise<void> {
  const now = "2026-10-04T10:00:00.000Z";
  // PostgreSQL purge eligibility deliberately uses database time. Keep these
  // quota fixtures unambiguously live instead of coupling the assertion below
  // to the wall-clock day on which the suite happens to run.
  const expiresAt = "2099-10-05T10:00:00.000Z";
  for (let index = 0; index < 20; index += 1) {
    await store.createAsset({
      id: uuid(1_000 + index),
      userId,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: "a".repeat(64),
      mimeType: "image/png",
      sizeBytes: 1,
      width: 8,
      height: 8,
      storageKey: `quota-storage-key-${index.toString().padStart(4, "0")}`,
      expiresAt,
      createdAt: now,
    });
  }
  assert.deepEqual(await store.listAssets({
    userId,
    includeDeleted: false,
    now: "2026-10-04T10:00:01.000Z",
    limit: 100,
  }), []);
  const firstReady = await store.markAssetReady(userId, uuid(1_000), "2026-10-04T10:00:01.000Z");
  assert.ok(firstReady?.readyAt);
  assert.deepEqual((await store.listAssets({
    userId,
    includeDeleted: false,
    now: "2026-10-04T10:00:01.000Z",
    limit: 100,
  })).map((asset) => asset.id), [uuid(1_000)]);
  assert.deepEqual(await store.listAssets({
    userId,
    includeDeleted: false,
    now: "2026-10-04T10:00:01.000Z",
    limit: 100,
    offset: 1,
  }), []);
  await assert.rejects(store.createAsset({
    id: uuid(1_020),
    userId,
    purpose: "ai-source",
    consentVersion: "privacy-v1",
    sha256: "b".repeat(64),
    mimeType: "image/png",
    sizeBytes: 1,
    width: 8,
    height: 8,
    storageKey: "quota-storage-key-overflow",
    expiresAt,
    createdAt: now,
  }), rejectsWithCode("ASSET_QUOTA_EXCEEDED"));

  const generationIds = Array.from({ length: 5 }, (_, index) => uuid(2_000 + index));
  for (const jobId of generationIds.slice(0, 4)) {
    await store.createGenerationJob({
      jobId,
      userId,
      kind: "normal",
      paletteId,
      sourceAssetId: null,
      cost: 0,
      seed: jobId,
      width: 8,
      height: 8,
      now,
    });
  }
  await assert.rejects(store.createGenerationJob({
    jobId: generationIds[4]!,
    userId,
    kind: "normal",
    paletteId,
    sourceAssetId: null,
    cost: 0,
    seed: generationIds[4]!,
    width: 8,
    height: 8,
    now,
  }), rejectsWithCode("GENERATION_ACTIVE_LIMIT_EXCEEDED"));
  await store.cancelGenerationJob(userId, generationIds[0]!, "2026-10-04T10:00:01.000Z");
  await store.createGenerationJob({
    jobId: generationIds[4]!,
    userId,
    kind: "normal",
    paletteId,
    sourceAssetId: null,
    cost: 0,
    seed: generationIds[4]!,
    width: 8,
    height: 8,
    now: "2026-10-04T10:00:02.000Z",
  });

  const project = await store.createProject(userId, {
    name: "配额测试作品",
    paletteId,
    grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["Q01"] },
  });
  const exportIds = Array.from({ length: 4 }, (_, index) => uuid(3_000 + index));
  for (const id of exportIds.slice(0, 3)) {
    await store.createExportJob({
      id,
      userId,
      projectId: project.id,
      projectRevision: 1,
      format: "png",
      fileName: "配额测试",
      options: {
        paper: "A4",
        orientation: "auto",
        showCodes: true,
        showGrid: true,
        transparentBackground: false,
      },
      now,
    });
  }
  await assert.rejects(store.createExportJob({
    id: exportIds[3]!,
    userId,
    projectId: project.id,
    projectRevision: 1,
    format: "png",
    fileName: "配额测试",
    options: {
      paper: "A4",
      orientation: "auto",
      showCodes: true,
      showGrid: true,
      transparentBackground: false,
    },
    now,
  }), rejectsWithCode("EXPORT_ACTIVE_LIMIT_EXCEEDED"));
  await store.cancelExportJob(userId, exportIds[0]!, "2026-10-04T10:00:03.000Z");
  await store.createExportJob({
    id: exportIds[3]!,
    userId,
    projectId: project.id,
    projectRevision: 1,
    format: "png",
    fileName: "配额测试",
    options: {
      paper: "A4",
      orientation: "auto",
      showCodes: true,
      showGrid: true,
      transparentBackground: false,
    },
    now: "2026-10-04T10:00:04.000Z",
  });

  const afterPublishTimeout = "2026-10-04T10:16:01.000Z";
  assert.equal(await store.claimAssetForPurge(userId, uuid(1_000), afterPublishTimeout), null);
  const purgeWon = await store.claimAssetForPurge(userId, uuid(1_001), afterPublishTimeout);
  // PostgreSQL deliberately uses its own clock for lease safety; only the
  // in-memory store echoes the caller-provided test time.
  assert.ok(purgeWon?.deletedAt);
  assert.equal(await store.markAssetReady(userId, uuid(1_001), "2026-10-04T10:16:02.000Z"), null);
  await assert.rejects(store.createAsset({
    id: uuid(1_020),
    userId,
    purpose: "ai-source",
    consentVersion: "privacy-v1",
    sha256: "b".repeat(64),
    mimeType: "image/png",
    sizeBytes: 1,
    width: 8,
    height: 8,
    storageKey: "quota-storage-key-before-physical-purge",
    expiresAt,
    createdAt: "2026-10-04T10:16:03.000Z",
  }), rejectsWithCode("ASSET_QUOTA_EXCEEDED"));
  await store.markAssetPurged(uuid(1_001), "2026-10-04T10:16:04.000Z");
  const afterPhysicalPurge = await store.createAsset({
    id: uuid(1_020),
    userId,
    purpose: "ai-source",
    consentVersion: "privacy-v1",
    sha256: "b".repeat(64),
    mimeType: "image/png",
    sizeBytes: 1,
    width: 8,
    height: 8,
    storageKey: "quota-storage-key-after-physical-purge",
    expiresAt,
    createdAt: "2026-10-04T10:16:05.000Z",
  });
  assert.equal(afterPhysicalPurge.id, uuid(1_020));
}

describe("per-user resource limits", () => {
  it("prioritizes deleted, abandoned-publish, then expired assets in MemoryStore purge scans", async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "清理排序测试",
      tokenHash: "8".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    const createAsset = async (id: string, createdAt: string, expiresAt: string): Promise<void> => {
      await store.createAsset({
        id,
        userId: session.user.id,
        purpose: "ai-source",
        consentVersion: "privacy-v1",
        sha256: "f".repeat(64),
        mimeType: "image/png",
        sizeBytes: 1,
        width: 1,
        height: 1,
        storageKey: `purge-order-${id}`,
        expiresAt,
        createdAt,
      });
    };
    const deletedId = uuid(9_000);
    const stalePendingId = uuid(9_001);
    const expiredId = uuid(9_002);
    await createAsset(deletedId, "2026-10-04T10:00:00.000Z", "2026-10-05T10:00:00.000Z");
    await store.markAssetReady(session.user.id, deletedId, "2026-10-04T10:00:01.000Z");
    await store.markAssetDeleted(session.user.id, deletedId, "2026-10-04T10:14:00.000Z");
    await createAsset(stalePendingId, "2026-10-04T10:00:00.000Z", "2026-10-05T10:00:00.000Z");
    await createAsset(expiredId, "2026-10-04T09:00:00.000Z", "2026-10-04T10:10:00.000Z");
    await store.markAssetReady(session.user.id, expiredId, "2026-10-04T09:00:01.000Z");

    assert.deepEqual(
      (await store.listAssetsForPurge("2026-10-04T10:16:00.000Z", 3)).map((asset) => asset.id),
      [deletedId, stalePendingId, expiredId],
    );
  });

  it("bounds project count, project revisions, and fixed-window mutations in MemoryStore", async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "内存作品上限测试",
      tokenHash: "9".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    const grid = { encoding: "palette-code-v1" as const, width: 1, height: 1, cells: ["H2"] };
    const projects = [];
    for (let index = 0; index < MAX_ACTIVE_PROJECTS_PER_USER; index += 1) {
      projects.push(await store.createProject(session.user.id, {
        name: `作品 ${index}`,
        paletteId: "mard-48-v1",
        grid,
      }));
    }
    await assert.rejects(store.createProject(session.user.id, {
      name: "超额作品",
      paletteId: "mard-48-v1",
      grid,
    }), rejectsWithCode("PROJECT_LIMIT_EXCEEDED"));
    assert.equal(await store.deleteProject(session.user.id, projects[0]!.id), true);
    const revisionProject = await store.createProject(session.user.id, {
      name: "版本上限作品",
      paletteId: "mard-48-v1",
      grid,
    });
    let revision = revisionProject.currentRevision;
    for (; revision < MAX_PROJECT_REVISIONS; revision += 1) {
      await store.updateProjectGrid({
        userId: session.user.id,
        projectId: revisionProject.id,
        baseRevision: revision,
        grid,
      });
    }
    await assert.rejects(store.updateProjectGrid({
      userId: session.user.id,
      projectId: revisionProject.id,
      baseRevision: MAX_PROJECT_REVISIONS,
      grid,
    }), rejectsWithCode("PROJECT_REVISION_LIMIT_EXCEEDED"));

    const first = await store.consumeUserRateLimit({
      userId: session.user.id,
      action: "test-mutation",
      now: "2026-10-04T10:00:00.000Z",
      limit: 2,
      windowMilliseconds: 60_000,
    });
    const second = await store.consumeUserRateLimit({
      userId: session.user.id,
      action: "test-mutation",
      now: "2026-10-04T10:00:01.000Z",
      limit: 2,
      windowMilliseconds: 60_000,
    });
    const limited = await store.consumeUserRateLimit({
      userId: session.user.id,
      action: "test-mutation",
      now: "2026-10-04T10:00:02.000Z",
      limit: 2,
      windowMilliseconds: 60_000,
    });
    assert.deepEqual([first.allowed, second.allowed, limited.allowed], [true, true, false]);
    assert.equal((await store.consumeUserRateLimit({
      userId: session.user.id,
      action: "test-mutation",
      now: "2026-10-04T10:01:00.000Z",
      limit: 2,
      windowMilliseconds: 60_000,
    })).allowed, true);
  });

  it("bounds soft-deleted project history and aggregate revision cells in MemoryStore", async () => {
    const historyStore = new MemoryStore();
    const historySession = await historyStore.createDevSession({
      displayName: "作品历史上限测试",
      tokenHash: "6".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    const tinyGrid = { encoding: "palette-code-v1" as const, width: 1, height: 1, cells: ["H2"] };
    for (let index = 0; index < MAX_PROJECT_HISTORY_PER_USER; index += 1) {
      const project = await historyStore.createProject(historySession.user.id, {
        name: `历史作品 ${index}`,
        paletteId: "mard-48-v1",
        grid: tinyGrid,
      });
      assert.equal(await historyStore.deleteProject(historySession.user.id, project.id), true);
    }
    await assert.rejects(historyStore.createProject(historySession.user.id, {
      name: "超额历史作品",
      paletteId: "mard-48-v1",
      grid: tinyGrid,
    }), rejectsWithCode("PROJECT_HISTORY_LIMIT_EXCEEDED"));

    const cellsStore = new MemoryStore();
    const cellsSession = await cellsStore.createDevSession({
      displayName: "图纸容量上限测试",
      tokenHash: "5".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    const side = 200;
    const largeGrid = {
      encoding: "palette-code-v1" as const,
      width: side,
      height: side,
      cells: Array.from({ length: side * side }, () => "H2"),
    };
    let project = await cellsStore.createProject(cellsSession.user.id, {
      name: "大图纸容量测试",
      paletteId: "mard-48-v1",
      grid: largeGrid,
    });
    const retainedRevisionCount = MAX_PROJECT_REVISION_CELLS_PER_USER / largeGrid.cells.length;
    for (let revision = 1; revision < retainedRevisionCount; revision += 1) {
      project = await cellsStore.updateProjectGrid({
        userId: cellsSession.user.id,
        projectId: project.id,
        baseRevision: project.currentRevision,
        grid: largeGrid,
      });
    }
    await assert.rejects(cellsStore.updateProjectGrid({
      userId: cellsSession.user.id,
      projectId: project.id,
      baseRevision: project.currentRevision,
      grid: largeGrid,
    }), rejectsWithCode("PROJECT_STORAGE_LIMIT_EXCEEDED"));
  });

  it("enforces active asset, generation, export, and total-byte limits in MemoryStore", async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "内存配额测试",
      tokenHash: "d".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 5,
    });
    await exerciseActiveLimits(store, session.user.id, "mard-48-v1");
    await exercisePendingPaymentLimit(store, session.user.id, 8_000);

    const retentionSession = await store.createDevSession({
      displayName: "内存历史保留测试",
      tokenHash: "7".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    await exerciseOperationalHistoryRetention(store, retentionSession.user.id, "mard-48-v1", 9_100);

    const assetHistorySession = await store.createDevSession({
      displayName: "内存素材历史测试",
      tokenHash: "4".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    await exerciseAssetHistoryRetention(store, assetHistorySession.user.id, "mard-48-v1", 9_400);

    const byteSession = await store.createDevSession({
      displayName: "内存字节配额测试",
      tokenHash: "e".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    for (let index = 0; index < 2; index += 1) {
      await store.createAsset({
        id: uuid(4_000 + index),
        userId: byteSession.user.id,
        purpose: "ai-source",
        consentVersion: "privacy-v1",
        sha256: "c".repeat(64),
        mimeType: "image/png",
        sizeBytes: MAX_ACTIVE_ASSET_BYTES_PER_USER / 2,
        width: 1,
        height: 1,
        storageKey: `byte-quota-key-${index.toString().padStart(8, "0")}`,
        expiresAt: "2026-10-05T10:00:00.000Z",
        createdAt: "2026-10-04T10:00:00.000Z",
      });
    }
    await assert.rejects(store.createAsset({
      id: uuid(4_002),
      userId: byteSession.user.id,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: "c".repeat(64),
      mimeType: "image/png",
      sizeBytes: 1,
      width: 1,
      height: 1,
      storageKey: "byte-quota-key-overflow",
      expiresAt: "2026-10-05T10:00:00.000Z",
      createdAt: "2026-10-04T10:00:00.000Z",
    }), rejectsWithCode("ASSET_QUOTA_EXCEEDED"));
  });

  it("bounds unpurged export artifact count and bytes in MemoryStore and PostgreSQL", async () => {
    const memory = new MemoryStore();
    const memorySession = await memory.createDevSession({
      displayName: "内存导出物理配额测试",
      tokenHash: "3".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    await exerciseExportArtifactPhysicalQuota(memory, memorySession.user.id, "mard-48-v1", 20_000);

    const database = new PGlite();
    const postgres = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      const userId = uuid(20_900);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, 'SQL 导出物理配额测试')", [userId]);
      await database.query("INSERT INTO credit_accounts(user_id, balance) VALUES ($1, 0)", [userId]);
      await database.query("INSERT INTO palettes(id, name, version) VALUES ('export-quota-palette', '导出配额色卡', 1)");
      await database.query(
        `INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
         VALUES ('export-quota-palette', 'Q01', '配额白', '#FFFFFF', 1, 0)`,
      );
      await exerciseExportArtifactPhysicalQuota(postgres, userId, "export-quota-palette", 30_000);
    } finally {
      await postgres.close();
    }
  });

  it("atomically bounds retained generation candidate cells per user", async () => {
    const memory = new MemoryStore();
    const memorySession = await memory.createDevSession({
      displayName: "内存候选容量测试",
      tokenHash: "2".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 1,
    });
    const largeCells = Array.from({ length: 64 * 64 }, () => "H2");
    const retainedJobs = Math.floor(MAX_GENERATION_CANDIDATE_CELLS_PER_USER / (4 * largeCells.length));
    for (let index = 0; index < retainedJobs; index += 1) {
      const jobId = uuid(40_000 + index);
      const leaseToken = uuid(41_000 + index);
      await memory.createGenerationJob({
        jobId,
        userId: memorySession.user.id,
        kind: "portrait",
        paletteId: "mard-48-v1",
        sourceAssetId: null,
        cost: 0,
        seed: `candidate-quota-${index}`,
        width: 64,
        height: 64,
        now: "2026-10-04T10:00:00.000Z",
      });
      await memory.claimNextGenerationJob({
        now: "2026-10-04T10:00:00.000Z",
        leaseToken,
        leaseMilliseconds: 3_600_000,
      });
      await memory.completeGenerationJob({
        jobId,
        leaseToken,
        now: "2026-10-04T10:00:01.000Z",
        candidates: Array.from({ length: 4 }, (_, ordinal) => ({
          id: `memory-quota-${index}-${ordinal + 1}`,
          jobId,
          ordinal: ordinal + 1,
          variantOrdinal: ordinal + 1,
          outputSlot: "combined" as const,
          grid: { encoding: "palette-code-v1" as const, width: 64, height: 64, cells: largeCells },
          createdAt: "2026-10-04T10:00:01.000Z",
        })),
      });
    }
    const overflowJobId = uuid(42_000);
    const overflowLease = uuid(42_001);
    await memory.createGenerationJob({
      jobId: overflowJobId,
      userId: memorySession.user.id,
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      cost: 1,
      seed: "candidate-quota-overflow",
      width: 64,
      height: 64,
      now: "2026-10-04T10:01:00.000Z",
    });
    await memory.claimNextGenerationJob({
      now: "2026-10-04T10:01:00.000Z",
      leaseToken: overflowLease,
      leaseMilliseconds: 3_600_000,
    });
    const overflowCandidate = {
      id: "memory-quota-overflow",
      jobId: overflowJobId,
      ordinal: 1,
      variantOrdinal: 1,
      outputSlot: "combined" as const,
      grid: { encoding: "palette-code-v1" as const, width: 64, height: 64, cells: largeCells },
      createdAt: "2026-10-04T10:01:01.000Z",
    };
    await assert.rejects(memory.completeGenerationJob({
      jobId: overflowJobId,
      leaseToken: overflowLease,
      candidates: [
        overflowCandidate,
        { ...overflowCandidate, id: "memory-quota-overflow-2", ordinal: 2, variantOrdinal: 2 },
      ],
      now: "2026-10-04T10:01:01.000Z",
    }), rejectsWithCode("GENERATION_CANDIDATE_CELLS_LIMIT_EXCEEDED"));
    assert.equal((await memory.getGenerationJob(memorySession.user.id, overflowJobId))?.candidates.length, 0);
    assert.equal((await memory.getCreditAccount(memorySession.user.id)).balance, 0);
    await memory.failGenerationJob({
      jobId: overflowJobId,
      leaseToken: overflowLease,
      code: "GENERATION_CANDIDATE_CELLS_LIMIT_EXCEEDED",
      message: "limit",
      retryable: false,
      availableAt: "2026-10-04T10:01:01.000Z",
      now: "2026-10-04T10:01:01.000Z",
    });
    assert.equal((await memory.getCreditAccount(memorySession.user.id)).balance, 1);

    const otherSession = await memory.createDevSession({
      displayName: "另一候选容量用户",
      tokenHash: "1".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 0,
    });
    const otherJobId = uuid(42_002);
    const otherLease = uuid(42_003);
    await memory.createGenerationJob({
      jobId: otherJobId,
      userId: otherSession.user.id,
      kind: "normal",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      cost: 0,
      seed: "candidate-quota-other-user",
      width: 64,
      height: 64,
      now: "2026-10-04T10:02:00.000Z",
    });
    await memory.claimNextGenerationJob({
      now: "2026-10-04T10:02:00.000Z",
      leaseToken: otherLease,
      leaseMilliseconds: 3_600_000,
    });
    const otherCompleted = await memory.completeGenerationJob({
      jobId: otherJobId,
      leaseToken: otherLease,
      candidates: [{ ...overflowCandidate, id: "other-user-candidate", jobId: otherJobId }],
      now: "2026-10-04T10:02:01.000Z",
    });
    assert.equal(otherCompleted.status, "completed");

    const database = new PGlite();
    const postgres = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      const fullUserId = uuid(43_000);
      const otherUserId = uuid(43_001);
      await database.query(
        "INSERT INTO users(id, display_name) VALUES ($1, 'SQL候选满额'), ($2, 'SQL候选另一用户')",
        [fullUserId, otherUserId],
      );
      await database.query(
        "INSERT INTO credit_accounts(user_id, balance) VALUES ($1, 1), ($2, 0)",
        [fullUserId, otherUserId],
      );
      await database.query("INSERT INTO palettes(id, name, version) VALUES ('candidate-quota-palette', '候选配额色卡', 1)");
      await database.query(
        `INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
         VALUES ('candidate-quota-palette', 'Q01', '配额白', '#FFFFFF', 1, 0)`,
      );
      await database.query(
        `INSERT INTO generation_jobs(
           id, user_id, kind, status, palette_id, options, cost, seed,
           width, height, progress, attempt_count, max_attempts, available_at,
           created_at, updated_at, completed_at
         )
         SELECT ('10000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
                $1, 'portrait', 'completed', 'candidate-quota-palette',
                '{"maxColors":12}'::jsonb, 0, 'seed-' || series,
                64, 64, 100, 1, 3, '2026-10-04T09:00:00Z',
                '2026-10-04T09:00:00Z', '2026-10-04T09:00:00Z', '2026-10-04T09:00:00Z'
         FROM generate_series(1, $2::integer) AS series`,
        [fullUserId, retainedJobs],
      );
      await database.query(
        `INSERT INTO generation_candidates(
           id, job_id, ordinal, variant_ordinal, output_slot,
           encoding, width, height, cells, created_at
         )
         SELECT 'sql-quota-' || jobs.series || '-' || ordinals.ordinal,
                ('10000000-0000-4000-8000-' || lpad(jobs.series::text, 12, '0'))::uuid,
                ordinals.ordinal, ordinals.ordinal, 'combined', 'palette-code-v1', 64, 64,
                to_jsonb(array_fill('Q01'::text, ARRAY[4096])), '2026-10-04T09:00:00Z'
         FROM generate_series(1, $1::integer) AS jobs(series)
         CROSS JOIN generate_series(1, 4) AS ordinals(ordinal)`,
        [retainedJobs],
      );
      const sqlOverflowJobId = uuid(43_010);
      const sqlOverflowLease = uuid(43_011);
      await postgres.createGenerationJob({
        jobId: sqlOverflowJobId,
        userId: fullUserId,
        kind: "portrait",
        paletteId: "candidate-quota-palette",
        sourceAssetId: null,
        cost: 1,
        seed: "sql-overflow",
        width: 64,
        height: 64,
        now: "2026-10-04T10:00:00.000Z",
      });
      await postgres.claimNextGenerationJob({
        now: "2026-10-04T10:00:00.000Z",
        leaseToken: sqlOverflowLease,
        leaseMilliseconds: 3_600_000,
      });
      await assert.rejects(postgres.completeGenerationJob({
        jobId: sqlOverflowJobId,
        leaseToken: sqlOverflowLease,
        candidates: [{
          id: "sql-overflow-candidate",
          jobId: sqlOverflowJobId,
          ordinal: 1,
          variantOrdinal: 1,
          outputSlot: "combined",
          grid: { encoding: "palette-code-v1", width: 64, height: 64, cells: Array.from({ length: 4096 }, () => "Q01") },
          createdAt: "2026-10-04T10:00:01.000Z",
        }, {
          id: "sql-overflow-candidate-2",
          jobId: sqlOverflowJobId,
          ordinal: 2,
          variantOrdinal: 2,
          outputSlot: "combined",
          grid: { encoding: "palette-code-v1", width: 64, height: 64, cells: Array.from({ length: 4096 }, () => "Q01") },
          createdAt: "2026-10-04T10:00:01.000Z",
        }],
        now: "2026-10-04T10:00:01.000Z",
      }), rejectsWithCode("GENERATION_CANDIDATE_CELLS_LIMIT_EXCEEDED"));
      const rollback = await database.query<{
        status: string;
        candidate_count: number;
        settled_count: number;
        balance: number;
      }>(
        `SELECT j.status,
                (SELECT count(*)::integer FROM generation_candidates WHERE job_id = j.id) AS candidate_count,
                (SELECT count(*)::integer FROM credit_ledger
                  WHERE reference_id = j.id::text AND reason = 'generation_settled') AS settled_count,
                (SELECT balance FROM credit_accounts WHERE user_id = j.user_id) AS balance
         FROM generation_jobs AS j WHERE j.id = $1`,
        [sqlOverflowJobId],
      );
      assert.deepEqual(rollback.rows[0], {
        status: "preprocessing",
        candidate_count: 0,
        settled_count: 0,
        balance: 0,
      });
      await postgres.failGenerationJob({
        jobId: sqlOverflowJobId,
        leaseToken: sqlOverflowLease,
        code: "GENERATION_CANDIDATE_CELLS_LIMIT_EXCEEDED",
        message: "limit",
        retryable: false,
        availableAt: "2026-10-04T10:00:01.000Z",
        now: "2026-10-04T10:00:01.000Z",
      });
      assert.equal((await postgres.getCreditAccount(fullUserId)).balance, 1);

      const sqlOtherJobId = uuid(43_012);
      const sqlOtherLease = uuid(43_013);
      await postgres.createGenerationJob({
        jobId: sqlOtherJobId,
        userId: otherUserId,
        kind: "normal",
        paletteId: "candidate-quota-palette",
        sourceAssetId: null,
        cost: 0,
        seed: "sql-other",
        width: 64,
        height: 64,
        now: "2026-10-04T10:02:00.000Z",
      });
      await postgres.claimNextGenerationJob({
        now: "2026-10-04T10:02:00.000Z",
        leaseToken: sqlOtherLease,
        leaseMilliseconds: 3_600_000,
      });
      assert.equal((await postgres.completeGenerationJob({
        jobId: sqlOtherJobId,
        leaseToken: sqlOtherLease,
        candidates: [{
          id: "sql-other-candidate",
          jobId: sqlOtherJobId,
          ordinal: 1,
          variantOrdinal: 1,
          outputSlot: "combined",
          grid: { encoding: "palette-code-v1", width: 64, height: 64, cells: Array.from({ length: 4096 }, () => "Q01") },
          createdAt: "2026-10-04T10:02:01.000Z",
        }],
        now: "2026-10-04T10:02:01.000Z",
      })).status, "completed");
    } finally {
      await postgres.close();
    }
  });

  it("enforces the same limits through real PostgreSQL SQL", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      const userId = uuid(5_000);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, 'SQL 配额测试')", [userId]);
      await database.query("INSERT INTO credit_accounts(user_id, balance) VALUES ($1, 5)", [userId]);
      await database.query("INSERT INTO palettes(id, name, version) VALUES ('quota-palette', '配额色卡', 1)");
      await database.query(
        `INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
         VALUES ('quota-palette', 'Q01', '配额白', '#FFFFFF', 1, 0)`,
      );
      await exerciseActiveLimits(store, userId, "quota-palette");
      await exercisePendingPaymentLimit(store, userId, 8_100);

      const retentionUserId = uuid(5_004);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, 'SQL 历史保留测试')", [retentionUserId]);
      await database.query("INSERT INTO credit_accounts(user_id, balance) VALUES ($1, 0)", [retentionUserId]);
      await exerciseOperationalHistoryRetention(store, retentionUserId, "quota-palette", 9_200);
      const assetHistoryUserId = uuid(5_005);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, 'SQL 素材历史测试')", [assetHistoryUserId]);
      await database.query("INSERT INTO credit_accounts(user_id, balance) VALUES ($1, 0)", [assetHistoryUserId]);
      await exerciseAssetHistoryRetention(store, assetHistoryUserId, "quota-palette", 9_500);
      const expiredDeletedProjectId = uuid(9_302);
      const protectedDeletedProjectId = uuid(9_303);
      const protectedExportJobId = uuid(9_304);
      const protectedArtifactId = uuid(9_305);
      await database.query(
        `INSERT INTO projects(
           id, user_id, name, palette_id, current_revision, deleted_at, created_at, updated_at
         ) VALUES
           ($1, $3, '可清理旧作品', 'quota-palette', 1,
            '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
           ($2, $3, '制品保护旧作品', 'quota-palette', 1,
            '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
        [expiredDeletedProjectId, protectedDeletedProjectId, retentionUserId],
      );
      await database.query(
        `INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells, created_at)
         VALUES
           ($1, 1, 'palette-code-v1', 1, 1, '["Q01"]'::jsonb, '2020-01-01T00:00:00Z'),
           ($2, 1, 'palette-code-v1', 1, 1, '["Q01"]'::jsonb, '2020-01-01T00:00:00Z')`,
        [expiredDeletedProjectId, protectedDeletedProjectId],
      );
      await database.query(
        `INSERT INTO export_jobs(
           id, user_id, project_id, project_revision, format, file_name, options,
           status, progress, available_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 1, 'png', '保留制品.png', '{}'::jsonb,
           'queued', 0, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'
         )`,
        [protectedExportJobId, retentionUserId, protectedDeletedProjectId],
      );
      await database.query(
        `INSERT INTO export_artifacts(
           id, job_id, storage_key, mime_type, file_name, size_bytes, sha256,
           expires_at, created_at, purge_available_at, ready_at
         ) VALUES (
           $1, $2, 'protected/project-artifact', 'image/png', '保留制品.png', 1, $3,
           '2020-01-02T00:00:00Z', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
           '2020-01-01T00:00:00Z'
         )`,
        [protectedArtifactId, protectedExportJobId, "f".repeat(64)],
      );
      await database.query(
        `UPDATE export_jobs
         SET status = 'succeeded', progress = 100, result_artifact_id = $2,
             finished_at = '2020-01-01T00:01:00Z', updated_at = '2020-01-01T00:01:00Z'
         WHERE id = $1`,
        [protectedExportJobId, protectedArtifactId],
      );
      await store.createProject(retentionUserId, {
        name: "触发旧作品清理",
        paletteId: "quota-palette",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["Q01"] },
      });
      const retainedDeleted = await database.query<{ id: string }>(
        "SELECT id FROM projects WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[expiredDeletedProjectId, protectedDeletedProjectId]],
      );
      assert.deepEqual(retainedDeleted.rows.map((row) => row.id), [protectedDeletedProjectId]);
      await store.markExportArtifactPurged(protectedArtifactId, "2026-10-04T12:01:00.000Z");
      await store.createProject(retentionUserId, {
        name: "清理已释放制品的旧作品",
        paletteId: "quota-palette",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["Q01"] },
      });
      assert.equal((await database.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM projects WHERE id = $1",
        [protectedDeletedProjectId],
      )).rows[0]?.count, 0);
      await database.query(
        `INSERT INTO api_idempotency(
           user_id, scope, idempotency_key, request_hash, status_code, response_body, created_at
         ) VALUES
           ($1, 'old-scope', 'old-record-key', $2, 200, '{"old":true}'::jsonb, '2020-01-01T00:00:00Z'),
           ($1, 'payment-orders:create', 'permanent-payment-key', $3, 201,
            '{"payment":true}'::jsonb, '2020-01-01T00:00:00Z')`,
        [retentionUserId, "a".repeat(64), "e".repeat(64)],
      );
      const idempotent = await store.executeIdempotent(
        {
          userId: retentionUserId,
          scope: "current-scope",
          key: "current-record-key",
          requestHash: "b".repeat(64),
        },
        async () => ({ statusCode: 201, body: { retained: true } }),
      );
      assert.equal(idempotent.replayed, false);
      const oldIdempotency = await database.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM api_idempotency WHERE user_id = $1 AND scope = 'old-scope'",
        [retentionUserId],
      );
      assert.equal(oldIdempotency.rows[0]?.count, 0);
      const permanentPaymentReplay = await store.getIdempotent<{ payment: boolean }>({
        userId: retentionUserId,
        scope: "payment-orders:create",
        key: "permanent-payment-key",
        requestHash: "e".repeat(64),
      });
      assert.deepEqual(permanentPaymentReplay, {
        statusCode: 201,
        body: { payment: true },
        replayed: true,
      });

      await database.query(
        `INSERT INTO payment_effect_claims(
           user_id, scope, idempotency_key, request_hash, lease_token,
           lease_expires_at, created_at, updated_at
         ) VALUES (
           $1, 'old-payment', 'old-effect-key', $2, $3,
           '2020-01-01T00:01:00Z', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'
         )`,
        [retentionUserId, "c".repeat(64), uuid(9_300)],
      );
      const effectClaim = await store.claimPaymentEffect({
        userId: retentionUserId,
        scope: "current-payment",
        key: "current-effect-key",
        requestHash: "d".repeat(64),
        leaseToken: uuid(9_301),
        now: "2026-10-04T12:00:00.000Z",
        leaseExpiresAt: "2026-10-04T12:00:30.000Z",
      });
      assert.equal(effectClaim.acquired, true);
      const oldClaims = await database.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM payment_effect_claims WHERE user_id = $1 AND scope = 'old-payment'",
        [retentionUserId],
      );
      assert.equal(oldClaims.rows[0]?.count, 0);

      const rateUserId = uuid(5_002);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, 'SQL 限流测试')", [rateUserId]);
      const concurrentRate = await Promise.all([
        store.consumeUserRateLimit({
          userId: rateUserId,
          action: "provider-effect",
          now: "2199-10-04T10:00:00.000Z",
          limit: 1,
          windowMilliseconds: 60_000,
        }),
        store.consumeUserRateLimit({
          userId: rateUserId,
          action: "provider-effect",
          now: "1900-10-04T10:00:00.000Z",
          limit: 1,
          windowMilliseconds: 60_000,
        }),
      ]);
      assert.deepEqual(concurrentRate.map((result) => result.allowed).sort(), [false, true]);
      assert.ok(concurrentRate.find((result) => !result.allowed)!.retryAfterMilliseconds > 0);

      const projectLimitUserId = uuid(5_003);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, 'SQL 作品上限测试')", [projectLimitUserId]);
      await database.query(
        `INSERT INTO projects(id, user_id, name, palette_id, current_revision)
         SELECT ('00000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
                $1, '批量作品 ' || series, 'quota-palette', 1
         FROM generate_series(7000, 7098) AS series`,
        [projectLimitUserId],
      );
      await database.query(
        `INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
         SELECT id, 1, 'palette-code-v1', 1, 1, '["Q01"]'::jsonb
         FROM projects WHERE user_id = $1`,
        [projectLimitUserId],
      );
      await store.createProject(projectLimitUserId, {
        name: "第 100 个作品",
        paletteId: "quota-palette",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["Q01"] },
      });
      await assert.rejects(store.createProject(projectLimitUserId, {
        name: "超额作品",
        paletteId: "quota-palette",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["Q01"] },
      }), rejectsWithCode("PROJECT_LIMIT_EXCEEDED"));

      const byteUserId = uuid(5_001);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, 'SQL 字节配额测试')", [byteUserId]);
      for (let index = 0; index < 2; index += 1) {
        await store.createAsset({
          id: uuid(6_000 + index),
          userId: byteUserId,
          purpose: "ai-source",
          consentVersion: "privacy-v1",
          sha256: "d".repeat(64),
          mimeType: "image/png",
          sizeBytes: MAX_ACTIVE_ASSET_BYTES_PER_USER / 2,
          width: 1,
          height: 1,
          storageKey: `sql-byte-quota-${index.toString().padStart(8, "0")}`,
          expiresAt: "2026-10-05T10:00:00.000Z",
          createdAt: "2026-10-04T10:00:00.000Z",
        });
      }
      await assert.rejects(store.createAsset({
        id: uuid(6_002),
        userId: byteUserId,
        purpose: "ai-source",
        consentVersion: "privacy-v1",
        sha256: "d".repeat(64),
        mimeType: "image/png",
        sizeBytes: 1,
        width: 1,
        height: 1,
        storageKey: "sql-byte-quota-overflow",
        expiresAt: "2026-10-05T10:00:00.000Z",
        createdAt: "2026-10-04T10:00:00.000Z",
      }), rejectsWithCode("ASSET_QUOTA_EXCEEDED"));
    } finally {
      await store.close();
    }
  });
});
