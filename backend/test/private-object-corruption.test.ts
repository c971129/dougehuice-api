import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";
import sharp from "sharp";

import { buildApp } from "../src/app.js";
import { hashToken } from "../src/auth.js";
import type { AppConfig } from "../src/config.js";
import type { GenerationProvider } from "../src/generation/provider.js";
import { processNextGeneration } from "../src/generation/worker.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import {
  StorageEncryptionKeyUnavailableError,
  StorageObjectCorruptedError,
  type StorageObjectContext,
  type StorageProvider,
} from "../src/storage/storage-provider.js";

const AUTH_TOKEN = "private-object-corruption-test-token";
const SOURCE_BYTES = Buffer.from("authoritative-private-source");

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused",
  databaseSsl: false,
  devAuthEnabled: true,
  corsOrigins: ["http://localhost:5173"],
  sessionTtlDays: 30,
  devStartingCredits: 5,
  assetStorageRoot: "unused-by-fake-storage",
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 100,
  assetPurgeMaxBatches: 10,
  internalWorkerKey: "private-object-test-worker-key-32-chars",
};

type ReadMode = "stored" | "corrupted" | "key-unavailable" | "tampered" | "truncated";

class FaultInjectingStorage implements StorageProvider {
  private readonly objects = new Map<string, { contents: Buffer; context: StorageObjectContext }>();
  private readonly queuedReads: Array<Buffer | null | Error> = [];
  readMode: ReadMode = "stored";
  putError: Error | null = null;

  async ready(): Promise<void> {}

  seed(storageKey: string, contents: Buffer, context: StorageObjectContext): void {
    this.objects.set(storageKey, { contents: Buffer.from(contents), context: { ...context } });
  }

  queueReads(...reads: Array<Buffer | null | Error>): void {
    this.queuedReads.push(...reads);
  }

  async put(
    contents: Buffer,
    context: StorageObjectContext,
    storageKey?: string,
  ): Promise<{ storageKey: string }> {
    if (this.putError) throw this.putError;
    assert.ok(storageKey);
    if (this.objects.has(storageKey)) throw Object.assign(new Error("object exists"), { code: "EEXIST" });
    this.seed(storageKey, contents, context);
    return { storageKey };
  }

  async get(storageKey: string, context: StorageObjectContext): Promise<Buffer | null> {
    if (this.queuedReads.length > 0) {
      const next = this.queuedReads.shift()!;
      if (next instanceof Error) throw next;
      return next === null ? null : Buffer.from(next);
    }
    if (this.readMode === "corrupted") throw new StorageObjectCorruptedError();
    if (this.readMode === "key-unavailable") throw new StorageEncryptionKeyUnavailableError();
    const object = this.objects.get(storageKey);
    if (!object) return null;
    assert.deepEqual(context, object.context);
    const contents = Buffer.from(object.contents);
    if (this.readMode === "truncated") return contents.subarray(0, Math.max(0, contents.length - 1));
    if (this.readMode === "tampered") {
      if (contents.length === 0) return Buffer.from([1]);
      contents[0] = contents[0]! ^ 0xff;
    }
    return contents;
  }

  async delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey);
  }
}

