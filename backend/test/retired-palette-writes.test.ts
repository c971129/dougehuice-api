import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import type { LightMyRequestResponse } from "fastify";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { copyDefaultGenerationOptions } from "../src/domain/generation-options.js";
import type { ExportArtifactRecord, Palette } from "../src/domain/models.js";
import { MAX_ACTIVE_PROJECTS_PER_USER } from "../src/domain/resource-limits.js";
import { MemoryStore } from "../src/repositories/memory-store.js";

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
  assetStorageRoot: join(tmpdir(), "pindou-retired-palette-tests"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function retireMemoryPalette(store: MemoryStore, paletteId: string): void {
  const palettes = Reflect.get(store, "palettes") as Map<string, Palette>;
  const palette = palettes.get(paletteId);
  assert.ok(palette);
  palette.retired = true;
}

async function expectPaletteRetired(responsePromise: Promise<LightMyRequestResponse>): Promise<void> {
  const response = await responsePromise;
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, "PALETTE_RETIRED", response.body);
}

function rejectsWithPaletteRetired(error: unknown): boolean {
  return error instanceof Error
    && "statusCode" in error
    && "code" in error
    && error.statusCode === 409
    && error.code === "PALETTE_RETIRED";
}

async function createMemoryUser(store: MemoryStore, displayName: string, token = randomUUID()) {
  return (await store.createDevSession({
    displayName,
    tokenHash: tokenHash(token),
    expiresAt: "2027-10-05T00:00:00.000Z",
    startingCredits: 20,
  })).user;
}

