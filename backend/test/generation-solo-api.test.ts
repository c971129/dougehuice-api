import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import type { StorageProvider } from "../src/storage/storage-provider.js";

const WORKER_KEY = "pindou-test-worker-key-at-least-32-chars";
const SOURCE_ASSET_ID = "00000000-0000-4000-8000-000000000451";
const SOURCE_STORAGE_KEY = "solo-api-source-storage-key";
const SOURCE_CONTENTS = Buffer.from("two-person-source-image");

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
  assetStorageRoot: join(tmpdir(), "pindou-generation-solo-api-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: WORKER_KEY,
};

const storage: StorageProvider = {
  ready: async () => undefined,
  put: async () => ({ storageKey: SOURCE_STORAGE_KEY }),
  get: async (storageKey) => storageKey === SOURCE_STORAGE_KEY ? Buffer.from(SOURCE_CONTENTS) : null,
  delete: async () => undefined,
};

describe("couple solo generation API", () => {
  let app: FastifyInstance;
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    app = await buildApp({ config, store, storage, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns two subject-owned grids and atomically adopts a complete solo variant", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: "独立人物 API 测试用户" },
    });
    assert.equal(login.statusCode, 201, login.body);
    const session = login.json() as { token: string; user: { id: string } };
    const auth = { authorization: `Bearer ${session.token}` };
    const createdAt = "2026-10-04T10:00:00.000Z";
    await store.createAsset({
      id: SOURCE_ASSET_ID,
      userId: session.user.id,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: createHash("sha256").update(SOURCE_CONTENTS).digest("hex"),
      mimeType: "image/png",
      sizeBytes: SOURCE_CONTENTS.length,
      width: 32,
      height: 24,
      storageKey: SOURCE_STORAGE_KEY,
      expiresAt: "2030-10-05T10:00:00.000Z",
      createdAt,
    });
    await store.markAssetReady(session.user.id, SOURCE_ASSET_ID, createdAt);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: { ...auth, "idempotency-key": "solo-api-create-0001" },
      payload: {
        kind: "couple",
        paletteId: "mard-48-v1",
        sourceAssetId: SOURCE_ASSET_ID,
        width: 12,
        height: 10,
        seed: "solo-api-seed",
        options: { coupleLayout: "solo" },
      },
    });
    assert.equal(created.statusCode, 202, created.body);
    assert.equal(created.json().job.cost, 2);
    assert.equal(created.json().job.options.coupleLayout, "solo");
    const jobId = created.json().job.id as string;

    const processed = await app.inject({
      method: "POST",
      url: "/api/v1/internal/generation-jobs/process-next",
      headers: { "x-internal-worker-key": WORKER_KEY },
    });
    assert.equal(processed.statusCode, 200, processed.body);
    const candidates = processed.json().job.candidates as Array<{
      id: string;
      subject: number;
      acceptedProjectId?: string;
      acceptedAt?: string;
      grid: { width: number; height: number; cells: Array<string | null> };
    }>;
    assert.deepEqual(candidates.map((candidate) => candidate.subject), [1, 2, 1, 2]);
    assert.deepEqual(
      candidates.map((candidate) => [candidate.grid.width, candidate.grid.height]),
      [[12, 10], [12, 10], [12, 10], [12, 10]],
    );
    assert.notDeepEqual(candidates[0]?.grid.cells, candidates[1]?.grid.cells);
    assert.ok(candidates.every((candidate) => !("acceptedProjectId" in candidate) && !("acceptedAt" in candidate)));

    const legacyCandidateAccept = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${jobId}/accept`,
      headers: { ...auth, "idempotency-key": "solo-api-accept-subject-1" },
      payload: { candidateId: candidates[0]!.id, projectName: "人物一" },
    });
    assert.equal(legacyCandidateAccept.statusCode, 409, legacyCandidateAccept.body);
    assert.equal(
      legacyCandidateAccept.json().error.code,
      "GENERATION_CANDIDATE_REQUIRES_VARIANT_ACCEPT",
    );

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${jobId}/variants/1/accept`,
      headers: { ...auth, "idempotency-key": "solo-api-accept-variant-1" },
      payload: {
        projects: [
          { outputSlot: "subject-1", projectName: "人物一" },
          { outputSlot: "subject-2", projectName: "人物二" },
        ],
      },
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
    const acceptedOutputs = accepted.json().variant.outputs as Array<{
      outputSlot: string;
      project: {
        id: string;
        mode: string;
        lifecycleStatus: string;
        sourceAssetId: string | null;
        previewAssetId: string | null;
        backgroundMode: string;
        backgroundColor: string | null;
      };
    }>;
    assert.deepEqual(acceptedOutputs.map((output) => output.outputSlot), ["subject-1", "subject-2"]);
    const firstProjectId = acceptedOutputs[0]!.project.id;
    const secondProjectId = acceptedOutputs[1]!.project.id;
    assert.notEqual(secondProjectId, firstProjectId);
    for (const output of acceptedOutputs) {
      assert.equal(output.project.mode, "couple");
      assert.equal(output.project.lifecycleStatus, "editable");
      assert.equal(output.project.sourceAssetId, SOURCE_ASSET_ID);
      assert.equal(output.project.previewAssetId, null);
      assert.equal(output.project.backgroundMode, "white");
      assert.equal(output.project.backgroundColor, null);
    }
    assert.equal(accepted.json().job.status, "accepted");
    assert.equal(accepted.json().job.acceptedCandidateId, candidates[0]!.id);
    assert.deepEqual(
      accepted.json().job.candidates.map((candidate: { acceptedProjectId?: string }) => candidate.acceptedProjectId),
      [firstProjectId, secondProjectId, undefined, undefined],
    );
    assert.ok(accepted.json().job.candidates.slice(0, 2).every(
      (candidate: { acceptedAt?: string }) => candidate.acceptedAt && Date.parse(candidate.acceptedAt) > 0,
    ));
    assert.ok(accepted.json().job.candidates.slice(2).every(
      (candidate: { acceptedAt?: string }) => candidate.acceptedAt === undefined,
    ));

    const duplicateCandidate = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${jobId}/accept`,
      headers: { ...auth, "idempotency-key": "solo-api-accept-subject-2" },
      payload: { candidateId: candidates[1]!.id, projectName: "人物二重复" },
    });
    assert.equal(duplicateCandidate.statusCode, 409, duplicateCandidate.body);
    assert.equal(
      duplicateCandidate.json().error.code,
      "GENERATION_CANDIDATE_REQUIRES_VARIANT_ACCEPT",
    );

    const duplicateVariant = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${jobId}/variants/2/accept`,
      headers: { ...auth, "idempotency-key": "solo-api-accept-variant-2" },
      payload: {
        projects: [
          { outputSlot: "subject-1", projectName: "第二方案人物一" },
          { outputSlot: "subject-2", projectName: "第二方案人物二" },
        ],
      },
    });
    assert.equal(duplicateVariant.statusCode, 409, duplicateVariant.body);
    assert.equal(duplicateVariant.json().error.code, "GENERATION_VARIANT_ALREADY_ACCEPTED");

    const fetched = await app.inject({
      method: "GET",
      url: `/api/v1/generation-jobs/${jobId}`,
      headers: auth,
    });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.deepEqual(
      fetched.json().job.candidates.map((candidate: { subject: number; acceptedProjectId: string }) => ({
        subject: candidate.subject,
        acceptedProjectId: candidate.acceptedProjectId,
      })),
      [
        { subject: 1, acceptedProjectId: firstProjectId },
        { subject: 2, acceptedProjectId: secondProjectId },
        { subject: 1, acceptedProjectId: undefined },
        { subject: 2, acceptedProjectId: undefined },
      ],
    );
    assert.deepEqual(
      fetched.json().job.variants.map((variant: { variantOrdinal: number; outputs: unknown[] }) => ({
        variantOrdinal: variant.variantOrdinal,
        outputCount: variant.outputs.length,
      })),
      [{ variantOrdinal: 1, outputCount: 2 }, { variantOrdinal: 2, outputCount: 2 }],
    );

    const projects = await app.inject({ method: "GET", url: "/api/v1/projects", headers: auth });
    assert.equal(projects.statusCode, 200, projects.body);
    assert.deepEqual(
      new Set(projects.json().projects.map((project: { name: string }) => project.name)),
      new Set(["人物一", "人物二"]),
    );
    assert.equal((await store.getCreditAccount(session.user.id)).balance, 18);
  });

  it("groups split variants and atomically adopts both outputs with aggregate materials", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: "完整方案 API 测试用户" },
    });
    assert.equal(login.statusCode, 201, login.body);
    const session = login.json() as { token: string; user: { id: string } };
    const auth = { authorization: `Bearer ${session.token}` };
    const createdAt = "2026-10-04T11:00:00.000Z";
    await store.createAsset({
      id: SOURCE_ASSET_ID,
      userId: session.user.id,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: createHash("sha256").update(SOURCE_CONTENTS).digest("hex"),
      mimeType: "image/png",
      sizeBytes: SOURCE_CONTENTS.length,
      width: 32,
      height: 24,
      storageKey: SOURCE_STORAGE_KEY,
      expiresAt: "2030-10-05T11:00:00.000Z",
      createdAt,
    });
    await store.markAssetReady(session.user.id, SOURCE_ASSET_ID, createdAt);

    const createJob = async (key: string, seed: string) => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/generation-jobs",
        headers: { ...auth, "idempotency-key": key },
        payload: {
          kind: "couple",
          paletteId: "mard-48-v1",
          sourceAssetId: SOURCE_ASSET_ID,
          width: 12,
          height: 10,
          seed,
          options: { coupleLayout: "split", transparentBackground: true },
        },
      });
      assert.equal(created.statusCode, 202, created.body);
      const processed = await app.inject({
        method: "POST",
        url: "/api/v1/internal/generation-jobs/process-next",
        headers: { "x-internal-worker-key": WORKER_KEY },
      });
      assert.equal(processed.statusCode, 200, processed.body);
      return processed.json().job as {
        id: string;
        candidates: Array<{ variantOrdinal: number; outputSlot: string }>;
        variants: Array<{
          variantOrdinal: number;
          outputs: Array<{ outputSlot: string }>;
        }>;
      };
    };

    const job = await createJob("split-api-create-0001", "split-api-seed-1");
    assert.deepEqual(job.candidates.map((candidate) => [candidate.variantOrdinal, candidate.outputSlot]), [
      [1, "left"],
      [1, "right"],
      [2, "left"],
      [2, "right"],
    ]);
    assert.deepEqual(job.variants.map((variant) => ({
      variantOrdinal: variant.variantOrdinal,
      slots: variant.outputs.map((output) => output.outputSlot),
    })), [
      { variantOrdinal: 1, slots: ["left", "right"] },
      { variantOrdinal: 2, slots: ["left", "right"] },
    ]);

    const payload = {
      projects: [
        { outputSlot: "left", projectName: "方案一左侧" },
        { outputSlot: "right", projectName: "方案一右侧" },
      ],
    };
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${job.id}/variants/1/accept`,
      headers: { ...auth, "idempotency-key": "split-api-variant-accept-0001" },
      payload,
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
    const acceptedBody = accepted.json() as {
      job: { status: string; candidates: Array<{ acceptedProjectId?: string }> };
      variant: {
        variantOrdinal: number;
        outputs: Array<{
          outputSlot: string;
          project: {
            id: string;
            mode: string;
            sourceAssetId: string | null;
            previewAssetId: string | null;
            backgroundMode: string;
          };
          materials: {
            beadCount: number;
            estimatedTotalCents: number;
            lines: Array<{ colorCode: string; quantity: number }>;
          };
        }>;
      };
      totalMaterials: {
        outputCount: number;
        colorCount: number;
        beadCount: number;
        estimatedTotalCents: number;
        lines: Array<{ colorCode: string; quantity: number }>;
      };
    };
    assert.equal(acceptedBody.job.status, "accepted");
    assert.equal(acceptedBody.variant.variantOrdinal, 1);
    assert.deepEqual(acceptedBody.variant.outputs.map((output) => output.outputSlot), ["left", "right"]);
    assert.ok(acceptedBody.variant.outputs.every((output) => output.project.mode === "couple"));
    assert.ok(acceptedBody.variant.outputs.every((output) => output.project.sourceAssetId === SOURCE_ASSET_ID));
    assert.ok(acceptedBody.variant.outputs.every((output) => output.project.previewAssetId === null));
    assert.ok(acceptedBody.variant.outputs.every((output) => output.project.backgroundMode === "transparent"));
    assert.deepEqual(
      acceptedBody.job.candidates.map((candidate) => Boolean(candidate.acceptedProjectId)),
      [true, true, false, false],
    );
    assert.equal(acceptedBody.totalMaterials.outputCount, 2);
    assert.equal(
      acceptedBody.totalMaterials.beadCount,
      acceptedBody.variant.outputs.reduce((sum, output) => sum + output.materials.beadCount, 0),
    );
    assert.equal(
      acceptedBody.totalMaterials.estimatedTotalCents,
      acceptedBody.variant.outputs.reduce((sum, output) => sum + output.materials.estimatedTotalCents, 0),
    );
    const expectedQuantities = new Map<string, number>();
    for (const output of acceptedBody.variant.outputs) {
      for (const line of output.materials.lines) {
        expectedQuantities.set(line.colorCode, (expectedQuantities.get(line.colorCode) ?? 0) + line.quantity);
      }
    }
    assert.equal(acceptedBody.totalMaterials.colorCount, expectedQuantities.size);
    assert.deepEqual(
      new Map(acceptedBody.totalMaterials.lines.map((line) => [line.colorCode, line.quantity])),
      expectedQuantities,
    );

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${job.id}/variants/1/accept`,
      headers: { ...auth, "idempotency-key": "split-api-variant-accept-0001" },
      payload,
    });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.deepEqual(
      replay.json().variant.outputs.map((output: { project: { id: string } }) => output.project.id),
      acceptedBody.variant.outputs.map((output) => output.project.id),
    );

    const secondAdoption = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${job.id}/variants/2/accept`,
      headers: { ...auth, "idempotency-key": "split-api-variant-accept-0002" },
      payload: {
        projects: [
          { outputSlot: "left", projectName: "方案二左侧" },
          { outputSlot: "right", projectName: "方案二右侧" },
        ],
      },
    });
    assert.equal(secondAdoption.statusCode, 409, secondAdoption.body);
    assert.equal(secondAdoption.json().error.code, "GENERATION_VARIANT_ALREADY_ACCEPTED");

    const otherLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: "其他租户" },
    });
    assert.equal(otherLogin.statusCode, 201, otherLogin.body);
    const otherTenant = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${job.id}/variants/1/accept`,
      headers: {
        authorization: `Bearer ${otherLogin.json().token as string}`,
        "idempotency-key": "split-api-other-tenant-0001",
      },
      payload,
    });
    assert.equal(otherTenant.statusCode, 404, otherTenant.body);
    assert.equal(otherTenant.json().error.code, "GENERATION_JOB_NOT_FOUND");

    const concurrentJob = await createJob("split-api-create-0002", "split-api-seed-2");
    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/generation-jobs/${concurrentJob.id}/variants/1/accept`,
        headers: { ...auth, "idempotency-key": "split-api-concurrent-0001" },
        payload: {
          projects: [
            { outputSlot: "left", projectName: "并发方案一左侧" },
            { outputSlot: "right", projectName: "并发方案一右侧" },
          ],
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/generation-jobs/${concurrentJob.id}/variants/2/accept`,
        headers: { ...auth, "idempotency-key": "split-api-concurrent-0002" },
        payload: {
          projects: [
            { outputSlot: "left", projectName: "并发方案二左侧" },
            { outputSlot: "right", projectName: "并发方案二右侧" },
          ],
        },
      }),
    ]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [201, 409]);
    const rejected = first.statusCode === 409 ? first : second;
    assert.equal(rejected.json().error.code, "GENERATION_VARIANT_ALREADY_ACCEPTED");
    const projects = await app.inject({ method: "GET", url: "/api/v1/projects", headers: auth });
    assert.equal(projects.statusCode, 200, projects.body);
    assert.equal(projects.json().projects.length, 4);
  });
});
