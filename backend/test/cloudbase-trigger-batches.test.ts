import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { runBoundedBatch } from "../src/cloudbase/triggers/batch.js";
import { runAssetPurgeTrigger } from "../src/cloudbase/triggers/asset-purge.js";
import { runExportPurgeTrigger } from "../src/cloudbase/triggers/export-purge.js";
import { runExportTrigger } from "../src/cloudbase/triggers/exports.js";
import { runGenerationTrigger } from "../src/cloudbase/triggers/generation.js";
import { runPaymentReconciliationTrigger } from "../src/cloudbase/triggers/payment-reconciliation.js";
import type { PaymentOrderRecord } from "../src/domain/models.js";
import type { GenerationProvider } from "../src/generation/provider.js";
import type { PaymentObservation, PaymentOrderIdentity, PaymentProvider } from "../src/payments/provider.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import type { StorageObjectContext, StorageProvider } from "../src/storage/storage-provider.js";

const NOW = "2026-10-07T10:00:00.000Z";
const LEASE_REPLACEMENT = "90000000-0000-4000-8000-000000000001";

class TestStorage implements StorageProvider {
  readonly objects = new Map<string, Buffer>();
  afterPut: (() => Promise<void>) | undefined;
  beforeDelete: ((storageKey: string) => Promise<void>) | undefined;

  async ready(): Promise<void> {}

  async put(contents: Buffer, _context: StorageObjectContext, requestedKey?: string): Promise<{ storageKey: string }> {
    const storageKey = requestedKey ?? randomUUID();
    this.objects.set(storageKey, Buffer.from(contents));
    await this.afterPut?.();
    return { storageKey };
  }

  async get(storageKey: string): Promise<Buffer | null> {
    const bytes = this.objects.get(storageKey);
    return bytes ? Buffer.from(bytes) : null;
  }

  async delete(storageKey: string): Promise<void> {
    await this.beforeDelete?.(storageKey);
    this.objects.delete(storageKey);
  }
}

async function userWithCredits(store: MemoryStore, startingCredits = 5) {
  const session = await store.createDevSession({
    displayName: "CloudBase trigger test",
    tokenHash: randomUUID().replaceAll("-", "0").padEnd(64, "0").slice(0, 64),
    expiresAt: "2027-10-07T00:00:00.000Z",
    startingCredits,
  });
  return session.user;
}

test("bounded batch stops at its cap, goes idle, and honors cancellation", async () => {
  let calls = 0;
  const capped = await runBoundedBatch({
    limit: 3,
    processNext: async () => ++calls,
  });
  assert.deepEqual(capped, { processed: 3, stoppedBy: "limit" });
  assert.equal(calls, 3);

  const idle = await runBoundedBatch({ processNext: async () => null });
  assert.deepEqual(idle, { processed: 0, stoppedBy: "idle" });

  const controller = new AbortController();
  const aborted = await runBoundedBatch({
    limit: 5,
    signal: controller.signal,
    processNext: async (signal) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      return { accepted: true };
    },
  });
  assert.deepEqual(aborted, { processed: 1, stoppedBy: "aborted" });
});

test("repeated generation triggers refund a terminal failed job once", async () => {
  const store = new MemoryStore();
  const user = await userWithCredits(store);
  const job = await store.createGenerationJob({
    jobId: "10000000-0000-4000-8000-000000000001",
    userId: user.id,
    kind: "portrait",
    paletteId: "mard-48-v1",
    sourceAssetId: null,
    cost: 1,
    seed: "trigger-refund-once",
    width: 8,
    height: 8,
    now: NOW,
  });
  const paletteMap = Reflect.get(store, "palettes") as Map<string, { retired?: boolean }>;
  const palette = paletteMap.get(job.paletteId);
  assert.ok(palette);
  palette.retired = true;
  const storage = new TestStorage();
  let providerCalls = 0;
  const provider: GenerationProvider = {
    kind: "must-not-run",
    generate: async () => {
      providerCalls += 1;
      return [];
    },
  };

  assert.deepEqual(await runGenerationTrigger({ store, storage, provider, limit: 1, now: new Date(NOW) }), {
    processed: 1,
    stoppedBy: "limit",
  });
  assert.deepEqual(await runGenerationTrigger({ store, storage, provider, limit: 1, now: new Date(NOW) }), {
    processed: 0,
    stoppedBy: "idle",
  });
  assert.equal(providerCalls, 0);
  assert.equal((await store.getGenerationJob(user.id, job.id))?.status, "failed");
  assert.equal((await store.getCreditAccount(user.id)).balance, 5);
  const ledger = await store.listCreditLedger(user.id, 20);
  assert.equal(ledger.filter((entry) => entry.reason === "generation_released").length, 1);
});

