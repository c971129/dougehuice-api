import assert from "node:assert/strict";
import { it } from "node:test";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { StorageDependencyUnavailableError } from "../src/storage/storage-provider.js";
import { VolatileMemoryStorage } from "../src/storage/volatile-memory-storage.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused",
  databaseSsl: false,
  devAuthEnabled: true,
  corsOrigins: [],
  sessionTtlDays: 30,
  devStartingCredits: 20,
  assetStorageRoot: ".data/test-storage-dependency",
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

it("maps private-storage dependency failures to a safe retryable 503", async () => {
  const app = await buildApp({
    config,
    store: new MemoryStore(),
    storage: new VolatileMemoryStorage(),
    logger: false,
  });
  app.get("/__test/storage-unavailable", async () => {
    throw new StorageDependencyUnavailableError(new Error("secret endpoint and bucket details"));
  });

  try {
    const response = await app.inject({ method: "GET", url: "/__test/storage-unavailable" });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.headers["retry-after"], "1");
    assert.equal(response.json().error.code, "STORAGE_DEPENDENCY_UNAVAILABLE");
    assert.equal(response.json().error.retryable, true);
    assert.equal(response.body.includes("secret endpoint"), false);
  } finally {
    await app.close();
  }
});

it("closes the attached storage provider with the Fastify lifecycle", async () => {
  class ClosingStorage extends VolatileMemoryStorage {
    closeCount = 0;

    async close(): Promise<void> {
      this.closeCount += 1;
    }
  }

  const storage = new ClosingStorage();
  const app = await buildApp({ config, store: new MemoryStore(), storage, logger: false });
  await app.close();
  assert.equal(storage.closeCount, 1);
});