it("fails closed for retired-palette progress, inventory, and completion-photo writes", async () => {
  const store = new MemoryStore();
  const owner = await createMemoryUser(store, "退役色卡写路径用户");
  const paletteId = "mard-48-v1";
  const palette = await store.getPalette(paletteId, owner.id);
  assert.ok(palette);
  const colorCode = palette.colors[0]!.code;
  const project = await store.createProject(owner.id, {
    name: "退役色卡写路径作品",
    paletteId,
    grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: [colorCode] },
  });
  const progress = await store.saveBuildProgress({
    userId: owner.id,
    projectId: project.id,
    projectRevision: project.currentRevision,
    baseProgressRevision: 0,
    completedIndices: [0],
    elapsedTime: 1,
  });
  assert.ok(progress.completedAt);
  const inventory = await store.setInventoryItem({
    userId: owner.id,
    paletteId,
    colorCode,
    quantity: 5,
    location: "A-1",
    baseRevision: 0,
    idempotencyReference: "retired-write-initial-inventory",
    now: "2026-10-05T09:00:00.000Z",
  });

  const pendingInput = {
    photoId: randomUUID(),
    userId: owner.id,
    projectId: project.id,
    projectRevision: project.currentRevision,
    idempotencyKey: "retired-pending-photo",
    requestHash: "a".repeat(64),
    uploadLeaseToken: randomUUID(),
    uploadLeaseAcquiredAt: "2026-10-05T10:00:00.000Z",
    asset: {
      id: randomUUID(),
      userId: owner.id,
      purpose: "project-completion" as const,
      consentVersion: null,
      sha256: "b".repeat(64),
      mimeType: "image/png" as const,
      sizeBytes: 4,
      width: 1,
      height: 1,
      storageKey: "retired-pending-photo-object",
      expiresAt: null,
      createdAt: "2026-10-05T10:00:00.000Z",
    },
  };
  const pending = await store.reserveProjectCompletionPhotoUpload(pendingInput);
  const readyInput = {
    ...pendingInput,
    photoId: randomUUID(),
    idempotencyKey: "retired-ready-photo",
    requestHash: "c".repeat(64),
    uploadLeaseToken: randomUUID(),
    asset: {
      ...pendingInput.asset,
      id: randomUUID(),
      sha256: "d".repeat(64),
      storageKey: "retired-ready-photo-object",
    },
  };
  const ready = await store.reserveProjectCompletionPhotoUpload(readyInput);
  const published = await store.publishProjectCompletionPhoto({
    userId: owner.id,
    projectId: project.id,
    photoId: ready.photo.id,
    assetId: ready.photo.asset.id,
    uploadLeaseToken: ready.uploadLeaseToken,
    readyAt: "2026-10-05T10:01:00.000Z",
  });
  assert.equal(published.asset.readyAt, "2026-10-05T10:01:00.000Z");

  retireMemoryPalette(store, paletteId);

  const metadataBefore = await store.getProject(owner.id, project.id);
  assert.ok(metadataBefore);
  await assert.rejects(store.updateProjectMetadata({
    userId: owner.id,
    projectId: project.id,
    baseRevision: metadataBefore.currentRevision,
    baseMetadataRevision: metadataBefore.metadataRevision,
    tags: ["不得写入"],
    deviceSource: "api",
  }), rejectsWithPaletteRetired);
  assert.deepEqual(await store.getProject(owner.id, project.id), metadataBefore);

  await assert.rejects(store.saveBuildProgress({
    userId: owner.id,
    projectId: project.id,
    projectRevision: project.currentRevision,
    baseProgressRevision: progress.progressRevision,
    completedIndices: [0],
    elapsedTime: 2,
  }), rejectsWithPaletteRetired);
  assert.deepEqual(await store.getBuildProgress(owner.id, project.id), progress);

  await assert.rejects(store.setInventoryItem({
    userId: owner.id,
    paletteId,
    colorCode,
    quantity: 6,
    location: "A-2",
    baseRevision: inventory.revision,
    idempotencyReference: "retired-set-inventory",
    now: "2026-10-05T10:02:00.000Z",
  }), rejectsWithPaletteRetired);
  await assert.rejects(store.applyInventoryBatch({
    userId: owner.id,
    mode: "delta",
    entries: [{ paletteId, colorCode, delta: -1, baseRevision: inventory.revision }],
    idempotencyReference: "retired-batch-inventory",
    now: "2026-10-05T10:02:01.000Z",
  }), rejectsWithPaletteRetired);
  await assert.rejects(store.consumeProjectInventory({
    userId: owner.id,
    projectId: project.id,
    projectRevision: project.currentRevision,
    idempotencyReference: "retired-project-consumption",
    now: "2026-10-05T10:02:02.000Z",
  }), rejectsWithPaletteRetired);
  assert.deepEqual(await store.listInventory(owner.id, paletteId), [inventory]);
  for (const reference of ["retired-set-inventory", "retired-batch-inventory", "retired-project-consumption"]) {
    assert.deepEqual(await store.listInventoryOperations({
      userId: owner.id,
      idempotencyReference: reference,
      limit: 10,
    }), []);
  }

  const uploadsBefore = structuredClone(Reflect.get(store, "completionPhotoUploads"));
  await assert.rejects(store.reserveProjectCompletionPhotoUpload({
    ...pendingInput,
    uploadLeaseToken: randomUUID(),
    uploadLeaseAcquiredAt: "2026-10-05T10:02:00.000Z",
  }), rejectsWithPaletteRetired);
  assert.deepEqual(Reflect.get(store, "completionPhotoUploads"), uploadsBefore, "pending replay must not renew its lease");
  await assert.rejects(store.publishProjectCompletionPhoto({
    userId: owner.id,
    projectId: project.id,
    photoId: pending.photo.id,
    assetId: pending.photo.asset.id,
    uploadLeaseToken: pending.uploadLeaseToken,
    readyAt: "2026-10-05T10:02:00.000Z",
  }), rejectsWithPaletteRetired);
  const stillPending = await store.getProjectCompletionPhoto({
    userId: owner.id,
    projectId: project.id,
    photoId: pending.photo.id,
    now: "2026-10-05T10:02:00.000Z",
    includeDeleted: true,
  });
  assert.equal(stillPending?.deletedAt, null);
  assert.equal(stillPending?.asset.readyAt, null);
  assert.equal(stillPending?.asset.deletedAt, null);

  const newPhotoInput = {
    ...pendingInput,
    photoId: randomUUID(),
    idempotencyKey: "retired-new-photo",
    requestHash: "e".repeat(64),
    uploadLeaseToken: randomUUID(),
    asset: {
      ...pendingInput.asset,
      id: randomUUID(),
      sha256: "f".repeat(64),
      storageKey: "retired-new-photo-object",
    },
  };
  await assert.rejects(store.reserveProjectCompletionPhotoUpload(newPhotoInput), rejectsWithPaletteRetired);
  assert.equal(await store.getAsset(owner.id, newPhotoInput.asset.id), null);

  const readyUploadsBefore = structuredClone(Reflect.get(store, "completionPhotoUploads"));
  const reserveReplay = await store.reserveProjectCompletionPhotoUpload({
    ...readyInput,
    uploadLeaseToken: randomUUID(),
    uploadLeaseAcquiredAt: "2026-10-05T11:00:00.000Z",
  });
  assert.equal(reserveReplay.replayed, true);
  assert.equal(reserveReplay.photo.asset.readyAt, published.asset.readyAt);
  assert.deepEqual(Reflect.get(store, "completionPhotoUploads"), readyUploadsBefore, "ready replay must stay read-only");
  const publishReplay = await store.publishProjectCompletionPhoto({
    userId: owner.id,
    projectId: project.id,
    photoId: ready.photo.id,
    assetId: ready.photo.asset.id,
    uploadLeaseToken: ready.uploadLeaseToken,
    readyAt: "2026-10-05T11:00:00.000Z",
  });
  assert.equal(publishReplay.asset.readyAt, published.asset.readyAt);
});