function multipartImage(bytes: Buffer): { contentType: string; payload: Buffer } {
  const boundary = `private-object-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nai-source\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="consentVersion"\r\n\r\nprivacy-v1\r\n`),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function multipartCompletionPhoto(bytes: Buffer): { contentType: string; payload: Buffer } {
  const boundary = `private-completion-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="completion.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe("private object corruption mapping", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let storage: FaultInjectingStorage;
  let userId: string;
  let png: Buffer;

  beforeEach(async () => {
    store = new MemoryStore();
    storage = new FaultInjectingStorage();
    const session = await store.createDevSession({
      displayName: "私有对象故障测试",
      tokenHash: hashToken(AUTH_TOKEN),
      expiresAt: "2099-01-01T00:00:00.000Z",
      startingCredits: 5,
    });
    userId = session.user.id;
    png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    }).png().toBuffer();
    app = await buildApp({ config, store, storage, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function createGenericAsset(): Promise<{ assetId: string; storageKey: string }> {
    const assetId = "00000000-0000-4000-8000-00000000c001";
    const storageKey = "fake-private-asset-c001";
    await store.createAsset({
      id: assetId,
      userId,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: createHash("sha256").update(SOURCE_BYTES).digest("hex"),
      mimeType: "image/png",
      sizeBytes: SOURCE_BYTES.length,
      width: 1,
      height: 1,
      storageKey,
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-10-05T00:00:00.000Z",
    });
    await store.markAssetReady(userId, assetId, "2026-10-05T00:00:01.000Z");
    storage.seed(storageKey, SOURCE_BYTES, { ownerId: userId, assetId });
    return { assetId, storageKey };
  }

  async function createCompletedProject(): Promise<string> {
    const project = await store.createProject(userId, {
      name: "已完成作品",
      paletteId: "mard-48-v1",
      grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
    });
    const progress = await store.saveBuildProgress({
      userId,
      projectId: project.id,
      projectRevision: 1,
      baseProgressRevision: 0,
      completedIndices: [0],
      elapsedTime: 1,
    });
    assert.ok(progress.completedAt);
    return project.id;
  }

  async function createCompletionPhoto(projectId: string): Promise<string> {
    const photoId = "00000000-0000-4000-8000-00000000c002";
    const assetId = "00000000-0000-4000-8000-00000000c003";
    const storageKey = "fake-completion-photo-c003";
    const reservation = await store.reserveProjectCompletionPhotoUpload({
      photoId,
      userId,
      projectId,
      projectRevision: 1,
      idempotencyKey: "fake-completion-photo-reservation",
      requestHash: "a".repeat(64),
      uploadLeaseToken: "00000000-0000-4000-8000-00000000c004",
      uploadLeaseAcquiredAt: new Date().toISOString(),
      asset: {
        id: assetId,
        userId,
        purpose: "project-completion",
        consentVersion: null,
        sha256: createHash("sha256").update(SOURCE_BYTES).digest("hex"),
        mimeType: "image/png",
        sizeBytes: SOURCE_BYTES.length,
        width: 1,
        height: 1,
        storageKey,
        expiresAt: null,
        createdAt: new Date().toISOString(),
      },
    });
    await store.publishProjectCompletionPhoto({
      userId,
      projectId,
      photoId,
      assetId,
      uploadLeaseToken: reservation.uploadLeaseToken,
      readyAt: new Date().toISOString(),
    });
    storage.seed(storageKey, SOURCE_BYTES, { ownerId: userId, assetId });
    return photoId;
  }

  it("returns stable non-retryable 410s for encrypted and plaintext generic-asset corruption", async () => {
    const { assetId } = await createGenericAsset();
    const url = `/api/v1/assets/${assetId}/content`;
    const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

    storage.readMode = "corrupted";
    const encrypted = await app.inject({ method: "GET", url, headers });
    assert.equal(encrypted.statusCode, 410, encrypted.body);
    assert.equal(encrypted.json().error.code, "ASSET_CONTENT_CORRUPTED");
    assert.equal(encrypted.json().error.retryable, false);

    storage.readMode = "tampered";
    const plaintext = await app.inject({ method: "GET", url, headers });
    assert.equal(plaintext.statusCode, 410, plaintext.body);
    assert.equal(plaintext.json().error.code, "ASSET_CONTENT_CORRUPTED");
    assert.equal(plaintext.json().error.retryable, false);

    storage.readMode = "truncated";
    const wrongSize = await app.inject({ method: "GET", url, headers });
    assert.equal(wrongSize.statusCode, 410, wrongSize.body);
    assert.equal(wrongSize.json().error.code, "ASSET_CONTENT_CORRUPTED");
    assert.equal(wrongSize.json().error.retryable, false);

    storage.readMode = "key-unavailable";
    const missingKey = await app.inject({ method: "GET", url, headers });
    assert.equal(missingKey.statusCode, 503, missingKey.body);
    assert.equal(missingKey.json().error.code, "STORAGE_DEPENDENCY_UNAVAILABLE");
    assert.equal(missingKey.json().error.retryable, true);
  });

  it("returns stable non-retryable 410s for encrypted and plaintext completion-photo corruption", async () => {
    const projectId = await createCompletedProject();
    const photoId = await createCompletionPhoto(projectId);
    const url = `/api/v1/projects/${projectId}/completion-photos/${photoId}/content`;
    const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

    storage.readMode = "corrupted";
    const encrypted = await app.inject({ method: "GET", url, headers });
    assert.equal(encrypted.statusCode, 410, encrypted.body);
    assert.equal(encrypted.json().error.code, "COMPLETION_PHOTO_CONTENT_CORRUPTED");
    assert.equal(encrypted.json().error.retryable, false);

    storage.readMode = "tampered";
    const plaintext = await app.inject({ method: "GET", url, headers });
    assert.equal(plaintext.statusCode, 410, plaintext.body);
    assert.equal(plaintext.json().error.code, "COMPLETION_PHOTO_CONTENT_CORRUPTED");
    assert.equal(plaintext.json().error.retryable, false);

    storage.readMode = "truncated";
    const wrongSize = await app.inject({ method: "GET", url, headers });
    assert.equal(wrongSize.statusCode, 410, wrongSize.body);
    assert.equal(wrongSize.json().error.code, "COMPLETION_PHOTO_CONTENT_CORRUPTED");
    assert.equal(wrongSize.json().error.retryable, false);

    storage.readMode = "key-unavailable";
    const missingKey = await app.inject({ method: "GET", url, headers });
    assert.equal(missingKey.statusCode, 503, missingKey.body);
    assert.equal(missingKey.json().error.code, "STORAGE_DEPENDENCY_UNAVAILABLE");
    assert.equal(missingKey.json().error.retryable, true);
  });

  for (const recovery of [
    {
      name: "permanent corruption",
      error: () => new StorageObjectCorruptedError(),
      statusCode: 410,
      code: "ASSET_CONTENT_CORRUPTED",
      retryable: false,
    },
    {
      name: "an unavailable encryption key",
      error: () => new StorageEncryptionKeyUnavailableError(),
      statusCode: 503,
      code: "STORAGE_DEPENDENCY_UNAVAILABLE",
      retryable: true,
    },
  ]) {
    it(`preserves ${recovery.name} from a generic-asset upload recovery read`, async () => {
      storage.queueReads(null, recovery.error());
      storage.putError = Object.assign(new Error("simulated write failure"), { code: "EIO" });
      const body = multipartImage(png);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/assets",
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
          "content-type": body.contentType,
          "idempotency-key": `asset-recovery-${recovery.statusCode}`,
        },
        payload: body.payload,
      });
      assert.equal(response.statusCode, recovery.statusCode, response.body);
      assert.equal(response.json().error.code, recovery.code);
      assert.equal(response.json().error.retryable, recovery.retryable);
    });
  }

  for (const recovery of [
    {
      name: "permanent corruption",
      error: () => new StorageObjectCorruptedError(),
      statusCode: 410,
      code: "COMPLETION_PHOTO_CONTENT_CORRUPTED",
      retryable: false,
    },
    {
      name: "an unavailable encryption key",
      error: () => new StorageEncryptionKeyUnavailableError(),
      statusCode: 503,
      code: "STORAGE_DEPENDENCY_UNAVAILABLE",
      retryable: true,
    },
  ]) {
    it(`preserves ${recovery.name} from a completion-photo upload recovery read`, async () => {
      const projectId = await createCompletedProject();
      storage.queueReads(null, recovery.error());
      storage.putError = Object.assign(new Error("simulated write failure"), { code: "EIO" });
      const body = multipartCompletionPhoto(png);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/completion-photos?projectRevision=1`,
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
          "content-type": body.contentType,
          "idempotency-key": `completion-recovery-${recovery.statusCode}`,
        },
        payload: body.payload,
      });
      assert.equal(response.statusCode, recovery.statusCode, response.body);
      assert.equal(response.json().error.code, recovery.code);
      assert.equal(response.json().error.retryable, recovery.retryable);
    });
  }
});

