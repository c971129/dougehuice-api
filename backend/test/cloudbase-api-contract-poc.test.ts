import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import type { PaymentProvider } from "../src/payments/provider.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { VolatileMemoryStorage } from "../src/storage/volatile-memory-storage.js";

const workerKey = "cloudbase-http-poc-worker-key-at-least-32-chars";
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
  assetStorageRoot: join(tmpdir(), "pindou-cloudbase-http-contract-unused"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: workerKey,
};

function multipartImage(bytes: Buffer): { body: Buffer; contentType: string } {
  const boundary = `pindou-poc-${randomUUID()}`;
  return {
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nai-source\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="consentVersion"\r\n\r\nprivacy-v1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.png"\r\nContent-Type: image/png\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

test("Fastify business HTTP contracts survive a real loopback TCP request", async (t) => {
  const observedRawBodies: string[] = [];
  const paymentProvider: PaymentProvider = {
    kind: "wechat-v3",
    async createOrder() {
      throw new Error("order creation is outside this callback transport probe");
    },
    async queryOrder() {
      return { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null };
    },
    async parseNotification(input) {
      observedRawBodies.push(input.rawBody);
      throw new AppError(401, "POC_SIGNATURE_REJECTED", "poc verifier stopped after recording raw body");
    },
  };

  const app = await buildApp({
    config,
    store: new MemoryStore(),
    storage: new VolatileMemoryStorage(),
    paymentProvider,
    logger: false,
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => app.close());

  const originUrl = new URL(origin);
  interface POCResponse {
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    json<T>(): Promise<T>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }
  const request = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; sendPartialBody?: boolean } = {},
  ): Promise<POCResponse> => new Promise((resolve, reject) => {
    const payload = init.body === undefined ? undefined : Buffer.from(init.body);
    let responseStarted = false;
    let requestError: Error | undefined;
    const failureTimer = setTimeout(() => {
      if (!responseStarted) reject(new Error(`loopback request failed: ${path}`, { cause: requestError }));
    }, 2_000);
    const client = httpRequest({
      hostname: "127.0.0.1",
      port: Number(originUrl.port),
      path,
      method: init.method ?? "GET",
      headers: {
        connection: "close",
        ...(init.headers ?? {}),
        ...(payload ? { "content-length": String(payload.length) } : {}),
      },
    }, (incoming) => {
      responseStarted = true;
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      incoming.once("error", reject);
      incoming.once("end", () => {
        clearTimeout(failureTimer);
        const body = Buffer.concat(chunks);
        const responseHeaders: IncomingHttpHeaders = incoming.headers;
        resolve({
          status: incoming.statusCode ?? 0,
          headers: { get: (name) => {
            const value = responseHeaders[name.toLowerCase()];
            return Array.isArray(value) ? value.join(", ") : value ?? null;
          } },
          async text() { return body.toString("utf8"); },
          async json<T>() { return JSON.parse(body.toString("utf8")) as T; },
          async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer; },
        });
        if (init.sendPartialBody) client.destroy();
      });
    });
    client.once("error", (error) => {
      requestError = error;
    });
    if (init.sendPartialBody && payload) {
      client.flushHeaders();
      client.write(payload.subarray(0, 64));
    } else {
      client.end(payload);
    }
  });
  const json = async <T>(response: POCResponse): Promise<T> => response.json<T>();

  const anonymousProfile = await request("/api/v1/me");
  assert.equal(anonymousProfile.status, 401);
  assert.equal((await json<{ error: { code: string } }>(anonymousProfile)).error.code, "AUTH_REQUIRED");

  const login = await request("/api/v1/auth/dev-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "CloudBase HTTP POC" }),
  });
  assert.equal(login.status, 201);
  const token = (await json<{ token: string }>(login)).token;
  const authHeaders = { authorization: `Bearer ${token}` };

  const oversizedOrdinaryJson = await request("/api/v1/auth/dev-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "x".repeat(3 * 1024 * 1024) }),
    sendPartialBody: true,
  });
  assert.equal(oversizedOrdinaryJson.status, 413);
  assert.equal((await json<{ error: { code: string } }>(oversizedOrdinaryJson)).error.code, "PAYLOAD_TOO_LARGE");

  const largeGridPayload = JSON.stringify({
    name: "POC large grid route",
    paletteId: "mard-48-v1",
    grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
    extraPadding: "x".repeat(3 * 1024 * 1024),
  });
  const unauthenticatedLargeGrid = await request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: largeGridPayload,
    sendPartialBody: true,
  });
  assert.equal(unauthenticatedLargeGrid.status, 401);
  assert.equal((await json<{ error: { code: string } }>(unauthenticatedLargeGrid)).error.code, "AUTH_REQUIRED");

  const authenticatedLargeGrid = await request("/api/v1/projects", {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json", "idempotency-key": randomUUID() },
    body: largeGridPayload,
  });
  assert.equal(authenticatedLargeGrid.status, 400);
  assert.equal((await json<{ error: { code: string } }>(authenticatedLargeGrid)).error.code, "VALIDATION_ERROR");

  const overLimitGrid = await request("/api/v1/projects", {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: Buffer.alloc(17 * 1024 * 1024, 0x20),
    sendPartialBody: true,
  });
  assert.equal(overLimitGrid.status, 413);
  assert.equal((await json<{ error: { code: string } }>(overLimitGrid)).error.code, "PAYLOAD_TOO_LARGE");

  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#3567aaff" } }).png().toBuffer();
  const malformedMultipart = await request("/api/v1/assets", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=poc-boundary" },
    body: "this body is deliberately not valid multipart",
  });
  assert.equal(malformedMultipart.status, 401);
  assert.equal((await json<{ error: { code: string } }>(malformedMultipart)).error.code, "AUTH_REQUIRED");

  const uploadBody = multipartImage(png);
  const upload = await request("/api/v1/assets", {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": uploadBody.contentType,
      "idempotency-key": `poc-asset-${randomUUID()}`,
    },
    body: new Uint8Array(uploadBody.body),
  });
  assert.equal(upload.status, 201, await upload.text());
  assert.equal((await json<{ asset: { mimeType: string } }>(upload)).asset.mimeType, "image/png");

  const project = await request("/api/v1/projects", {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json", "idempotency-key": `poc-project-${randomUUID()}` },
    body: JSON.stringify({
      name: "Fastify binary POC",
      paletteId: "mard-48-v1",
      grid: { encoding: "palette-code-v1", width: 3, height: 2, cells: ["H2", "A11", null, "E2", "F13", "H2"] },
    }),
  });
  assert.equal(project.status, 201, await project.text());
  const projectId = (await json<{ project: { id: string } }>(project)).project.id;

  const createdExport = await request("/api/v1/exports", {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json", "idempotency-key": `poc-export-${randomUUID()}` },
    body: JSON.stringify({ projectId, projectRevision: 1, format: "png", fileName: "poc-export" }),
  });
  assert.equal(createdExport.status, 202, await createdExport.text());
  const exportId = (await json<{ export: { id: string } }>(createdExport)).export.id;

  const processedExport = await request("/api/v1/internal/export-jobs/process-next", {
    method: "POST",
    headers: { "x-internal-worker-key": workerKey },
  });
  assert.equal(processedExport.status, 200, await processedExport.text());

  const exportDetails = await request(`/api/v1/exports/${exportId}`, { headers: authHeaders });
  assert.equal(exportDetails.status, 200);
  const artifactSha256 = (await json<{ export: { artifact: { sha256: string } } }>(exportDetails)).export.artifact.sha256;
  const download = await request(`/api/v1/exports/${exportId}/content`, { headers: authHeaders });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "image/png");
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(download.headers.get("cache-control"), "private, no-store");
  const downloadBytes = Buffer.from(await download.arrayBuffer());
  assert.deepEqual(downloadBytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.equal(Number(download.headers.get("content-length")), downloadBytes.length);
  assert.equal(createHash("sha256").update(downloadBytes).digest("hex"), artifactSha256);

  const exactRawBody = '{ "id" : "notification-poc", "data" : "unchanged" }  \n';
  const notification = await request("/api/v1/wechat-pay/notifications", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "wechatpay-serial": "poc-serial",
      "wechatpay-signature": "poc-signature",
      "wechatpay-timestamp": "1760000000",
      "wechatpay-nonce": "poc-nonce",
    },
    body: exactRawBody,
  });
  assert.equal(notification.status, 401);
  assert.deepEqual(observedRawBodies, [exactRawBody]);
});
