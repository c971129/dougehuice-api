import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";
import sharp from "sharp";

import { buildApp } from "../src/app.js";
import { purgeExpiredAssets } from "../src/assets/asset-service.js";
import { sanitizeImage } from "../src/assets/image.js";
import type { AppConfig } from "../src/config.js";
import { resolveAssetConsentPolicy } from "../src/domain/asset-consent.js";
import {
  ASSET_UPLOAD_LEASE_MILLISECONDS,
  USER_RATE_LIMITS,
} from "../src/domain/resource-limits.js";
import { AppError } from "../src/errors.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { LocalEncryptedStorage } from "../src/storage/local-encrypted-storage.js";
import type { StorageObjectContext, StorageProvider } from "../src/storage/storage-provider.js";

const ENCRYPTION_KEY = "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=";
const WORKER_KEY = "pindou-test-worker-key-at-least-32-chars";

type MultipartTestPart =
  | { type: "field"; name: string; value: string }
  | { type: "file"; name: string; filename: string; mimeType: string; bytes: Buffer };

function multipartBody(parts: readonly MultipartTestPart[]): { payload: Buffer; contentType: string } {
  const boundary = `pindou-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    ...parts.flatMap((part) => part.type === "field"
      ? [Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
      )]
      : [
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.mimeType}\r\n\r\n`,
        ),
        part.bytes,
        Buffer.from("\r\n"),
      ]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

class LateWriterStorage implements StorageProvider {
  private readonly objects = new Map<string, { contents: Buffer; context: StorageObjectContext }>();
  private getCalls = 0;
  private putCalls = 0;
  private releaseInitialGets = (): void => undefined;
  private readonly initialGetsGate = new Promise<void>((resolve) => { this.releaseInitialGets = resolve; });
  private releaseLatePut = (): void => undefined;
  private readonly latePutGate = new Promise<void>((resolve) => { this.releaseLatePut = resolve; });

  async ready(): Promise<void> {}

  async get(storageKey: string, context: StorageObjectContext): Promise<Buffer | null> {
    this.getCalls += 1;
    if (this.getCalls <= 2) {
      if (this.getCalls === 2) this.releaseInitialGets();
      await this.initialGetsGate;
      return null;
    }
    const object = this.objects.get(storageKey);
    if (!object) return null;
    assert.deepEqual(object.context, context);
    return Buffer.from(object.contents);
  }

  async put(
    contents: Buffer,
    context: StorageObjectContext,
    storageKey?: string,
  ): Promise<{ storageKey: string }> {
    assert.ok(storageKey);
    this.putCalls += 1;
    if (this.putCalls === 2) await this.latePutGate;
    if (this.objects.has(storageKey)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.objects.set(storageKey, { contents: Buffer.from(contents), context });
    return { storageKey };
  }

  async delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey);
    this.releaseLatePut();
  }

  hasObject(storageKey: string): boolean {
    return this.objects.has(storageKey);
  }
}

function multipartImage(input: {
  bytes: Buffer;
  mimeType: string;
  purpose?: string;
  consentVersion?: string;
}): { payload: Buffer; contentType: string } {
  const purpose = input.purpose ?? "ai-source";
  const consentVersion = input.consentVersion ?? "privacy-v1";
  return multipartBody([
    { type: "field", name: "purpose", value: purpose },
    { type: "field", name: "consentVersion", value: consentVersion },
    { type: "file", name: "file", filename: "source.png", mimeType: input.mimeType, bytes: input.bytes },
  ]);
}

