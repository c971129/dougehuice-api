import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";
import sharp from "sharp";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { processNextExport } from "../src/exports/worker.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import {
  StorageEncryptionKeyUnavailableError,
  StorageObjectCorruptedError,
  type StorageObjectContext,
  type StorageProvider,
} from "../src/storage/storage-provider.js";

const WORKER_KEY = "pindou-test-worker-key-at-least-32-chars";
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
  assetStorageRoot: join(tmpdir(), "pindou-export-test-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: WORKER_KEY,
};

class MemoryStorage implements StorageProvider {
  readonly objects = new Map<string, { contents: Buffer; context: StorageObjectContext }>();
  readonly putAttempts: Buffer[] = [];
  afterPut: (() => Promise<void>) | undefined;
  getError: Error | undefined;

  async ready(): Promise<void> {}

  async put(contents: Buffer, context: StorageObjectContext, requestedKey?: string): Promise<{ storageKey: string }> {
    this.putAttempts.push(Buffer.from(contents));
    const storageKey = requestedKey ?? randomUUID();
    this.objects.set(storageKey, { contents: Buffer.from(contents), context: { ...context } });
    await this.afterPut?.();
    return { storageKey };
  }

  async get(storageKey: string, context: StorageObjectContext): Promise<Buffer | null> {
    if (this.getError) throw this.getError;
    const object = this.objects.get(storageKey);
    if (!object || object.context.ownerId !== context.ownerId || object.context.assetId !== context.assetId) return null;
    return Buffer.from(object.contents);
  }

  async delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey);
  }
}