it("blocks every retired-palette derivative while preserving historical reads", async () => {
  const store = new MemoryStore();
  const ownerToken = "retired-palette-owner-token";
  const owner = (await store.createDevSession({
    displayName: "退役色卡历史作者",
    tokenHash: tokenHash(ownerToken),
    expiresAt: "2027-10-05T00:00:00.000Z",
    startingCredits: 20,
  })).user;
  const paletteId = "mard-48-v1";
  const palette = await store.getPalette(paletteId, owner.id);
  assert.ok(palette);
  const colorCode = palette.colors[0]!.code;
  const grid = {
    encoding: "palette-code-v1" as const,
    width: 2,
    height: 2,
    cells: [colorCode, null, colorCode, null],
  };

  const editableProject = await store.createProject(owner.id, {
    name: "待迁移历史项目",
    paletteId,
    grid,
  });
  const queuedHistoricalExport = await store.createExportJob({
    id: randomUUID(),
    userId: owner.id,
    projectId: editableProject.id,
    projectRevision: editableProject.currentRevision,
    format: "png",
    fileName: "退役前已排队历史导出.png",
    options: {
      paper: "A4",
      orientation: "auto",
      showCodes: true,
      showGrid: true,
      transparentBackground: false,
    },
    now: "2026-10-05T07:59:00.000Z",
  });
  const projectDraft = await store.saveProjectDraft({
    userId: owner.id,
    projectId: editableProject.id,
    baseProjectRevision: editableProject.currentRevision,
    baseDraftRevision: 0,
    grid,
  });
  const remapProject = await store.createProject(owner.id, {
    name: "待换卡历史项目",
    paletteId,
    grid,
  });
  const creationDraft = await store.saveCreationDraft({
    userId: owner.id,
    draftId: null,
    baseDraftRevision: 0,
    name: "待迁移创建草稿",
    kind: "portrait",
    setupStep: 3,
    paletteId,
    sourceAssetId: null,
    width: 2,
    height: 2,
    options: copyDefaultGenerationOptions(),
    grid,
  });

  const now = "2026-10-05T08:00:00.000Z";
  const sourceAssetId = randomUUID();
  await store.createAsset({
    id: sourceAssetId,
    userId: owner.id,
    purpose: "ai-source",
    consentVersion: "privacy-v1",
    sha256: "a".repeat(64),
    mimeType: "image/png",
    sizeBytes: 4,
    width: 1,
    height: 1,
    storageKey: `retired-palette/${sourceAssetId}`,
    expiresAt: "2027-10-05T08:00:00.000Z",
    createdAt: now,
  });
  await store.markAssetReady(owner.id, sourceAssetId, now);
  const job = await store.createGenerationJob({
    jobId: randomUUID(),
    userId: owner.id,
    kind: "portrait",
    paletteId,
    sourceAssetId,
    cost: 1,
    seed: "retired-palette-parent",
    width: 2,
    height: 2,
    now,
  });
  const leaseToken = randomUUID();
  const claimed = await store.claimNextGenerationJob({ now, leaseToken, leaseMilliseconds: 300_000 });
  assert.equal(claimed?.id, job.id);
  const candidateId = "retired-palette-candidate";
  await store.completeGenerationJob({
    jobId: job.id,
    leaseToken,
    now: "2026-10-05T08:00:01.000Z",
    candidates: [
      {
        id: candidateId,
        jobId: job.id,
        variantOrdinal: 1,
        outputSlot: "combined",
        ordinal: 1,
        grid,
        createdAt: "2026-10-05T08:00:01.000Z",
      },
      {
        id: "retired-palette-candidate-2",
        jobId: job.id,
        variantOrdinal: 2,
        outputSlot: "combined",
        ordinal: 2,
        grid,
        createdAt: "2026-10-05T08:00:01.000Z",
      },
    ],
  });
  const completionJob = await store.createGenerationJob({
    jobId: randomUUID(),
    userId: owner.id,
    kind: "normal",
    paletteId,
    sourceAssetId: null,
    cost: 0,
    seed: "retired-before-completion",
    width: 2,
    height: 2,
    now: "2026-10-05T08:00:02.000Z",
  });

  retireMemoryPalette(store, paletteId);
  assert.equal((await store.getPalette(paletteId, owner.id))?.retired, true);
  assert.ok(await store.getProject(owner.id, editableProject.id));
  assert.ok(await store.getProjectForExport({
    userId: owner.id,
    projectId: editableProject.id,
    projectRevision: editableProject.currentRevision,
  }));
  const exportLeaseToken = randomUUID();
  const claimedHistoricalExport = await store.claimNextExportJob({
    now: "2026-10-05T08:00:10.000Z",
    leaseToken: exportLeaseToken,
    leaseMilliseconds: 300_000,
  });
  assert.equal(claimedHistoricalExport?.id, queuedHistoricalExport.id);
  const historicalArtifact: ExportArtifactRecord = {
    id: randomUUID(),
    jobId: queuedHistoricalExport.id,
    storageKey: `retired-palette/export/${queuedHistoricalExport.id}`,
    mimeType: "image/png",
    fileName: queuedHistoricalExport.fileName,
    sizeBytes: 1,
    sha256: "9".repeat(64),
    expiresAt: "2026-10-06T08:00:11.000Z",
    createdAt: "2026-10-05T08:00:11.000Z",
  };
  await store.prepareExportArtifact({
    jobId: queuedHistoricalExport.id,
    leaseToken: exportLeaseToken,
    artifact: historicalArtifact,
    now: historicalArtifact.createdAt,
  });
  const completedHistoricalExport = await store.completeExportJob({
    jobId: queuedHistoricalExport.id,
    leaseToken: exportLeaseToken,
    artifact: historicalArtifact,
    now: historicalArtifact.createdAt,
  });
  assert.equal(completedHistoricalExport.status, "succeeded");
  assert.deepEqual(
    await store.getExportJob(owner.id, queuedHistoricalExport.id),
    completedHistoricalExport,
  );
  await assert.rejects(store.saveCreationDraft({
    userId: owner.id,
    draftId: creationDraft.id,
    baseDraftRevision: creationDraft.draftRevision,
    name: creationDraft.name,
    kind: creationDraft.kind,
    setupStep: creationDraft.setupStep,
    paletteId,
    sourceAssetId: creationDraft.sourceAssetId,
    width: creationDraft.width,
    height: creationDraft.height,
    options: creationDraft.options,
    grid: creationDraft.grid,
  }), rejectsWithPaletteRetired);
  const completionLeaseToken = randomUUID();
  const completionClaim = await store.claimNextGenerationJob({
    now: "2026-10-05T08:00:02.000Z",
    leaseToken: completionLeaseToken,
    leaseMilliseconds: 300_000,
  });
  assert.equal(completionClaim?.id, completionJob.id);
  await assert.rejects(store.completeGenerationJob({
    jobId: completionJob.id,
    leaseToken: completionLeaseToken,
    now: "2026-10-05T08:00:03.000Z",
    candidates: [{
      id: "retired-completion-candidate",
      jobId: completionJob.id,
      variantOrdinal: 1,
      outputSlot: "combined",
      ordinal: 1,
      grid,
      createdAt: "2026-10-05T08:00:03.000Z",
    }],
  }), rejectsWithPaletteRetired);

  const app = await buildApp({ config, store, logger: false });
  await app.ready();
  const ownerHeaders = (key: string) => ({
    authorization: `Bearer ${ownerToken}`,
    "idempotency-key": key,
  });
  try {
    const historicalRead = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${editableProject.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(historicalRead.statusCode, 200, historicalRead.body);
    const materials = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${editableProject.id}/materials`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(materials.statusCode, 200, materials.body);
    await expectPaletteRetired(app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: ownerHeaders("retired-export"),
      payload: {
        projectId: editableProject.id,
        projectRevision: editableProject.currentRevision,
        format: "png",
        fileName: "退役色卡历史导出",
        options: { showCodes: true, showGrid: true },
      },
    }));
    const remapped = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${remapProject.id}/remap-palette`,
      headers: ownerHeaders("retired-remap-source"),
      payload: { baseRevision: remapProject.currentRevision, paletteId: "mard-72-v1", maxColors: 5 },
    });
    assert.equal(remapped.statusCode, 200, remapped.body);
    assert.equal(remapped.json().project.paletteId, "mard-72-v1");

    await expectPaletteRetired(app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${job.id}/redraw`,
      headers: ownerHeaders("retired-redraw"),
      payload: {},
    }));
    await expectPaletteRetired(app.inject({
      method: "POST",
      url: "/api/v1/creation-draft/commit",
      headers: ownerHeaders("retired-creation-commit"),
      payload: { draftId: creationDraft.id, draftRevision: creationDraft.draftRevision },
    }));
    await expectPaletteRetired(app.inject({
      method: "POST",
      url: `/api/v1/projects/${editableProject.id}/copy`,
      headers: ownerHeaders("retired-project-copy"),
      payload: {},
    }));
    await expectPaletteRetired(app.inject({
      method: "POST",
      url: `/api/v1/projects/${editableProject.id}/revisions/1/restore`,
      headers: ownerHeaders("retired-project-restore"),
      payload: { baseRevision: editableProject.currentRevision },
    }));
    await expectPaletteRetired(app.inject({
      method: "PUT",
      url: `/api/v1/projects/${editableProject.id}/grid`,
      headers: ownerHeaders("retired-project-grid"),
      payload: { baseRevision: editableProject.currentRevision, grid },
    }));
    await expectPaletteRetired(app.inject({
      method: "PUT",
      url: `/api/v1/projects/${editableProject.id}/draft`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        baseProjectRevision: editableProject.currentRevision,
        baseDraftRevision: projectDraft.draftRevision,
        grid,
      },
    }));
    await expectPaletteRetired(app.inject({
      method: "POST",
      url: `/api/v1/projects/${editableProject.id}/draft/commit`,
      headers: ownerHeaders("retired-project-draft-commit"),
      payload: {
        baseProjectRevision: editableProject.currentRevision,
        draftRevision: projectDraft.draftRevision,
      },
    }));
    await expectPaletteRetired(app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${job.id}/accept`,
      headers: ownerHeaders("retired-candidate-accept"),
      payload: { candidateId, projectName: "不得创建的候选项目" },
    }));
    await expectPaletteRetired(app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${job.id}/variants/1/accept`,
      headers: ownerHeaders("retired-variant-accept"),
      payload: { projects: [{ outputSlot: "combined", projectName: "不得创建的方案项目" }] },
    }));

    assert.equal((await store.getProject(owner.id, editableProject.id))?.currentRevision, 1);
    assert.equal((await store.getProjectDraft(owner.id, editableProject.id))?.draftRevision, 1);
    assert.equal((await store.getCreationDraft(owner.id))?.draftRevision, 1);
    assert.equal((await store.getGenerationJob(owner.id, job.id))?.status, "completed");
  } finally {
    await app.close();
  }
});
