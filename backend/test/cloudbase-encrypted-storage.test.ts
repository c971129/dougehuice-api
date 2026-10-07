import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { CloudbaseEncryptedStorage } from "../src/storage/cloudbase-storage.js";
import { createConfiguredStorageProvider } from "../src/storage/configured-storage.js";
import {
  StorageDependencyUnavailableError,
  StorageObjectCorruptedError,
} from "../src/storage/storage-provider.js";

const encryptionKey = "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=";
const storageKey = "cloudbase_storage_key_1234";
const context = { ownerId: "owner-1", assetId: "asset-1" };
const objectName = (key: string): string => {
  const digest = createHash("sha256").update(key).digest("hex");
  return `${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}.pdae`;
};
const token = "test-only-placeholder-key";

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function storageWith(fetchImpl: typeof fetch): CloudbaseEncryptedStorage {
  return new CloudbaseEncryptedStorage({
    envId: "pindou-test-env",
    bucketId: "private bucket",
    serviceRoleApiKey: token,
    keyBase64: encryptionKey,
    fetch: fetchImpl,
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof Request) return input.url;
  return input.toString();
}

const cloudbaseStorageConfig = {
  NODE_ENV: "development",
  ASSET_STORAGE_PROVIDER: "cloudbase-pg",
  ASSET_CLOUDBASE_ENV_ID: "pindou-test-env",
  ASSET_CLOUDBASE_BUCKET_ID: "pindou-test-bucket",
  ASSET_CLOUDBASE_SERVICE_ROLE_API_KEY: "test-only-placeholder-key",
};

test("CloudBase PG storage requires all server-side configuration and keeps its token out of errors", () => {
  for (const key of [
    "ASSET_CLOUDBASE_ENV_ID",
    "ASSET_CLOUDBASE_BUCKET_ID",
    "ASSET_CLOUDBASE_SERVICE_ROLE_API_KEY",
  ] as const) {
    const environment = { ...cloudbaseStorageConfig, [key]: undefined };
    assert.throws(
      () => loadConfig(environment),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ASSET_CLOUDBASE_/);
        assert.equal(error.message.includes(cloudbaseStorageConfig.ASSET_CLOUDBASE_SERVICE_ROLE_API_KEY), false);
        return true;
      },
    );
  }

  const config = loadConfig(cloudbaseStorageConfig);
  assert.equal(config.assetStorageProvider, "cloudbase-pg");
  assert.equal(config.assetCloudbaseEnvId, "pindou-test-env");
  assert.equal(config.assetCloudbaseBucketId, "pindou-test-bucket");
  assert.equal(config.assetCloudbaseServiceRoleApiKey, "test-only-placeholder-key");
  assert.ok(createConfiguredStorageProvider(config) instanceof CloudbaseEncryptedStorage);
});

test("CloudBase PG storage rejects unsafe env IDs and credentials mixed with another provider", () => {
  assert.throws(
    () => loadConfig({ ...cloudbaseStorageConfig, ASSET_CLOUDBASE_ENV_ID: "env.example.test/path" }),
    /ASSET_CLOUDBASE_ENV_ID/,
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "development",
      ASSET_CLOUDBASE_SERVICE_ROLE_API_KEY: cloudbaseStorageConfig.ASSET_CLOUDBASE_SERVICE_ROLE_API_KEY,
    }),
    /ASSET_STORAGE_PROVIDER=local/,
  );
  assert.throws(
    () => loadConfig({
      ...cloudbaseStorageConfig,
      ASSET_STORAGE_PROVIDER: "s3",
      ASSET_S3_BUCKET: "pindou-assets-test",
      ASSET_S3_REGION: "ap-singapore",
    }),
    /ASSET_STORAGE_PROVIDER=s3/,
  );
});

