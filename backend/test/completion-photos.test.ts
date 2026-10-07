import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";
import sharp from "sharp";

import { buildApp } from "../src/app.js";
import { sanitizeImage } from "../src/assets/image.js";
import type { AppConfig } from "../src/config.js";
import {
  COMPLETION_PHOTO_UPLOAD_LEASE_MILLISECONDS,
  USER_RATE_LIMITS,
} from "../src/domain/resource-limits.js";
import { AppError } from "../src/errors.js";
import { hashIdempotencyRequest } from "../src/idempotency.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { LocalEncryptedStorage } from "../src/storage/local-encrypted-storage.js";
import {
  StorageObjectCorruptedError,
  type StorageObjectContext,
  type StorageProvider,
} from "../src/storage/storage-provider.js";

const ENCRYPTION_KEY = "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=";

type MultipartTestPart =
  | { type: "field"; name: string; value: string }
  | { type: "file"; name: string; filename: string; mimeType: string; bytes: Buffer };

function multipartBody(parts: readonly MultipartTestPart[]) {
  const boundary = `pindou-completion-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
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
    ]),
  };
}

function multipartPhoto(bytes: Buffer, mimeType = "image/png") {
  return multipartBody([
    { type: "file", name: "file", filename: "finished.png", mimeType, bytes },
  ]);
}

class CollisionStorage implements StorageProvider {
  private readonly objects = new Map<string, { contents: Buffer; context: StorageObjectContext }>();
  putCalls = 0;
  private firstPutRelease = (): void => undefined;
  private readonly firstPutGate = new Promise<void>((resolve) => { this.firstPutRelease = resolve; });

  async ready(): Promise<void> {}

  async put(contents: Buffer, context: StorageObjectContext, storageKey?: string): Promise<{ storageKey: string }> {
    assert.ok(storageKey);
    this.putCalls += 1;
    if (this.putCalls === 1) {
      await this.firstPutGate;
      if (this.objects.has(storageKey)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    } else if (this.putCalls === 2) {
      this.objects.set(storageKey, { contents: Buffer.from(contents), context });
      this.firstPutRelease();
      return { storageKey };
    }
    if (this.objects.has(storageKey)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.objects.set(storageKey, { contents: Buffer.from(contents), context });
    return { storageKey };
  }

  async get(storageKey: string, context: StorageObjectContext): Promise<Buffer | null> {
    const object = this.objects.get(storageKey);
    if (!object) return null;
    assert.deepEqual(object.context, context);
    return Buffer.from(object.contents);
  }

  async delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey);
  }
}

class InterleavingStorage implements StorageProvider {
  private readonly objects = new Map<string, { contents: Buffer; context: StorageObjectContext }>();
  private ranMissHook = false;

  constructor(private readonly onFirstMiss: () => Promise<void>) {}

  async ready(): Promise<void> {}

  async get(storageKey: string, context: StorageObjectContext): Promise<Buffer | null> {
    const object = this.objects.get(storageKey);
    if (object) {
      assert.deepEqual(object.context, context);
      return Buffer.from(object.contents);
    }
    if (!this.ranMissHook) {
      this.ranMissHook = true;
      await this.onFirstMiss();
    }
    return null;
  }

  async put(contents: Buffer, context: StorageObjectContext, storageKey?: string): Promise<{ storageKey: string }> {
    assert.ok(storageKey);
    if (this.objects.has(storageKey)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.objects.set(storageKey, { contents: Buffer.from(contents), context });
    return { storageKey };
  }

  async delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey);
  }
}

class LateWriterStorage implements StorageProvider {
  private readonly objects = new Map<string, { contents: Buffer; context: StorageObjectContext }>();
  private getCalls = 0;
  private putCalls = 0;
  deleteCalls = 0;
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
    this.deleteCalls += 1;
    this.objects.delete(storageKey);
    this.releaseLatePut();
  }

  hasObject(storageKey: string): boolean {
    return this.objects.has(storageKey);
  }
}

describe("project completion photos", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let storageRoot: string;
  let storage: StorageProvider;
  let png: Buffer;
  let config: AppConfig;

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "pindou-completion-photos-"));
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
      assetStorageRoot: storageRoot,
      assetEncryptionKeyBase64: ENCRYPTION_KEY,
      assetMaxBytes: 1024 * 1024,
      assetDefaultTtlHours: 23,
      assetConsentVersion: "privacy-v1",
      assetPurgeBatchSize: 500,
      assetPurgeMaxBatches: 100,
      internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
    };
    store = new MemoryStore();
    storage = new LocalEncryptedStorage({ root: storageRoot, keyBase64: ENCRYPTION_KEY });
    app = await buildApp({ config, store, storage, logger: false });
    await app.ready();
    png = await sharp({
      create: { width: 4, height: 3, channels: 4, background: { r: 250, g: 100, b: 80, alpha: 1 } },
    }).png().toBuffer();
  });

  afterEach(async () => {
    await app.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  async function useStorage(nextStorage: StorageProvider): Promise<void> {
    await app.close();
    storage = nextStorage;
    app = await buildApp({ config, store, storage, logger: false });
    await app.ready();
  }

  async function login(name: string): Promise<{ token: string; userId: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: name },
    });
    assert.equal(response.statusCode, 201, response.body);
    return { token: response.json().token as string, userId: response.json().user.id as string };
  }

  async function createProject(token: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": `create-${randomSuffix()}` },
      payload: {
        name: "完工作品",
        paletteId: "mard-48-v1",
        grid: {
          encoding: "palette-code-v1",
          width: 2,
          height: 2,
          cells: ["H2", "A11", null, "E2"],
        },
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().project.id as string;
  }

  async function completeProject(token: string, projectId: string, revision = 1): Promise<void> {
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/build-progress`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": `complete-${randomSuffix()}` },
      payload: {
        projectRevision: revision,
        baseProgressRevision: 0,
        completedIndices: [0, 1, 3],
        elapsedTime: 123,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json().progress.completedAt);
  }

  function randomSuffix(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function upload(input: {
    token: string;
    projectId: string;
    revision?: number;
    key: string;
    bytes?: Buffer;
  }) {
    const body = multipartPhoto(input.bytes ?? png);
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${input.projectId}/completion-photos?projectRevision=${input.revision ?? 1}`,
      headers: {
        authorization: `Bearer ${input.token}`,
        "idempotency-key": input.key,
        "content-type": body.contentType,
      },
      payload: body.payload,
    });
  }

  it("requires the current revision to be fully built and keeps the generic asset API closed", async () => {
    const owner = await login("完工照片用户");
    const stranger = await login("其他用户");
    const projectId = await createProject(owner.token);

    const incomplete = await upload({ token: owner.token, projectId, key: "completion-incomplete-01" });
    assert.equal(incomplete.statusCode, 409, incomplete.body);
    assert.equal(incomplete.json().error.code, "PROJECT_BUILD_NOT_COMPLETED");
    await completeProject(owner.token, projectId);

    const created = await upload({ token: owner.token, projectId, key: "completion-create-0001" });
    assert.equal(created.statusCode, 201, created.body);
    const photo = created.json().photo as Record<string, unknown>;
    const photoId = photo.id as string;
    assert.equal(photo.projectId, projectId);
    assert.equal(photo.projectRevision, 1);
    assert.equal(photo.mimeType, "image/png");
    assert.equal(JSON.stringify(photo).includes("assetId"), false);
    assert.equal(JSON.stringify(photo).includes("storageKey"), false);

    const completionAssets = await store.listAssets({
      userId: owner.userId,
      purpose: "project-completion",
      includeDeleted: false,
      now: new Date().toISOString(),
      limit: 10,
    });
    assert.equal(completionAssets.length, 1);
    assert.equal(completionAssets[0]?.consentVersion, null);
    assert.equal(completionAssets[0]?.expiresAt, null);
    const assetId = completionAssets[0]!.id;

    const genericList = await app.inject({
      method: "GET",
      url: "/api/v1/assets?limit=50",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(genericList.statusCode, 200, genericList.body);
    assert.deepEqual(genericList.json().assets, []);
    for (const suffix of ["", "/content"]) {
      const hidden = await app.inject({
        method: "GET",
        url: `/api/v1/assets/${assetId}${suffix}`,
        headers: { authorization: `Bearer ${owner.token}` },
      });
      assert.equal(hidden.statusCode, 404, hidden.body);
      assert.equal(hidden.json().error.code, "ASSET_NOT_FOUND");
    }
    const genericDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${assetId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(genericDelete.statusCode, 404, genericDelete.body);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/completion-photos`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().revision, 1);
    assert.deepEqual(listed.json().photos.map((item: { id: string }) => item.id), [photoId]);

    const content = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/completion-photos/${photoId}/content`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(content.statusCode, 200, content.body);
    assert.equal(content.headers["cache-control"], "private, no-store");
    assert.equal(content.headers["content-type"], "image/png");
    assert.equal(Number(content.headers["content-length"]), content.rawPayload.length);
    assert.equal(content.headers["x-content-type-options"], "nosniff");
    assert.equal(createHash("sha256").update(content.rawPayload).digest("hex"), photo.sha256);

    for (const token of [stranger.token]) {
      const hidden = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/completion-photos/${photoId}/content`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(hidden.statusCode, 404, hidden.body);
    }

    const advanced = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/grid`,
      headers: { authorization: `Bearer ${owner.token}`, "idempotency-key": "completion-new-revision-01" },
      payload: {
        baseRevision: 1,
        grid: {
          encoding: "palette-code-v1",
          width: 2,
          height: 2,
          cells: ["H2", "A11", null, "E2"],
        },
      },
    });
    assert.equal(advanced.statusCode, 200, advanced.body);
    const currentList = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/completion-photos`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(currentList.statusCode, 200, currentList.body);
    assert.equal(currentList.json().revision, 2);
    assert.deepEqual(currentList.json().photos, []);
    const historicalList = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/completion-photos?revision=1`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(historicalList.statusCode, 200, historicalList.body);
    assert.deepEqual(historicalList.json().photos.map((item: { id: string }) => item.id), [photoId]);
    const staleUpload = await upload({
      token: owner.token,
      projectId,
      revision: 1,
      key: "completion-stale-revision",
    });
    assert.equal(staleUpload.statusCode, 409, staleUpload.body);
    assert.equal(staleUpload.json().error.code, "PROJECT_COMPLETION_REVISION_MISMATCH");

    const deleteHeaders = {
      authorization: `Bearer ${owner.token}`,
      "idempotency-key": "completion-delete-0001",
    };
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/completion-photos/${photoId}`,
      headers: deleteHeaders,
    });
    assert.equal(removed.statusCode, 204, removed.body);
    const replay = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/completion-photos/${photoId}`,
      headers: deleteHeaders,
    });
    assert.equal(replay.statusCode, 204, replay.body);
    assert.equal(replay.headers["idempotency-replayed"], "true");
  });

  it("requires bearer authentication for completion-photo routes", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    const photoId = "00000000-0000-4000-8000-000000000002";
    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/completion-photos?projectRevision=1`,
        headers: { "idempotency-key": "completion-unauthenticated-upload" },
      }),
      app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/completion-photos` }),
      app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/completion-photos/${photoId}/content`,
      }),
      app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}/completion-photos/${photoId}` }),
    ]);

    for (const response of responses) {
      assert.equal(response.statusCode, 401, response.body);
      assert.equal(response.json().error.code, "AUTH_REQUIRED");
      assert.equal(typeof response.json().requestId, "string");
    }
  });

  it("paginates at the HTTP boundaries without exposing storage identifiers or URLs", async () => {
    const owner = await login("完工照片分页用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);
    await upload({ token: owner.token, projectId, key: "completion-pagination-01" });
    await upload({ token: owner.token, projectId, key: "completion-pagination-02" });

    const first = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/completion-photos?limit=1&offset=0`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().photos.length, 1);
    assert.deepEqual(first.json().pagination, { limit: 1, offset: 0, hasMore: true, nextOffset: 1 });

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/completion-photos?limit=1&offset=1`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().photos.length, 1);
    assert.deepEqual(second.json().pagination, { limit: 1, offset: 1, hasMore: false, nextOffset: null });

    const finalBoundary = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/completion-photos?limit=50&offset=1000000`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(finalBoundary.statusCode, 200, finalBoundary.body);
    assert.deepEqual(finalBoundary.json().pagination, {
      limit: 50,
      offset: 1_000_000,
      hasMore: false,
      nextOffset: null,
    });
    assert.deepEqual(finalBoundary.json().photos, []);

    for (const query of ["limit=0", "limit=51", "offset=-1", "offset=1000001"]) {
      const invalid = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/completion-photos?${query}`,
        headers: { authorization: `Bearer ${owner.token}` },
      });
      assert.equal(invalid.statusCode, 400, `${query}: ${invalid.body}`);
      assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
    }

    for (const photo of [...first.json().photos, ...second.json().photos]) {
      for (const field of ["assetId", "storageKey", "url", "objectUrl", "downloadUrl"]) {
        assert.equal(field in photo, false, `list item must not expose ${field}`);
      }
      assert.doesNotMatch(JSON.stringify(photo), /https?:\/\//);
    }
  });

  it("returns stable error envelopes for missing and corrupted stored photo contents", async () => {
    const owner = await login("完工照片读取错误用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);
    const created = await upload({ token: owner.token, projectId, key: "completion-content-errors" });
    assert.equal(created.statusCode, 201, created.body);
    const photoId = created.json().photo.id as string;
    const contentUrl = `/api/v1/projects/${projectId}/completion-photos/${photoId}/content`;

    const readStorage = (get: StorageProvider["get"]): StorageProvider => ({
      ready: async () => undefined,
      get,
      put: async (_contents, _context, storageKey) => {
        assert.ok(storageKey);
        return { storageKey };
      },
      delete: async () => undefined,
    });
    const assertContentError = async (expectedCode: string): Promise<void> => {
      const response = await app.inject({
        method: "GET",
        url: contentUrl,
        headers: { authorization: `Bearer ${owner.token}` },
      });
      assert.equal(response.statusCode, 410, response.body);
      assert.equal(response.json().error.code, expectedCode);
      assert.equal(typeof response.json().requestId, "string");
    };

    await useStorage(readStorage(async () => null));
    await assertContentError("COMPLETION_PHOTO_CONTENT_UNAVAILABLE");

    await useStorage(readStorage(async () => Buffer.from("not-the-published-image")));
    await assertContentError("COMPLETION_PHOTO_CONTENT_CORRUPTED");

    await useStorage(readStorage(async () => { throw new StorageObjectCorruptedError(); }));
    await assertContentError("COMPLETION_PHOTO_CONTENT_CORRUPTED");
  });

  it("single-flights concurrent same-key uploads and authenticates an EEXIST winner", async () => {
    const collisionStorage = new CollisionStorage();
    await useStorage(collisionStorage);
    const owner = await login("并发完工照片用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);

    const [first, second] = await Promise.all([
      upload({ token: owner.token, projectId, key: "completion-concurrent-01" }),
      upload({ token: owner.token, projectId, key: "completion-concurrent-01" }),
    ]);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(first.json().photo.id, second.json().photo.id);
    assert.equal([first, second].filter((response) => response.headers["idempotency-replayed"] === "true").length, 1);
    assert.equal(collisionStorage.putCalls, 2);
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/completion-photos`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(listed.json().photos.length, 1);
  });

  it("rate-limits attempts before idempotency, multipart parsing, and Sharp work", async () => {
    const owner = await login("上传尝试限流用户");
    const now = new Date().toISOString();
    for (let index = 0; index < USER_RATE_LIMITS.completionPhotoUploadAttempt.limit; index += 1) {
      const consumed = await store.consumeUserRateLimit({
        userId: owner.userId,
        ...USER_RATE_LIMITS.completionPhotoUploadAttempt,
        now,
      });
      assert.equal(consumed.allowed, true);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/projects/00000000-0000-4000-8000-000000000001/completion-photos?projectRevision=1",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "idempotency-key": "completion-preparse-limit",
        "content-type": "multipart/form-data; boundary=never-parsed",
      },
      payload: "this is intentionally malformed multipart and must never be parsed",
    });
    assert.equal(blocked.statusCode, 429, blocked.body);
    assert.equal(blocked.json().error.code, "USER_RATE_LIMITED");
    assert.ok(blocked.headers["retry-after"], "the pre-parse limiter must expose Retry-After");
  });

  it("streams an authenticated completion image larger than the ordinary 2 MiB JSON limit", async () => {
    config = { ...config, assetMaxBytes: 4 * 1024 * 1024 };
    await useStorage(new LocalEncryptedStorage({ root: storageRoot, keyBase64: ENCRYPTION_KEY }));

    const owner = await login("大图完工上传用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);
    const width = 900;
    const height = 900;
    const largePng = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    }).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer();
    assert.ok(largePng.length > 2 * 1024 * 1024);
    assert.ok(largePng.length < config.assetMaxBytes);

    const response = await upload({
      token: owner.token,
      projectId,
      key: "completion-over-json-body-limit",
      bytes: largePng,
    });
    assert.equal(response.statusCode, 201, response.body);
  });

  it("returns 413 for completion multipart file, field, and part limits", async () => {
    const owner = await login("完工流式边界用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);
    const url = `/api/v1/projects/${projectId}/completion-photos?projectRevision=1`;
    const cases = [
      {
        label: "file size",
        body: multipartPhoto(Buffer.alloc(config.assetMaxBytes + 1)),
      },
      {
        label: "field size",
        body: multipartBody([
          { type: "field", name: "unexpected", value: "x".repeat(257) },
          { type: "file", name: "file", filename: "finished.png", mimeType: "image/png", bytes: png },
        ]),
      },
      {
        label: "part count",
        body: multipartBody([
          { type: "file", name: "file", filename: "finished.png", mimeType: "image/png", bytes: png },
          { type: "file", name: "extra", filename: "extra.png", mimeType: "image/png", bytes: png },
        ]),
      },
    ];

    for (const [index, current] of cases.entries()) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: {
          authorization: `Bearer ${owner.token}`,
          "idempotency-key": `completion-multipart-limit-${index}`,
          "content-type": current.body.contentType,
        },
        payload: current.body.payload,
      });
      assert.equal(response.statusCode, 413, `${current.label}: ${response.body}`);
      assert.equal(response.json().error.code, "ASSET_TOO_LARGE", current.label);
    }
  });

  it("does not start a stable-key write after its durable upload lease deadline", async () => {
    let putCalls = 0;
    const deadlineStorage: StorageProvider = {
      ready: async () => undefined,
      get: async () => null,
      put: async (_contents, _context, storageKey) => {
        putCalls += 1;
        return { storageKey: storageKey ?? "unexpected-generated-key" };
      },
      delete: async () => undefined,
    };
    await useStorage(deadlineStorage);
    const owner = await login("上传期限用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);
    const originalReserve = store.reserveProjectCompletionPhotoUpload.bind(store);
    store.reserveProjectCompletionPhotoUpload = async (input) => ({
      ...await originalReserve(input),
      uploadLeaseExpiresAt: new Date(Date.now() - 1).toISOString(),
    });

    const response = await upload({ token: owner.token, projectId, key: "completion-expired-write-01" });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.code, "COMPLETION_PHOTO_UPLOAD_LEASE_LOST");
    assert.equal(putCalls, 0);
  });

  it("publishes with a ready timestamp equal to the pending asset timestamp", async () => {
    const owner = await login("同毫秒完工照片用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);
    const sanitized = await sanitizeImage(png, "image/png", config.assetMaxBytes);
    const timestamp = "2026-10-05T10:00:00.000Z";
    const reserved = await store.reserveProjectCompletionPhotoUpload({
      photoId: "00000000-0000-4000-8000-000000000d01",
      userId: owner.userId,
      projectId,
      projectRevision: 1,
      idempotencyKey: "completion-same-millisecond",
      requestHash: hashIdempotencyRequest({
        projectRevision: 1,
        sha256: sanitized.sha256,
        mimeType: sanitized.mimeType,
        sizeBytes: sanitized.contents.length,
        width: sanitized.width,
        height: sanitized.height,
      }),
      uploadLeaseToken: "00000000-0000-4000-8000-000000000d02",
      uploadLeaseAcquiredAt: timestamp,
      asset: {
        id: "00000000-0000-4000-8000-000000000d03",
        userId: owner.userId,
        purpose: "project-completion",
        consentVersion: null,
        sha256: sanitized.sha256,
        mimeType: sanitized.mimeType,
        sizeBytes: sanitized.contents.length,
        width: sanitized.width,
        height: sanitized.height,
        storageKey: "completion-same-millisecond-object",
        expiresAt: null,
        createdAt: timestamp,
      },
    });
    const published = await store.publishProjectCompletionPhoto({
      userId: owner.userId,
      projectId,
      photoId: reserved.photo.id,
      assetId: reserved.photo.asset.id,
      uploadLeaseToken: reserved.uploadLeaseToken,
      readyAt: timestamp,
    });
    assert.equal(published.asset.readyAt, timestamp);
    const readyReplay = await store.publishProjectCompletionPhoto({
      userId: owner.userId,
      projectId,
      photoId: reserved.photo.id,
      assetId: reserved.photo.asset.id,
      uploadLeaseToken: reserved.uploadLeaseToken,
      readyAt: new Date(Date.parse(timestamp) + COMPLETION_PHOTO_UPLOAD_LEASE_MILLISECONDS + 1).toISOString(),
    });
    assert.equal(readyReplay.id, published.id, "the winning token replays ready state after lease expiry");
    await assert.rejects(
      store.publishProjectCompletionPhoto({
        userId: owner.userId,
        projectId,
        photoId: reserved.photo.id,
        assetId: reserved.photo.asset.id,
        uploadLeaseToken: "00000000-0000-4000-8000-000000000d04",
        readyAt: new Date(Date.parse(timestamp) + COMPLETION_PHOTO_UPLOAD_LEASE_MILLISECONDS + 2).toISOString(),
      }),
      (error: unknown) => error instanceof AppError
        && error.code === "COMPLETION_PHOTO_UPLOAD_LEASE_LOST",
    );
  });

  it("fences a stale purge scan between replay get-miss, put, and publish", async () => {
    const owner = await login("上传租约交错用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);
    const sanitized = await sanitizeImage(png, "image/png", config.assetMaxBytes);
    const requestHash = hashIdempotencyRequest({
      projectRevision: 1,
      sha256: sanitized.sha256,
      mimeType: sanitized.mimeType,
      sizeBytes: sanitized.contents.length,
      width: sanitized.width,
      height: sanitized.height,
    });
    const photoId = "00000000-0000-4000-8000-000000000c01";
    const assetId = "00000000-0000-4000-8000-000000000c02";
    const oldLeaseToken = "00000000-0000-4000-8000-000000000c03";
    const key = "completion-purge-interleave";
    const oldCreatedAt = "2000-01-01T00:00:00.000Z";
    const abandoned = await store.reserveProjectCompletionPhotoUpload({
      photoId,
      userId: owner.userId,
      projectId,
      projectRevision: 1,
      idempotencyKey: key,
      requestHash,
      uploadLeaseToken: oldLeaseToken,
      uploadLeaseAcquiredAt: oldCreatedAt,
      asset: {
        id: assetId,
        userId: owner.userId,
        purpose: "project-completion",
        consentVersion: null,
        sha256: sanitized.sha256,
        mimeType: sanitized.mimeType,
        sizeBytes: sanitized.contents.length,
        width: sanitized.width,
        height: sanitized.height,
        storageKey: "completion-purge-interleave-object",
        expiresAt: null,
        createdAt: oldCreatedAt,
      },
    });
    assert.ok(
      (await store.listAssetsForPurge(new Date().toISOString(), 20)).some((asset) => asset.id === assetId),
      "the old pending reservation must be scannable before replay",
    );

    let purgeClaimChecked = false;
    const interleavingStorage = new InterleavingStorage(async () => {
      await assert.rejects(
        store.publishProjectCompletionPhoto({
          userId: owner.userId,
          projectId,
          photoId,
          assetId,
          uploadLeaseToken: abandoned.uploadLeaseToken,
          readyAt: new Date().toISOString(),
        }),
        (error: unknown) => error instanceof AppError
          && error.code === "COMPLETION_PHOTO_UPLOAD_LEASE_LOST",
      );
      assert.equal(
        await store.claimAssetForPurge(owner.userId, assetId, new Date().toISOString()),
        null,
        "the replay lease and asset touch must fence a candidate scanned before replay",
      );
      purgeClaimChecked = true;
    });
    await useStorage(interleavingStorage);
    const resumed = await upload({ token: owner.token, projectId, key });
    assert.equal(resumed.statusCode, 201, resumed.body);
    assert.equal(resumed.headers["idempotency-replayed"], "true");
    assert.equal(resumed.json().photo.id, photoId);
    assert.equal(purgeClaimChecked, true);
  });

  it("resumes after bytes were stored but the publish acknowledgement was lost", async () => {
    const backing = new LocalEncryptedStorage({ root: storageRoot, keyBase64: ENCRYPTION_KEY });
    // Avoid the collision gate in the single-request recovery scenario.
    const stableStorage: StorageProvider & { putCalls: number } = {
      putCalls: 0,
      ready: () => backing.ready(),
      get: (key, context) => backing.get(key, context),
      delete: (key) => backing.delete(key),
      put: async (contents, context, key) => {
        stableStorage.putCalls += 1;
        return backing.put(contents, context, key);
      },
    };
    await useStorage(stableStorage);
    const owner = await login("恢复完工照片用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);

    const originalPublish = store.publishProjectCompletionPhoto.bind(store);
    let loseFirstConfirmation = true;
    store.publishProjectCompletionPhoto = async (input) => {
      if (loseFirstConfirmation) {
        loseFirstConfirmation = false;
        throw new Error("simulated publish acknowledgement loss");
      }
      return originalPublish(input);
    };
    const first = await upload({ token: owner.token, projectId, key: "completion-recovery-001" });
    assert.equal(first.statusCode, 500, first.body);
    assert.equal(stableStorage.putCalls, 1);

    const replay = await upload({ token: owner.token, projectId, key: "completion-recovery-001" });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.equal(stableStorage.putCalls, 1, "replay must authenticate and reuse the existing object");
  });

  it("keeps a late same-key writer tracked until the ordinary purge confirms quiescence", async () => {
    const lateStorage = new LateWriterStorage();
    await useStorage(lateStorage);
    const owner = await login("晚写清理用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);

    const originalPublish = store.publishProjectCompletionPhoto.bind(store);
    let publishCalls = 0;
    store.publishProjectCompletionPhoto = async (input) => {
      publishCalls += 1;
      if (publishCalls === 1) {
        await store.updateProjectGrid({
          userId: owner.userId,
          projectId,
          baseRevision: 1,
          grid: {
            encoding: "palette-code-v1",
            width: 2,
            height: 2,
            cells: ["H2", "A11", null, "E2"],
          },
        });
        return originalPublish(input);
      }
      throw new Error("simulated process crash after late stable-key put");
    };

    const responses = await Promise.all([
      upload({ token: owner.token, projectId, key: "completion-late-writer-01" }),
      upload({ token: owner.token, projectId, key: "completion-late-writer-01" }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.statusCode).sort((left, right) => left - right),
      [409, 500],
    );
    assert.equal(lateStorage.deleteCalls, 1, "the terminal request performs one best-effort delete");

    const assets = await store.listAssets({
      userId: owner.userId,
      purpose: "project-completion",
      includeDeleted: true,
      now: new Date().toISOString(),
      limit: 10,
    });
    const asset = assets[0];
    assert.ok(asset?.deletedAt);
    assert.equal(asset.purgedAt, null, "route cleanup cannot acknowledge purge while a writer lease is active");
    assert.equal(lateStorage.hasObject(asset.storageKey), true, "the simulated crashed writer lands after cleanup");

    const duringLease = new Date(Date.now() + 60_000).toISOString();
    await store.markAssetPurged(asset.id, duringLease);
    assert.deepEqual(await store.listAssetsForPurge(duringLease, 10), []);
    const stillTracked = (await store.listAssets({
      userId: owner.userId,
      purpose: "project-completion",
      includeDeleted: true,
      now: duringLease,
      limit: 10,
    }))[0];
    assert.equal(stillTracked?.purgedAt, null, "an active writer lease fences direct purge acknowledgement");
    const afterLease = new Date(
      Date.now() + COMPLETION_PHOTO_UPLOAD_LEASE_MILLISECONDS + 60_000,
    ).toISOString();
    assert.deepEqual(
      (await store.listAssetsForPurge(afterLease, 10)).map((candidate) => candidate.id),
      [asset.id],
    );
    const claimed = await store.claimAssetForPurge(owner.userId, asset.id, afterLease);
    assert.equal(claimed?.id, asset.id);
    await lateStorage.delete(asset.storageKey);
    await store.markAssetPurged(asset.id, afterLease);
    assert.equal(lateStorage.hasObject(asset.storageKey), false);
    const finalized = (await store.listAssets({
      userId: owner.userId,
      purpose: "project-completion",
      includeDeleted: true,
      now: afterLease,
      limit: 10,
    }))[0];
    assert.ok(finalized?.purgedAt, "the ordinary purge owns final confirmation after lease expiry");
  });

  it("keeps a ready photo deletion fenced while a same-key writer is still in flight", async () => {
    const lateStorage = new LateWriterStorage();
    await useStorage(lateStorage);
    const owner = await login("发布后晚写用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);

    const originalPublish = store.publishProjectCompletionPhoto.bind(store);
    let publishCalls = 0;
    store.publishProjectCompletionPhoto = async (input) => {
      publishCalls += 1;
      if (publishCalls === 1) return originalPublish(input);
      throw new Error("simulated process crash after ready photo was deleted");
    };

    const pending = [
      upload({ token: owner.token, projectId, key: "completion-ready-delete-01" }),
      upload({ token: owner.token, projectId, key: "completion-ready-delete-01" }),
    ];
    const first = await Promise.race(pending.map(async (response, index) => ({ response: await response, index })));
    assert.equal(first.response.statusCode, 201, first.response.body);
    const photoId = first.response.json().photo.id as string;
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/completion-photos/${photoId}`,
      headers: {
        authorization: `Bearer ${owner.token}`,
        "idempotency-key": "completion-ready-delete-remove",
      },
    });
    assert.equal(removed.statusCode, 204, removed.body);
    const late = await pending[first.index === 0 ? 1 : 0]!;
    assert.equal(late.statusCode, 500, late.body);

    const asset = (await store.listAssets({
      userId: owner.userId,
      purpose: "project-completion",
      includeDeleted: true,
      now: new Date().toISOString(),
      limit: 10,
    }))[0];
    assert.ok(asset?.deletedAt);
    assert.equal(asset.purgedAt, null, "DELETE must not finalize purge ahead of an active writer");
    assert.equal(lateStorage.hasObject(asset.storageKey), true, "the late writer recreates the stable key after delete");
    assert.deepEqual(
      await store.listAssetsForPurge(new Date(Date.now() + 60_000).toISOString(), 10),
      [],
      "ready assets retain the same writer fence as pending assets",
    );
    const afterLease = new Date(
      Date.now() + COMPLETION_PHOTO_UPLOAD_LEASE_MILLISECONDS + 60_000,
    ).toISOString();
    assert.deepEqual(
      (await store.listAssetsForPurge(afterLease, 10)).map((candidate) => candidate.id),
      [asset.id],
    );
  });

  it("keeps a tombstoned object retryable when stale-publish cleanup cannot delete storage", async () => {
    const backing = new LocalEncryptedStorage({ root: storageRoot, keyBase64: ENCRYPTION_KEY });
    let deleteCalls = 0;
    const failingDeleteStorage: StorageProvider = {
      ready: () => backing.ready(),
      get: (key, context) => backing.get(key, context),
      put: (contents, context, key) => backing.put(contents, context, key),
      delete: async () => {
        deleteCalls += 1;
        throw new Error("simulated storage delete outage");
      },
    };
    await useStorage(failingDeleteStorage);
    const owner = await login("清理重试用户");
    const projectId = await createProject(owner.token);
    await completeProject(owner.token, projectId);

    const originalPublish = store.publishProjectCompletionPhoto.bind(store);
    let advanceBeforePublish = true;
    store.publishProjectCompletionPhoto = async (input) => {
      if (advanceBeforePublish) {
        advanceBeforePublish = false;
        await store.updateProjectGrid({
          userId: owner.userId,
          projectId,
          baseRevision: 1,
          grid: {
            encoding: "palette-code-v1",
            width: 2,
            height: 2,
            cells: ["H2", "A11", null, "E2"],
          },
        });
      }
      try {
        return await originalPublish(input);
      } catch (error) {
        // Simulate a purge worker that observed no object and acknowledged the
        // tombstone just before this late writer's route-level cleanup fails.
        await store.markAssetPurged(input.assetId, input.readyAt);
        throw error;
      }
    };

    const response = await upload({ token: owner.token, projectId, key: "completion-stale-cleanup-01" });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.code, "PROJECT_COMPLETION_STATE_CHANGED");
    assert.equal(deleteCalls, 1);

    const assets = await store.listAssets({
      userId: owner.userId,
      purpose: "project-completion",
      includeDeleted: true,
      now: new Date().toISOString(),
      limit: 10,
    });
    assert.equal(assets.length, 1);
    assert.ok(assets[0]?.deletedAt);
    assert.equal(
      assets[0]?.purgedAt,
      null,
      "failed cleanup must reopen an already-acknowledged purge for a tracked retry",
    );
    assert.deepEqual(await store.listAssetsForPurge(new Date().toISOString(), 10), [], "failure applies retry backoff");
    const afterBackoff = new Date(
      Date.now() + COMPLETION_PHOTO_UPLOAD_LEASE_MILLISECONDS + 60_000,
    ).toISOString();
    assert.deepEqual(
      (await store.listAssetsForPurge(afterBackoff, 10)).map((asset) => asset.id),
      [assets[0]!.id],
      "the regular purge worker must be able to retry the tombstoned object",
    );
  });
});