describe("asynchronous exports", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let storage: MemoryStorage;

  beforeEach(async () => {
    store = new MemoryStore();
    storage = new MemoryStorage();
    app = await buildApp({ config, store, storage, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
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

  async function createProject(token: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": `project-${randomUUID()}` },
      payload: {
        name: "导出测试图纸",
        paletteId: "mard-48-v1",
        grid: {
          encoding: "palette-code-v1",
          width: 3,
          height: 2,
          cells: ["H2", "A11", null, "E2", "F13", "H2"],
        },
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().project.id as string;
  }

  function assertNoPrivateExportFields(value: unknown): void {
    const serialized = JSON.stringify(value);
    for (const forbidden of ["storageKey", "leaseToken", "leaseExpiresAt", "userId"]) {
      assert.equal(serialized.includes(forbidden), false, `public response leaked ${forbidden}`);
    }
  }

  it("locks a revision, processes exactly one job and serves a private PNG", async () => {
    const owner = await login("导出所有者");
    const stranger = await login("其他用户");
    const projectId = await createProject(owner);
    const payload = {
      projectId,
      projectRevision: 1,
      format: "png",
      fileName: "我的/图纸",
      options: { showCodes: true, showGrid: true },
    };
    const headers = { authorization: `Bearer ${owner}`, "idempotency-key": "export-create-0001" };
    const [created, replayed] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/exports", headers, payload }),
      app.inject({ method: "POST", url: "/api/v1/exports", headers, payload }),
    ]);
    assert.equal(created.statusCode, 202, created.body);
    assert.equal(replayed.statusCode, 202, replayed.body);
    assertNoPrivateExportFields(created.json());
    assertNoPrivateExportFields(replayed.json());
    const exportId = created.json().export.id as string;
    assert.equal(replayed.json().export.id, exportId);
    assert.equal([created, replayed].filter((response) => response.headers["idempotency-replayed"] === "true").length, 1);

    const queuedProfile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(queuedProfile.statusCode, 200, queuedProfile.body);
    assert.deepEqual(queuedProfile.json().stats.exports, { total: 1, succeeded: 0 });
    assert.deepEqual(await store.getExportJobStats(queuedProfile.json().user.id), {
      total: 1,
      succeeded: 0,
    });
    const strangerProfile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${stranger}` },
    });
    assert.equal(strangerProfile.statusCode, 200, strangerProfile.body);
    assert.deepEqual(strangerProfile.json().stats.exports, { total: 0, succeeded: 0 });

    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}`,
      headers: { authorization: `Bearer ${stranger}` },
    });
    assert.equal(hidden.statusCode, 404);

    const earlyDownload = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}/content`,
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(earlyDownload.statusCode, 409);
    assert.equal(earlyDownload.json().error.code, "EXPORT_NOT_READY");
    assert.equal(earlyDownload.headers["retry-after"], "2");
    assert.equal(earlyDownload.headers["cache-control"], "private, no-store");

    const deniedWorker = await app.inject({
      method: "POST",
      url: "/api/v1/internal/export-jobs/process-next",
      headers: { "x-internal-worker-key": "wrong" },
    });
    assert.equal(deniedWorker.statusCode, 401);

    const processed = await app.inject({
      method: "POST",
      url: "/api/v1/internal/export-jobs/process-next",
      headers: { "x-internal-worker-key": WORKER_KEY },
    });
    assert.equal(processed.statusCode, 200, processed.body);
    assert.equal(processed.json().export.status, "succeeded");
    assert.equal(processed.json().export.projectRevision, 1);
    assertNoPrivateExportFields(processed.json());
    assert.equal(storage.objects.size, 1);

    const exportedProject = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(exportedProject.statusCode, 200, exportedProject.body);
    assert.equal(exportedProject.json().project.lifecycleStatus, "exported");

    const completedProfile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(completedProfile.statusCode, 200, completedProfile.body);
    assert.deepEqual(completedProfile.json().stats.exports, { total: 1, succeeded: 1 });

    const status = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}`,
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(status.statusCode, 200, status.body);
    assertNoPrivateExportFields(status.json());

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/exports",
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().exports.map((item: { id: string }) => item.id), [exportId]);
    assert.deepEqual(list.json().pagination, { limit: 30, offset: 0, hasMore: false, nextOffset: null });
    assertNoPrivateExportFields(list.json());
    const nextPage = await app.inject({
      method: "GET",
      url: "/api/v1/exports?limit=1&offset=1",
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(nextPage.statusCode, 200, nextPage.body);
    assert.deepEqual(nextPage.json().exports, []);
    assert.deepEqual(nextPage.json().pagination, { limit: 1, offset: 1, hasMore: false, nextOffset: null });
    const invalidOffset = await app.inject({
      method: "GET",
      url: "/api/v1/exports?offset=-1",
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(invalidOffset.statusCode, 400, invalidOffset.body);

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}/content`,
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(downloaded.statusCode, 200, downloaded.body);
    assert.equal(downloaded.headers["content-type"], "image/png");
    assert.equal(downloaded.headers["cache-control"], "private, no-store");
    assert.equal(downloaded.rawPayload.subarray(1, 4).toString("ascii"), "PNG");

    const storedObject = [...storage.objects.values()][0];
    assert.ok(storedObject);
    storedObject.contents[0] = storedObject.contents[0]! ^ 0xff;
    const corrupted = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}/content`,
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(corrupted.statusCode, 410, corrupted.body);
    assert.equal(corrupted.json().error.code, "EXPORT_ARTIFACT_CORRUPTED");

    storage.getError = new StorageObjectCorruptedError();
    const failedAuthentication = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}/content`,
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(failedAuthentication.statusCode, 410, failedAuthentication.body);
    assert.equal(failedAuthentication.json().error.code, "EXPORT_ARTIFACT_CORRUPTED");
    assert.equal(failedAuthentication.json().error.retryable, false);

    storage.getError = new StorageEncryptionKeyUnavailableError();
    const missingEncryptionKey = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}/content`,
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(missingEncryptionKey.statusCode, 503, missingEncryptionKey.body);
    assert.equal(missingEncryptionKey.json().error.code, "STORAGE_DEPENDENCY_UNAVAILABLE");
    assert.equal(missingEncryptionKey.json().error.retryable, true);
    assert.equal(missingEncryptionKey.headers["retry-after"], "1");
    storage.getError = undefined;

    const cannotCancel = await app.inject({
      method: "POST",
      url: `/api/v1/exports/${exportId}/cancel`,
      headers: { authorization: `Bearer ${owner}`, "idempotency-key": "export-cancel-finished-0001" },
    });
    assert.equal(cannotCancel.statusCode, 409);
    assert.equal(cannotCancel.json().error.code, "EXPORT_ALREADY_FINISHED");
  });

  it("serves malformed Unicode names with a safe RFC 5987 content disposition", async () => {
    const owner = await login("导出文件名测试");
    const projectId = await createProject(owner);
    const auth = { authorization: `Bearer ${owner}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: { ...auth, "idempotency-key": "unicode-export-name-create-0001" },
      payload: {
        projectId,
        projectRevision: 1,
        format: "png",
        fileName: "\ud800'()",
      },
    });
    assert.equal(created.statusCode, 202, created.body);

    const processed = await app.inject({
      method: "POST",
      url: "/api/v1/internal/export-jobs/process-next",
      headers: { "x-internal-worker-key": WORKER_KEY },
    });
    assert.equal(processed.statusCode, 200, processed.body);
    assert.equal(processed.json().export.status, "succeeded");

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${created.json().export.id}/content`,
      headers: auth,
    });
    assert.equal(downloaded.statusCode, 200, downloaded.body);
    assert.equal(
      downloaded.headers["content-disposition"],
      "attachment; filename*=UTF-8''%EF%BF%BD%27%28%29.png",
    );
  });

  it("finishes the queued fixed revision after its project is soft-deleted", async () => {
    const owner = await login("删除后导出用户");
    const projectId = await createProject(owner);
    const auth = { authorization: `Bearer ${owner}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: { ...auth, "idempotency-key": "soft-delete-export-create-0001" },
      payload: {
        projectId,
        projectRevision: 1,
        format: "png",
        fileName: "删除后固定版本",
      },
    });
    assert.equal(created.statusCode, 202, created.body);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/grid`,
      headers: { ...auth, "idempotency-key": "soft-delete-export-update-0001" },
      payload: {
        baseRevision: 1,
        grid: {
          encoding: "palette-code-v1",
          width: 1,
          height: 1,
          cells: ["H2"],
        },
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().project.currentRevision, 2);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...auth, "idempotency-key": "soft-delete-export-delete-0001" },
    });
    assert.equal(removed.statusCode, 204, removed.body);

    const hiddenRevision = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}?revision=1`,
      headers: auth,
    });
    assert.equal(hiddenRevision.statusCode, 404, hiddenRevision.body);
    assert.equal(hiddenRevision.json().error.code, "PROJECT_NOT_FOUND");

    const processed = await app.inject({
      method: "POST",
      url: "/api/v1/internal/export-jobs/process-next",
      headers: { "x-internal-worker-key": WORKER_KEY },
    });
    assert.equal(processed.statusCode, 200, processed.body);
    assert.equal(processed.json().export.status, "succeeded");
    assert.equal(processed.json().export.projectRevision, 1);

    const storedObject = [...storage.objects.values()][0];
    assert.ok(storedObject);
    const metadata = await sharp(storedObject.contents).metadata();
    assert.deepEqual(
      { width: metadata.width, height: metadata.height },
      { width: 534, height: 356 },
      "worker must render the queued 3x2 revision instead of the current 1x1 revision",
    );

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${created.json().export.id}/content`,
      headers: auth,
    });
    assert.equal(downloaded.statusCode, 200, downloaded.body);
  });

  it("cancels a queued PDF and rejects unknown renderer options", async () => {
    const token = await login("取消测试");
    const projectId = await createProject(token);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "invalid-export-0001" },
      payload: { projectId, projectRevision: 1, format: "pdf", options: { templatePath: "../../secret" } },
    });
    assert.equal(invalid.statusCode, 400);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "cancel-export-create-0001" },
      payload: { projectId, projectRevision: 1, format: "pdf", options: { orientation: "portrait" } },
    });
    assert.equal(created.statusCode, 202, created.body);
    const exportId = created.json().export.id as string;
    const canceled = await app.inject({
      method: "POST",
      url: `/api/v1/exports/${exportId}/cancel`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "cancel-export-action-0001" },
    });
    assert.equal(canceled.statusCode, 200, canceled.body);
    assert.equal(canceled.json().export.status, "canceled");
    assertNoPrivateExportFields(canceled.json());

    const profile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(profile.statusCode, 200, profile.body);
    assert.deepEqual(profile.json().stats.exports, { total: 1, succeeded: 0 });

    const canceledDownload = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(canceledDownload.statusCode, 410, canceledDownload.body);
    assert.equal(canceledDownload.json().error.code, "EXPORT_TERMINAL_WITHOUT_ARTIFACT");

    const idleWorker = await app.inject({
      method: "POST",
      url: "/api/v1/internal/export-jobs/process-next",
      headers: { "x-internal-worker-key": WORKER_KEY },
    });
    assert.equal(idleWorker.statusCode, 204);
  });

  it("cleans up a rendered object when cancellation wins the completion race", async () => {
    const token = await login("取消竞态测试");
    const projectId = await createProject(token);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "cancel-race-create-0001" },
      payload: { projectId, projectRevision: 1, format: "png", fileName: "取消竞态" },
    });
    assert.equal(created.statusCode, 202, created.body);
    const exportId = created.json().export.id as string;

    storage.afterPut = async () => {
      storage.afterPut = undefined;
      const canceled = await app.inject({
        method: "POST",
        url: `/api/v1/exports/${exportId}/cancel`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": "cancel-race-action-0001" },
      });
      assert.equal(canceled.statusCode, 200, canceled.body);
      assert.equal(canceled.json().export.status, "canceled");
    };

    const processed = await app.inject({
      method: "POST",
      url: "/api/v1/internal/export-jobs/process-next",
      headers: { "x-internal-worker-key": WORKER_KEY },
    });
    assert.equal(processed.statusCode, 200, processed.body);
    assert.equal(processed.json().export.status, "canceled");
    assertNoPrivateExportFields(processed.json());
    assert.equal(storage.objects.size, 0);
  });

  it("does not let an expired worker overwrite a newer lease", async () => {
    const token = await login("租约竞态测试");
    const projectId = await createProject(token);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "lease-race-create-0001" },
      payload: { projectId, projectRevision: 1, format: "png", fileName: "租约竞态" },
    });
    assert.equal(created.statusCode, 202, created.body);

    const replacementLease = randomUUID();
    storage.afterPut = async () => {
      storage.afterPut = undefined;
      const takeoverAt = new Date(Date.now() + 3 * 60_000);
      const takenOver = await store.claimNextExportJob({
        now: takeoverAt.toISOString(),
        leaseToken: replacementLease,
        leaseMilliseconds: 2 * 60_000,
      });
      assert.ok(takenOver);
      assert.equal(takenOver.attemptCount, 2);
      assert.equal(takenOver.leaseToken, replacementLease);
    };

    const staleWorker = await app.inject({
      method: "POST",
      url: "/api/v1/internal/export-jobs/process-next",
      headers: { "x-internal-worker-key": WORKER_KEY },
    });
    assert.equal(staleWorker.statusCode, 200, staleWorker.body);
    assert.equal(staleWorker.json().export.status, "running");
    assert.equal(staleWorker.json().export.attemptCount, 2);
    assertNoPrivateExportFields(staleWorker.json());
    assert.equal(JSON.stringify(staleWorker.json()).includes(replacementLease), false);
    assert.equal(storage.objects.size, 0);
  });

  it("renders byte-identical PDF content on retry even if the project is renamed", async () => {
    const token = await login("确定性重试测试");
    const projectId = await createProject(token);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "deterministic-export-create-0001" },
      payload: { projectId, projectRevision: 1, format: "pdf", fileName: "稳定导出名称" },
    });
    assert.equal(created.statusCode, 202, created.body);

    storage.afterPut = async () => {
      storage.afterPut = undefined;
      throw new Error("storage acknowledgement lost");
    };
    const firstAttemptAt = new Date();
    const firstAttempt = await processNextExport({ store, storage, now: firstAttemptAt });
    assert.ok(firstAttempt);
    assert.equal(firstAttempt.status, "retry_wait");
    assert.equal(firstAttempt.attemptCount, 1);
    assert.equal(storage.objects.size, 1);
    const orphanedAttemptKey = [...storage.objects.keys()][0];
    assert.ok(orphanedAttemptKey);

    const renamed = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/grid`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "rename-between-export-retries-0001" },
      payload: {
        baseRevision: 1,
        name: "重试期间已改名",
        grid: {
          encoding: "palette-code-v1",
          width: 3,
          height: 2,
          cells: ["H2", "A11", null, "E2", "F13", "H2"],
        },
      },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);

    const secondAttempt = await processNextExport({
      store,
      storage,
      now: new Date(firstAttemptAt.getTime() + 11_000),
    });
    assert.ok(secondAttempt);
    assert.equal(secondAttempt.status, "succeeded");
    assert.equal(secondAttempt.projectRevision, 1);
    assert.equal(storage.putAttempts.length, 2);
    assert.deepEqual(storage.putAttempts[1], storage.putAttempts[0]);
    assert.equal(storage.objects.size, 1);
    assert.equal(storage.objects.has(orphanedAttemptKey), false);
  });

  it("retains a committed artifact when the completion acknowledgement is lost", async () => {
    const token = await login("提交确认丢失测试");
    const projectId = await createProject(token);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "completion-ack-create-0001" },
      payload: { projectId, projectRevision: 1, format: "png", fileName: "确认丢失" },
    });
    assert.equal(created.statusCode, 202, created.body);

    const complete = store.completeExportJob.bind(store);
    store.completeExportJob = async (input) => {
      await complete(input);
      throw new Error("database acknowledgement lost");
    };
    const processed = await processNextExport({ store, storage });
    assert.ok(processed);
    assert.equal(processed.status, "succeeded");
    assert.ok(processed.artifact);
    assert.equal(storage.objects.has(processed.artifact.storageKey), true);
  });
});
