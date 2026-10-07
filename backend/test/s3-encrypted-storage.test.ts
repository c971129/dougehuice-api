import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { createConfiguredStorageProvider } from "../src/storage/configured-storage.js";
import { S3EncryptedStorage } from "../src/storage/s3-encrypted-storage.js";
import {
  StorageDependencyUnavailableError,
  StorageEncryptionKeyUnavailableError,
  StorageObjectCorruptedError,
} from "../src/storage/storage-provider.js";

const ENCRYPTION_KEY = "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=";
const OLD_KEY = Buffer.alloc(32, 0x31).toString("base64");
const NEW_KEY = Buffer.alloc(32, 0x32).toString("base64");
const BUCKET = "private-test";

function objectKey(prefix: string, storageKey: string): string {
  const digest = createHash("sha256").update(storageKey).digest("hex");
  return `${prefix}/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}.pdae`;
}

function encryptLegacyObject(
  contents: Buffer,
  keyBase64: string,
  storageKey: string,
  context: { ownerId: string; assetId: string },
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
  cipher.setAAD(Buffer.from(`PDAE1\0${storageKey}\0${context.ownerId}\0${context.assetId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(contents), cipher.final()]);
  return Buffer.concat([Buffer.from("PDAE1", "ascii"), iv, cipher.getAuthTag(), ciphertext]);
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function s3Error(
  response: ServerResponse,
  status: number,
  code: string,
  details: { key?: string; resource?: string; bucketName?: string } = {},
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/xml");
  response.end([
    "<Error>",
    `<Code>${code}</Code>`,
    `<Message>${code}</Message>`,
    ...(details.key ? [`<Key>${details.key}</Key>`] : []),
    ...(details.resource ? [`<Resource>${details.resource}</Resource>`] : []),
    ...(details.bucketName ? [`<BucketName>${details.bucketName}</BucketName>`] : []),
    "<RequestId>test-request</RequestId>",
    "</Error>",
  ].join(""));
}

function assertDependencyUnavailable(
  error: unknown,
  expectedCauseName: string,
  expectedStatus = 404,
): boolean {
  assert.ok(error instanceof StorageDependencyUnavailableError);
  assert.equal(error.message, "私有存储依赖暂时不可用");
  assert.equal(error.message.includes(expectedCauseName), false, "the public error message must not leak its cause");
  assert.ok(typeof error.cause === "object" && error.cause !== null);
  assert.equal("name" in error.cause ? error.cause.name : undefined, expectedCauseName);
  assert.equal(
    "$metadata" in error.cause
      && typeof error.cause.$metadata === "object"
      && error.cause.$metadata !== null
      && "httpStatusCode" in error.cause.$metadata
      ? error.cause.$metadata.httpStatusCode
      : undefined,
    expectedStatus,
  );
  return true;
}

describe("S3/MinIO encrypted private storage", () => {
  const objects = new Map<string, Buffer>();
  const forcedGetErrors = new Map<string, {
    code: string | null;
    key?: string;
    resource?: string;
    bucketName?: string;
  }>();
  const requests: Array<{
    method: string;
    path: string;
    authorization: string;
    ifNoneMatch?: string;
    format?: string;
  }> = [];
  const server = createServer(async (request, response) => {
    const method = request.method ?? "";
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push({
      method,
      path,
      authorization: request.headers.authorization ?? "",
      ...(request.headers["if-none-match"] ? { ifNoneMatch: request.headers["if-none-match"] } : {}),
      ...(request.headers["x-amz-meta-pindou-format"]
        ? { format: String(request.headers["x-amz-meta-pindou-format"]) }
        : {}),
    });

    if (method === "HEAD" && (path === `/${BUCKET}` || path === `/${BUCKET}/`)) {
      response.statusCode = 200;
      response.end();
      return;
    }
    const objectPrefix = `/${BUCKET}/`;
    if (!path.startsWith(objectPrefix)) {
      s3Error(response, 404, "NoSuchBucket");
      return;
    }
    const key = path.slice(objectPrefix.length);
    if (method === "PUT") {
      if (request.headers["if-none-match"] !== "*") {
        s3Error(response, 400, "InvalidRequest");
        return;
      }
      if (objects.has(key)) {
        s3Error(response, 412, "PreconditionFailed");
        return;
      }
      objects.set(key, await requestBody(request));
      response.statusCode = 200;
      response.setHeader("ETag", '"test-etag"');
      response.end();
      return;
    }
    if (method === "GET") {
      const forcedError = forcedGetErrors.get(key);
      if (forcedError) {
        if (forcedError.code === null) {
          response.statusCode = 404;
          response.setHeader("Content-Type", "text/plain");
          response.end("generic upstream 404");
        } else {
          s3Error(response, 404, forcedError.code, forcedError);
        }
        return;
      }
      const contents = objects.get(key);
      if (!contents) {
        s3Error(response, 404, "NoSuchKey");
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", String(contents.length));
      response.end(contents);
      return;
    }
    if (method === "DELETE") {
      objects.delete(key);
      response.statusCode = 204;
      response.end();
      return;
    }
    s3Error(response, 405, "MethodNotAllowed");
  });
  let endpoint = "";

  before(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock S3 server did not bind TCP");
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });

  it("uses the shared factory and verifies readiness without exposing credentials", async () => {
    const config = loadConfig({
      NODE_ENV: "development",
      ASSET_STORAGE_PROVIDER: "s3",
      ASSET_ENCRYPTION_KEY_BASE64: NEW_KEY,
      ASSET_ENCRYPTION_ACTIVE_KEY_ID: "factory-new",
      ASSET_ENCRYPTION_READ_KEYS_JSON: JSON.stringify({ "factory-old": OLD_KEY }),
      ASSET_ENCRYPTION_LEGACY_KEY_ID: "factory-old",
      ASSET_S3_BUCKET: BUCKET,
      ASSET_S3_REGION: "us-east-1",
      ASSET_S3_ENDPOINT: endpoint,
      ASSET_S3_PREFIX: "pindou/private",
      ASSET_S3_FORCE_PATH_STYLE: "true",
      ASSET_S3_ACCESS_KEY_ID: "local-access-key",
      ASSET_S3_SECRET_ACCESS_KEY: "local-secret-key",
    });
    const storage = createConfiguredStorageProvider(config);
    assert.ok(storage instanceof S3EncryptedStorage);
    await storage.ready();
    const request = requests.at(-1);
    assert.equal(request?.method, "HEAD");
    assert.match(request?.authorization ?? "", /^AWS4-HMAC-SHA256 /);
    assert.equal((request?.authorization ?? "").includes("local-secret-key"), false);

    const legacyStorageKey = "factory-legacy-key-0001";
    const context = { ownerId: "factory-owner-0001", assetId: "factory-asset-0001" };
    const plaintext = Buffer.from("factory legacy bytes");
    objects.set(
      objectKey("pindou/private", legacyStorageKey),
      encryptLegacyObject(plaintext, OLD_KEY, legacyStorageKey, context),
    );
    assert.deepEqual(await storage.get(legacyStorageKey, context), plaintext);
    await storage.delete(legacyStorageKey);
  });

  it("encrypts bytes, conditionally preserves stable keys, and binds reads to owner and asset", async () => {
    const storage = new S3EncryptedStorage({
      bucket: BUCKET,
      region: "us-east-1",
      endpoint,
      prefix: "pindou/private",
      forcePathStyle: true,
      accessKeyId: "local-access-key",
      secretAccessKey: "local-secret-key",
      keyBase64: ENCRYPTION_KEY,
    });
    const storageKey = "stable-storage-key-0001";
    const context = { ownerId: "owner-0001", assetId: "asset-0001" };
    const plaintext = Buffer.from("private-source-image-bytes");

    assert.deepEqual(await storage.put(plaintext, context, storageKey), { storageKey });
    const putRequest = requests.at(-1);
    assert.equal(putRequest?.ifNoneMatch, "*");
    assert.equal(putRequest?.format, "pdae2");
    assert.equal(putRequest?.path.includes(storageKey), false);
    assert.equal(putRequest?.path.includes(context.ownerId), false);
    assert.equal(putRequest?.path.includes(context.assetId), false);
    const encrypted = [...objects.values()].at(-1);
    assert.ok(encrypted);
    assert.equal(encrypted.includes(plaintext), false);
    assert.deepEqual(await storage.get(storageKey, context), plaintext);

    await assert.rejects(
      storage.get(storageKey, { ...context, ownerId: "owner-0002" }),
      StorageObjectCorruptedError,
    );
    await assert.rejects(
      storage.get(storageKey, { ...context, assetId: "asset-0002" }),
      StorageObjectCorruptedError,
    );
    await assert.rejects(
      storage.put(Buffer.from("replacement-must-not-win"), context, storageKey),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST",
    );
    assert.equal(requests.at(-1)?.path, putRequest?.path);
    assert.deepEqual(await storage.get(storageKey, context), plaintext);

    assert.equal(await storage.get("missing-storage-key-0001", context), null);
    await storage.delete(storageKey);
    await storage.delete(storageKey);
    assert.equal(await storage.get(storageKey, context), null);

    const requestCountBeforeAbort = requests.length;
    const controller = new AbortController();
    controller.abort(new Error("test storage write deadline"));
    await assert.rejects(
      storage.put(Buffer.from("must-not-be-written"), context, "aborted-storage-key-0001", controller.signal),
      /test storage write deadline|abort/i,
    );
    assert.equal(requests.length, requestCountBeforeAbort, "a pre-aborted write never reaches object storage");

    const requestCountBeforeReadAbort = requests.length;
    const readReason = new Error("test storage read deadline");
    const readController = new AbortController();
    readController.abort(readReason);
    await assert.rejects(
      storage.get("aborted-storage-key-0001", context, readController.signal),
      (error) => error === readReason,
    );
    assert.equal(requests.length, requestCountBeforeReadAbort, "a pre-aborted read never reaches object storage");
  });

  it("returns null only for verified object-not-found errors", async () => {
    const prefix = "pindou/not-found-classification";
    const storage = new S3EncryptedStorage({
      bucket: BUCKET,
      region: "us-east-1",
      endpoint,
      prefix,
      forcePathStyle: true,
      accessKeyId: "local-access-key",
      secretAccessKey: "local-secret-key",
      keyBase64: ENCRYPTION_KEY,
    });
    const context = { ownerId: "not-found-owner", assetId: "not-found-asset" };

    assert.equal(await storage.get("explicit-no-such-key-0001", context), null);

    const verifiedNotFoundStorageKey = "verified-not-found-key-0001";
    const verifiedObjectKey = objectKey(prefix, verifiedNotFoundStorageKey);
    forcedGetErrors.set(verifiedObjectKey, {
      code: "NotFound",
      key: verifiedObjectKey,
      resource: `/${BUCKET}/${verifiedObjectKey}`,
    });
    assert.equal(await storage.get(verifiedNotFoundStorageKey, context), null);

    const noSuchBucketStorageKey = "no-such-bucket-key-0001";
    const noSuchBucketObjectKey = objectKey(prefix, noSuchBucketStorageKey);
    forcedGetErrors.set(noSuchBucketObjectKey, {
      code: "NoSuchBucket",
      bucketName: BUCKET,
      resource: `/${BUCKET}`,
    });
    await assert.rejects(
      storage.get(noSuchBucketStorageKey, context),
      (error: unknown) => assertDependencyUnavailable(error, "NoSuchBucket"),
    );

    const unverifiedNotFoundStorageKey = "unverified-not-found-key-0001";
    const unverifiedNotFoundObjectKey = objectKey(prefix, unverifiedNotFoundStorageKey);
    forcedGetErrors.set(unverifiedNotFoundObjectKey, { code: "NotFound" });
    await assert.rejects(
      storage.get(unverifiedNotFoundStorageKey, context),
      (error: unknown) => assertDependencyUnavailable(error, "NotFound"),
    );

    const genericStorageKey = "generic-http-404-key-0001";
    forcedGetErrors.set(objectKey(prefix, genericStorageKey), { code: null });
    await assert.rejects(
      storage.get(genericStorageKey, context),
      (error: unknown) => assertDependencyUnavailable(error, "Error"),
    );

    forcedGetErrors.delete(verifiedObjectKey);
    forcedGetErrors.delete(noSuchBucketObjectKey);
    forcedGetErrors.delete(unverifiedNotFoundObjectKey);
    forcedGetErrors.delete(objectKey(prefix, genericStorageKey));
    await storage.close();
  });

  it("destroys its AWS client when closed", async () => {
    const storage = new S3EncryptedStorage({
      bucket: BUCKET,
      region: "us-east-1",
      endpoint,
      prefix: "pindou/close",
      forcePathStyle: true,
      accessKeyId: "local-access-key",
      secretAccessKey: "local-secret-key",
      keyBase64: ENCRYPTION_KEY,
    });
    const client = (storage as unknown as { client: { destroy(): void } }).client;
    let destroyCalls = 0;
    client.destroy = () => {
      destroyCalls += 1;
    };

    await storage.close();
    assert.equal(destroyCalls, 1);
  });

  it("reads legacy and keyed objects across rotation and fails closed for an unknown key ID", async () => {
    const prefix = "pindou/rotation";
    const legacyStorageKey = "s3-legacy-storage-key-0001";
    const activeStorageKey = "s3-active-storage-key-0001";
    const context = { ownerId: "owner-s3-rotation", assetId: "asset-s3-rotation" };
    const legacyPlaintext = Buffer.from("legacy S3 bytes");
    objects.set(
      objectKey(prefix, legacyStorageKey),
      encryptLegacyObject(legacyPlaintext, OLD_KEY, legacyStorageKey, context),
    );
    const storage = new S3EncryptedStorage({
      bucket: BUCKET,
      region: "us-east-1",
      endpoint,
      prefix,
      forcePathStyle: true,
      accessKeyId: "local-access-key",
      secretAccessKey: "local-secret-key",
      keyBase64: NEW_KEY,
      activeKeyId: "key-new",
      readKeysBase64: { "key-old": OLD_KEY },
      legacyKeyId: "key-old",
    });

    assert.deepEqual(await storage.get(legacyStorageKey, context), legacyPlaintext);
    const activePlaintext = Buffer.from("new S3 bytes");
    await storage.put(activePlaintext, context, activeStorageKey);
    const payload = objects.get(objectKey(prefix, activeStorageKey));
    assert.ok(payload);
    assert.equal(payload.subarray(0, 5).toString("ascii"), "PDAE2");
    const keyIdLength = payload[5] ?? 0;
    assert.equal(payload.subarray(6, 6 + keyIdLength).toString("ascii"), "key-new");
    assert.deepEqual(await storage.get(activeStorageKey, context), activePlaintext);

    const unknownKeyIdPayload = Buffer.from(payload);
    Buffer.from("missing", "ascii").copy(unknownKeyIdPayload, 6);
    objects.set(objectKey(prefix, activeStorageKey), unknownKeyIdPayload);
    await assert.rejects(storage.get(activeStorageKey, context), StorageEncryptionKeyUnavailableError);

    objects.delete(objectKey(prefix, legacyStorageKey));
    objects.delete(objectKey(prefix, activeStorageKey));
  });
});
