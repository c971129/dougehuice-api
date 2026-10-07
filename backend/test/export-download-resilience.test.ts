import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import type { StorageObjectContext, StorageProvider } from "../src/storage/storage-provider.js";

const BASE_CONFIG: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused",
  databaseSsl: false,
  devAuthEnabled: true,
  corsOrigins: ["http://localhost:5173"],
  sessionTtlDays: 30,
  devStartingCredits: 20,
  assetStorageRoot: join(tmpdir(), "pindou-export-download-resilience"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

interface StoredObject {
  contents: Buffer;
  context: StorageObjectContext;
}

interface PendingRead {
  release(): void;
}

class BlockingStorage implements StorageProvider {
  private readonly objects = new Map<string, StoredObject>();
  private readonly pendingReads = new Set<PendingRead>();
  private readonly stateWaiters = new Set<() => void>();
  private passThrough = false;

  readCount = 0;
  abortCount = 0;
  readonly observedSignals: AbortSignal[] = [];

  async ready(): Promise<void> {}

  async put(
    contents: Buffer,
    context: StorageObjectContext,
    requestedKey = randomUUID(),
    signal?: AbortSignal,
  ): Promise<{ storageKey: string }> {
    signal?.throwIfAborted();
    this.objects.set(requestedKey, { contents: Buffer.from(contents), context: { ...context } });
    return { storageKey: requestedKey };
  }

  async get(
    storageKey: string,
    context: StorageObjectContext,
    signal?: AbortSignal,
  ): Promise<Buffer | null> {
    this.readCount += 1;
    if (signal) this.observedSignals.push(signal);
    this.notifyStateChange();

    const object = this.objects.get(storageKey);
    if (!object
      || object.context.ownerId !== context.ownerId
      || object.context.assetId !== context.assetId) return null;
    if (this.passThrough) return Buffer.from(object.contents);

    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      let pending: PendingRead;
      const cleanup = (): void => {
        this.pendingReads.delete(pending);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const onAbort = (): void => finish(() => {
        this.abortCount += 1;
        this.notifyStateChange();
        reject(signal?.reason ?? new Error("storage read aborted"));
      });
      pending = {
        release: () => finish(() => resolve(Buffer.from(object.contents))),
      };
      this.pendingReads.add(pending);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey);
  }

  store(storageKey: string, contents: Buffer, context: StorageObjectContext): void {
    this.objects.set(storageKey, { contents: Buffer.from(contents), context: { ...context } });
  }

  allowReads(): void {
    this.passThrough = true;
    for (const pending of [...this.pendingReads]) pending.release();
  }

  waitForReads(expected: number): Promise<void> {
    return this.waitFor(() => this.readCount >= expected, `${expected} storage reads`);
  }

  waitForAborts(expected: number): Promise<void> {
    return this.waitFor(() => this.abortCount >= expected, `${expected} aborted storage reads`);
  }

  private notifyStateChange(): void {
    for (const waiter of [...this.stateWaiters]) waiter();
  }

  private waitFor(predicate: () => boolean, description: string, timeoutMilliseconds = 2_000): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onStateChange = (): void => {
        if (!predicate()) return;
        clearTimeout(timer);
        this.stateWaiters.delete(onStateChange);
        resolve();
      };
      const timer = setTimeout(() => {
        this.stateWaiters.delete(onStateChange);
        reject(new Error(`timed out waiting for ${description}`));
      }, timeoutMilliseconds);
      this.stateWaiters.add(onStateChange);
    });
  }
}

interface Fixture {
  app: FastifyInstance;
  store: MemoryStore;
  storage: BlockingStorage;
}

interface TestUser {
  token: string;
  userId: string;
}

function testConfig(input: {
  globalLimit: number;
  perUserLimit: number;
  readTimeoutMilliseconds?: number;
  writeTimeoutMilliseconds?: number;
}): AppConfig {
  return {
    ...BASE_CONFIG,
    exportDownloadGlobalConcurrency: input.globalLimit,
    exportDownloadPerUserConcurrency: input.perUserLimit,
    exportDownloadReadTimeoutMilliseconds: input.readTimeoutMilliseconds ?? 5_000,
    exportDownloadWriteTimeoutMilliseconds: input.writeTimeoutMilliseconds ?? 5_000,
  };
}

async function createFixture(input: Parameters<typeof testConfig>[0]): Promise<Fixture> {
  const store = new MemoryStore();
  const storage = new BlockingStorage();
  const app = await buildApp({ config: testConfig(input), store, storage, logger: false });
  await app.ready();
  return { app, store, storage };
}

async function login(app: FastifyInstance, displayName: string): Promise<TestUser> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/dev-session",
    payload: { displayName },
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