test("expired generation lease takeover fences the stale batch before completion", async () => {
  const store = new MemoryStore();
  const user = await userWithCredits(store);
  const job = await store.createGenerationJob({
    jobId: "10000000-0000-4000-8000-000000000002",
    userId: user.id,
    kind: "portrait",
    paletteId: "mard-48-v1",
    sourceAssetId: null,
    cost: 1,
    seed: "trigger-lease-takeover",
    width: 8,
    height: 8,
    now: NOW,
  });
  const takeoverTime = new Date(Date.parse(NOW) + 60_000).toISOString();
  const originalRenew = store.renewGenerationJobLease.bind(store);
  store.renewGenerationJobLease = async (input) => {
    const replacement = await store.claimNextGenerationJob({
      now: takeoverTime,
      leaseToken: LEASE_REPLACEMENT,
      leaseMilliseconds: 60_000,
    });
    assert.equal(replacement?.id, job.id);
    await originalRenew({ ...input, now: takeoverTime });
    return false;
  };
  const storage = new TestStorage();
  let providerCalls = 0;
  const provider: GenerationProvider = {
    kind: "wait-for-lost-lease",
    generate: async (input) => {
      providerCalls += 1;
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) resolve();
        else input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return [];
    },
  };

  const summary = await runGenerationTrigger({
    store,
    storage,
    provider,
    limit: 1,
    now: new Date(NOW),
    leaseMilliseconds: 5_000,
    heartbeatIntervalMilliseconds: 1,
  });
  assert.equal(summary.processed, 1);
  assert.equal(providerCalls, 1);
  assert.equal((await store.getGenerationJob(user.id, job.id))?.leaseToken, LEASE_REPLACEMENT);
  assert.equal((await store.getGenerationJob(user.id, job.id))?.candidates.length, 0);
});

test("export lease takeover removes the stale writer's object before returning", async () => {
  const store = new MemoryStore();
  const user = await userWithCredits(store);
  const project = await store.createProject(user.id, {
    name: "bounded trigger export",
    paletteId: "mard-48-v1",
    grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
  });
  const job = await store.createExportJob({
    id: "20000000-0000-4000-8000-000000000001",
    userId: user.id,
    projectId: project.id,
    projectRevision: 1,
    format: "png",
    fileName: "lease-fence",
    options: {
      paper: "A4",
      orientation: "auto",
      showCodes: true,
      showGrid: true,
      transparentBackground: false,
    },
    now: NOW,
  });
  const storage = new TestStorage();
  storage.afterPut = async () => {
    storage.afterPut = undefined;
    const takeover = await store.claimNextExportJob({
      now: new Date(Date.parse(NOW) + 3 * 60_000).toISOString(),
      leaseToken: LEASE_REPLACEMENT,
      leaseMilliseconds: 60_000,
    });
    assert.equal(takeover?.id, job.id);
  };

  const summary = await runExportTrigger({ store, storage, limit: 1, now: new Date(NOW) });
  assert.equal(summary.processed, 1);
  assert.equal(storage.objects.size, 0);
  const current = await store.getExportJob(user.id, job.id);
  assert.equal(current?.status, "running");
  assert.equal(current?.leaseToken, LEASE_REPLACEMENT);
  assert.equal(current?.artifact, null);
});

class ReconciliationProvider implements PaymentProvider {
  readonly kind = "fake" as const;
  observations: PaymentObservation[] = [];
  queryAction: ((order: PaymentOrderIdentity | PaymentOrderRecord) => Promise<PaymentObservation>) | undefined;
  queries = 0;

  async createOrder(): Promise<never> { throw new Error("not exercised"); }
  async queryOrder(order: PaymentOrderIdentity | PaymentOrderRecord): Promise<PaymentObservation> {
    this.queries += 1;
    if (this.queryAction) return this.queryAction(order);
    return this.observations.shift() ?? { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null };
  }
  async closeOrder(): Promise<void> {}
}