describe("private AI assets", () => {
  let app: FastifyInstance;
  let root: string;
  let store: MemoryStore;
  let storage: LocalEncryptedStorage;
  let config: AppConfig;
  let png: Buffer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pindou-private-assets-"));
    config = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      databaseUrl: "postgres://unused",
      databaseSsl: false,
      devAuthEnabled: true,
      corsOrigins: ["http://localhost:5173"],
      sessionTtlDays: 30,
      devStartingCredits: 20,
      assetStorageRoot: root,
      assetEncryptionKeyBase64: ENCRYPTION_KEY,
      assetMaxBytes: 1024 * 1024,
      assetDefaultTtlHours: 23,
      assetConsentVersion: "privacy-v1",
      assetConsentProcessor: "pindou-test-processor",
      assetConsentPurposeText: "将用户提供的图片处理为拼豆图纸",
      assetConsentRetentionText: "AI 素材最长保留 23 小时，之后进入清理流程",
      assetPurgeBatchSize: 500,
      assetPurgeMaxBatches: 100,
      internalWorkerKey: WORKER_KEY,
    };
    store = new MemoryStore();
    storage = new LocalEncryptedStorage({ root, keyBase64: ENCRYPTION_KEY });
    app = await buildApp({ config, store, storage, logger: false });
    await app.ready();
    png = await sharp({
      create: { width: 3, height: 2, channels: 4, background: { r: 250, g: 80, b: 120, alpha: 1 } },
    }).png().toBuffer();
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it("does not delete an existing encrypted object when a stable storage key collides", async () => {
    const storageKey = "stable-storage-key-0001";
    const context = { ownerId: "owner-0001", assetId: "asset-0001" };
    const original = Buffer.from("original-private-object");
    await storage.put(original, context, storageKey);

    await assert.rejects(
      storage.put(Buffer.from("replacement-must-not-win"), context, storageKey),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST",
    );
    assert.deepEqual(await storage.get(storageKey, context), original);
  });

  async function login(name: string): Promise<{ token: string; userId: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: name },
    });
    assert.equal(response.statusCode, 201);
    return { token: response.json().token as string, userId: response.json().user.id as string };
  }

  async function upload(token: string, key = `asset-${randomUUID()}`): Promise<Record<string, unknown>> {
    const body = multipartImage({ bytes: png, mimeType: "image/png" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": body.contentType,
        "idempotency-key": key,
      },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().asset as Record<string, unknown>;
  }

  it("publishes only the client-facing AI consent and upload metadata before authentication", async () => {
    const consentPolicy = resolveAssetConsentPolicy(config);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/privacy/ai-processing-consent",
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json(), {
      consentVersion: "privacy-v1",
      policySha256: consentPolicy.policySha256,
      processor: consentPolicy.processor,
      purpose: consentPolicy.processingPurpose,
      upload: {
        maxBytes: 1024 * 1024,
        supportedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
        supportedPurposes: ["ai-source", "ai-intermediate"],
      },
      retention: { defaultHours: 23, description: consentPolicy.retention },
    });
    assert.equal(response.body.includes(ENCRYPTION_KEY), false);
    assert.equal(response.body.includes(WORKER_KEY), false);
    assert.equal(response.body.includes(root), false);
  });

  it("lists immutable consent-backed upload history only for its owning user", async () => {
    const consentPolicy = resolveAssetConsentPolicy(config);
    const owner = await login("同意审计用户");
    const stranger = await login("同意审计隔离用户");
    const asset = await upload(owner.token, "asset-consent-audit-0001");

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/privacy/ai-processing-consent/events",
    });
    assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);

    const history = await app.inject({
      method: "GET",
      url: "/api/v1/privacy/ai-processing-consent/events?limit=1&offset=0",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.headers["cache-control"], "private, no-store");
    assert.deepEqual(history.json().pagination, {
      limit: 1,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    assert.equal(history.json().events.length, 1);
    assert.deepEqual(
      {
        assetId: history.json().events[0].assetId,
        consentVersion: history.json().events[0].consentVersion,
        assetPurpose: history.json().events[0].assetPurpose,
        policySha256: history.json().events[0].policySha256,
        processor: history.json().events[0].processor,
        purpose: history.json().events[0].purpose,
        retention: history.json().events[0].retention,
        source: history.json().events[0].source,
      },
      {
        assetId: asset.id,
        consentVersion: "privacy-v1",
        assetPurpose: "ai-source",
        policySha256: consentPolicy.policySha256,
        processor: consentPolicy.processor,
        purpose: consentPolicy.processingPurpose,
        retention: consentPolicy.retention,
        source: "asset-upload",
      },
    );
    assert.ok(Number.isFinite(Date.parse(history.json().events[0].occurredAt)));
    assert.ok(Number.isFinite(Date.parse(history.json().events[0].recordedAt)));
    assert.equal("userId" in history.json().events[0], false);

    const isolated = await app.inject({
      method: "GET",
      url: "/api/v1/privacy/ai-processing-consent/events",
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(isolated.statusCode, 200, isolated.body);
    assert.deepEqual(isolated.json().events, []);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${asset.id as string}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(deleted.statusCode, 204, deleted.body);
    const retained = await store.listAssetConsentEvents({ userId: owner.userId, limit: 10, offset: 0 });
    assert.equal(retained.length, 1, "asset deletion cannot erase immutable consent evidence");
  });

  it("rate-limits asset deletion before changing metadata or private bytes", async () => {
    const owner = await login("素材删除限流用户");
    const asset = await upload(owner.token, "asset-delete-rate-limit-upload");
    const now = new Date().toISOString();
    for (let index = 0; index < USER_RATE_LIMITS.assetDelete.limit; index += 1) {
      const consumed = await store.consumeUserRateLimit({
        userId: owner.userId,
        ...USER_RATE_LIMITS.assetDelete,
        now,
      });
      assert.equal(consumed.allowed, true);
    }

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${asset.id as string}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(response.statusCode, 429, response.body);
    assert.equal(response.json().error.code, "USER_RATE_LIMITED");
    assert.ok(Number(response.headers["retry-after"]) >= 1);
    const retained = await store.getAsset(owner.userId, asset.id as string);
    assert.equal(retained?.deletedAt, null);
    assert.equal(retained?.purgedAt, null);
    assert.ok(retained && await storage.get(retained.storageKey, { ownerId: owner.userId, assetId: retained.id }));
  });

  it("rejects an upload before parsing bytes when the attempt window is exhausted", async () => {
    const owner = await login("上传限流测试");
    const now = new Date().toISOString();
    for (let index = 0; index < USER_RATE_LIMITS.assetUploadAttempt.limit; index += 1) {
      const result = await store.consumeUserRateLimit({
        userId: owner.userId,
        ...USER_RATE_LIMITS.assetUploadAttempt,
        now,
      });
      assert.equal(result.allowed, true);
    }
    const body = multipartImage({ bytes: png, mimeType: "image/png" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": body.contentType,
        "idempotency-key": "asset-attempt-rate-limit",
      },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 429, response.body);
    assert.equal(response.json().error.code, "USER_RATE_LIMITED");
    assert.ok(Number(response.headers["retry-after"]) >= 1);
  });

  it("streams an authenticated image larger than the ordinary 2 MiB JSON limit", async () => {
    await app.close();
    config = { ...config, assetMaxBytes: 4 * 1024 * 1024 };
    storage = new LocalEncryptedStorage({ root, keyBase64: ENCRYPTION_KEY });
    app = await buildApp({ config, store, storage, logger: false });
    await app.ready();

    const width = 900;
    const height = 900;
    const largePng = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    }).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer();
    assert.ok(largePng.length > 2 * 1024 * 1024);
    assert.ok(largePng.length < config.assetMaxBytes);

    const owner = await login("大图流式上传测试");
    const body = multipartImage({ bytes: largePng, mimeType: "image/png" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": body.contentType,
        "idempotency-key": "asset-over-json-body-limit",
      },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 201, response.body);
  });

  it("returns 413 for multipart file, field-size, field-count, and part-count limits", async () => {
    const owner = await login("素材流式边界测试");
    const headers = {
      authorization: `Bearer ${owner.token}`,
    };
    const cases = [
      {
        label: "file size",
        body: multipartImage({
          bytes: Buffer.alloc(config.assetMaxBytes + 1),
          mimeType: "image/png",
        }),
      },
      {
        label: "field size",
        body: multipartImage({
          bytes: png,
          mimeType: "image/png",
          purpose: "x".repeat(257),
        }),
      },
      {
        label: "field count",
        body: multipartBody([
          { type: "field", name: "purpose", value: "ai-source" },
          { type: "field", name: "consentVersion", value: "privacy-v1" },
          { type: "field", name: "unexpected", value: "third-field" },
          { type: "file", name: "file", filename: "source.png", mimeType: "image/png", bytes: png },
        ]),
      },
      {
        label: "part count",
        body: multipartBody([
          { type: "field", name: "purpose", value: "ai-source" },
          { type: "field", name: "consentVersion", value: "privacy-v1" },
          { type: "file", name: "file", filename: "source.png", mimeType: "image/png", bytes: png },
          { type: "file", name: "extra", filename: "extra.png", mimeType: "image/png", bytes: png },
        ]),
      },
    ];

    for (const [index, current] of cases.entries()) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/assets",
        headers: {
          ...headers,
          "content-type": current.body.contentType,
          "idempotency-key": `asset-multipart-limit-${index}`,
        },
        payload: current.body.payload,
      });
      assert.equal(response.statusCode, 413, `${current.label}: ${response.body}`);
      assert.equal(response.json().error.code, "ASSET_TOO_LARGE", current.label);
    }
  });

  it("requires an idempotency key for generic uploads", async () => {
    const owner = await login("缺少幂等键测试");
    const body = multipartImage({ bytes: png, mimeType: "image/png" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: { authorization: `Bearer ${owner.token}`, "content-type": body.contentType },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, "IDEMPOTENCY_KEY_REQUIRED");
  });

  it("concurrently replays one durable asset without charging upload or storage quota twice", async () => {
    const owner = await login("并发幂等上传测试");
    const body = multipartImage({ bytes: png, mimeType: "image/png" });
    const headers = {
      authorization: `Bearer ${owner.token}`,
      "content-type": body.contentType,
      "idempotency-key": "asset-concurrent-replay-0001",
    };
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/assets", headers, payload: body.payload }),
      app.inject({ method: "POST", url: "/api/v1/assets", headers, payload: body.payload }),
    ]);
    assert.deepEqual(responses.map((response) => response.statusCode), [201, 201]);
    assert.equal(responses[0]!.json().asset.id, responses[1]!.json().asset.id);
    assert.equal(
      responses.filter((response) => response.headers["idempotency-replayed"] === "true").length,
      1,
    );
    const records = await store.listAssets({
      userId: owner.userId,
      includeDeleted: false,
      now: new Date().toISOString(),
      limit: 10,
    });
    assert.equal(records.length, 1, "same request reserves one quota-bearing asset row");
    assert.equal((await readdir(root)).length, 1, "same request stores one encrypted object");
    assert.equal(
      (await store.listAssetConsentEvents({ userId: owner.userId, limit: 10, offset: 0 })).length,
      1,
      "concurrent upload and later replay keep one immutable consent event",
    );

    const now = new Date().toISOString();
    for (let index = 1; index < USER_RATE_LIMITS.assetUpload.limit; index += 1) {
      const consumed = await store.consumeUserRateLimit({
        userId: owner.userId,
        ...USER_RATE_LIMITS.assetUpload,
        now,
      });
      assert.equal(consumed.allowed, true);
    }
    const replay = await app.inject({ method: "POST", url: "/api/v1/assets", headers, payload: body.payload });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    const newRequest = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: { ...headers, "idempotency-key": "asset-new-after-rate-limit" },
      payload: body.payload,
    });
    assert.equal(newRequest.statusCode, 429, newRequest.body);
    assert.equal(newRequest.json().error.code, "USER_RATE_LIMITED");
  });

  it("rejects reuse of one upload key for different request files or metadata", async () => {
    const owner = await login("幂等冲突测试");
    const source = multipartImage({ bytes: png, mimeType: "image/png", purpose: "ai-source" });
    const intermediate = multipartImage({ bytes: png, mimeType: "image/png", purpose: "ai-intermediate" });
    const baseHeaders = {
      authorization: `Bearer ${owner.token}`,
      "idempotency-key": "asset-request-conflict-0001",
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: { ...baseHeaders, "content-type": source.contentType },
      payload: source.payload,
    });
    assert.equal(created.statusCode, 201, created.body);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: { ...baseHeaders, "content-type": intermediate.contentType },
      payload: intermediate.payload,
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");
    const alternateEncoding = await sharp(png).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer();
    assert.notDeepEqual(alternateEncoding, png);
    assert.equal(
      (await sanitizeImage(alternateEncoding, "image/png", config.assetMaxBytes)).sha256,
      (await sanitizeImage(png, "image/png", config.assetMaxBytes)).sha256,
      "the alternate file intentionally sanitizes to the same stored pixels",
    );
    const samePixels = multipartImage({ bytes: alternateEncoding, mimeType: "image/png", purpose: "ai-source" });
    const rawConflict = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: { ...baseHeaders, "content-type": samePixels.contentType },
      payload: samePixels.payload,
    });
    assert.equal(rawConflict.statusCode, 409, rawConflict.body);
    assert.equal(rawConflict.json().error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal((await store.listAssets({
      userId: owner.userId,
      includeDeleted: false,
      now: new Date().toISOString(),
      limit: 10,
    })).length, 1);
  });

  it("fences purge and stale publishers across upload lease takeover", async () => {
    const consentPolicy = resolveAssetConsentPolicy(config);
    const owner = await login("上传租约接管测试");
    const oldAt = new Date(Date.now() - ASSET_UPLOAD_LEASE_MILLISECONDS - 60_000).toISOString();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const requestHash = "a".repeat(64);
    const assetId = "00000000-0000-4000-8000-00000000a701";
    const oldToken = "00000000-0000-4000-8000-00000000a702";
    const newToken = "00000000-0000-4000-8000-00000000a703";
    const metadata = {
      id: assetId,
      userId: owner.userId,
      purpose: "ai-source" as const,
      consentVersion: "privacy-v1",
      sha256: createHash("sha256").update(png).digest("hex"),
      mimeType: "image/png" as const,
      sizeBytes: png.length,
      width: 3,
      height: 2,
      storageKey: "asset-upload-lease-takeover-object",
      expiresAt,
      createdAt: oldAt,
    };
    await store.reserveAssetUpload({
      userId: owner.userId,
      scope: "assets:create",
      idempotencyKey: "asset-lease-takeover-0001",
      requestHash,
      uploadLeaseToken: oldToken,
      uploadLeaseAcquiredAt: oldAt,
      asset: metadata,
    });
    const resumed = await store.reserveAssetUpload({
      userId: owner.userId,
      scope: "assets:create",
      idempotencyKey: "asset-lease-takeover-0001",
      requestHash,
      uploadLeaseToken: newToken,
      uploadLeaseAcquiredAt: now,
      asset: { ...metadata, id: randomUUID(), storageKey: "unused-replay-object", createdAt: now },
    });
    assert.equal(resumed.replayed, true);
    assert.equal(resumed.asset.id, assetId);
    assert.equal(resumed.uploadLeaseToken, newToken);
    await assert.rejects(
      store.publishAssetUpload({
        userId: owner.userId,
        scope: "assets:create",
        idempotencyKey: "asset-lease-takeover-0001",
        assetId,
        uploadLeaseToken: oldToken,
        readyAt: now,
        consentPolicy,
      }),
      (error: unknown) => error instanceof AppError && error.code === "ASSET_UPLOAD_LEASE_LOST",
    );
    assert.equal(await store.claimAssetForPurge(owner.userId, assetId, now), null);
    await assert.rejects(
      store.publishAssetUpload({
        userId: owner.userId,
        scope: "assets:create",
        idempotencyKey: "asset-lease-takeover-0001",
        assetId,
        uploadLeaseToken: newToken,
        readyAt: now,
        consentPolicy: { ...consentPolicy, processor: ` ${consentPolicy.processor}` },
      }),
      (error: unknown) => error instanceof AppError && error.code === "ASSET_CONSENT_POLICY_TEXT_INVALID",
    );
    assert.equal((await store.getAsset(owner.userId, assetId))?.readyAt, null);
    const published = await store.publishAssetUpload({
      userId: owner.userId,
      scope: "assets:create",
      idempotencyKey: "asset-lease-takeover-0001",
      assetId,
      uploadLeaseToken: newToken,
      readyAt: now,
      consentPolicy,
    });
    assert.equal(published.id, assetId);
    const afterLease = new Date(Date.parse(resumed.uploadLeaseExpiresAt) + 1).toISOString();
    assert.equal((await store.publishAssetUpload({
      userId: owner.userId,
      scope: "assets:create",
      idempotencyKey: "asset-lease-takeover-0001",
      assetId,
      uploadLeaseToken: newToken,
      readyAt: afterLease,
      consentPolicy,
    })).id, assetId, "winning token can replay already-ready state after expiry");
    await assert.rejects(
      store.publishAssetUpload({
        userId: owner.userId,
        scope: "assets:create",
        idempotencyKey: "asset-lease-takeover-0001",
        assetId,
        uploadLeaseToken: oldToken,
        readyAt: afterLease,
        consentPolicy,
      }),
      (error: unknown) => error instanceof AppError && error.code === "ASSET_UPLOAD_LEASE_LOST",
    );
    await store.markAssetDeleted(owner.userId, assetId, now);
    await store.markAssetPurged(assetId, new Date(Date.parse(now) + 60_000).toISOString());
    assert.equal((await store.getAsset(owner.userId, assetId))?.purgedAt, null);
    await store.markAssetPurged(assetId, afterLease);
    assert.ok((await store.getAsset(owner.userId, assetId))?.purgedAt);
  });

  it("keeps a late same-key writer tracked after a ready asset is deleted", async () => {
    await app.close();
    const lateStorage = new LateWriterStorage();
    app = await buildApp({ config, store, storage: lateStorage, logger: false });
    await app.ready();
    const owner = await login("普通素材晚写测试");
    const body = multipartImage({ bytes: png, mimeType: "image/png" });
    const headers = {
      authorization: `Bearer ${owner.token}`,
      "content-type": body.contentType,
      "idempotency-key": "asset-ready-delete-late-0001",
    };
    const originalPublish = store.publishAssetUpload.bind(store);
    let publishCalls = 0;
    store.publishAssetUpload = async (input) => {
      publishCalls += 1;
      if (publishCalls === 1) return originalPublish(input);
      throw new Error("simulated process crash after late stable-key put");
    };
    const pending = [
      app.inject({ method: "POST", url: "/api/v1/assets", headers, payload: body.payload }),
      app.inject({ method: "POST", url: "/api/v1/assets", headers, payload: body.payload }),
    ];
    const first = await Promise.race(pending.map(async (response, index) => ({ response: await response, index })));
    assert.equal(first.response.statusCode, 201, first.response.body);
    const assetId = first.response.json().asset.id as string;
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${assetId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(removed.statusCode, 204, removed.body);
    const late = await pending[first.index === 0 ? 1 : 0]!;
    assert.equal(late.statusCode, 500, late.body);

    const tracked = await store.getAsset(owner.userId, assetId);
    assert.ok(tracked?.deletedAt);
    assert.equal(tracked.purgedAt, null, "DELETE cannot acknowledge purge while a writer lease is active");
    assert.equal(lateStorage.hasObject(tracked.storageKey), true, "late writer lands after the first delete");
    assert.deepEqual(
      await store.listAssetsForPurge(new Date(Date.now() + 60_000).toISOString(), 10),
      [],
    );
    const afterLease = new Date(Date.now() + ASSET_UPLOAD_LEASE_MILLISECONDS + 60_000).toISOString();
    const purged = await purgeExpiredAssets({ store, storage: lateStorage, now: afterLease, limit: 10 });
    assert.equal(purged.purged, 1);
    assert.equal(lateStorage.hasObject(tracked.storageKey), false);
    assert.ok((await store.getAsset(owner.userId, assetId))?.purgedAt);
  });

  it("stores sanitized bytes encrypted and never exposes storage coordinates", async () => {
    const owner = await login("素材所有者");
    const stranger = await login("其他用户");
    const asset = await upload(owner.token);
    const assetId = asset.id as string;

    assert.equal(asset.mimeType, "image/png");
    assert.equal(asset.width, 3);
    assert.equal(asset.height, 2);
    assert.equal(asset.consentVersion, "privacy-v1");
    assert.match(asset.sha256 as string, /^[0-9a-f]{64}$/);
    const remainingTtl = Date.parse(asset.expiresAt as string) - Date.now();
    assert.ok(remainingTtl > 22 * 3_600_000);
    assert.ok(remainingTtl <= 23 * 3_600_000);
    assert.equal(JSON.stringify(asset).includes("storageKey"), false);
    assert.equal(JSON.stringify(asset).includes(root), false);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/assets?purpose=ai-source&limit=10",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json().assets.map((item: { id: string }) => item.id), [assetId]);
    assert.deepEqual(listed.json().pagination, { limit: 10, offset: 0, hasMore: false, nextOffset: null });
    assert.equal(JSON.stringify(listed.json()).includes("storageKey"), false);
    const nextPage = await app.inject({
      method: "GET",
      url: "/api/v1/assets?purpose=ai-source&limit=1&offset=1",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(nextPage.statusCode, 200, nextPage.body);
    assert.deepEqual(nextPage.json().assets, []);
    assert.deepEqual(nextPage.json().pagination, { limit: 1, offset: 1, hasMore: false, nextOffset: null });
    const strangerList = await app.inject({
      method: "GET",
      url: "/api/v1/assets",
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(strangerList.statusCode, 200, strangerList.body);
    assert.deepEqual(strangerList.json().assets, []);
    const invalidList = await app.inject({
      method: "GET",
      url: "/api/v1/assets?includeDeleted=not-a-boolean&extra=1",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(invalidList.statusCode, 400, invalidList.body);
    const invalidOffset = await app.inject({
      method: "GET",
      url: "/api/v1/assets?offset=-1",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(invalidOffset.statusCode, 400, invalidOffset.body);

    for (const suffix of ["", "/content"]) {
      const denied = await app.inject({
        method: "GET",
        url: `/api/v1/assets/${assetId}${suffix}`,
        headers: { authorization: `Bearer ${stranger.token}` },
      });
      assert.equal(denied.statusCode, 404);
      assert.equal(denied.json().error.code, "ASSET_NOT_FOUND");
    }
    const deniedDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${assetId}`,
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(deniedDelete.statusCode, 404);

    const metadata = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(metadata.statusCode, 200);
    assert.equal(JSON.stringify(metadata.json()).includes("storageKey"), false);

    const content = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}/content`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(content.statusCode, 200);
    assert.equal(content.headers["cache-control"], "private, no-store");
    assert.equal(content.headers["x-content-type-options"], "nosniff");
    assert.equal(createHash("sha256").update(content.rawPayload).digest("hex"), asset.sha256);

    const firstLevel = await readdir(root);
    const secondLevel = await readdir(join(root, firstLevel[0]!));
    const files = await readdir(join(root, firstLevel[0]!, secondLevel[0]!));
    const ciphertext = await readFile(join(root, firstLevel[0]!, secondLevel[0]!, files[0]!));
    assert.equal(ciphertext.subarray(0, 5).toString("ascii"), "PDAE2");
    assert.equal(ciphertext.includes(content.rawPayload), false);
    const internalRecord = await store.getAsset(owner.userId, assetId);
    assert.ok(internalRecord);
    await assert.rejects(
      storage.get(internalRecord.storageKey, { ownerId: stranger.userId, assetId }),
      /无法验证/,
    );

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${assetId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(removed.statusCode, 204);
    const unavailable = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}/content`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(unavailable.statusCode, 410);
    assert.equal(unavailable.json().error.code, "ASSET_UNAVAILABLE");
    const activeAfterDelete = await app.inject({
      method: "GET",
      url: "/api/v1/assets",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(activeAfterDelete.statusCode, 200, activeAfterDelete.body);
    assert.deepEqual(activeAfterDelete.json().assets, []);
    const deletionHistory = await app.inject({
      method: "GET",
      url: "/api/v1/assets?includeDeleted=true",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(deletionHistory.statusCode, 200, deletionHistory.body);
    assert.deepEqual(deletionHistory.json().assets.map((item: { id: string }) => item.id), [assetId]);
    assert.ok(deletionHistory.json().assets[0].deletedAt);
    assert.equal(JSON.stringify(deletionHistory.json()).includes("storageKey"), false);
  });

  it("cancels in-flight generation and refunds reserved credits when its source photo is deleted", async () => {
    const owner = await login("删除生成中素材");
    const auth = { authorization: `Bearer ${owner.token}` };
    const asset = await upload(owner.token);
    const assetId = asset.id as string;
    const createPayload = {
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId: assetId,
      width: 8,
      height: 8,
      seed: "asset-delete-generation-seed",
    } as const;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: { ...auth, "idempotency-key": "asset-delete-generation-0001" },
      payload: createPayload,
    });
    assert.equal(created.statusCode, 202, created.body);
    const jobId = created.json().job.id as string;
    assert.equal((await store.getCreditAccount(owner.userId)).balance, 19);

    const claimed = await store.claimNextGenerationJob({
      now: new Date().toISOString(),
      leaseToken: "00000000-0000-4000-8000-0000000000d1",
      leaseMilliseconds: 60_000,
    });
    assert.equal(claimed?.id, jobId);
    assert.equal(claimed?.status, "preprocessing");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${assetId}`,
      headers: auth,
    });
    assert.equal(removed.statusCode, 204, removed.body);
    const canceled = await store.getGenerationJob(owner.userId, jobId);
    assert.equal(canceled?.status, "canceled");
    assert.equal(canceled?.leaseToken, null);
    assert.ok(canceled?.canceledAt);
    assert.equal((await store.getCreditAccount(owner.userId)).balance, 20);

    const replayCreate = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: { ...auth, "idempotency-key": "asset-delete-generation-0001" },
      payload: createPayload,
    });
    assert.equal(replayCreate.statusCode, 202, replayCreate.body);
    assert.equal(replayCreate.headers["idempotency-replayed"], "true");
    assert.equal(replayCreate.json().job.id, jobId);
    assert.equal((await store.getCreditAccount(owner.userId)).balance, 20);
    assert.equal((await store.getGenerationJob(owner.userId, jobId))?.status, "canceled");

    const replayDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${assetId}`,
      headers: auth,
    });
    assert.equal(replayDelete.statusCode, 204, replayDelete.body);
    const releases = (await store.listCreditLedger(owner.userId, 100))
      .filter((entry) => entry.reason === "generation_released" && entry.referenceId === jobId);
    assert.equal(releases.length, 1);
    assert.equal((await store.getCreditAccount(owner.userId)).balance, 20);

    assert.equal(await store.renewGenerationJobLease({
      jobId,
      leaseToken: "00000000-0000-4000-8000-0000000000d1",
      now: new Date().toISOString(),
      leaseMilliseconds: 120_000,
    }), false);
  });

  it("rejects a declared MIME type that does not match decoded image bytes", async () => {
    const owner = await login("格式测试");
    const body = multipartImage({ bytes: png, mimeType: "image/jpeg" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": body.contentType,
        "idempotency-key": "asset-mime-mismatch",
      },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 415);
    assert.equal(response.json().error.code, "ASSET_MIME_MISMATCH");
  });

  it("accepts only the server-owned consent version", async () => {
    const owner = await login("同意版本测试");
    const body = multipartImage({ bytes: png, mimeType: "image/png", consentVersion: "privacy-old" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": body.contentType,
        "idempotency-key": "asset-old-consent",
      },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "CONSENT_VERSION_OUTDATED");
    assert.equal(response.json().error.details.currentConsentVersion, "privacy-v1");
  });

  it("resumes the same durable reservation after a storage write failure", async () => {
    await app.close();
    const attempted: { value?: { storageKey: string; ownerId: string; assetId: string } } = {};
    const failingStorage: StorageProvider = {
      ready: async () => {},
      put: async (_contents, context, storageKey) => {
        assert.ok(storageKey);
        attempted.value = { storageKey, ...context };
        throw Object.assign(new Error("simulated storage outage"), { code: "EIO" });
      },
      get: async () => null,
      delete: async () => {},
    };
    app = await buildApp({ config, store, storage: failingStorage, logger: false });
    await app.ready();

    const owner = await login("写入失败测试");
    const body = multipartImage({ bytes: png, mimeType: "image/png" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": body.contentType,
        "idempotency-key": "asset-write-recovery-0001",
      },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 500);
    const attempt = attempted.value as { storageKey: string; ownerId: string; assetId: string } | undefined;
    assert.ok(attempt);
    const record = await store.getAsset(owner.userId, attempt.assetId);
    assert.equal(record?.readyAt, null);
    assert.equal(record?.deletedAt, null);
    assert.equal(record?.purgedAt, null);
    assert.equal(record?.storageKey, attempt.storageKey);

    await app.close();
    // A process restart creates a new provider for the same durable root. The
    // previous app has closed its provider (including maintenance timers), so
    // reusing that closed instance would not model a restart.
    storage = new LocalEncryptedStorage({ root, keyBase64: ENCRYPTION_KEY });
    app = await buildApp({ config, store, storage, logger: false });
    await app.ready();
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": body.contentType,
        "idempotency-key": "asset-write-recovery-0001",
      },
      payload: body.payload,
    });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.equal(replay.json().asset.id, attempt.assetId);
    assert.ok((await store.getAsset(owner.userId, attempt.assetId))?.readyAt);
  });

  it("does not start an object write when the returned lease budget is exhausted", async () => {
    await app.close();
    let putCalls = 0;
    const observingStorage: StorageProvider = {
      ready: async () => {},
      get: async () => null,
      put: async (_contents, _context, storageKey) => {
        putCalls += 1;
        assert.ok(storageKey);
        return { storageKey };
      },
      delete: async () => {},
    };
    app = await buildApp({ config, store, storage: observingStorage, logger: false });
    await app.ready();
    const owner = await login("上传写入期限测试");
    const originalReserve = store.reserveAssetUpload.bind(store);
    store.reserveAssetUpload = async (input) => ({
      ...await originalReserve(input),
      uploadLeaseExpiresAt: new Date(Date.now() - 1).toISOString(),
    });
    const body = multipartImage({ bytes: png, mimeType: "image/png" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": body.contentType,
        "idempotency-key": "asset-expired-write-budget",
      },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.code, "ASSET_UPLOAD_LEASE_LOST");
    assert.equal(putCalls, 0);
  });

  it("keeps metadata private and unavailable until the object write is published", async () => {
    await app.close();
    let releasePut = (): void => undefined;
    let markPutStarted = (): void => undefined;
    const putGate = new Promise<void>((resolve) => { releasePut = resolve; });
    const putStarted = new Promise<void>((resolve) => { markPutStarted = resolve; });
    let pendingContext: { ownerId: string; assetId: string } | null = null;
    const blockingStorage: StorageProvider = {
      ready: async () => {},
      put: async (_contents, context, storageKey) => {
        assert.ok(storageKey);
        pendingContext = context;
        markPutStarted();
        await putGate;
        return { storageKey };
      },
      get: async () => null,
      delete: async () => {},
    };
    app = await buildApp({ config, store, storage: blockingStorage, logger: false });
    await app.ready();

    const owner = await login("两阶段发布测试");
    const body = multipartImage({ bytes: png, mimeType: "image/png" });
    const uploadRequest = app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": body.contentType,
        "idempotency-key": "asset-two-phase-publish",
      },
      payload: body.payload,
    });
    await putStarted;
    const context = pendingContext as { ownerId: string; assetId: string } | null;
    assert.ok(context);
    const pending = await store.getAsset(owner.userId, context.assetId);
    assert.equal(pending?.readyAt, null);
    assert.deepEqual(await store.listAssets({
      userId: owner.userId,
      includeDeleted: false,
      now: new Date().toISOString(),
      limit: 10,
    }), []);

    releasePut();
    const response = await uploadRequest;
    assert.equal(response.statusCode, 201, response.body);
    const ready = await store.getAsset(owner.userId, context.assetId);
    assert.ok(ready?.readyAt);
    assert.equal(response.json().asset.id, context.assetId);
  });

  it("sweeps an abandoned pending upload after the publish timeout", async () => {
    const owner = await login("发布超时清理测试");
    const assetId = "00000000-0000-4000-8000-0000000000c1";
    const stored = await storage.put(png, { ownerId: owner.userId, assetId });
    const now = Date.now();
    await store.createAsset({
      id: assetId,
      userId: owner.userId,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: createHash("sha256").update(png).digest("hex"),
      mimeType: "image/png",
      sizeBytes: png.length,
      width: 3,
      height: 2,
      storageKey: stored.storageKey,
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      createdAt: new Date(now - 16 * 60_000).toISOString(),
    });

    const result = await purgeExpiredAssets({
      store,
      storage,
      now: new Date(now).toISOString(),
      limit: 10,
    });
    assert.equal(result.purged, 1);
    assert.equal(await storage.get(stored.storageKey, { ownerId: owner.userId, assetId }), null);
    const swept = await store.getAsset(owner.userId, assetId);
    assert.ok(swept?.deletedAt);
    assert.ok(swept?.purgedAt);
  });

  it("lets a completed publish win over a stale purge scan", async () => {
    const owner = await login("发布清理竞态测试");
    const now = Date.now();
    const assetId = "00000000-0000-4000-8000-0000000000b1";
    const context = { ownerId: owner.userId, assetId };
    const stored = await storage.put(png, context);
    await store.createAsset({
      id: assetId,
      userId: owner.userId,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: createHash("sha256").update(png).digest("hex"),
      mimeType: "image/png",
      sizeBytes: png.length,
      width: 3,
      height: 2,
      storageKey: stored.storageKey,
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      createdAt: new Date(now - 16 * 60_000).toISOString(),
    });

    const listCandidates = store.listAssetsForPurge.bind(store);
    store.listAssetsForPurge = async (scanAt, limit) => {
      const staleSnapshot = await listCandidates(scanAt, limit);
      const published = await store.markAssetReady(owner.userId, assetId, new Date(now).toISOString());
      assert.ok(published?.readyAt);
      return staleSnapshot;
    };
    const result = await purgeExpiredAssets({
      store,
      storage,
      now: new Date(now).toISOString(),
      limit: 10,
    });

    assert.deepEqual({ purged: result.purged, skipped: result.skipped, failed: result.failed }, {
      purged: 0,
      skipped: 1,
      failed: 0,
    });
    assert.deepEqual(await storage.get(stored.storageKey, context), png);
    const asset = await store.getAsset(owner.userId, assetId);
    assert.ok(asset?.readyAt);
    assert.equal(asset?.deletedAt, null);
    assert.equal(asset?.purgedAt, null);
  });

  it("allows only the internal worker to purge expired encrypted bytes", async () => {
    const owner = await login("过期清理测试");
    const expiredAssetId = "00000000-0000-4000-8000-0000000000a1";
    const stored = await storage.put(png, { ownerId: owner.userId, assetId: expiredAssetId });
    const asset = await store.createAsset({
      id: expiredAssetId,
      userId: owner.userId,
      purpose: "ai-intermediate",
      consentVersion: "privacy-v1",
      sha256: createHash("sha256").update(png).digest("hex"),
      mimeType: "image/png",
      sizeBytes: png.length,
      width: 3,
      height: 2,
      storageKey: stored.storageKey,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });

    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/privacy/delete-expired",
      headers: { "x-internal-worker-key": "wrong-worker-key" },
      payload: { limit: 100 },
    });
    assert.equal(denied.statusCode, 401);
    assert.ok(await storage.get(stored.storageKey, { ownerId: owner.userId, assetId: expiredAssetId }));

    const cleaned = await app.inject({
      method: "POST",
      url: "/api/v1/privacy/delete-expired",
      headers: { "x-internal-worker-key": WORKER_KEY },
      payload: { limit: 100 },
    });
    assert.equal(cleaned.statusCode, 200);
    assert.equal(cleaned.json().purged, 1);
    assert.equal(await storage.get(stored.storageKey, { ownerId: owner.userId, assetId: expiredAssetId }), null);
    const record = await store.getAsset(owner.userId, asset.id);
    assert.ok(record?.deletedAt);
    assert.ok(record?.purgedAt);

    const unavailable = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${asset.id}/content`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(unavailable.statusCode, 410);
  });

  it("isolates a failed purge item and leaves it retryable", async () => {
    const owner = await login("清理失败隔离测试");
    const failedAssetId = "00000000-0000-4000-8000-0000000000b1";
    const healthyAssetId = "00000000-0000-4000-8000-0000000000b2";
    const now = Date.now();
    const createdAt = new Date(now - 120_000).toISOString();
    const expiresAt = new Date(now - 60_000).toISOString();

    const failedStored = await storage.put(png, { ownerId: owner.userId, assetId: failedAssetId });
    const healthyStored = await storage.put(png, { ownerId: owner.userId, assetId: healthyAssetId });
    for (const [assetId, storageKey] of [
      [failedAssetId, failedStored.storageKey],
      [healthyAssetId, healthyStored.storageKey],
    ] as const) {
      await store.createAsset({
        id: assetId,
        userId: owner.userId,
        purpose: "ai-source",
        consentVersion: "privacy-v1",
        sha256: createHash("sha256").update(png).digest("hex"),
        mimeType: "image/png",
        sizeBytes: png.length,
        width: 3,
        height: 2,
        storageKey,
        expiresAt,
        createdAt,
      });
    }

    let failOnce = true;
    const flakyStorage: StorageProvider = {
      ready: () => storage.ready(),
      put: (contents, context, storageKey) => storage.put(contents, context, storageKey),
      get: (storageKey, context) => storage.get(storageKey, context),
      delete: async (storageKey) => {
        if (storageKey === failedStored.storageKey && failOnce) {
          failOnce = false;
          throw Object.assign(new Error("simulated delete failure"), { code: "EIO" });
        }
        await storage.delete(storageKey);
      },
    };

    const first = await purgeExpiredAssets({
      store,
      storage: flakyStorage,
      now: new Date(now).toISOString(),
      limit: 1,
    });
    assert.equal(first.scanned, 1);
    assert.equal(first.purged, 0);
    assert.equal(first.failed, 1);
    assert.deepEqual(first.failures, [{ assetId: failedAssetId, code: "EIO", retryable: true }]);
    assert.equal((await store.getAsset(owner.userId, failedAssetId))?.purgedAt, null);
    assert.equal((await store.getAsset(owner.userId, healthyAssetId))?.purgedAt, null);

    const retried = await purgeExpiredAssets({
      store,
      storage,
      now: new Date(now).toISOString(),
      limit: 1,
    });
    assert.equal(retried.scanned, 1);
    assert.equal(retried.purged, 1);
    assert.equal(retried.failed, 0);
    assert.ok((await store.getAsset(owner.userId, healthyAssetId))?.purgedAt);
    assert.equal((await store.getAsset(owner.userId, failedAssetId))?.purgedAt, null);

    const afterBackoff = await purgeExpiredAssets({
      store,
      storage,
      now: new Date(now + 30_000).toISOString(),
      limit: 1,
    });
    assert.equal(afterBackoff.purged, 1);
    assert.equal(afterBackoff.failed, 0);
    assert.ok((await store.getAsset(owner.userId, failedAssetId))?.purgedAt);
  });
});
