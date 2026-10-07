import { createHash } from "node:crypto";

import sharp from "sharp";

const baseUrl = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:8787/api/v1").replace(/\/$/, "");
const workerKey = process.env.INTERNAL_WORKER_KEY ?? "pindou-dev-only-worker-key-change-me";
const externalWorkers = process.env.E2E_EXTERNAL_WORKERS?.toLowerCase() === "true";
const productionCandidate = process.env.E2E_PRODUCTION_CANDIDATE === "true";
const suppliedAuthToken = process.env.E2E_AUTH_TOKEN?.trim();
if (productionCandidate && !suppliedAuthToken) {
  throw new Error("E2E_AUTH_TOKEN is required for a production candidate smoke test");
}
const stamp = `${Date.now()}-${process.pid}`;

function invariant(value, message) {
  if (!value) throw new Error(message);
}

async function requestUnchecked(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body, bytes };
}

async function request(path, options = {}) {
  const result = await requestUnchecked(path, options);
  const { response, body, bytes } = result;
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path} failed (${response.status}): ${bytes.toString("utf8").slice(0, 500)}`,
    );
  }
  return result;
}

async function json(path, method, body, headers = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function uncheckedJson(path, method, body, headers = {}) {
  return requestUnchecked(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function processGenerationUntilDone(generationId, authorization) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!externalWorkers) {
      await json("/internal/generation-jobs/process-next", "POST", {}, { "x-internal-worker-key": workerKey });
    }
    const current = await request(`/generation-jobs/${generationId}`, { headers: { authorization } });
    const status = current.body.job.status;
    if (status === "completed") return current.body.job;
    if (status === "accepted" || status === "failed" || status === "canceled") {
      throw new Error(`generation ${generationId} ended unexpectedly as ${status}: ${current.body.job.errorCode ?? "unknown"}`);
    }
    await wait(250);
  }
  throw new Error(`generation ${generationId} did not finish within the smoke-test deadline`);
}

async function processExportUntilDone(exportId, authorization) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!externalWorkers) {
      await json("/internal/export-jobs/process-next", "POST", {}, { "x-internal-worker-key": workerKey });
    }
    const current = await request(`/exports/${exportId}`, { headers: { authorization } });
    const status = current.body.export.status;
    if (status === "succeeded") return current.body.export;
    if (status === "failed" || status === "canceled") {
      throw new Error(`export ${exportId} ended as ${status}: ${current.body.export.errorCode ?? "unknown"}`);
    }
    await wait(250);
  }
  throw new Error(`export ${exportId} did not finish within the smoke-test deadline`);
}

await request("/ready");
const consent = await request("/privacy/ai-processing-consent");
invariant(typeof consent.body.consentVersion === "string", "AI consent version is missing");

const sessionToken = suppliedAuthToken
  ?? (await json("/auth/dev-session", "POST", { displayName: `端到端冒烟 ${stamp}` })).body.token;
const authorization = `Bearer ${sessionToken}`;
const authHeaders = { authorization };

const sourceWidth = 8;
const sourceHeight = 8;
const sourcePixels = Buffer.alloc(sourceWidth * sourceHeight * 4);
const sourceColors = {
  red: [0xd8, 0x01, 0x27, 0xff], // MARD F5
  blue: [0x01, 0xac, 0xeb, 0xff], // MARD C5
  green: [0x7c, 0xee, 0x9d, 0xff], // MARD B3
  transparent: [0x00, 0x00, 0x00, 0x00],
};
for (let y = 0; y < sourceHeight; y += 1) {
  for (let x = 0; x < sourceWidth; x += 1) {
    const color = y >= sourceHeight / 2 && x >= sourceWidth / 2
      ? sourceColors.transparent
      : y >= sourceHeight / 2
        ? sourceColors.green
        : x >= sourceWidth / 2
          ? sourceColors.blue
          : sourceColors.red;
    sourcePixels.set(color, (y * sourceWidth + x) * 4);
  }
}
const sourcePng = await sharp(sourcePixels, {
  raw: { width: sourceWidth, height: sourceHeight, channels: 4 },
}).png().toBuffer();
const form = new FormData();
form.append("purpose", "ai-source");
form.append("consentVersion", consent.body.consentVersion);
form.append("file", new Blob([sourcePng], { type: "image/png" }), "e2e-source.png");
const uploaded = await request("/assets", {
  method: "POST",
  headers: { ...authHeaders, "Idempotency-Key": `e2e-source-${stamp}` },
  body: form,
});
const sourceAssetId = uploaded.body.asset.id;
invariant(uploaded.response.status === 201 && sourceAssetId, "private source asset was not created");

const rasterGenerationPayload = {
  kind: "pixel",
  paletteId: "mard-48-v1",
  sourceAssetId,
  width: sourceWidth,
  height: sourceHeight,
  seed: `e2e-raster-${stamp}`,
  options: {
    crop: { ratio: "original" },
    maxColors: 8,
    transparentBackground: true,
  },
};
const rasterGenerationHeaders = {
  ...authHeaders,
  "idempotency-key": `e2e-raster-${stamp}`,
};
const [rasterGeneration, rasterConcurrentReplay] = await Promise.all([
  json("/generation-jobs", "POST", rasterGenerationPayload, rasterGenerationHeaders),
  json("/generation-jobs", "POST", rasterGenerationPayload, rasterGenerationHeaders),
]);
invariant(rasterGeneration.response.status === 202, "raster generation job was not queued");
const rasterGenerationId = rasterGeneration.body.job.id;
invariant(
  rasterConcurrentReplay.body.job.id === rasterGenerationId,
  "concurrent idempotent raster generation created two jobs",
);
const processedRasterGeneration = await processGenerationUntilDone(rasterGenerationId, authorization);
invariant(processedRasterGeneration.kind === "pixel", "raster generation did not retain pixel mode");
const rasterCandidate = processedRasterGeneration.candidates[0];
invariant(
  rasterCandidate?.grid?.cells?.length === sourceWidth * sourceHeight,
  "raster generation candidate is invalid",
);
const rasterCells = rasterCandidate.grid.cells;
const rasterColors = new Set(rasterCells.filter((cell) => cell !== null));
const rasterBlankCount = rasterCells.filter((cell) => cell === null).length;
invariant(rasterColors.size >= 2, "raster generation did not preserve multiple source colors");
invariant(rasterBlankCount > 0, "raster generation did not preserve transparent source pixels as empty cells");
invariant(rasterCells[0] === "F5", "raster generation did not map the source red quadrant");
invariant(rasterCells[sourceWidth - 1] === "C5", "raster generation did not map the source blue quadrant");
invariant(
  rasterCells[(sourceHeight - 1) * sourceWidth] === "B3",
  "raster generation did not map the source green quadrant",
);
invariant(rasterCells.at(-1) === null, "raster generation did not preserve the transparent quadrant");

let generationId = rasterGenerationId;
let candidate = rasterCandidate;
let acceptedProjectMode = "pixel";
if (!productionCandidate) {
  const generationPayload = {
    kind: "portrait",
    paletteId: "mard-48-v1",
    sourceAssetId,
    width: 8,
    height: 8,
    seed: `e2e-${stamp}`,
    options: {
      removeBackground: true,
      figureStyle: "chibi-full",
      maxColors: 8,
      transparentBackground: true,
    },
  };
  const generationHeaders = {
    ...authHeaders,
    "idempotency-key": `e2e-generation-${stamp}`,
  };
  const [createdGeneration, concurrentReplay] = await Promise.all([
    json("/generation-jobs", "POST", generationPayload, generationHeaders),
    json("/generation-jobs", "POST", generationPayload, generationHeaders),
  ]);
  invariant(createdGeneration.response.status === 202, "generation job was not queued");
  generationId = createdGeneration.body.job.id;
  invariant(concurrentReplay.body.job.id === generationId, "concurrent idempotent generation created two jobs");

  const processedGeneration = await processGenerationUntilDone(generationId, authorization);
  invariant(processedGeneration.id === generationId, "worker processed an unexpected generation job");
  invariant(processedGeneration.status === "completed", "generation job did not complete");
  candidate = processedGeneration.candidates[0];
  acceptedProjectMode = "portrait";
  invariant(candidate?.id && candidate.grid?.cells?.length === 64, "generation candidate is invalid");
}

const accepted = await json(`/generation-jobs/${generationId}/accept`, "POST", {
  candidateId: candidate.id,
  projectName: "端到端生成作品",
}, {
  ...authHeaders,
  "idempotency-key": `e2e-accept-${stamp}`,
});
invariant(accepted.response.status === 201, "candidate was not accepted");
let project = accepted.body.project;
invariant(project.mode === acceptedProjectMode, "accepted project did not retain its generation mode");
invariant(project.lifecycleStatus === "editable", "accepted project has an invalid initial lifecycle status");
invariant(project.sourceAssetId === sourceAssetId, "accepted project did not retain its private source reference");
invariant(project.backgroundMode === "transparent", "accepted project did not retain its background mode");

const baseGridRevision = project.currentRevision;
const baseMetadataRevision = project.metadataRevision;
const gridBeforeMetadataUpdate = structuredClone(project.grid);
invariant(Number.isInteger(baseMetadataRevision), "accepted project is missing its metadata revision");
const metadataUpdated = await json(`/projects/${project.id}/metadata`, "PATCH", {
  baseRevision: baseGridRevision,
  baseMetadataRevision,
  backgroundMode: "white",
}, {
  ...authHeaders,
  "idempotency-key": `e2e-project-metadata-${stamp}`,
});
project = metadataUpdated.body.project;
invariant(project.metadataRevision === baseMetadataRevision + 1, "metadata revision did not increment");
invariant(project.currentRevision === baseGridRevision, "metadata update incorrectly created a grid revision");
invariant(
  JSON.stringify(project.grid) === JSON.stringify(gridBeforeMetadataUpdate),
  "metadata update changed the immutable project grid",
);
const staleMetadataUpdate = await uncheckedJson(`/projects/${project.id}/metadata`, "PATCH", {
  baseRevision: baseGridRevision,
  baseMetadataRevision,
  backgroundMode: "transparent",
}, {
  ...authHeaders,
  "idempotency-key": `e2e-project-metadata-stale-${stamp}`,
});
invariant(staleMetadataUpdate.response.status === 409, "stale metadata revision was not rejected with HTTP 409");
invariant(
  staleMetadataUpdate.body?.error?.code === "PROJECT_METADATA_REVISION_CONFLICT",
  "stale metadata revision returned an unexpected error code",
);
invariant(
  staleMetadataUpdate.body?.error?.details?.currentMetadataRevision === project.metadataRevision,
  "metadata conflict did not report the current metadata revision",
);

const draftGrid = structuredClone(project.grid);
const firstFilledIndex = draftGrid.cells.findIndex((cell) => cell !== null);
if (firstFilledIndex >= 0) draftGrid.cells[firstFilledIndex] = "F5";
const savedDraft = await json(`/projects/${project.id}/draft`, "PUT", {
  baseProjectRevision: project.currentRevision,
  baseDraftRevision: 0,
  name: "端到端编辑草稿",
  grid: draftGrid,
}, authHeaders);
invariant(savedDraft.body.draft.draftRevision === 1, "project working draft was not saved");

const committedDraft = await json(`/projects/${project.id}/draft/commit`, "POST", {
  baseProjectRevision: project.currentRevision,
  draftRevision: savedDraft.body.draft.draftRevision,
}, {
  ...authHeaders,
  "idempotency-key": `e2e-draft-commit-${stamp}`,
});
project = committedDraft.body.project;
invariant(project.currentRevision === 2, "working draft did not create the next immutable revision");

const preRemapRevision = project.currentRevision;
const remapPayload = {
  baseRevision: preRemapRevision,
  paletteId: "mard-48-v1",
  maxColors: 5,
  inventoryOnly: false,
};
const remapHeaders = {
  ...authHeaders,
  "idempotency-key": `e2e-remap-${stamp}`,
};
const remapped = await json(`/projects/${project.id}/remap-palette`, "POST", remapPayload, remapHeaders);
const remapReplay = await json(`/projects/${project.id}/remap-palette`, "POST", remapPayload, remapHeaders);
project = remapped.body.project;
invariant(project.currentRevision === preRemapRevision + 1, "palette remap did not create one immutable revision");
invariant(remapReplay.body.project.currentRevision === project.currentRevision, "palette remap replay created another revision");
invariant(project.paletteId === "mard-48-v1", "palette remap did not persist the target palette");
invariant(remapped.body.materials.colorCount <= 5, "palette remap exceeded maxColors");
invariant(remapped.body.materials.width === project.grid.width, "remap material width is inconsistent");
invariant(remapped.body.materials.height === project.grid.height, "remap material height is inconsistent");
invariant(remapped.body.materials.occupiedBounds !== null, "remap material occupied bounds are missing");
invariant(remapped.body.materials.physicalSize?.unit === "mm", "remap physical size contract is missing");
invariant(remapped.body.materials.physicalSize?.beadSizeMm === 2.6, "remap bead size is inconsistent");
const staleRemap = await uncheckedJson(`/projects/${project.id}/remap-palette`, "POST", {
  ...remapPayload,
  baseRevision: preRemapRevision,
  maxColors: 6,
}, {
  ...authHeaders,
  "idempotency-key": `e2e-remap-stale-${stamp}`,
});
invariant(staleRemap.response.status === 409, "stale palette remap was not rejected with HTTP 409");
invariant(staleRemap.body?.error?.code === "PROJECT_REVISION_CONFLICT", "stale palette remap returned a wrong code");
const progressIndex = project.grid.cells.findIndex((cell) => cell !== null);
invariant(progressIndex >= 0, "generated project contains no bead to mark as completed");

const progress = await json(`/projects/${project.id}/build-progress`, "PUT", {
  projectRevision: project.currentRevision,
  baseProgressRevision: 0,
  mode: "color",
  completedIndices: [progressIndex],
  elapsedTime: 7,
}, {
  ...authHeaders,
  "idempotency-key": `e2e-progress-${stamp}`,
});
invariant(progress.body.progress.progressRevision === 1, "build progress was not saved");
invariant(progress.body.progress.mode === "color", "build mode was not persisted");
invariant(progress.body.progress.elapsedTime === 7, "elapsed build time was not persisted");
invariant(Date.parse(progress.body.progress.startedAt) > 0, "build start time was not assigned by the server");
invariant(progress.body.progress.completedAt === null, "partial build progress was incorrectly marked complete");

const materials = await request(`/projects/${project.id}/materials`, { headers: authHeaders });
invariant(
  materials.body.materials.beadCount === project.grid.cells.filter((cell) => cell !== null).length,
  "material count does not match the committed grid",
);

const creationGrid = {
  encoding: "palette-code-v1",
  width: 2,
  height: 2,
  cells: ["F5", null, "C5", "A11"],
};
const initialCreationDraft = await json("/creation-draft", "PUT", {
  draftId: null,
  baseDraftRevision: 0,
  name: "端到端创建流程",
  kind: "portrait",
  setupStep: 2,
  paletteId: "mard-48-v1",
  sourceAssetId,
  width: creationGrid.width,
  height: creationGrid.height,
  options: { figureStyle: "chibi-full", maxColors: 8 },
  grid: null,
}, authHeaders);
const creationDraft = await json("/creation-draft", "PUT", {
  draftId: initialCreationDraft.body.draft.id,
  baseDraftRevision: initialCreationDraft.body.draft.draftRevision,
  name: "端到端创建流程",
  kind: "portrait",
  setupStep: 3,
  paletteId: "mard-48-v1",
  sourceAssetId,
  width: creationGrid.width,
  height: creationGrid.height,
  options: { figureStyle: "chibi-full", maxColors: 8 },
  grid: creationGrid,
}, authHeaders);
const creationCommitted = await json("/creation-draft/commit", "POST", {
  draftId: creationDraft.body.draft.id,
  draftRevision: creationDraft.body.draft.draftRevision,
}, {
  ...authHeaders,
  "idempotency-key": `e2e-creation-commit-${stamp}`,
});
invariant(creationCommitted.response.status === 201, "creation flow draft was not promoted to a project");
invariant(creationCommitted.body.project.mode === "portrait", "creation flow project did not retain its mode");
invariant(
  creationCommitted.body.project.sourceAssetId === sourceAssetId,
  "creation flow project did not retain its private source reference",
);
invariant(creationCommitted.body.project.backgroundMode === "white", "creation flow project background is invalid");
const creationAfterCommit = await request("/creation-draft", { headers: authHeaders });
invariant(creationAfterCommit.body.draft === null, "creation flow draft still exists after commit");

const inventoryProject = creationCommitted.body.project;
const inventorySeedQuantities = new Map([
  ["F5", 3],
  ["C5", 2],
  ["A11", 4],
]);
const inventoryBatch = await json("/inventory/batch", "POST", {
  mode: "calibrate",
  items: [...inventorySeedQuantities].map(([colorCode, quantity]) => ({
    paletteId: inventoryProject.paletteId,
    colorCode,
    quantity,
    location: "  端到端库存位  ",
    baseRevision: 0,
  })),
}, {
  ...authHeaders,
  "idempotency-key": `e2e-inventory-batch-${stamp}`,
});
invariant(inventoryBatch.body.items.length === inventorySeedQuantities.size, "inventory batch did not save every color");
invariant(
  inventoryBatch.body.items.every((item) =>
    item.quantity === inventorySeedQuantities.get(item.colorCode)
      && item.location === "端到端库存位"
      && item.revision === 1),
  "inventory batch quantities, locations, or revisions are inconsistent",
);
invariant(
  inventoryBatch.body.transactions.every((entry) =>
    entry.quantityBefore === 0
      && entry.delta === inventorySeedQuantities.get(entry.colorCode)
      && entry.quantityAfter === inventorySeedQuantities.get(entry.colorCode)),
  "inventory calibration ledger did not record before, delta, and after quantities",
);

const inventoryProjectFilledIndices = inventoryProject.grid.cells
  .map((cell, index) => cell === null ? null : index)
  .filter((index) => index !== null);
invariant(inventoryProjectFilledIndices.length > 0, "inventory smoke project contains no beads");
const inventoryProgress = await json(`/projects/${inventoryProject.id}/build-progress`, "PUT", {
  projectRevision: inventoryProject.currentRevision,
  baseProgressRevision: 0,
  mode: "color",
  completedIndices: inventoryProjectFilledIndices,
  elapsedTime: 12,
}, {
  ...authHeaders,
  "idempotency-key": `e2e-inventory-progress-${stamp}`,
});
invariant(inventoryProgress.body.progress.completedAt, "fully completed inventory project was not marked complete");
invariant(
  inventoryProgress.body.progress.completedIndices.length === inventoryProjectFilledIndices.length,
  "inventory project progress did not retain every non-empty cell",
);

const completionPhotoPng = await sharp({
  create: { width: 12, height: 9, channels: 4, background: { r: 249, g: 121, b: 111, alpha: 1 } },
}).png().toBuffer();
const completionPhotoKey = `e2e-completion-photo-${stamp}`;
const uploadCompletionPhoto = async () => {
  const completionPhotoForm = new FormData();
  completionPhotoForm.append(
    "file",
    new Blob([completionPhotoPng], { type: "image/png" }),
    "e2e-completion.png",
  );
  return request(
    `/projects/${inventoryProject.id}/completion-photos?projectRevision=${inventoryProject.currentRevision}`,
    {
      method: "POST",
      headers: { ...authHeaders, "idempotency-key": completionPhotoKey },
      body: completionPhotoForm,
    },
  );
};
const completionPhotoCreated = await uploadCompletionPhoto();
const completionPhotoReplay = await uploadCompletionPhoto();
invariant(completionPhotoCreated.response.status === 201, "completion photo was not created");
invariant(
  completionPhotoReplay.body.photo.id === completionPhotoCreated.body.photo.id
    && completionPhotoReplay.response.headers.get("idempotency-replayed") === "true",
  "completion photo upload was not replayed idempotently",
);
const completionPhotoId = completionPhotoCreated.body.photo.id;
const completionPhotoList = await request(
  `/projects/${inventoryProject.id}/completion-photos`,
  { headers: authHeaders },
);
invariant(
  completionPhotoList.body.revision === inventoryProject.currentRevision
    && completionPhotoList.body.photos.some((photo) => photo.id === completionPhotoId),
  "completion photo was not visible on its current project revision",
);
const completionPhotoContent = await request(
  `/projects/${inventoryProject.id}/completion-photos/${completionPhotoId}/content`,
  { headers: authHeaders },
);
invariant(
  createHash("sha256").update(completionPhotoContent.bytes).digest("hex")
    === completionPhotoCreated.body.photo.sha256,
  "completion photo content hash differs from its published metadata",
);
const completionPhotoDeleteHeaders = {
  ...authHeaders,
  "idempotency-key": `e2e-completion-photo-delete-${stamp}`,
};
const completionPhotoDeleted = await request(
  `/projects/${inventoryProject.id}/completion-photos/${completionPhotoId}`,
  { method: "DELETE", headers: completionPhotoDeleteHeaders },
);
const completionPhotoDeleteReplay = await request(
  `/projects/${inventoryProject.id}/completion-photos/${completionPhotoId}`,
  { method: "DELETE", headers: completionPhotoDeleteHeaders },
);
invariant(completionPhotoDeleted.response.status === 204, "completion photo was not deleted");
invariant(
  completionPhotoDeleteReplay.response.headers.get("idempotency-replayed") === "true",
  "completion photo deletion was not replayed idempotently",
);
const hiddenCompletionPhoto = await requestUnchecked(
  `/projects/${inventoryProject.id}/completion-photos/${completionPhotoId}/content`,
  { headers: authHeaders },
);
invariant(
  hiddenCompletionPhoto.response.status === 404,
  "deleted completion photo content remained visible",
);
const completionPhotoListAfterDelete = await request(
  `/projects/${inventoryProject.id}/completion-photos`,
  { headers: authHeaders },
);
invariant(
  completionPhotoListAfterDelete.body.photos.every((photo) => photo.id !== completionPhotoId),
  "deleted completion photo remained in the project list",
);

const inventoryConsumptionHeaders = {
  ...authHeaders,
  "idempotency-key": `e2e-inventory-consume-${stamp}`,
};
const inventoryConsumption = await json(`/projects/${inventoryProject.id}/inventory-consumption`, "POST", {
  projectRevision: inventoryProject.currentRevision,
}, inventoryConsumptionHeaders);
const inventoryConsumptionReplay = await json(`/projects/${inventoryProject.id}/inventory-consumption`, "POST", {
  projectRevision: inventoryProject.currentRevision,
}, inventoryConsumptionHeaders);
invariant(
  inventoryConsumptionReplay.response.headers.get("idempotency-replayed") === "true",
  "inventory consumption replay was not served idempotently",
);
invariant(
  inventoryConsumptionReplay.body.consumption.operationId === inventoryConsumption.body.consumption.operationId,
  "inventory consumption replay created another operation",
);
const consumedByColor = new Map(
  inventoryConsumption.body.consumption.transactions.map((entry) => [entry.colorCode, entry]),
);
invariant(consumedByColor.size === inventorySeedQuantities.size, "inventory consumption did not write every color ledger line");
for (const [colorCode, quantityBefore] of inventorySeedQuantities) {
  const entry = consumedByColor.get(colorCode);
  invariant(
    entry?.type === "project_consumption"
      && entry.quantityBefore === quantityBefore
      && entry.delta === -1
      && entry.quantityAfter === quantityBefore - 1,
    `inventory consumption ledger is inconsistent for ${colorCode}`,
  );
}

const inventoryBalance = await request(`/inventory?paletteId=${encodeURIComponent(inventoryProject.paletteId)}`, {
  headers: authHeaders,
});
const inventoryBalanceByColor = new Map(inventoryBalance.body.items.map((item) => [item.colorCode, item]));
for (const [colorCode, seededQuantity] of inventorySeedQuantities) {
  const item = inventoryBalanceByColor.get(colorCode);
  invariant(
    item?.quantity === seededQuantity - 1 && item.revision === 2,
    `inventory balance was not deducted exactly once for ${colorCode}`,
  );
}
const inventoryLedger = await request(
  `/inventory/transactions?projectId=${encodeURIComponent(inventoryProject.id)}&limit=10`,
  { headers: authHeaders },
);
invariant(
  inventoryLedger.body.transactions.length === inventorySeedQuantities.size
    && inventoryLedger.body.transactions.every((entry) =>
      entry.type === "project_consumption"
        && entry.projectId === inventoryProject.id
        && entry.projectRevision === inventoryProject.currentRevision),
  "project-filtered inventory ledger is incomplete or references the wrong revision",
);
invariant(
  inventoryLedger.body.pagination.hasMore === false && inventoryLedger.body.pagination.nextOffset === null,
  "inventory ledger pagination metadata is inconsistent",
);

const createdExport = await json("/exports", "POST", {
  projectId: project.id,
  projectRevision: project.currentRevision,
  format: "png",
  fileName: "端到端图纸",
  options: { showCodes: true, showGrid: true, transparentBackground: false },
}, {
  ...authHeaders,
  "idempotency-key": `e2e-export-${stamp}`,
});
const exportJob = await processExportUntilDone(createdExport.body.export.id, authorization);
const downloaded = await request(`/exports/${exportJob.id}/content`, { headers: authHeaders });
invariant(downloaded.bytes.length === exportJob.artifact.sizeBytes, "download size differs from export metadata");
invariant(downloaded.bytes.subarray(1, 4).toString("ascii") === "PNG", "download is not a PNG file");
const exportedProject = await request(`/projects/${project.id}`, { headers: authHeaders });
invariant(exportedProject.body.project.lifecycleStatus === "exported", "successful export did not update project lifecycle");

// --- Extended smoke: Web login domain, Fake payment, export cancel, privacy purge, idempotency conflict ---
const webChallenge = await json("/auth/web-login-challenges", "POST", {});
invariant(webChallenge.response.status === 201, "web login challenge was not created");
const pollToken = webChallenge.body.token;
const webSessionToken = webChallenge.body.sessionToken;
invariant(typeof pollToken === "string" && typeof webSessionToken === "string", "web login tokens missing");
invariant(webSessionToken !== pollToken, "web login poll token and sessionToken must stay distinct");
invariant(/^\d{6}$/.test(webChallenge.body.code), "web login code is not a six-digit string");
const webPending = await request("/auth/web-login-challenges/current", {
  headers: { "x-web-login-token": pollToken },
});
invariant(webPending.body.status === "pending", "web login challenge was not pending before confirm");
const webConfirmed = await json("/auth/web-login-challenges/confirm", "POST", { code: webChallenge.body.code }, authHeaders);
invariant(webConfirmed.response.status === 200, "web login confirm failed");
const webApproved = await request("/auth/web-login-challenges/current", {
  headers: { "x-web-login-token": pollToken },
});
invariant(webApproved.body.status === "approved", "web login challenge was not approved after confirm");
const confirmingMe = await request("/me", { headers: authHeaders });
const webMe = await request("/me", { headers: { authorization: `Bearer ${webSessionToken}` } });
invariant(webMe.body.user.id === confirmingMe.body.user.id, "web sessionToken did not hydrate the confirming account");
const pollAsBearer = await requestUnchecked("/me", { headers: { authorization: `Bearer ${pollToken}` } });
if (productionCandidate) {
  invariant(pollAsBearer.response.status === 401, "production candidate must reject poll token as Bearer");
}

const creditProducts = await request("/credit-products", { headers: authHeaders });
const fakePack = creditProducts.body.products?.find((product) => product.id === "ai-9" && product.enabled !== false)
  ?? creditProducts.body.products?.[0];
invariant(fakePack?.id && Number.isInteger(fakePack.version), "credit products are missing for Fake payment smoke");
const paymentCreateHeaders = { ...authHeaders, "idempotency-key": `e2e-payment-${stamp}` };
const paymentCreated = await json("/payment-orders", "POST", {
  productId: fakePack.id,
  productVersion: fakePack.version,
}, paymentCreateHeaders);
invariant(paymentCreated.response.status === 201, "Fake payment order was not created");
const paymentOrderId = paymentCreated.body.order.id;
const paymentReplay = await json("/payment-orders", "POST", {
  productId: fakePack.id,
  productVersion: fakePack.version,
}, paymentCreateHeaders);
invariant(paymentReplay.body.order.id === paymentOrderId, "Fake payment create replay minted another order");
const paymentConflict = await uncheckedJson("/payment-orders", "POST", {
  productId: fakePack.id === "ai-9" ? "ai-49" : "ai-9",
  productVersion: 1,
}, paymentCreateHeaders);
invariant(paymentConflict.response.status === 409, "same Idempotency-Key with different body must return 409");
invariant(
  paymentConflict.body?.error?.code === "IDEMPOTENCY_CONFLICT",
  "same Idempotency-Key with different body must return IDEMPOTENCY_CONFLICT",
);
let fakePaymentCredited = 0;
if (!productionCandidate) {
  const pendingRefresh = await json(`/payment-orders/${paymentOrderId}/refresh`, "POST", {}, {
    ...authHeaders,
    "idempotency-key": `e2e-payment-refresh-pending-${stamp}`,
  });
  invariant(pendingRefresh.body.order.status === "pending", "Fake payment order should stay pending before succeed");
  const fakeSucceed = await json(`/internal/fake-payments/${paymentOrderId}/succeed`, "POST", {}, {
    "x-internal-worker-key": workerKey,
  });
  invariant(fakeSucceed.response.status === 202, "Fake payment succeed endpoint failed");
  const paidRefresh = await json(`/payment-orders/${paymentOrderId}/refresh`, "POST", {}, {
    ...authHeaders,
    "idempotency-key": `e2e-payment-refresh-paid-${stamp}`,
  });
  invariant(paidRefresh.body.order.status === "succeeded", "Fake payment refresh did not converge to succeeded");
  invariant(paidRefresh.body.credited === true, "Fake payment refresh did not credit once");
  fakePaymentCredited = paidRefresh.body.order.creditAmount ?? fakePack.creditAmount ?? 0;
  const paidRefreshAgain = await json(`/payment-orders/${paymentOrderId}/refresh`, "POST", {}, {
    ...authHeaders,
    "idempotency-key": `e2e-payment-refresh-paid-again-${stamp}`,
  });
  invariant(paidRefreshAgain.body.credited === false, "Fake payment refresh credited more than once");
}

const cancelExportCreated = await json("/exports", "POST", {
  projectId: project.id,
  projectRevision: project.currentRevision,
  format: "pdf",
  fileName: "端到端取消导出",
  options: { orientation: "portrait" },
}, {
  ...authHeaders,
  "idempotency-key": `e2e-export-cancel-create-${stamp}`,
});
invariant(cancelExportCreated.response.status === 202, "cancel-target export was not queued");
const cancelExportId = cancelExportCreated.body.export.id;
const canceledExport = await json(`/exports/${cancelExportId}/cancel`, "POST", {}, {
  ...authHeaders,
  "idempotency-key": `e2e-export-cancel-${stamp}`,
});
invariant(canceledExport.response.status === 200, "export cancel failed");
invariant(canceledExport.body.export.status === "canceled", "export cancel did not mark canceled");
const canceledDownload = await requestUnchecked(`/exports/${cancelExportId}/content`, { headers: authHeaders });
invariant(canceledDownload.response.status === 410, "canceled export content must be unavailable");

const privacyPurge = await json("/privacy/delete-expired", "POST", { limit: 20 }, {
  "x-internal-worker-key": workerKey,
});
invariant(
  privacyPurge.response.status === 200 || privacyPurge.response.status === 207,
  "privacy delete-expired must accept the internal worker key",
);
invariant(Number.isInteger(privacyPurge.body.purged), "privacy delete-expired must report purged count");

const me = await request("/me", { headers: authHeaders });
const generationHistory = await request("/generation-jobs?limit=10", { headers: authHeaders });
const expectedGenerationIds = new Set([generationId, rasterGenerationId]);
invariant(
  generationHistory.body.jobs.length === expectedGenerationIds.size
    && generationHistory.body.jobs.every((job) => expectedGenerationIds.has(job.id)),
  "generation history contains a duplicate or unexpected job",
);
const expectedBalance = (productionCandidate ? 20 : 19) + fakePaymentCredited;
invariant(me.body.account.balance === expectedBalance, "credit balance after smoke extensions is inconsistent");
const result = {
  baseUrl,
  workerMode: externalWorkers ? "external-processes" : "internal-endpoints",
  candidateRuntime: productionCandidate ? "production" : "source-test",
  userId: me.body.user.id,
  sourceAssetId,
  rasterGenerationId,
  rasterColorCodes: [...rasterColors].sort(),
  rasterBlankCount,
  generationId,
  generatedProjectId: project.id,
  generatedProjectRevision: project.currentRevision,
  generatedProjectMetadataRevision: project.metadataRevision,
  remapColorCount: remapped.body.materials.colorCount,
  creationProjectId: creationCommitted.body.project.id,
  inventoryOperationId: inventoryConsumption.body.consumption.operationId,
  inventoryLedgerLines: inventoryLedger.body.transactions.length,
  completionPhotoId,
  completionPhotoBytes: completionPhotoContent.bytes.length,
  inventoryBalances: Object.fromEntries(
    [...inventorySeedQuantities.keys()].map((colorCode) => [colorCode, inventoryBalanceByColor.get(colorCode).quantity]),
  ),
  buildProgressRevision: progress.body.progress.progressRevision,
  materialBeadCount: materials.body.materials.beadCount,
  exportId: exportJob.id,
  exportBytes: downloaded.bytes.length,
  remainingCredits: me.body.account.balance,
  webLoginSessionDistinct: webSessionToken !== pollToken,
  paymentOrderId,
  fakePaymentCredited,
  canceledExportId: cancelExportId,
  privacyPurged: privacyPurge.body.purged,
  idempotencyConflict: paymentConflict.body?.error?.code === "IDEMPOTENCY_CONFLICT",
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