async function paymentOrder(store: MemoryStore, expiresAt: string): Promise<{
  userId: string;
  order: PaymentOrderRecord;
  creditAmount: number;
}> {
  const user = await userWithCredits(store, 2);
  const product = (await store.listCreditProducts())[0]!;
  const order = await store.createPaymentOrder({
    id: randomUUID(),
    userId: user.id,
    product,
    outTradeNo: `PD${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    providerReference: "redacted:trigger-test",
    paymentExpiresAt: expiresAt,
    now: NOW,
  });
  return { userId: user.id, order, creditAmount: product.creditAmount };
}

test("repeated payment triggers credit a confirmed SUCCESS once", async () => {
  const store = new MemoryStore();
  const setup = await paymentOrder(store, new Date(Date.parse(NOW) + 5 * 60_000).toISOString());
  const provider = new ReconciliationProvider();
  provider.observations.push({
    tradeState: "SUCCESS",
    providerTransactionId: "TRIGGER-SUCCESS-ONCE",
    paidAt: new Date(Date.parse(NOW) + 30_000).toISOString(),
  });

  assert.deepEqual(await runPaymentReconciliationTrigger({
    store,
    provider,
    limit: 1,
    now: new Date(Date.parse(NOW) + 60_000),
  }), { processed: 1, stoppedBy: "limit" });
  assert.deepEqual(await runPaymentReconciliationTrigger({
    store,
    provider,
    limit: 1,
    now: new Date(Date.parse(NOW) + 120_000),
  }), { processed: 0, stoppedBy: "idle" });
  assert.equal((await store.getCreditAccount(setup.userId)).balance, 2 + setup.creditAmount);
  assert.equal((await store.listCreditLedger(setup.userId, 20)).filter((entry) => entry.reason === "payment_credit").length, 1);
  assert.equal(provider.queries, 1);
});

test("a stale payment lease cannot confirm a CLOSED observation", async () => {
  const store = new MemoryStore();
  const setup = await paymentOrder(store, new Date(Date.parse(NOW) - 60_000).toISOString());
  const provider = new ReconciliationProvider();
  provider.queryAction = async () => {
    const takeover = await store.claimNextPaymentReconciliation({
      now: new Date(Date.parse(NOW) + 121_000).toISOString(),
      leaseToken: LEASE_REPLACEMENT,
      leaseMilliseconds: 60_000,
    });
    assert.equal(takeover?.order.id, setup.order.id);
    return { tradeState: "CLOSED", providerTransactionId: null, paidAt: null };
  };

  assert.equal((await runPaymentReconciliationTrigger({
    store,
    provider,
    limit: 1,
    now: new Date(Date.parse(NOW) + 60_000),
  })).processed, 1);
  const order = await store.getPaymentOrder(setup.userId, setup.order.id);
  assert.equal(order?.status, "pending");
  assert.equal((await store.getCreditAccount(setup.userId)).balance, 2);
  assert.equal((await store.getPaymentReconciliationJob(setup.order.id))?.leaseToken, LEASE_REPLACEMENT);
});

test("asset purge tombstones before deleting and marks purged only afterward", async () => {
  const store = new MemoryStore();
  const user = await userWithCredits(store);
  const storage = new TestStorage();
  const assetId = "30000000-0000-4000-8000-000000000001";
  const storageKey = "private-asset-storage-key";
  storage.objects.set(storageKey, Buffer.from("encrypted"));
  await store.createAsset({
    id: assetId,
    userId: user.id,
    purpose: "ai-source",
    consentVersion: "privacy-v1",
    sha256: "a".repeat(64),
    mimeType: "image/png",
    sizeBytes: 9,
    width: 1,
    height: 1,
    storageKey,
    expiresAt: "2026-10-06T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  await store.markAssetReady(user.id, assetId, "2026-10-01T00:00:00.000Z");
  storage.beforeDelete = async () => {
    const asset = await store.getAsset(user.id, assetId);
    assert.ok(asset?.deletedAt, "purge must persist the tombstone before deleting bytes");
    assert.equal(asset.purgedAt, null);
  };

  const result = await runAssetPurgeTrigger({ store, storage, now: new Date(NOW), limit: 5 });
  assert.equal(result.purged, 1);
  assert.equal(result.retryRequired, false);
  assert.equal(storage.objects.size, 0);
  assert.ok((await store.getAsset(user.id, assetId))?.purgedAt);
});

test("export purge retains the artifact record through deletion and marks it purged afterward", async () => {
  const store = new MemoryStore();
  const user = await userWithCredits(store);
  const project = await store.createProject(user.id, {
    name: "bounded export cleanup",
    paletteId: "mard-48-v1",
    grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
  });
  const job = await store.createExportJob({
    id: "20000000-0000-4000-8000-000000000002",
    userId: user.id,
    projectId: project.id,
    projectRevision: 1,
    format: "png",
    fileName: "purge-order",
    options: {
      paper: "A4",
      orientation: "auto",
      showCodes: true,
      showGrid: true,
      transparentBackground: false,
    },
    now: NOW,
  });
  const storage = new TestStorage();
  const generated = await runExportTrigger({ store, storage, limit: 1, now: new Date(NOW) });
  assert.equal(generated.processed, 1);
  const completed = await store.getExportJob(user.id, job.id);
  assert.ok(completed?.artifact);
  const artifacts = Reflect.get(store, "exportJobs") as Map<string, { artifact: { id: string; expiresAt: string } | null }>;
  const persisted = artifacts.get(job.id);
  assert.ok(persisted?.artifact);
  persisted.artifact.expiresAt = "2026-10-06T00:00:00.000Z";
  let artifactId = "";
  storage.beforeDelete = async () => {
    const current = await store.getExportJob(user.id, job.id);
    assert.ok(current?.artifact, "the authoritative artifact metadata must remain through object deletion");
    artifactId = current.artifact.id;
    const purgeState = (Reflect.get(store, "exportArtifactPurgeState") as Map<string, { availableAt: string }>).get(artifactId);
    assert.ok(purgeState?.availableAt, "the janitor claim/tombstone must be recorded before deletion");
    assert.equal((Reflect.get(store, "purgedExportArtifacts") as Set<string>).has(artifactId), false);
  };

  const result = await runExportPurgeTrigger({
    store,
    storage,
    now: new Date("2026-10-07T10:01:00.000Z"),
    limit: 5,
  });
  assert.equal(result.purged, 1);
  assert.equal(storage.objects.size, 0);
  assert.equal((Reflect.get(store, "purgedExportArtifacts") as Set<string>).has(artifactId), true);
});