async function seedSucceededExport(
  fixture: Fixture,
  user: TestUser,
  suppliedContents?: Buffer,
): Promise<string> {
  const project = await fixture.store.createProject(user.userId, {
    name: `download-resilience-${randomUUID()}`,
    paletteId: "mard-48-v1",
    grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
  });
  const now = new Date().toISOString();
  const jobId = randomUUID();
  await fixture.store.createExportJob({
    id: jobId,
    userId: user.userId,
    projectId: project.id,
    projectRevision: project.currentRevision,
    format: "png",
    fileName: "resilience-download",
    options: {
      paper: "A4",
      orientation: "auto",
      showCodes: true,
      showGrid: true,
      transparentBackground: false,
    },
    now,
  });
  const leaseToken = randomUUID();
  const claimed = await fixture.store.claimNextExportJob({
    now,
    leaseToken,
    leaseMilliseconds: 60_000,
  });
  assert.equal(claimed?.id, jobId);

  const contents = suppliedContents ?? Buffer.from(`private-export-${jobId}`);
  const artifactId = randomUUID();
  const storageKey = `exports/${user.userId}/${jobId}`;
  const artifact = {
    id: artifactId,
    jobId,
    storageKey,
    mimeType: "image/png" as const,
    fileName: "resilience-download.png",
    sizeBytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
  };
  await fixture.store.prepareExportArtifact({ jobId, leaseToken, artifact, now });
  fixture.storage.store(storageKey, contents, { ownerId: user.userId, assetId: artifactId });
  await fixture.store.completeExportJob({ jobId, leaseToken, artifact, now });
  return jobId;
}

