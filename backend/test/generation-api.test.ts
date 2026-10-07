import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";
import sharp from "sharp";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { MemoryStore } from "../src/repositories/memory-store.js";

const ENCRYPTION_KEY = "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=";
const WORKER_KEY = "pindou-test-worker-key-at-least-32-chars";

function multipartAiSource(bytes: Buffer): { payload: Buffer; contentType: string } {
  const boundary = `pindou-generation-cancel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nai-source\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="consentVersion"\r\n\r\nprivacy-v1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="portrait.png"\r\nContent-Type: image/png\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe("generation cancellation API", () => {
  let app: FastifyInstance;
  let assetRoot: string;

  beforeEach(async () => {
    assetRoot = await mkdtemp(join(tmpdir(), "pindou-generation-cancel-"));
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
      assetStorageRoot: assetRoot,
      assetEncryptionKeyBase64: ENCRYPTION_KEY,
      assetMaxBytes: 1024 * 1024,
      assetDefaultTtlHours: 23,
      assetConsentVersion: "privacy-v1",
      assetPurgeBatchSize: 500,
      assetPurgeMaxBatches: 100,
      internalWorkerKey: WORKER_KEY,
    };
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(assetRoot, { recursive: true, force: true });
  });

  async function login(displayName: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().token as string;
  }

  async function getBalance(token: string): Promise<number> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credits",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().account.balance as number;
  }

  async function getLedger(token: string): Promise<Array<{ reason: string; referenceId: string | null }>> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credits/ledger",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().entries as Array<{ reason: string; referenceId: string | null }>;
  }

  it("refunds a canceled queued job once, hides it from other users, and leaves no worker work", async () => {
    const ownerToken = await login("生成任务所有者");
    const strangerToken = await login("其他用户");
    const ownerAuth = { authorization: `Bearer ${ownerToken}` };
    const strangerAuth = { authorization: `Bearer ${strangerToken}` };

    const image = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 80, g: 150, b: 220, alpha: 1 } },
    }).png().toBuffer();
    const uploadBody = multipartAiSource(image);
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        ...ownerAuth,
        "content-type": uploadBody.contentType,
        "idempotency-key": "generation-source-upload-0001",
      },
      payload: uploadBody.payload,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    assert.equal(uploaded.json().asset.purpose, "ai-source");
    const sourceAssetId = uploaded.json().asset.id as string;

    assert.equal(await getBalance(ownerToken), 20);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: { ...ownerAuth, "idempotency-key": "generation-cancel-create-0001" },
      payload: {
        kind: "portrait",
        paletteId: "mard-48-v1",
        sourceAssetId,
        width: 8,
        height: 8,
        seed: "generation-cancel-seed",
      },
    });
    assert.equal(created.statusCode, 202, created.body);
    assert.equal(created.json().job.status, "queued");
    assert.equal(created.json().job.cost, 1);
    const jobId = created.json().job.id as string;
    assert.equal(await getBalance(ownerToken), 19);

    const activeList = await app.inject({
      method: "GET",
      url: "/api/v1/generation-jobs?status=active&limit=10",
      headers: ownerAuth,
    });
    assert.equal(activeList.statusCode, 200, activeList.body);
    assert.deepEqual(activeList.json().jobs.map((job: { id: string }) => job.id), [jobId]);
    assert.deepEqual(activeList.json().pagination, { limit: 10, offset: 0, hasMore: false, nextOffset: null });
    const nextPage = await app.inject({
      method: "GET",
      url: "/api/v1/generation-jobs?status=active&limit=1&offset=1",
      headers: ownerAuth,
    });
    assert.equal(nextPage.statusCode, 200, nextPage.body);
    assert.deepEqual(nextPage.json().jobs, []);
    assert.deepEqual(nextPage.json().pagination, { limit: 1, offset: 1, hasMore: false, nextOffset: null });
    const strangerList = await app.inject({
      method: "GET",
      url: "/api/v1/generation-jobs?status=active",
      headers: strangerAuth,
    });
    assert.equal(strangerList.statusCode, 200, strangerList.body);
    assert.deepEqual(strangerList.json().jobs, []);
    const invalidList = await app.inject({
      method: "GET",
      url: "/api/v1/generation-jobs?status=unknown&extra=1",
      headers: ownerAuth,
    });
    assert.equal(invalidList.statusCode, 400, invalidList.body);
    const invalidOffset = await app.inject({
      method: "GET",
      url: "/api/v1/generation-jobs?offset=-1",
      headers: ownerAuth,
    });
    assert.equal(invalidOffset.statusCode, 400, invalidOffset.body);

    const reservedLedger = await getLedger(ownerToken);
    assert.equal(
      reservedLedger.filter((entry) => entry.reason === "generation_reserved" && entry.referenceId === jobId).length,
      1,
    );

    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/generation-jobs/${jobId}`,
      headers: strangerAuth,
    });
    assert.equal(hidden.statusCode, 404, hidden.body);
    assert.equal(hidden.json().error.code, "GENERATION_JOB_NOT_FOUND");

    const forbiddenCancel = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${jobId}/cancel`,
      headers: { ...strangerAuth, "idempotency-key": "generation-cancel-cross-user" },
    });
    assert.equal(forbiddenCancel.statusCode, 404, forbiddenCancel.body);
    assert.equal(forbiddenCancel.json().error.code, "GENERATION_JOB_NOT_FOUND");
    assert.equal(await getBalance(ownerToken), 19);

    const cancelHeaders = { ...ownerAuth, "idempotency-key": "generation-cancel-owner-0001" };
    const canceled = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${jobId}/cancel`,
      headers: cancelHeaders,
    });
    assert.equal(canceled.statusCode, 200, canceled.body);
    assert.equal(canceled.json().job.status, "canceled");
    assert.ok(canceled.json().job.canceledAt);
    assert.equal(canceled.headers["idempotency-replayed"], undefined);
    assert.equal(await getBalance(ownerToken), 20);

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${jobId}/cancel`,
      headers: cancelHeaders,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.equal(replay.json().job.id, jobId);
    assert.equal(replay.json().job.canceledAt, canceled.json().job.canceledAt);
    assert.equal(await getBalance(ownerToken), 20);

    const activeAfterCancel = await app.inject({
      method: "GET",
      url: "/api/v1/generation-jobs?status=active",
      headers: ownerAuth,
    });
    assert.equal(activeAfterCancel.statusCode, 200, activeAfterCancel.body);
    assert.deepEqual(activeAfterCancel.json().jobs, []);
    const canceledList = await app.inject({
      method: "GET",
      url: "/api/v1/generation-jobs?status=canceled",
      headers: ownerAuth,
    });
    assert.equal(canceledList.statusCode, 200, canceledList.body);
    assert.deepEqual(canceledList.json().jobs.map((job: { id: string }) => job.id), [jobId]);

    const releasedLedger = await getLedger(ownerToken);
    assert.equal(
      releasedLedger.filter((entry) => entry.reason === "generation_released" && entry.referenceId === jobId).length,
      1,
    );

    const worker = await app.inject({
      method: "POST",
      url: "/api/v1/internal/generation-jobs/process-next",
      headers: { "x-internal-worker-key": WORKER_KEY },
    });
    assert.equal(worker.statusCode, 204, worker.body);
    assert.equal(worker.body, "");
  });
});