test("CloudBase PG storage uses Singapore create-only uploads and preserves an existing stable key", async () => {
  const requests: Array<{ url: string; init?: RequestInit | undefined; body?: Buffer }> = [];
  let storedBody: Buffer | undefined;
  const storage = storageWith(async (input, init) => {
    const body = Buffer.from(init?.body as Buffer);
    requests.push({ url: requestUrl(input), init, body });
    if (requests.length === 1) {
      storedBody = body;
      return new Response(null, { status: 200 });
    }
    return jsonResponse(418, { code: "OBJECT_ALREADY_EXIST" });
  });

  const result = await storage.put(Buffer.from("first private bytes"), context, storageKey);
  assert.deepEqual(result, { storageKey });
  const originalStoredBody = Buffer.from(storedBody as Buffer);
  await assert.rejects(
    storage.put(Buffer.from("replacement private bytes"), context, storageKey),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EEXIST",
  );
  assert.equal(requests.length, 2);
  assert.equal(storedBody?.equals(originalStoredBody), true);
  for (const request of requests) {
    assert.equal(
      request.url,
      `https://pindou-test-env.api.intl.tcloudbasegateway.com/v1/storages/object/private%20bucket/${objectName(storageKey)}`,
    );
    assert.equal(request.init?.method, "POST");
    const headers = new Headers(request.init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("content-type"), "application/octet-stream");
    assert.equal(headers.has("x-upsert"), false);
    assert.notEqual(String(request.init?.method), "PUT");
    assert.equal(request.body?.includes(Buffer.from("private bytes")), false);
  }
  assert.notDeepEqual(requests[1]?.body, originalStoredBody, "a retry produces a new ciphertext but must not replace the stored bytes");
});

test("CloudBase PG storage decrypts private authenticated downloads and validates owner-bound AAD", async () => {
  let method = "";
  let requestedUrl = "";
  let encryptedBody: Buffer | undefined;
  const writer = storageWith(async (_input, init) => {
    encryptedBody = Buffer.from(init?.body as Buffer);
    return new Response(null, { status: 200 });
  });
  const upload = await writer.put(Buffer.from("encrypted payload"), context, storageKey);
  const captured: RequestInit[] = [];
  const storage = storageWith(async (input, init) => {
    requestedUrl = requestUrl(input);
    method = init?.method ?? "";
    captured.push(init ?? {});
    return new Response(encryptedBody, { status: 200 });
  });

  assert.deepEqual(await storage.get(storageKey, context), Buffer.from("encrypted payload"));
  assert.equal(method, "GET");
  assert.equal(
    requestedUrl,
    `https://pindou-test-env.api.intl.tcloudbasegateway.com/v1/storages/object/authenticated/private%20bucket/${objectName(storageKey)}`,
  );
  assert.equal(new Headers(captured[0]?.headers).get("authorization"), `Bearer ${token}`);
  await assert.rejects(storage.get(storageKey, { ...context, ownerId: "different-owner" }), StorageObjectCorruptedError);
});

test("CloudBase PG storage maps documented missing/conflict codes independent of HTTP status", async () => {
  const existing = storageWith(async () => jsonResponse(500, { code: "OBJECT_ALREADY_EXIST" }));
  await assert.rejects(
    existing.put(Buffer.from("one"), context, storageKey),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EEXIST",
  );

  let calls = 0;
  const missing = storageWith(async () => {
    calls += 1;
    return jsonResponse(418, { code: "OBJECT_NOT_EXIST" });
  });
  assert.equal(await missing.get(storageKey, context), null);
  await missing.delete(storageKey);
  assert.equal(calls, 2);
});

test("CloudBase PG storage makes an authenticated DELETE with the encoded Singapore object path", async () => {
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;
  const storage = storageWith(async (input, init) => {
    requestedUrl = requestUrl(input);
    requestInit = init;
    return jsonResponse(500, { code: "OBJECT_NOT_EXIST" });
  });

  await storage.delete(storageKey);
  assert.equal(requestInit?.method, "DELETE");
  assert.equal(
    requestedUrl,
    `https://pindou-test-env.api.intl.tcloudbasegateway.com/v1/storages/object/private%20bucket/${objectName(storageKey)}`,
  );
  assert.equal(new Headers(requestInit?.headers).get("authorization"), `Bearer ${token}`);
});

test("CloudBase PG storage keeps API secrets out of dependency errors", async () => {

  const denied = storageWith(async () => jsonResponse(401, { code: "ACTION_FORBIDDEN", message: token }));
  await assert.rejects(
    denied.get(storageKey, context),
    (error: unknown) => {
      assert.ok(error instanceof StorageDependencyUnavailableError);
      assert.equal(error.message.includes(token), false);
      assert.equal(String(error.cause).includes(token), false);
      return true;
    },
  );
});

test("CloudBase PG storage does not hide corrupt ciphertext or ignore aborts", async () => {
  const corrupt = storageWith(async () => new Response(Buffer.from("plain data"), { status: 200 }));
  await assert.rejects(corrupt.get(storageKey, context), StorageObjectCorruptedError);

  const controller = new AbortController();
  controller.abort();
  const storage = storageWith(async (_input, init) => {
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException("The operation was aborted", "AbortError");
  });
  await assert.rejects(storage.get(storageKey, context, controller.signal), { name: "AbortError" });
});