function download(app: FastifyInstance, user: TestUser, exportId: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/exports/${exportId}/content`,
    headers: { authorization: `Bearer ${user.token}` },
  });
}

function httpGet(url: URL, token: string): Promise<{
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("export download resilience", () => {
  it("returns 429 with Retry-After at the per-user limit and admits the user after release", async () => {
    const fixture = await createFixture({ globalLimit: 2, perUserLimit: 1 });
    try {
      const user = await login(fixture.app, "per-user-download-limit");
      const exportId = await seedSucceededExport(fixture, user);

      const occupyingDownload = download(fixture.app, user, exportId);
      await fixture.storage.waitForReads(1);

      const rejected = await download(fixture.app, user, exportId);
      assert.equal(rejected.statusCode, 429, rejected.body);
      assert.equal(rejected.json().error.code, "EXPORT_DOWNLOAD_BUSY");
      assert.equal(rejected.headers["retry-after"], "1");
      assert.equal(fixture.storage.readCount, 1, "a rejected request must not reach storage");

      fixture.storage.allowReads();
      const completed = await occupyingDownload;
      assert.equal(completed.statusCode, 200, completed.body);

      const admittedAfterRelease = await download(fixture.app, user, exportId);
      assert.equal(admittedAfterRelease.statusCode, 200, admittedAfterRelease.body);
      assert.equal(fixture.storage.readCount, 2);
    } finally {
      fixture.storage.allowReads();
      await fixture.app.close();
    }
  });

  it("applies the global limit across different users and admits another user after releases", async () => {
    const fixture = await createFixture({ globalLimit: 2, perUserLimit: 1 });
    try {
      const firstUser = await login(fixture.app, "global-download-first");
      const secondUser = await login(fixture.app, "global-download-second");
      const thirdUser = await login(fixture.app, "global-download-third");
      const firstExportId = await seedSucceededExport(fixture, firstUser);
      const secondExportId = await seedSucceededExport(fixture, secondUser);
      const thirdExportId = await seedSucceededExport(fixture, thirdUser);

      const firstDownload = download(fixture.app, firstUser, firstExportId);
      await fixture.storage.waitForReads(1);
      const secondDownload = download(fixture.app, secondUser, secondExportId);
      await fixture.storage.waitForReads(2);

      const rejected = await download(fixture.app, thirdUser, thirdExportId);
      assert.equal(rejected.statusCode, 429, rejected.body);
      assert.equal(rejected.json().error.code, "EXPORT_DOWNLOAD_BUSY");
      assert.equal(rejected.headers["retry-after"], "1");
      assert.equal(fixture.storage.readCount, 2, "the global limiter must reject before storage");

      fixture.storage.allowReads();
      const [firstCompleted, secondCompleted] = await Promise.all([firstDownload, secondDownload]);
      assert.equal(firstCompleted.statusCode, 200, firstCompleted.body);
      assert.equal(secondCompleted.statusCode, 200, secondCompleted.body);

      const admittedAfterRelease = await download(fixture.app, thirdUser, thirdExportId);
      assert.equal(admittedAfterRelease.statusCode, 200, admittedAfterRelease.body);
      assert.equal(fixture.storage.readCount, 3);
    } finally {
      fixture.storage.allowReads();
      await fixture.app.close();
    }
  });

  it("returns 503 when storage read times out and releases the permit", async () => {
    const fixture = await createFixture({
      globalLimit: 1,
      perUserLimit: 1,
      readTimeoutMilliseconds: 40,
    });
    try {
      const user = await login(fixture.app, "download-timeout");
      const exportId = await seedSucceededExport(fixture, user);

      const timedOut = await download(fixture.app, user, exportId);
      assert.equal(timedOut.statusCode, 503, timedOut.body);
      assert.equal(timedOut.json().error.code, "EXPORT_ARTIFACT_READ_TIMEOUT");
      assert.equal(timedOut.json().error.retryable, true);
      assert.equal(timedOut.headers["retry-after"], "1");
      assert.equal(fixture.storage.abortCount, 1);
      assert.equal(fixture.storage.observedSignals[0]?.aborted, true);

      fixture.storage.allowReads();
      const admittedAfterTimeout = await download(fixture.app, user, exportId);
      assert.equal(admittedAfterTimeout.statusCode, 200, admittedAfterTimeout.body);
      assert.equal(fixture.storage.readCount, 2, "the timed-out request must release its permit");
    } finally {
      fixture.storage.allowReads();
      await fixture.app.close();
    }
  });

  it("aborts storage and releases the permit when a real HTTP client disconnects", async () => {
    const fixture = await createFixture({ globalLimit: 1, perUserLimit: 1 });
    try {
      const user = await login(fixture.app, "download-client-disconnect");
      const exportId = await seedSucceededExport(fixture, user);
      const origin = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
      const downloadUrl = new URL(`/api/v1/exports/${exportId}/content`, origin);

      const disconnected = httpRequest(downloadUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${user.token}` },
      });
      const clientClosed = new Promise<void>((resolve) => {
        disconnected.once("error", () => resolve());
        disconnected.once("close", () => resolve());
      });
      disconnected.end();
      await fixture.storage.waitForReads(1);
      disconnected.destroy();
      await Promise.all([clientClosed, fixture.storage.waitForAborts(1)]);
      assert.equal(fixture.storage.observedSignals[0]?.aborted, true);

      fixture.storage.allowReads();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const admittedAfterDisconnect = await httpGet(downloadUrl, user.token);
      assert.equal(admittedAfterDisconnect.statusCode, 200, admittedAfterDisconnect.body.toString());
      assert.equal(fixture.storage.readCount, 2, "disconnect cleanup must release the only permit");
    } finally {
      fixture.storage.allowReads();
      await fixture.app.close();
    }
  });

  it("destroys a paused real HTTP download after the absolute write timeout and releases the permit", {
    timeout: 10_000,
  }, async () => {
    const fixture = await createFixture({
      globalLimit: 1,
      perUserLimit: 1,
      writeTimeoutMilliseconds: 1_000,
    });
    let pausedSocket: Socket | undefined;
    try {
      const user = await login(fixture.app, "download-paused-writer");
      const largeContents = Buffer.alloc(16 * 1024 * 1024, 0x61);
      const exportId = await seedSucceededExport(fixture, user, largeContents);
      const followUpExportId = await seedSucceededExport(fixture, user);
      fixture.storage.allowReads();
      const origin = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
      const downloadUrl = new URL(`/api/v1/exports/${exportId}/content`, origin);
      const followUpUrl = new URL(`/api/v1/exports/${followUpExportId}/content`, origin);

      let settleClosed = (): void => undefined;
      const clientClosed = new Promise<void>((resolve) => {
        let settled = false;
        settleClosed = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
      });
      const clientConnected = new Promise<void>((resolve, reject) => {
        let connected = false;
        pausedSocket = createConnection({
          host: downloadUrl.hostname,
          port: Number(downloadUrl.port),
        }, () => {
          connected = true;
          pausedSocket?.pause();
          pausedSocket?.write([
            `GET ${downloadUrl.pathname} HTTP/1.1`,
            `Host: ${downloadUrl.host}`,
            `Authorization: Bearer ${user.token}`,
            "Connection: keep-alive",
            "",
            "",
          ].join("\r\n"));
          resolve();
        });
        pausedSocket.once("close", settleClosed);
        pausedSocket.once("error", (error) => {
          settleClosed();
          if (!connected) reject(error);
        });
      });

      await Promise.all([clientConnected, fixture.storage.waitForReads(1)]);
      const rejectedBeforeTimeout = await download(fixture.app, user, followUpExportId);
      assert.equal(rejectedBeforeTimeout.statusCode, 429, rejectedBeforeTimeout.body);
      assert.equal(rejectedBeforeTimeout.json().error.code, "EXPORT_DOWNLOAD_BUSY");
      assert.equal(fixture.storage.readCount, 1, "a slow response must retain its permit until the write timeout");
      // A paused net.Socket does not observe the peer's FIN/RST until reads
      // resume. Wait past the server deadline, then resume only to observe it.
      await delay(1_250);
      assert.ok(pausedSocket);
      pausedSocket.resume();
      await Promise.race([
        clientClosed,
        delay(5_000, undefined, { ref: false })
          .then(() => assert.fail("paused download socket was not destroyed by the write timeout")),
      ]);
      const admittedAfterTimeout = await httpGet(followUpUrl, user.token);
      assert.equal(admittedAfterTimeout.statusCode, 200, admittedAfterTimeout.body.toString());
      assert.equal(fixture.storage.readCount, 2, "write-timeout cleanup must release the only permit exactly once");
    } finally {
      pausedSocket?.destroy();
      fixture.storage.allowReads();
      await fixture.app.close();
    }
  });
});
