import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import {
  copyDefaultGenerationOptions,
  deserializeGenerationOptions,
} from "../src/domain/generation-options.js";
import { AppError } from "../src/errors.js";
import { DeterministicGenerationProvider } from "../src/generation/deterministic-provider.js";
import type { GenerationProvider } from "../src/generation/provider.js";
import { processNextGeneration } from "../src/generation/worker.js";
import { hashIdempotencyRequest } from "../src/idempotency.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import type { StorageProvider } from "../src/storage/storage-provider.js";

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
  assetStorageRoot: join(tmpdir(), "pindou-generation-options-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

const emptyStorage: StorageProvider = {
  ready: async () => undefined,
  put: async () => ({ storageKey: "unused-storage-key-000000" }),
  get: async () => null,
  delete: async () => undefined,
};

describe("generation option persistence parser", () => {
  it("defaults missing legacy fields and rejects present corrupt values", () => {
    const defaults = copyDefaultGenerationOptions();
    const legacy = structuredClone(defaults) as unknown as Record<string, unknown>;
    delete legacy.maxColors;
    delete legacy.brightness;
    delete legacy.contrast;
    delete legacy.saturation;
    delete legacy.dither;
    assert.deepEqual(deserializeGenerationOptions(legacy), defaults);

    for (const [field, value] of [
      ["brightness", -101],
      ["contrast", 101],
      ["saturation", 1.5],
      ["dither", "false"],
    ] as const) {
      assert.throws(
        () => deserializeGenerationOptions({ ...defaults, [field]: value }),
        (error: unknown) => error instanceof AppError && error.code === "GENERATION_OPTIONS_CORRUPT",
        field,
      );
    }
    assert.throws(
      () => deserializeGenerationOptions({ ...defaults, maxColors: "12" }),
      (error: unknown) => error instanceof AppError && error.code === "GENERATION_OPTIONS_CORRUPT",
    );
  });
});

describe("generation options API", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let lastUserId = "";

  beforeEach(async () => {
    store = new MemoryStore();
    app = await buildApp({
      config,
      store,
      storage: emptyStorage,
      logger: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function login(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: "生成参数测试用户" },
    });
    assert.equal(response.statusCode, 201, response.body);
    lastUserId = response.json().user.id as string;
    return response.json().token as string;
  }

  it("derives omitted maxColors from the selected palette and preserves explicit values", async () => {
    const expectedDefaults = [
      ["mard-48-v1", 16],
      ["mard-72-v1", 16],
      ["mard-144-v1", 24],
      ["mard-221-v1", 24],
      ["mard-291-v1", 32],
    ] as const;
    for (const [paletteId, expectedMaxColors] of expectedDefaults) {
      const token = await login();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/generation-jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": `generation-default-${paletteId}`,
        },
        payload: { kind: "normal", paletteId, width: 8, height: 8 },
      });
      assert.equal(response.statusCode, 202, response.body);
      assert.equal(response.json().job.options.maxColors, expectedMaxColors, paletteId);
    }

    const customToken = await login();
    const customPalette = await store.createPalette(lastUserId, {
      id: "generation-default-custom",
      name: "生成默认值自定义色卡",
      brand: "测试",
      beadSizeMm: 5,
      verified: false,
      version: 1,
      colors: [
        { code: "X1", name: "黑", hex: "#000000", unitPriceCents: 0, available: true },
        { code: "X2", name: "白", hex: "#FFFFFF", unitPriceCents: 0, available: true },
      ],
    });
    const custom = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: {
        authorization: `Bearer ${customToken}`,
        "idempotency-key": "generation-default-custom",
      },
      payload: { kind: "normal", paletteId: customPalette.id, width: 8, height: 8 },
    });
    assert.equal(custom.statusCode, 202, custom.body);
    assert.equal(custom.json().job.options.maxColors, 16);

    const explicitToken = await login();
    const explicit = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: {
        authorization: `Bearer ${explicitToken}`,
        "idempotency-key": "generation-default-explicit",
      },
      payload: {
        kind: "normal",
        paletteId: "mard-291-v1",
        width: 8,
        height: 8,
        options: { maxColors: 7 },
      },
    });
    assert.equal(explicit.statusCode, 202, explicit.body);
    assert.equal(explicit.json().job.options.maxColors, 7);
  });

  it("accepts, normalizes, returns, and idempotently replays generation options", async () => {
    const token = await login();
    const payload = {
      kind: "normal",
      paletteId: "mard-48-v1",
      width: 16,
      height: 16,
      seed: "generation-options-api-seed",
      options: {
        crop: {
          ratio: "4:3",
          rotation: 90,
          scale: 1.25,
          offsetX: -12.5,
          offsetY: 17,
          flipX: true,
        },
        figureStyle: "chibi-half",
        coupleLayout: "split",
        maxColors: 32,
        transparentBackground: true,
        inventoryOnly: true,
        brightness: -25,
        contrast: 40,
        saturation: 75,
        dither: true,
      },
    };
    const headers = {
      authorization: `Bearer ${token}`,
      "idempotency-key": "generation-options-api-create-0001",
    };
    const expectedOptions = {
      crop: {
        ratio: "4:3",
        freeRatio: 1,
        rotation: 90,
        scale: 1.25,
        offsetX: -12.5,
        offsetY: 17,
        flipX: true,
        flipY: false,
      },
      removeBackground: true,
      figureStyle: "chibi-half",
      coupleLayout: "split",
      maxColors: 32,
      transparentBackground: true,
      inventoryOnly: true,
      brightness: -25,
      contrast: 40,
      saturation: 75,
      dither: true,
    };

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers,
      payload,
    });
    assert.equal(created.statusCode, 202, created.body);
    assert.equal(created.headers["idempotency-replayed"], undefined);
    assert.deepEqual(created.json().job.options, expectedOptions);

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers,
      payload,
    });
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.equal(replay.json().job.id, created.json().job.id);
    assert.deepEqual(replay.json().job.options, expectedOptions);

    const fetched = await app.inject({
      method: "GET",
      url: `/api/v1/generation-jobs/${created.json().job.id as string}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.deepEqual(fetched.json().job.options, expectedOptions);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/generation-jobs",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json().jobs[0].options, expectedOptions);
  });

  it("rejects unknown and out-of-range generation option fields", async () => {
    const token = await login();
    const invalidCases: Array<{ name: string; options: object }> = [
      { name: "unknown option", options: { unsupportedMode: true } },
      { name: "unknown crop option", options: { crop: { zoom: 1.1 } } },
      { name: "too few colors", options: { maxColors: 4 } },
      { name: "too many colors", options: { maxColors: 33 } },
      { name: "crop outside bounds", options: { crop: { offsetX: 301 } } },
      { name: "brightness below range", options: { brightness: -101 } },
      { name: "contrast above range", options: { contrast: 101 } },
      { name: "fractional saturation", options: { saturation: 0.5 } },
      { name: "non-boolean dither", options: { dither: "yes" } },
    ];

    for (const [index, invalidCase] of invalidCases.entries()) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/generation-jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": `generation-options-invalid-${index}`,
        },
        payload: {
          kind: "pixel",
          paletteId: "mard-48-v1",
          width: 8,
          height: 8,
          options: invalidCase.options,
        },
      });
      assert.equal(response.statusCode, 400, `${invalidCase.name}: ${response.body}`);
      assert.equal(response.json().error.code, "VALIDATION_ERROR", invalidCase.name);
    }
  });

  it("canonicalizes legacy generation options in retained idempotency responses", async () => {
    const token = await login();
    const payload = {
      kind: "normal",
      paletteId: "mard-48-v1",
      width: 8,
      height: 8,
    };
    const key = "generation-options-legacy-replay-0001";
    const legacyOptions = copyDefaultGenerationOptions() as unknown as Record<string, unknown>;
    delete legacyOptions.brightness;
    delete legacyOptions.contrast;
    delete legacyOptions.saturation;
    delete legacyOptions.dither;
    await store.executeIdempotent({
      userId: lastUserId,
      scope: "generation-jobs:create",
      key,
      requestHash: hashIdempotencyRequest(payload),
    }, async () => ({
      statusCode: 202,
      body: { job: { id: "legacy-generation-job", options: legacyOptions } },
    }));

    const replayed = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      payload,
    });
    assert.equal(replayed.statusCode, 202, replayed.body);
    assert.equal(replayed.headers["idempotency-replayed"], "true");
    assert.deepEqual(replayed.json().job.options, copyDefaultGenerationOptions());

    const corruptKey = "generation-options-corrupt-replay-0001";
    await store.executeIdempotent({
      userId: lastUserId,
      scope: "generation-jobs:create",
      key: corruptKey,
      requestHash: hashIdempotencyRequest(payload),
    }, async () => ({
      statusCode: 202,
      body: { job: { id: "corrupt-generation-job", options: { ...legacyOptions, brightness: "bad" } } },
    }));
    const corruptReplay = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": corruptKey },
      payload,
    });
    assert.equal(corruptReplay.statusCode, 500, corruptReplay.body);
    assert.equal(corruptReplay.json().error.code, "GENERATION_OPTIONS_CORRUPT");
  });
});

async function userWithCredits(store: MemoryStore, credits = 5) {
  const session = await store.createDevSession({
    displayName: "库存生成测试用户",
    tokenHash: "b".repeat(64),
    expiresAt: "2027-10-04T00:00:00.000Z",
    startingCredits: credits,
  });
  return session.user;
}

describe("inventory-constrained generation", () => {
  it("terminally fails and refunds an inventory-only job when no colors are in stock", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const options = copyDefaultGenerationOptions();
    options.inventoryOnly = true;
    options.maxColors = 5;
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000801",
      userId: user.id,
      kind: "pixel",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      options,
      cost: 1,
      seed: "inventory-empty-seed",
      width: 8,
      height: 8,
      now: "2026-10-04T10:00:00.000Z",
    });
    assert.equal((await store.getCreditAccount(user.id)).balance, 4);

    let providerCalled = false;
    const provider: GenerationProvider = {
      kind: "must-not-run-with-empty-inventory",
      generate: async () => {
        providerCalled = true;
        return [];
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
    assert.equal(failed?.errorCode, "GENERATION_INVENTORY_EMPTY");
    assert.equal(failed?.attemptCount, 1);
    assert.equal(providerCalled, false);
    assert.equal((await store.getCreditAccount(user.id)).balance, 5);
    const ledger = await store.listCreditLedger(user.id, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_reserved").length, 1);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_released").length, 1);
    assert.equal(ledger.filter((entry) => entry.reason === "generation_settled").length, 0);
  });

  it("uses only in-stock colors and obeys maxColors in every generated candidate", async () => {
    const store = new MemoryStore();
    const user = await userWithCredits(store);
    const stockedColorCodes = ["A4", "A6", "A7", "A10", "A11", "A13", "B3"];
    for (const colorCode of stockedColorCodes) {
      await store.setInventoryItem({
        userId: user.id,
        paletteId: "mard-48-v1",
        colorCode,
        quantity: 10,
        location: null,
        baseRevision: 0,
        now: "2026-10-04T10:00:00.000Z",
      });
    }

    const options = copyDefaultGenerationOptions();
    options.inventoryOnly = true;
    options.maxColors = 5;
    const job = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000000802",
      userId: user.id,
      kind: "pixel",
      paletteId: "mard-48-v1",
      sourceAssetId: null,
      options,
      cost: 1,
      seed: "inventory-constrained-seed",
      width: 16,
      height: 16,
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
    assert.ok(completed.candidates.length > 0);
    const stocked = new Set(stockedColorCodes);
    for (const candidate of completed.candidates) {
      const usedColors = new Set(
        candidate.grid.cells.filter((colorCode): colorCode is string => colorCode !== null),
      );
      assert.ok(usedColors.size > 0);
      assert.ok(
        usedColors.size <= options.maxColors,
        `candidate ${candidate.id} used ${usedColors.size} colors`,
      );
      assert.deepEqual(
        [...usedColors].filter((colorCode) => !stocked.has(colorCode)),
        [],
        `candidate ${candidate.id} used an out-of-stock color`,
      );
    }
  });
});