describe("generation source private object failures", () => {
  async function runWithStorageMode(readMode: ReadMode) {
    const store = new MemoryStore();
    const storage = new FaultInjectingStorage();
    storage.readMode = readMode;
    const session = await store.createDevSession({
      displayName: "generation-private-object-test",
      tokenHash: "b".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      startingCredits: 5,
    });
    const userId = session.user.id;
    const assetId = "00000000-0000-4000-8000-00000000c101";
    const storageKey = "fake-generation-source-c101";
    await store.createAsset({
      id: assetId,
      userId,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: createHash("sha256").update(SOURCE_BYTES).digest("hex"),
      mimeType: "image/png",
      sizeBytes: SOURCE_BYTES.length,
      width: 1,
      height: 1,
      storageKey,
      expiresAt: "2026-10-06T00:00:00.000Z",
      createdAt: "2026-10-05T00:00:00.000Z",
    });
    await store.markAssetReady(userId, assetId, "2026-10-05T00:00:01.000Z");
    storage.seed(storageKey, SOURCE_BYTES, { ownerId: userId, assetId });
    await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-00000000c102",
      userId,
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: assetId,
      cost: 1,
      seed: "private-object-failure",
      width: 8,
      height: 8,
      now: "2026-10-05T01:00:00.000Z",
    });
    let providerCalled = false;
    const provider: GenerationProvider = {
      kind: "must-not-run",
      generate: async () => {
        providerCalled = true;
        return [];
      },
    };
    const result = await processNextGeneration({
      store,
      storage,
      provider,
      now: new Date("2026-10-05T01:00:00.000Z"),
    });
    return { result, providerCalled, balance: (await store.getCreditAccount(userId)).balance };
  }

  for (const mode of ["corrupted", "tampered", "truncated"] as const) {
    it(`makes ${mode} source contents terminal with the stable corruption code`, async () => {
      const { result, providerCalled, balance } = await runWithStorageMode(mode);
      assert.equal(result?.status, "failed");
      assert.equal(result?.errorCode, "GENERATION_SOURCE_ASSET_CORRUPTED");
      assert.equal(result?.attemptCount, 1);
      assert.equal(providerCalled, false);
      assert.equal(balance, 5);
    });
  }

  it("keeps an unavailable source encryption key retryable", async () => {
    const { result, providerCalled, balance } = await runWithStorageMode("key-unavailable");
    assert.equal(result?.status, "retry_wait");
    assert.equal(result?.attemptCount, 1);
    assert.equal(providerCalled, false);
    assert.equal(balance, 4);
  });
});
