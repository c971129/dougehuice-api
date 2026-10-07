import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { copyDefaultGenerationOptions } from "../src/domain/generation-options.js";
import type { GenerationProvider } from "../src/generation/provider.js";
import { processNextGeneration } from "../src/generation/worker.js";
import { DeterministicGenerationProvider } from "../src/generation/deterministic-provider.js";
import { AppError } from "../src/errors.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import type { StorageProvider } from "../src/storage/storage-provider.js";

const emptyStorage: StorageProvider = {
  ready: async () => undefined,
  put: async () => ({ storageKey: "unused-storage-key-000000" }),
  get: async () => null,
  delete: async () => undefined,
};

async function userWithCredits(store: MemoryStore, credits = 5) {
  const session = await store.createDevSession({
    displayName: "生成测试用户",
    tokenHash: "a".repeat(64),
    expiresAt: "2027-10-04T00:00:00.000Z",
    startingCredits: credits,
  });
  return session.user;
}

describe("generation worker", () => {
  it("cancels a queued job and releases reserved credits exactly once", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000401",
      userId: user.id,
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      cost: 1,
      seed: "cancel-seed",
      width: 8,
      height: 8,
      now: "2026-10-04T10:00:00.000Z",
    });
    assert.equal(job.status, "queued");
    assert.equal((await store.getCreditAccount(user.id)).balance, 4);

    const canceled = await store.cancelGenerationJob(user.id, job.id, "2026-10-04T10:01:00.000Z");
    assert.equal(canceled.status, "canceled");
    assert.equal((await store.getCreditAccount(user.id)).balance, 5);
    const replay = await store.cancelGenerationJob(user.id, job.id, "2026-10-04T10:02:00.000Z");
    assert.equal(replay.status, "canceled");
    assert.equal((await store.getCreditAccount(user.id)).balance, 5);
    const ledger = await store.listCreditLedger(user.id, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_reserved").length, 1);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_released").length, 1);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_settled").length, 0);
  });

  it("retries provider failures and releases credits only after the terminal attempt", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000402",
      userId: user.id,
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      cost: 1,
      seed: "retry-seed",
      width: 8,
      height: 8,
      now: "2026-10-04T10:00:00.000Z",
    });
    let attempts = 0;
    const provider: GenerationProvider = {
      kind: "failing-test",
      generate: async () => {
        attempts += 1;
        throw new Error("temporary provider outage");
      },
    };

    const first = await processNextGeneration({
      store,
      storage: emptyStorage,
      provider,
      now: new Date("2026-10-04T10:00:00.000Z"),
    });
    assert.equal(first?.status, "retry_wait");
    assert.equal(first?.attemptCount, 1);
    assert.equal((await store.getCreditAccount(user.id)).balance, 4);
    assert.equal(await processNextGeneration({
      store,
      storage: emptyStorage,
      provider,
      now: new Date("2026-10-04T10:00:09.000Z"),
    }), null);

    const second = await processNextGeneration({
      store,
      storage: emptyStorage,
      provider,
      now: new Date("2026-10-04T10:00:11.000Z"),
    });
    assert.equal(second?.status, "retry_wait");
    assert.equal(second?.attemptCount, 2);
    const third = await processNextGeneration({
      store,
      storage: emptyStorage,
      provider,
      now: new Date("2026-10-04T10:00:32.000Z"),
    });
    assert.equal(third?.status, "failed");
    assert.equal(third?.attemptCount, 3);
    assert.equal(attempts, 3);
    assert.equal((await store.getCreditAccount(user.id)).balance, 5);
    const ledger = await store.listCreditLedger(user.id, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_reserved").length, 1);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_released").length, 1);
  });

  it("terminally refunds a queued job whose palette was retired before worker processing", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-00000000040a",
      userId: user.id,
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      cost: 1,
      seed: "retired-before-worker",
      width: 8,
      height: 8,
      now: "2026-10-04T10:00:00.000Z",
    });
    const palettes = Reflect.get(store, "palettes") as Map<string, { retired?: boolean }>;
    const palette = palettes.get(job.paletteId);
    assert.ok(palette);
    palette.retired = true;
    let providerCalls = 0;
    const result = await processNextGeneration({
      store,
      storage: emptyStorage,
      provider: {
        kind: "must-not-run-for-retired-palette",
        generate: async () => {
          providerCalls += 1;
          return [];
        },
      },
      now: new Date("2026-10-04T10:00:01.000Z"),
    });
    assert.equal(result?.status, "failed");
    assert.equal(result?.errorCode, "PALETTE_RETIRED");
    assert.equal(providerCalls, 0);
    assert.equal((await store.getCreditAccount(user.id)).balance, 5);
    const ledger = await store.listCreditLedger(user.id, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_released").length, 1);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_settled").length, 0);
  });

  it("does not let a worker overwrite a cancellation that occurs during provider work", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000403",
      userId: user.id,
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      cost: 1,
      seed: "cancel-during-provider",
      width: 8,
      height: 8,
      now: "2026-10-04T10:00:00.000Z",
    });
    const provider: GenerationProvider = {
      kind: "canceling-test",
      generate: async (input) => {
        await store.cancelGenerationJob(user.id, input.job.id, "2026-10-04T10:00:01.000Z");
        return [];
      },
    };
    const result = await processNextGeneration({
      store,
      storage: emptyStorage,
      provider,
      now: new Date("2026-10-04T10:00:00.000Z"),
    });
    assert.equal(result?.status, "canceled");
    assert.equal((await store.getGenerationJob(user.id, job.id))?.status, "canceled");
    assert.equal((await store.getCreditAccount(user.id)).balance, 5);
  });

  it("fails a missing private source without retry and never calls the provider", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const contents = Buffer.from("source-image-bytes");
    const assetId = "00000000-0000-4000-8000-000000000404";
    await store.createAsset({
      id: assetId,
      userId: user.id,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: createHash("sha256").update(contents).digest("hex"),
      mimeType: "image/png",
      sizeBytes: contents.length,
      width: 8,
      height: 8,
      storageKey: "missing-private-object-000404",
      expiresAt: "2026-10-05T10:00:00.000Z",
      createdAt: "2026-10-04T09:00:00.000Z",
    });
    await store.markAssetReady(user.id, assetId, "2026-10-04T09:00:01.000Z");
    await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000405",
      userId: user.id,
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: assetId,
      cost: 1,
      seed: "missing-source",
      width: 8,
      height: 8,
      now: "2026-10-04T10:00:00.000Z",
    });
    let called = false;
    const provider: GenerationProvider = {
      kind: "must-not-run",
      generate: async () => {
        called = true;
        return [];
      },
    };
    const result = await processNextGeneration({
      store,
      storage: emptyStorage,
      provider,
      now: new Date("2026-10-04T10:00:00.000Z"),
    });
    assert.equal(result?.status, "failed");
    assert.equal(result?.errorCode, "GENERATION_SOURCE_ASSET_UNAVAILABLE");
    assert.equal(result?.attemptCount, 1);
    assert.equal(called, false);
    assert.equal((await store.getCreditAccount(user.id)).balance, 5);
  });

  it("completes deterministic candidates and records settlement without changing balance twice", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000406",
      userId: user.id,
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      cost: 1,
      seed: "success-seed",
      width: 8,
      height: 8,
      now: "2026-10-04T10:00:00.000Z",
    });
    const completed = await processNextGeneration({
      store,
      storage: emptyStorage,
      provider: new DeterministicGenerationProvider(),
      now: new Date("2026-10-04T10:00:00.000Z"),
    });
    assert.equal(completed?.id, job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.progress, 100);
    assert.equal(completed?.candidates.length, 2);
    assert.equal((await store.getCreditAccount(user.id)).balance, 4);
    const ledger = await store.listCreditLedger(user.id, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_reserved").length, 1);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_settled").length, 1);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_released").length, 0);
  });

  it("emits two complete, independently identified couple/solo variants", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const options = copyDefaultGenerationOptions();
    options.coupleLayout = "solo";
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000416",
      userId: user.id,
      kind: "couple",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      options,
      cost: 2,
      seed: "solo-subjects-seed",
      width: 12,
      height: 10,
      now: "2026-10-04T10:00:00.000Z",
    });

    const completed = await processNextGeneration({
      store,
      storage: emptyStorage,
      provider: new DeterministicGenerationProvider(),
      now: new Date("2026-10-04T10:00:00.000Z"),
    });

    assert.equal(completed?.id, job.id);
    assert.equal(completed?.cost, 2);
    assert.deepEqual(completed?.candidates.map((candidate) => [
      candidate.variantOrdinal,
      candidate.outputSlot,
      candidate.subject,
    ]), [
      [1, "subject-1", 1],
      [1, "subject-2", 2],
      [2, "subject-1", 1],
      [2, "subject-2", 2],
    ]);
    assert.deepEqual(
      completed?.candidates.map((candidate) => [candidate.acceptedProjectId, candidate.acceptedAt]),
      Array.from({ length: 4 }, () => [undefined, undefined]),
    );
    assert.notDeepEqual(completed?.candidates[0]?.grid.cells, completed?.candidates[1]?.grid.cells);
    assert.equal((await store.getCreditAccount(user.id)).balance, 3);
  });

  it("terminally rejects a couple/solo provider result without both subject slots", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const options = copyDefaultGenerationOptions();
    options.coupleLayout = "solo";
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000417",
      userId: user.id,
      kind: "couple",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      options,
      cost: 2,
      seed: "invalid-solo-subjects-seed",
      width: 8,
      height: 8,
      now: "2026-10-04T10:00:00.000Z",
    });
    const deterministic = new DeterministicGenerationProvider();
    const provider: GenerationProvider = {
      kind: "missing-solo-subject-test",
      generate: async (input) => {
        const generated = await deterministic.generate(input);
        return generated.map(({ subject: _subject, ...candidate }) => candidate);
      },
    };

    const failed = await processNextGeneration({
      store,
      storage: emptyStorage,
      provider,
      now: new Date("2026-10-04T10:00:00.000Z"),
    });

    assert.equal(failed?.id, job.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.errorCode, "GENERATION_CANDIDATES_INVALID");
    assert.equal((await store.getCreditAccount(user.id)).balance, 5);
  });

  it("accepts both couple/split outputs atomically as one variant", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const options = copyDefaultGenerationOptions();
    options.coupleLayout = "split";
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000418",
      userId: user.id,
      kind: "couple",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      options,
      cost: 2,
      seed: "split-compatibility-seed",
      width: 8,
      height: 8,
      now: "2026-10-04T10:00:00.000Z",
    });
    const completed = await processNextGeneration({
      store,
      storage: emptyStorage,
      provider: new DeterministicGenerationProvider(),
      now: new Date("2026-10-04T10:00:00.000Z"),
    });
    assert.deepEqual(completed?.candidates.map((candidate) => [
      candidate.variantOrdinal,
      candidate.outputSlot,
      candidate.subject,
    ]), [
      [1, "left", undefined],
      [1, "right", undefined],
      [2, "left", undefined],
      [2, "right", undefined],
    ]);
    await assert.rejects(
      store.acceptGenerationCandidate({
        userId: user.id,
        jobId: job.id,
        candidateId: completed!.candidates[0]!.id,
        projectName: "不得部分采用的左侧图纸",
      }),
      (error: unknown) => error instanceof AppError
        && error.code === "GENERATION_CANDIDATE_REQUIRES_VARIANT_ACCEPT",
    );
    const accepted = await store.acceptGenerationVariant({
      userId: user.id,
      jobId: job.id,
      variantOrdinal: 1,
      projects: [
        { outputSlot: "left", projectName: "左侧图纸" },
        { outputSlot: "right", projectName: "右侧图纸" },
      ],
    });
    assert.deepEqual(accepted.outputs.map((output) => output.outputSlot), ["left", "right"]);
    await assert.rejects(
      store.acceptGenerationVariant({
        userId: user.id,
        jobId: job.id,
        variantOrdinal: 2,
        projects: [
          { outputSlot: "left", projectName: "第二方案左侧" },
          { outputSlot: "right", projectName: "第二方案右侧" },
        ],
      }),
      (error: unknown) => error instanceof AppError && error.code === "GENERATION_VARIANT_ALREADY_ACCEPTED",
    );
  });

  it("terminally rejects an unbounded provider candidate response", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000407",
      userId: user.id,
      kind: "normal",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      cost: 0,
      seed: "too-many-candidates",
      width: 8,
      height: 8,
      now: "2026-10-04T10:00:00.000Z",
    });
    const baseProvider = new DeterministicGenerationProvider();
    const provider: GenerationProvider = {
      kind: "too-many-candidates-test",
      generate: async (input) => {
        const [first] = await baseProvider.generate(input);
        assert.ok(first);
        return Array.from({ length: 5 }, (_, index) => ({
          ...first,
          id: `${job.id}:overflow:${index + 1}`,
          ordinal: index + 1,
        }));
      },
    };

    const result = await processNextGeneration({
      store,
      storage: emptyStorage,
      provider,
      now: new Date("2026-10-04T10:00:00.000Z"),
    });
    assert.equal(result?.status, "failed");
    assert.equal(result?.attemptCount, 1);
    assert.equal(result?.errorCode, "GENERATION_CANDIDATE_LIMIT_EXCEEDED");
  });

  it("matches PostgreSQL candidate shape and uniqueness checks in MemoryStore", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store, 0);
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000408",
      userId: user.id,
      kind: "normal",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      cost: 0,
      seed: "candidate-parity",
      width: 2,
      height: 2,
      now: "2026-10-04T10:00:00.000Z",
    });
    const leaseToken = "00000000-0000-4000-8000-000000000409";
    await store.claimNextGenerationJob({
      now: "2026-10-04T10:00:00.000Z",
      leaseToken,
      leaseMilliseconds: 5 * 60_000,
    });
    const base = {
      id: "candidate-a",
      jobId: job.id,
      variantOrdinal: 1,
      outputSlot: "combined" as const,
      ordinal: 1,
      grid: { encoding: "palette-code-v1" as const, width: 2, height: 2, cells: ["H2", "H2", null, null] },
      createdAt: "2026-10-04T10:00:01.000Z",
    };
    const invalidSets = [
      [{ ...base, grid: { ...base.grid, width: 3 } }],
      [{ ...base, grid: { ...base.grid, cells: ["H2"] } }],
      [base, { ...base, ordinal: 2 }],
      [base, { ...base, id: "candidate-b" }],
      [{ ...base, id: "x".repeat(101) }],
      [{ ...base, ordinal: 0 }],
      [{ ...base, ordinal: 5 }],
      [{ ...base, ordinal: 1.5 }],
      [{ ...base, createdAt: "not-a-timestamp" }],
      [{ ...base, grid: { ...base.grid, encoding: "unexpected" as "palette-code-v1" } }],
    ];
    for (const candidates of invalidSets) {
      await assert.rejects(
        store.completeGenerationJob({
          jobId: job.id,
          leaseToken,
          now: "2026-10-04T10:00:02.000Z",
          candidates,
        }),
        (error: unknown) => error instanceof AppError && error.code === "GENERATION_CANDIDATES_INVALID",
      );
    }
    const completed = await store.completeGenerationJob({
      jobId: job.id,
      leaseToken,
      now: "2026-10-04T10:00:03.000Z",
      candidates: [base],
    });
    assert.equal(completed.status, "completed");
  });
});
