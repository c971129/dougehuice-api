import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  const boundary = `pindou-generation-redraw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nai-source\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="consentVersion"\r\n\r\nprivacy-v1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="couple.png"\r\nContent-Type: image/png\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe("generation redraw API", () => {
  let app: FastifyInstance;
  let assetRoot: string;

  beforeEach(async () => {
    assetRoot = await mkdtemp(join(tmpdir(), "pindou-generation-redraw-"));
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

  async function uploadSource(token: string): Promise<string> {
    const image = await sharp({
      create: { width: 6, height: 4, channels: 4, background: { r: 178, g: 92, b: 116, alpha: 1 } },
    }).png().toBuffer();
    const body = multipartAiSource(image);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": body.contentType,
        "idempotency-key": `redraw-source-${randomUUID()}`,
      },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().asset.id as string;
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

  async function getLedger(token: string): Promise<Array<{
    delta: number;
    reason: string;
    referenceId: string | null;
  }>> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credits/ledger",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().entries as Array<{
      delta: number;
      reason: string;
      referenceId: string | null;
    }>;
  }

  async function processNext(): Promise<Record<string, unknown>> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/generation-jobs/process-next",
      headers: { "x-internal-worker-key": WORKER_KEY },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().job as Record<string, unknown>;
  }

  it("redraws a completed couple job for exactly one credit and replays idempotently", async () => {
    const token = await login("情侣换一批测试用户");
    const authorization = { authorization: `Bearer ${token}` };
    const sourceAssetId = await uploadSource(token);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: { ...authorization, "idempotency-key": "generation-redraw-original-0001" },
      payload: {
        kind: "couple",
        paletteId: "mard-48-v1",
        sourceAssetId,
        width: 24,
        height: 16,
        seed: "generation-redraw-couple-seed",
        options: {
          crop: {
            ratio: "4:3",
            rotation: 90,
            scale: 1.25,
            offsetX: -12,
            offsetY: 8,
            flipX: true,
          },
          removeBackground: false,
          figureStyle: "chibi-half",
          coupleLayout: "split",
          maxColors: 7,
          transparentBackground: true,
          inventoryOnly: false,
          brightness: -35,
          contrast: 45,
          saturation: 55,
          dither: true,
        },
      },
    });
    assert.equal(created.statusCode, 202, created.body);
    const original = created.json().job as Record<string, unknown>;
    assert.equal(original.cost, 2);
    assert.equal(original.parentJobId, null);
    assert.equal(await getBalance(token), 18);

    const completed = await processNext();
    assert.equal(completed.id, original.id);
    assert.equal(completed.status, "completed");
    assert.ok((completed.candidates as unknown[]).length > 0);

    const redrawHeaders = {
      ...authorization,
      "idempotency-key": "generation-redraw-request-0001",
    };
    const redrawn = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${original.id as string}/redraw`,
      headers: redrawHeaders,
    });
    assert.equal(redrawn.statusCode, 202, redrawn.body);
    assert.equal(redrawn.headers["idempotency-replayed"], undefined);
    const redraw = redrawn.json().job as Record<string, unknown>;
    assert.notEqual(redraw.id, original.id);
    assert.deepEqual(
      {
        parentJobId: redraw.parentJobId,
        kind: redraw.kind,
        status: redraw.status,
        paletteId: redraw.paletteId,
        sourceAssetId: redraw.sourceAssetId,
        options: redraw.options,
        cost: redraw.cost,
        width: redraw.width,
        height: redraw.height,
      },
      {
        parentJobId: original.id,
        kind: original.kind,
        status: "queued",
        paletteId: original.paletteId,
        sourceAssetId: original.sourceAssetId,
        options: original.options,
        cost: 1,
        width: original.width,
        height: original.height,
      },
    );
    assert.equal(await getBalance(token), 17);

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${original.id as string}/redraw`,
      headers: redrawHeaders,
    });
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.equal(replay.json().job.id, redraw.id);
    assert.equal(await getBalance(token), 17);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/generation-jobs?limit=10",
      headers: authorization,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(
      listed.json().jobs.filter((job: { id: string }) => job.id === redraw.id).length,
      1,
    );
    const redrawReservations = (await getLedger(token)).filter((entry) =>
      entry.reason === "generation_reserved" && entry.referenceId === redraw.id);
    assert.deepEqual(redrawReservations.map((entry) => entry.delta), [-1]);

    const redrawCompleted = await processNext();
    assert.equal(redrawCompleted.id, redraw.id);
    assert.equal(redrawCompleted.status, "completed");
    assert.equal(await getBalance(token), 17);
  });

  it("hides another user's job and rejects a redraw before the original completes", async () => {
    const ownerToken = await login("换一批所有者");
    const strangerToken = await login("换一批其他用户");
    const sourceAssetId = await uploadSource(ownerToken);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "generation-redraw-pending-original",
      },
      payload: {
        kind: "couple",
        paletteId: "mard-48-v1",
        sourceAssetId,
        width: 16,
        height: 16,
      },
    });
    assert.equal(created.statusCode, 202, created.body);
    const jobId = created.json().job.id as string;

    const hidden = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${jobId}/redraw`,
      headers: {
        authorization: `Bearer ${strangerToken}`,
        "idempotency-key": "generation-redraw-cross-user",
      },
    });
    assert.equal(hidden.statusCode, 404, hidden.body);
    assert.equal(hidden.json().error.code, "GENERATION_JOB_NOT_FOUND");

    const notReady = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${jobId}/redraw`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "generation-redraw-not-ready",
      },
    });
    assert.equal(notReady.statusCode, 409, notReady.body);
    assert.equal(notReady.json().error.code, "GENERATION_REDRAW_NOT_READY");
    assert.equal(notReady.json().error.details.status, "queued");
    assert.equal(await getBalance(ownerToken), 18);
  });

  it("rejects completed normal and pixel jobs as unsupported", async () => {
    const token = await login("非 AI 换一批测试用户");
    const authorization = { authorization: `Bearer ${token}` };

    for (const kind of ["normal", "pixel"] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/generation-jobs",
        headers: {
          ...authorization,
          "idempotency-key": `generation-redraw-${kind}-original`,
        },
        payload: {
          kind,
          paletteId: "mard-48-v1",
          width: 8,
          height: 8,
          seed: `generation-redraw-${kind}-seed`,
        },
      });
      assert.equal(created.statusCode, 202, created.body);
      const jobId = created.json().job.id as string;
      const completed = await processNext();
      assert.equal(completed.id, jobId);
      assert.equal(completed.status, "completed");

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/generation-jobs/${jobId}/redraw`,
        headers: {
          ...authorization,
          "idempotency-key": `generation-redraw-${kind}-unsupported`,
        },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, "GENERATION_REDRAW_UNSUPPORTED");
    }
    assert.equal(await getBalance(token), 20);
  });
});
