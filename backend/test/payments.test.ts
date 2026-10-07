import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { PaymentOrderRecord } from "../src/domain/models.js";
import { AppError } from "../src/errors.js";
import type { PaymentObservation, PaymentOrderIdentity, PaymentProvider } from "../src/payments/provider.js";
import { openPaymentProviderReference, sealPaymentProviderReference } from "../src/payments/payment-recovery-token.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import type {
  AppStore,
  IdempotentExecutionResult,
  IdempotentOperationResult,
} from "../src/repositories/store.js";

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
  assetStorageRoot: join(tmpdir(), "pindou-payment-test-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: WORKER_KEY,
};

describe("server-authoritative credit payments", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function login(name: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: name },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().token as string;
  }

  it("uses immutable server prices and credits one successful provider transaction exactly once", async () => {
    const owner = await login("支付用户");
    const stranger = await login("其他用户");
    const auth = { authorization: `Bearer ${owner}` };
    const products = await app.inject({ method: "GET", url: "/api/v1/credit-products", headers: auth });
    assert.equal(products.statusCode, 200, products.body);
    assert.deepEqual(
      products.json().products.map((product: { id: string; creditAmount: number; amountCents: number }) => ({
        id: product.id,
        creditAmount: product.creditAmount,
        amountCents: product.amountCents,
      })),
      [
        { id: "ai-9", creditAmount: 9, amountCents: 390 },
        { id: "ai-49", creditAmount: 49, amountCents: 1_990 },
        { id: "ai-99", creditAmount: 99, amountCents: 3_990 },
        { id: "ai-lifetime", creditAmount: 999_999, amountCents: 19_900 },
      ],
    );

    const tampered = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: { ...auth, "idempotency-key": "tampered-payment-0001" },
      payload: { productId: "ai-9", productVersion: 1, amountCents: 1, creditAmount: 9_999 },
    });
    assert.equal(tampered.statusCode, 400);

    const createHeaders = { ...auth, "idempotency-key": "create-payment-0001" };
    const [created, replayed] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/payment-orders",
        headers: createHeaders,
        payload: { productId: "ai-9", productVersion: 1 },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/payment-orders",
        headers: createHeaders,
        payload: { productId: "ai-9", productVersion: 1 },
      }),
    ]);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(replayed.statusCode, 201, replayed.body);
    const orderId = created.json().order.id as string;
    assert.equal(replayed.json().order.id, orderId);
    assert.equal([created, replayed].filter((response) => response.headers["idempotency-replayed"] === "true").length, 1);
    assert.equal(created.json().order.amountCents, 390);
    assert.equal(created.json().order.creditAmount, 9);
    assert.equal(created.json().paymentParams.signType, "RSA");
    assert.equal(JSON.stringify(created.json()).includes("providerReference"), false);
    assert.equal(JSON.stringify(created.json()).includes("outTradeNo"), false);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: createHeaders,
      payload: { productId: "ai-49", productVersion: 1 },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");

    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/payment-orders/${orderId}`,
      headers: { authorization: `Bearer ${stranger}` },
    });
    assert.equal(hidden.statusCode, 404);

    const pendingRefresh = await app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: { ...auth, "idempotency-key": "refresh-pending-0001" },
    });
    assert.equal(pendingRefresh.statusCode, 200, pendingRefresh.body);
    assert.equal(pendingRefresh.json().order.status, "pending");
    assert.equal(pendingRefresh.json().credited, false);

    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/internal/fake-payments/${orderId}/succeed`,
      headers: { "x-internal-worker-key": "wrong" },
    });
    assert.equal(denied.statusCode, 401);
    const simulated = await app.inject({
      method: "POST",
      url: `/api/v1/internal/fake-payments/${orderId}/succeed`,
      headers: { "x-internal-worker-key": WORKER_KEY },
    });
    assert.equal(simulated.statusCode, 202, simulated.body);

    const [refreshA, refreshB] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/payment-orders/${orderId}/refresh`,
        headers: { ...auth, "idempotency-key": `refresh-success-${randomUUID()}` },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/payment-orders/${orderId}/refresh`,
        headers: { ...auth, "idempotency-key": `refresh-success-${randomUUID()}` },
      }),
    ]);
    assert.equal(refreshA.statusCode, 200, refreshA.body);
    assert.equal(refreshB.statusCode, 200, refreshB.body);
    assert.equal(refreshA.json().order.status, "succeeded");
    assert.equal(refreshB.json().order.status, "succeeded");
    assert.equal([refreshA.json().credited, refreshB.json().credited].filter(Boolean).length, 1);

    const credits = await app.inject({ method: "GET", url: "/api/v1/credits", headers: auth });
    assert.equal(credits.statusCode, 200);
    assert.equal(credits.json().account.balance, 29);
    const ledger = await app.inject({ method: "GET", url: "/api/v1/credits/ledger", headers: auth });
    assert.equal(ledger.statusCode, 200);
    assert.equal(ledger.json().entries.filter((entry: { reason: string }) => entry.reason === "payment_credit").length, 1);

    const replayRefresh = await app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: { ...auth, "idempotency-key": `refresh-replay-${randomUUID()}` },
    });
    assert.equal(replayRefresh.statusCode, 200);
    assert.equal(replayRefresh.json().credited, false);
    const creditsAfter = await app.inject({ method: "GET", url: "/api/v1/credits", headers: auth });
    assert.equal(creditsAfter.json().account.balance, 29);
  });
});

class RecordingPaymentProvider implements PaymentProvider {
  readonly kind = "wechat-v3" as const;
  readonly createInputs: Parameters<PaymentProvider["createOrder"]>[0][] = [];
  readonly queryInputs: Array<PaymentOrderIdentity | PaymentOrderRecord> = [];
  inTransactionWhenCreating: boolean[] = [];
  transactionState: (() => boolean) | null = null;
  createBarrier: Promise<void> | null = null;
  queryBarrier: Promise<void> | null = null;
  createFailuresRemaining = 0;
  duplicateTradeFailuresRemaining = 0;
  queryFailuresRemaining = 0;
  readonly queryErrors: unknown[] = [];
  readonly queryObservations: PaymentObservation[] = [];
  queryObservation: PaymentObservation = {
    tradeState: "NOTPAY",
    providerTransactionId: null,
    paidAt: null,
  };
  readonly createdTrades = new Set<string>();
  readonly closedTrades: string[] = [];
  recoveryKey = "recording-payment-provider-test-key";

  async createOrder(input: Parameters<PaymentProvider["createOrder"]>[0]) {
    this.createInputs.push(structuredClone(input));
    this.inTransactionWhenCreating.push(this.transactionState?.() ?? false);
    if (this.createBarrier) await this.createBarrier;
    if (this.createFailuresRemaining > 0) {
      this.createFailuresRemaining -= 1;
      throw new Error("simulated provider create failure");
    }
    if (this.duplicateTradeFailuresRemaining > 0) {
      this.duplicateTradeFailuresRemaining -= 1;
      throw new AppError(409, "WECHAT_PAY_REJECTED", "商户订单号已被使用", {
        providerCode: "OUT_TRADE_NO_USED",
        providerStatus: 403,
      });
    }
    this.createdTrades.add(input.outTradeNo);
    const providerReference = `recorded-${input.orderId}-${input.outTradeNo}`;
    return {
      providerReference,
      paymentParams: {
        timeStamp: "1700000000",
        nonceStr: "payment-test-nonce",
        package: `prepay_id=${providerReference}`,
        signType: "RSA" as const,
        paySign: "payment-test-signature",
      },
      recoveryCiphertext: sealPaymentProviderReference({
        providerReference,
        keyMaterial: this.recoveryKey,
        orderId: input.orderId,
        outTradeNo: input.outTradeNo,
      }),
    };
  }

  async queryOrder(order: PaymentOrderIdentity | PaymentOrderRecord) {
    this.queryInputs.push(structuredClone(order));
    if (this.queryBarrier) await this.queryBarrier;
    if (this.queryErrors.length > 0) throw this.queryErrors.shift();
    if (this.queryFailuresRemaining > 0) {
      this.queryFailuresRemaining -= 1;
      throw new Error("simulated provider query failure");
    }
    const queuedObservation = this.queryObservations.shift();
    if (queuedObservation) return structuredClone(queuedObservation);
    if (!this.createdTrades.has(order.outTradeNo)) {
      return { tradeState: "NOT_FOUND" as const, providerTransactionId: null, paidAt: null };
    }
    if (this.closedTrades.includes(order.outTradeNo)) {
      return { tradeState: "CLOSED" as const, providerTransactionId: null, paidAt: null };
    }
    return structuredClone(this.queryObservation);
  }

  async recoverOrderSession(input: Parameters<NonNullable<PaymentProvider["recoverOrderSession"]>>[0]) {
    const providerReference = openPaymentProviderReference({
      recoveryCiphertext: input.recoveryCiphertext,
      keyMaterial: this.recoveryKey,
      orderId: input.orderId,
      outTradeNo: input.outTradeNo,
    });
    return {
      providerReference,
      paymentParams: {
        timeStamp: "1700000001",
        nonceStr: "payment-recovery-nonce",
        package: `prepay_id=${providerReference}`,
        signType: "RSA" as const,
        paySign: "payment-recovery-signature",
      },
    };
  }

  async closeOrder(order: Parameters<NonNullable<PaymentProvider["closeOrder"]>>[0]): Promise<void> {
    if (!this.createdTrades.has(order.outTradeNo)) return;
    if (this.queryObservation.tradeState === "SUCCESS") {
      throw new AppError(409, "WECHAT_PAY_REJECTED", "订单已支付", { providerCode: "ORDERPAID" });
    }
    this.closedTrades.push(order.outTradeNo);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for payment provider call");
    await delay(5);
  }
}

class BoundaryStore extends MemoryStore {
  transactionActive = false;
  failFirstPaymentCreate = false;
  private paymentCreateFailed = false;

  override async executeIdempotent<T>(
    input: { userId: string; scope: string; key: string; requestHash: string },
    operation: (transactionStore: AppStore) => Promise<IdempotentOperationResult<T>>,
  ): Promise<IdempotentExecutionResult<T>> {
    if (this.failFirstPaymentCreate && input.scope === "payment-orders:create" && !this.paymentCreateFailed) {
      this.paymentCreateFailed = true;
      throw new Error("simulated database failure after provider create");
    }
    return super.executeIdempotent(input, async (transactionStore) => {
      this.transactionActive = true;
      try {
        return await operation(transactionStore);
      } finally {
        this.transactionActive = false;
      }
    });
  }
}

describe("payment provider retry boundaries", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  async function createHarness(input: {
    failFirstPaymentCreate?: boolean;
    paymentProvider?: RecordingPaymentProvider;
  } = {}) {
    const store = new BoundaryStore();
    store.failFirstPaymentCreate = input.failFirstPaymentCreate ?? false;
    const paymentProvider = input.paymentProvider ?? new RecordingPaymentProvider();
    paymentProvider.transactionState = () => store.transactionActive;
    app = await buildApp({ config, store, paymentProvider, logger: false });
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: "支付边界测试" },
    });
    assert.equal(login.statusCode, 201, login.body);
    return {
      store,
      paymentProvider,
      auth: { authorization: `Bearer ${login.json().token as string}` },
    };
  }

  it("fences every local payment mutation and final commit after a MemoryStore takeover", async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "支付 fencing 用户",
      tokenHash: "f".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      startingCredits: 0,
    });
    const product = await store.getCreditProduct("ai-9", 1);
    assert.ok(product);
    const base = {
      userId: session.user.id,
      scope: "payment-orders:create",
      key: "memory-payment-fence-0001",
      requestHash: "a".repeat(64),
    };
    const staleFence = { ...base, leaseToken: "memory-owner-a" };
    const activeFence = { ...base, leaseToken: "memory-owner-b" };
    const now = new Date();
    assert.equal((await store.claimPaymentEffect({
      ...staleFence,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    })).acquired, true);
    const orderId = "00000000-0000-4000-8000-000000000801";
    const firstTrade = "PDMEMORYFENCE000000000000000001";
    const secondTrade = "PDMEMORYFENCE000000000000000002";
    await store.reservePaymentOrderSlot({
      userId: session.user.id,
      orderId,
      outTradeNo: firstTrade,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      effectFence: staleFence,
    });
    const claims = (store as unknown as {
      paymentEffectClaims: Map<string, { leaseExpiresAt: string }>;
    }).paymentEffectClaims;
    claims.get(`${base.userId}:${base.scope}:${base.key}`)!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    assert.equal((await store.claimPaymentEffect({
      ...activeFence,
      now: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    })).acquired, true);

    const rejectsLost = (error: unknown) => error instanceof AppError
      && error.code === "PAYMENT_EFFECT_LEASE_LOST"
      && error.statusCode === 503
      && error.retryable === true;
    const paymentState = store as unknown as {
      paymentOrderSlots: Map<string, unknown>;
      paymentOrderAttempts: Map<string, { outTradeNo: string; state: string }>;
      paymentEvents: Map<string, { outTradeNo: string }>;
    };
    const capacityBeforeStaleReserve = {
      slots: paymentState.paymentOrderSlots.size,
      attempts: paymentState.paymentOrderAttempts.size,
    };
    await assert.rejects(store.reservePaymentOrderSlot({
      userId: base.userId,
      orderId: "00000000-0000-4000-8000-000000000802",
      outTradeNo: "PDMEMORYFENCE000000000000000099",
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      effectFence: staleFence,
    }), rejectsLost);
    assert.deepEqual({
      slots: paymentState.paymentOrderSlots.size,
      attempts: paymentState.paymentOrderAttempts.size,
    }, capacityBeforeStaleReserve, "a stale reserve cannot consume capacity or append an attempt");
    await assert.rejects(store.beginPaymentOrderProviderAttempt({
      userId: base.userId,
      orderId,
      outTradeNo: firstTrade,
      startedAt: new Date().toISOString(),
      effectFence: staleFence,
    }), rejectsLost);
    await assert.rejects(store.recordPaymentOrderProviderResult({
      userId: base.userId,
      orderId,
      outTradeNo: firstTrade,
      recoveryCiphertext: "PDP1.stale-owner-envelope",
      providerReferenceSha256: "b".repeat(64),
      recordedAt: new Date().toISOString(),
      effectFence: staleFence,
    }), rejectsLost);
    await assert.rejects(store.rotatePaymentOrderProviderAttempt({
      userId: base.userId,
      orderId,
      previousOutTradeNo: firstTrade,
      nextOutTradeNo: secondTrade,
      rotatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      effectFence: staleFence,
    }), rejectsLost);
    await assert.rejects(store.releasePaymentOrderSlot({
      userId: base.userId,
      orderId,
      effectFence: staleFence,
    }), rejectsLost);
    let staleOperationRan = false;
    await assert.rejects(store.executePaymentEffectIdempotent(staleFence, async () => {
      staleOperationRan = true;
      return { statusCode: 201, body: { unexpected: true } };
    }), rejectsLost);
    assert.equal(staleOperationRan, false);
    assert.ok(await store.getPaymentOrderRecoveryAttempt(base.userId, orderId), "stale release must not delete B's slot");

    await store.rotatePaymentOrderProviderAttempt({
      userId: base.userId,
      orderId,
      previousOutTradeNo: firstTrade,
      nextOutTradeNo: secondTrade,
      rotatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      effectFence: activeFence,
    });
    await store.beginPaymentOrderProviderAttempt({
      userId: base.userId,
      orderId,
      outTradeNo: secondTrade,
      startedAt: new Date().toISOString(),
      effectFence: activeFence,
    });
    const committed = await store.executePaymentEffectIdempotent(activeFence, async (transactionStore) => {
      const order = await transactionStore.createPaymentOrder({
        id: orderId,
        userId: base.userId,
        product,
        outTradeNo: secondTrade,
        providerReference: `sha256:${"c".repeat(64)}`,
        paymentExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        now: new Date().toISOString(),
      });
      return { statusCode: 201, body: { orderId: order.id } };
    });
    assert.equal(committed.replayed, false);
    assert.equal((await store.getPaymentOrder(base.userId, orderId))?.id, orderId);
    assert.ok(await store.getPaymentReconciliationJob(orderId), "0037 reconciliation job remains atomic with order creation");
    assert.equal(claims.size, 0);

    const lateOldAttempt = {
      orderId,
      observedOutTradeNo: firstTrade,
      eventKey: "notify:memory-old-attempt-success",
      providerTransactionId: "wx-memory-old-attempt-success",
      providerTradeState: "SUCCESS" as const,
      paidAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      source: "wechat-notify" as const,
      notificationId: "EV-memory-old-attempt-success",
      rawBodySha256: "d".repeat(64),
      wechatSerial: "PUB_KEY_ID_memory_old_attempt",
    };
    assert.equal((await store.applyPaymentSuccess(lateOldAttempt)).credited, true);
    assert.equal((await store.applyPaymentSuccess(lateOldAttempt)).credited, false);
    assert.equal(paymentState.paymentEvents.get(lateOldAttempt.eventKey)?.outTradeNo, firstTrade);
    assert.equal((await store.getCreditAccount(base.userId)).balance, product.creditAmount);
    await assert.rejects(store.applyPaymentSuccess({
      ...lateOldAttempt,
      eventKey: "notify:memory-forged-attempt-success",
      observedOutTradeNo: "PDMEMORYFENCE000000000000000098",
      providerTransactionId: "wx-memory-forged-attempt-success",
    }), (error: unknown) => error instanceof AppError && error.code === "PAYMENT_OUT_TRADE_NO_MISMATCH");
    assert.equal((await store.getCreditAccount(base.userId)).balance, product.creditAmount);
  });

  it("replays create and refresh before calling the provider again", async () => {
    const { store, paymentProvider, auth } = await createHarness();
    const createHeaders = { ...auth, "idempotency-key": "provider-create-replay-0001" };
    const firstCreate = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: createHeaders,
      payload: { productId: "ai-9", productVersion: 1 },
    });
    const replayCreate = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: createHeaders,
      payload: { productId: "ai-9", productVersion: 1 },
    });
    assert.equal(firstCreate.statusCode, 201, firstCreate.body);
    assert.equal(replayCreate.statusCode, 201, replayCreate.body);
    assert.equal(replayCreate.headers["idempotency-replayed"], "true");
    assert.equal(paymentProvider.createInputs.length, 1);
    assert.deepEqual(paymentProvider.inTransactionWhenCreating, [false]);
    assert.equal(replayCreate.json().paymentSessionStatus, "ready");
    const storedIdempotency = (store as unknown as {
      idempotency: Map<string, { body: unknown }>;
    }).idempotency;
    assert.equal(JSON.stringify([...storedIdempotency.values()]).includes("paymentParams"), false);
    const attempts = (store as unknown as {
      paymentOrderAttempts: Map<string, { recoveryCiphertext: string | null }>;
    }).paymentOrderAttempts;
    const recoveryCiphertext = [...attempts.values()][0]?.recoveryCiphertext;
    assert.ok(recoveryCiphertext);
    assert.equal(recoveryCiphertext.includes("recorded-"), false);

    const orderId = firstCreate.json().order.id as string;
    const refreshHeaders = { ...auth, "idempotency-key": "provider-refresh-replay-0001" };
    const firstRefresh = await app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: refreshHeaders,
    });
    const replayRefresh = await app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: refreshHeaders,
    });
    assert.equal(firstRefresh.statusCode, 200, firstRefresh.body);
    assert.equal(replayRefresh.statusCode, 200, replayRefresh.body);
    assert.equal(replayRefresh.headers["idempotency-replayed"], "true");
    assert.equal(paymentProvider.queryInputs.length, 1);
    assert.equal((store as unknown as { paymentEffectClaims: Map<string, unknown> }).paymentEffectClaims.size, 0);
  });

  it("persists a new refresh for an already-succeeded local order without querying the provider", async () => {
    const { store, paymentProvider, auth } = await createHarness();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: { ...auth, "idempotency-key": "provider-local-success-create-0001" },
      payload: { productId: "ai-9", productVersion: 1 },
    });
    assert.equal(created.statusCode, 201, created.body);
    const orderId = created.json().order.id as string;
    const userId = created.json().order.userId as string;
    const order = await store.getPaymentOrder(userId, orderId);
    assert.ok(order);
    const paidAt = new Date().toISOString();
    const notification = await store.applyPaymentSuccess({
      orderId,
      observedOutTradeNo: order.outTradeNo,
      eventKey: "notify:local-success-refresh-0001",
      providerTransactionId: "wx-local-success-refresh-0001",
      providerTradeState: "SUCCESS",
      paidAt,
      observedAt: paidAt,
      source: "wechat-notify",
      notificationId: "EV-local-success-refresh-0001",
      rawBodySha256: "a".repeat(64),
      wechatSerial: "PUB_KEY_ID_local_success_refresh",
    });
    assert.equal(notification.credited, true);

    const refreshHeaders = { ...auth, "idempotency-key": "provider-local-success-refresh-0001" };
    const refreshed = await app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: refreshHeaders,
    });
    const replayed = await app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: refreshHeaders,
    });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.equal(refreshed.json().order.status, "succeeded");
    assert.equal(refreshed.json().credited, false);
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.equal(replayed.headers["idempotency-replayed"], "true");
    assert.equal(replayed.json().credited, false);
    assert.equal(paymentProvider.queryInputs.length, 0);
    assert.equal((await store.getCreditAccount(userId)).balance, 29);
    const ledger = await store.listCreditLedger(userId, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "payment_credit").length, 1);
  });

  it("converges a retryable query failure to a concurrent local success exactly once", async () => {
    const paymentProvider = new RecordingPaymentProvider();
    paymentProvider.queryErrors.push(
      new AppError(503, "WECHAT_PAY_UNAVAILABLE", "provider temporarily unavailable", null, true),
    );
    let releaseQuery = (): void => undefined;
    paymentProvider.queryBarrier = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const { store, auth } = await createHarness({ paymentProvider });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: { ...auth, "idempotency-key": "provider-racing-success-create-0001" },
      payload: { productId: "ai-9", productVersion: 1 },
    });
    assert.equal(created.statusCode, 201, created.body);
    const orderId = created.json().order.id as string;
    const userId = created.json().order.userId as string;
    const order = await store.getPaymentOrder(userId, orderId);
    assert.ok(order);
    const refreshHeaders = { ...auth, "idempotency-key": "provider-racing-success-refresh-0001" };
    const refreshPromise = app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: refreshHeaders,
    });
    await waitFor(() => paymentProvider.queryInputs.length === 1);
    const paidAt = new Date().toISOString();
    const notification = await store.applyPaymentSuccess({
      orderId,
      observedOutTradeNo: order.outTradeNo,
      eventKey: "notify:racing-success-refresh-0001",
      providerTransactionId: "wx-racing-success-refresh-0001",
      providerTradeState: "SUCCESS",
      paidAt,
      observedAt: paidAt,
      source: "wechat-notify",
      notificationId: "EV-racing-success-refresh-0001",
      rawBodySha256: "b".repeat(64),
      wechatSerial: "PUB_KEY_ID_racing_success_refresh",
    });
    assert.equal(notification.credited, true);
    releaseQuery();

    const refreshed = await refreshPromise;
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.equal(refreshed.json().order.status, "succeeded");
    assert.equal(refreshed.json().credited, false);
    assert.equal(paymentProvider.queryInputs.length, 1);
    const replayed = await app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: refreshHeaders,
    });
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.equal(replayed.headers["idempotency-replayed"], "true");
    assert.equal(paymentProvider.queryInputs.length, 1);
    assert.equal((await store.getCreditAccount(userId)).balance, 29);
    const ledger = await store.listCreditLedger(userId, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "payment_credit").length, 1);
  });

  it("converges a NOT_FOUND observation to a concurrent local success", async () => {
    const paymentProvider = new RecordingPaymentProvider();
    paymentProvider.queryObservation = {
      tradeState: "NOT_FOUND",
      providerTransactionId: null,
      paidAt: null,
    };
    let releaseQuery = (): void => undefined;
    paymentProvider.queryBarrier = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const { store, auth } = await createHarness({ paymentProvider });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: { ...auth, "idempotency-key": "provider-not-found-race-create-0001" },
      payload: { productId: "ai-9", productVersion: 1 },
    });
    assert.equal(created.statusCode, 201, created.body);
    const orderId = created.json().order.id as string;
    const userId = created.json().order.userId as string;
    const order = await store.getPaymentOrder(userId, orderId);
    assert.ok(order);
    const refresh = app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: { ...auth, "idempotency-key": "provider-not-found-race-refresh-0001" },
    });
    await waitFor(() => paymentProvider.queryInputs.length === 1);
    const paidAt = new Date().toISOString();
    assert.equal((await store.applyPaymentSuccess({
      orderId,
      observedOutTradeNo: order.outTradeNo,
      eventKey: "notify:not-found-race-refresh-0001",
      providerTransactionId: "wx-not-found-race-refresh-0001",
      providerTradeState: "SUCCESS",
      paidAt,
      observedAt: paidAt,
      source: "wechat-notify",
      notificationId: "EV-not-found-race-refresh-0001",
      rawBodySha256: "c".repeat(64),
      wechatSerial: "PUB_KEY_ID_not_found_race_refresh",
    })).credited, true);
    releaseQuery();

    const response = await refresh;
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().order.status, "succeeded");
    assert.equal(response.json().credited, false);
    assert.equal(paymentProvider.queryInputs.length, 1);
    assert.equal((await store.getCreditAccount(userId)).balance, 29);
    const ledger = await store.listCreditLedger(userId, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "payment_credit").length, 1);
  });

  it("preserves integrity, non-retryable, and unclassified native query failures", async () => {
    const paymentProvider = new RecordingPaymentProvider();
    const { store, auth } = await createHarness({ paymentProvider });
    const cases = [
      {
        code: "WECHAT_PAY_IDENTITY_MISMATCH",
        error: new AppError(502, "WECHAT_PAY_IDENTITY_MISMATCH", "identity mismatch", null, true),
        statusCode: 502,
      },
      {
        code: "WECHAT_PAY_RESPONSE_UNVERIFIED",
        error: new AppError(503, "WECHAT_PAY_RESPONSE_UNVERIFIED", "unverified response", null, true),
        statusCode: 503,
      },
      {
        code: "WECHAT_PAY_INVALID_RESPONSE",
        error: new AppError(502, "WECHAT_PAY_INVALID_RESPONSE", "invalid response", null, true),
        statusCode: 502,
      },
      {
        code: "PROVIDER_FATAL",
        error: new AppError(500, "PROVIDER_FATAL", "non-retryable provider failure", null, false),
        statusCode: 500,
      },
      {
        code: "INTERNAL_ERROR",
        error: new Error("unclassified native provider failure"),
        statusCode: 500,
      },
    ] as const;

    let userId = "";
    for (const [index, testCase] of cases.entries()) {
      const suffix = index + 1;
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/payment-orders",
        headers: { ...auth, "idempotency-key": `provider-integrity-create-000${suffix}` },
        payload: { productId: "ai-9", productVersion: 1 },
      });
      assert.equal(created.statusCode, 201, created.body);
      const orderId = created.json().order.id as string;
      userId = created.json().order.userId as string;
      const order = await store.getPaymentOrder(userId, orderId);
      assert.ok(order);

      let releaseQuery = (): void => undefined;
      paymentProvider.queryBarrier = new Promise<void>((resolve) => { releaseQuery = resolve; });
      paymentProvider.queryErrors.push(testCase.error);
      const refresh = app.inject({
        method: "POST",
        url: `/api/v1/payment-orders/${orderId}/refresh`,
        headers: { ...auth, "idempotency-key": `provider-integrity-refresh-000${suffix}` },
      });
      await waitFor(() => paymentProvider.queryInputs.length === suffix);
      const paidAt = new Date().toISOString();
      assert.equal((await store.applyPaymentSuccess({
        orderId,
        observedOutTradeNo: order.outTradeNo,
        eventKey: `notify:integrity-refresh-000${suffix}`,
        providerTransactionId: `wx-integrity-refresh-000${suffix}`,
        providerTradeState: "SUCCESS",
        paidAt,
        observedAt: paidAt,
        source: "wechat-notify",
        notificationId: `EV-integrity-refresh-000${suffix}`,
        rawBodySha256: suffix.toString().repeat(64),
        wechatSerial: `PUB_KEY_ID_integrity_refresh_${suffix}`,
      })).credited, true);
      releaseQuery();
      const response = await refresh;
      assert.equal(response.statusCode, testCase.statusCode, response.body);
      assert.equal(response.json().error.code, testCase.code);
      paymentProvider.queryBarrier = null;
    }

    assert.equal(paymentProvider.queryInputs.length, cases.length);
    assert.equal((await store.getCreditAccount(userId)).balance, 20 + (cases.length * 9));
    const ledger = await store.listCreditLedger(userId, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "payment_credit").length, cases.length);
  });

  it("queries closed orders before converging unavailable and NOT_FOUND late-success races", async () => {
    const { store, paymentProvider, auth } = await createHarness();
    const scenarios: Array<{
      label: string;
      error?: AppError;
      observation?: PaymentObservation;
    }> = [
      {
        label: "unavailable",
        error: new AppError(503, "WECHAT_PAY_UNAVAILABLE", "provider temporarily unavailable", null, true),
      },
      {
        label: "not-found",
        observation: { tradeState: "NOT_FOUND", providerTransactionId: null, paidAt: null },
      },
    ];

    let userId = "";
    for (const [index, scenario] of scenarios.entries()) {
      const suffix = index + 1;
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/payment-orders",
        headers: { ...auth, "idempotency-key": `provider-create-closed-race-000${suffix}` },
        payload: { productId: "ai-9", productVersion: 1 },
      });
      assert.equal(created.statusCode, 201, created.body);
      const orderId = created.json().order.id as string;
      userId = created.json().order.userId as string;
      paymentProvider.queryObservation = {
        tradeState: "CLOSED",
        providerTransactionId: null,
        paidAt: null,
      };
      const closed = await app.inject({
        method: "POST",
        url: `/api/v1/payment-orders/${orderId}/refresh`,
        headers: { ...auth, "idempotency-key": `provider-refresh-closed-race-000${suffix}` },
      });
      assert.equal(closed.statusCode, 200, closed.body);
      assert.equal(closed.json().order.status, "closed");
      assert.equal(closed.json().order.providerTradeState, "CLOSED");
      assert.equal(closed.json().credited, false);
      assert.equal(paymentProvider.queryInputs.length, (index * 2) + 1);

      let releaseQuery = (): void => undefined;
      paymentProvider.queryBarrier = new Promise<void>((resolve) => { releaseQuery = resolve; });
      if (scenario.error) paymentProvider.queryErrors.push(scenario.error);
      paymentProvider.queryObservation = scenario.observation ?? {
        tradeState: "NOTPAY",
        providerTransactionId: null,
        paidAt: null,
      };
      const lateHeaders = {
        ...auth,
        "idempotency-key": `provider-refresh-closed-${scenario.label}-000${suffix}`,
      };
      const lateRefresh = app.inject({
        method: "POST",
        url: `/api/v1/payment-orders/${orderId}/refresh`,
        headers: lateHeaders,
      });
      await waitFor(() => paymentProvider.queryInputs.length === (index * 2) + 2);
      const order = await store.getPaymentOrder(userId, orderId);
      assert.ok(order);
      const paidAt = new Date().toISOString();
      assert.equal((await store.applyPaymentSuccess({
        orderId,
        observedOutTradeNo: order.outTradeNo,
        eventKey: `notify:closed-${scenario.label}-race-000${suffix}`,
        providerTransactionId: `wx-closed-${scenario.label}-race-000${suffix}`,
        providerTradeState: "SUCCESS",
        paidAt,
        observedAt: paidAt,
        source: "wechat-notify",
        notificationId: `EV-closed-${scenario.label}-race-000${suffix}`,
        rawBodySha256: `${suffix + 5}`.repeat(64),
        wechatSerial: `PUB_KEY_ID_closed_${scenario.label}_${suffix}`,
      })).credited, true);
      releaseQuery();

      const lateSuccess = await lateRefresh;
      assert.equal(lateSuccess.statusCode, 200, lateSuccess.body);
      assert.equal(lateSuccess.json().order.status, "succeeded");
      assert.equal(lateSuccess.json().credited, false);
      assert.equal(
        paymentProvider.queryInputs.length,
        (index * 2) + 2,
        "closed orders must complete a Provider query before local convergence",
      );
      paymentProvider.queryBarrier = null;
      const replayed = await app.inject({
        method: "POST",
        url: `/api/v1/payment-orders/${orderId}/refresh`,
        headers: lateHeaders,
      });
      assert.equal(replayed.statusCode, 200, replayed.body);
      assert.equal(replayed.headers["idempotency-replayed"], "true");
      assert.equal(paymentProvider.queryInputs.length, (index * 2) + 2);
    }

    assert.equal((await store.getCreditAccount(userId)).balance, 20 + (scenarios.length * 9));
    const ledger = await store.listCreditLedger(userId, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "payment_credit").length, scenarios.length);
  });

  it("rate-limits before creating a durable claim or calling the provider", async () => {
    const store = new BoundaryStore();
    const paymentProvider = new RecordingPaymentProvider();
    let claimCalls = 0;
    const claim = store.claimPaymentEffect.bind(store);
    store.claimPaymentEffect = async (input) => {
      claimCalls += 1;
      return claim(input);
    };
    store.consumeUserRateLimit = async () => ({
      allowed: false,
      remaining: 0,
      retryAfterMilliseconds: 60_000,
    });
    app = await buildApp({ config, store, paymentProvider, logger: false });
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: "支付限流顺序测试" },
    });
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: {
        authorization: `Bearer ${login.json().token as string}`,
        "idempotency-key": "provider-rate-limit-before-claim-0001",
      },
      payload: { productId: "ai-9", productVersion: 1 },
    });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json().error.code, "USER_RATE_LIMITED");
    assert.equal(claimCalls, 0);
    assert.equal(paymentProvider.createInputs.length, 0);
  });

  it("reuses the stable provider identity after the first database persistence fails", async () => {
    const { paymentProvider, auth } = await createHarness({ failFirstPaymentCreate: true });
    const headers = { ...auth, "idempotency-key": "provider-db-retry-0001" };
    const payload = { productId: "ai-49", productVersion: 1 };
    const failed = await app.inject({ method: "POST", url: "/api/v1/payment-orders", headers, payload });
    const conflictingRetry = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers,
      payload: { productId: "ai-9", productVersion: 1 },
    });
    const retried = await app.inject({ method: "POST", url: "/api/v1/payment-orders", headers, payload });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal(conflictingRetry.statusCode, 409, conflictingRetry.body);
    assert.equal(conflictingRetry.json().error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(retried.statusCode, 201, retried.body);
    assert.equal(paymentProvider.createInputs.length, 1, "encrypted prepay recovery avoids duplicate create");
    assert.equal(retried.json().order.id, paymentProvider.createInputs[0]?.orderId);
    assert.deepEqual(paymentProvider.inTransactionWhenCreating, [false]);
    assert.match(retried.json().paymentParams.package, /^prepay_id=recorded-/);
  });

  it("recovers OUT_TRADE_NO_USED by querying the same identity and applying SUCCESS once", async () => {
    const paymentProvider = new RecordingPaymentProvider();
    paymentProvider.duplicateTradeFailuresRemaining = 1;
    paymentProvider.queryObservations.push({
      tradeState: "SUCCESS",
      providerTransactionId: "wx-duplicate-success-0001",
      paidAt: "2026-10-05T08:00:00.000Z",
    });
    const { store, auth } = await createHarness({ paymentProvider });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: { ...auth, "idempotency-key": "provider-duplicate-success-0001" },
      payload: { productId: "ai-9", productVersion: 1 },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().order.status, "succeeded");
    assert.equal(created.json().paymentSessionStatus, "not-required");
    assert.equal(paymentProvider.createInputs.length, 1);
    assert.equal(paymentProvider.queryInputs.length, 1);
    const queriedIdentity = paymentProvider.queryInputs[0]!;
    assert.equal("orderId" in queriedIdentity ? queriedIdentity.orderId : queriedIdentity.id, paymentProvider.createInputs[0]?.orderId);
    assert.equal(queriedIdentity.outTradeNo, paymentProvider.createInputs[0]?.outTradeNo);
    assert.equal((await store.getCreditAccount(created.json().order.userId)).balance, 29);
    const ledger = await store.listCreditLedger(created.json().order.userId, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "payment_credit").length, 1);
  });

  it("closes and re-queries OUT_TRADE_NO_USED NOTPAY before rotating to a fresh identity", async () => {
    const paymentProvider = new RecordingPaymentProvider();
    paymentProvider.duplicateTradeFailuresRemaining = 1;
    paymentProvider.queryObservations.push(
      { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null },
      { tradeState: "CLOSED", providerTransactionId: null, paidAt: null },
    );
    const { store, auth } = await createHarness({ paymentProvider });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: { ...auth, "idempotency-key": "provider-duplicate-close-0001" },
      payload: { productId: "ai-9", productVersion: 1 },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(paymentProvider.queryInputs.length, 2, "close success is followed by a confirming query");
    assert.equal(paymentProvider.queryInputs[0]?.outTradeNo, paymentProvider.createInputs[0]?.outTradeNo);
    assert.equal(paymentProvider.queryInputs[1]?.outTradeNo, paymentProvider.createInputs[0]?.outTradeNo);
    assert.equal(paymentProvider.createInputs.length, 2);
    assert.notEqual(paymentProvider.createInputs[1]?.outTradeNo, paymentProvider.createInputs[0]?.outTradeNo);
    const attempts = (store as unknown as {
      paymentOrderAttempts: Map<string, { attemptNo: number; state: string }>;
    }).paymentOrderAttempts;
    assert.deepEqual([...attempts.values()].map(({ attemptNo, state }) => ({ attemptNo, state })), [
      { attemptNo: 1, state: "closed" },
      { attemptNo: 2, state: "created" },
    ]);
  });

  it("keeps OUT_TRADE_NO_USED NOT_FOUND retryable without recreating or rotating", async () => {
    const paymentProvider = new RecordingPaymentProvider();
    paymentProvider.duplicateTradeFailuresRemaining = 1;
    paymentProvider.queryObservations.push({
      tradeState: "NOT_FOUND",
      providerTransactionId: null,
      paidAt: null,
    });
    const { store, auth } = await createHarness({ paymentProvider });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: { ...auth, "idempotency-key": "provider-duplicate-not-found-0001" },
      payload: { productId: "ai-9", productVersion: 1 },
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, "PAYMENT_PROVIDER_STATE_UNCERTAIN");
    assert.equal(response.json().error.retryable, true);
    assert.equal(paymentProvider.createInputs.length, 1);
    assert.equal(paymentProvider.queryInputs.length, 1);
    const attempts = (store as unknown as {
      paymentOrderAttempts: Map<string, { state: string }>;
    }).paymentOrderAttempts;
    assert.equal(attempts.size, 1);
    assert.equal([...attempts.values()][0]?.state, "creating");
  });

  it("queries, closes, and rotates after the recovery encryption key changes", async () => {
    const { paymentProvider, auth } = await createHarness({ failFirstPaymentCreate: true });
    const headers = { ...auth, "idempotency-key": "provider-key-rotation-recovery-0001" };
    const payload = { productId: "ai-9", productVersion: 1 };
    const failed = await app.inject({ method: "POST", url: "/api/v1/payment-orders", headers, payload });
    assert.equal(failed.statusCode, 500, failed.body);
    const oldTradeNo = paymentProvider.createInputs[0]?.outTradeNo;
    assert.ok(oldTradeNo);

    paymentProvider.recoveryKey = "rotated-payment-provider-test-key";
    const recovered = await app.inject({ method: "POST", url: "/api/v1/payment-orders", headers, payload });
    assert.equal(recovered.statusCode, 201, recovered.body);
    assert.equal(paymentProvider.createInputs.length, 2);
    assert.deepEqual(paymentProvider.closedTrades, [oldTradeNo]);
    assert.notEqual(paymentProvider.createInputs[1]?.outTradeNo, oldTradeNo);
    assert.equal(recovered.json().paymentSessionStatus, "ready");
  });

  it("calls create and query providers at most once for simultaneous first requests", async () => {
    const paymentProvider = new RecordingPaymentProvider();
    let releaseCreate = (): void => undefined;
    paymentProvider.createBarrier = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const { auth } = await createHarness({ paymentProvider });
    const createHeaders = { ...auth, "idempotency-key": "provider-create-concurrent-0001" };
    const payload = { productId: "ai-9", productVersion: 1 };

    const firstCreatePromise = app.inject({ method: "POST", url: "/api/v1/payment-orders", headers: createHeaders, payload });
    await waitFor(() => paymentProvider.createInputs.length === 1);
    const competingCreate = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: createHeaders,
      payload,
    });
    assert.equal(competingCreate.statusCode, 409, competingCreate.body);
    assert.equal(competingCreate.json().error.code, "IDEMPOTENCY_IN_PROGRESS");
    assert.equal(competingCreate.json().error.retryable, true);
    assert.match(String(competingCreate.headers["retry-after"]), /^\d+$/);
    assert.equal(paymentProvider.createInputs.length, 1);

    releaseCreate();
    const firstCreate = await firstCreatePromise;
    assert.equal(firstCreate.statusCode, 201, firstCreate.body);
    const replayCreate = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: createHeaders,
      payload,
    });
    assert.equal(replayCreate.statusCode, 201, replayCreate.body);
    assert.equal(replayCreate.headers["idempotency-replayed"], "true");
    assert.equal(paymentProvider.createInputs.length, 1);

    paymentProvider.createBarrier = null;
    let releaseQuery = (): void => undefined;
    paymentProvider.queryBarrier = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const orderId = firstCreate.json().order.id as string;
    const refreshHeaders = { ...auth, "idempotency-key": "provider-query-concurrent-0001" };
    const firstRefreshPromise = app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: refreshHeaders,
    });
    await waitFor(() => paymentProvider.queryInputs.length === 1);
    const competingRefresh = await app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: refreshHeaders,
    });
    assert.equal(competingRefresh.statusCode, 409, competingRefresh.body);
    assert.equal(competingRefresh.json().error.code, "IDEMPOTENCY_IN_PROGRESS");
    assert.match(String(competingRefresh.headers["retry-after"]), /^\d+$/);
    assert.equal(paymentProvider.queryInputs.length, 1);

    releaseQuery();
    const firstRefresh = await firstRefreshPromise;
    assert.equal(firstRefresh.statusCode, 200, firstRefresh.body);
    const replayRefresh = await app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: refreshHeaders,
    });
    assert.equal(replayRefresh.statusCode, 200, replayRefresh.body);
    assert.equal(replayRefresh.headers["idempotency-replayed"], "true");
    assert.equal(paymentProvider.queryInputs.length, 1);
  });

  it("releases the durable claim after provider failures so the same request can retry", async () => {
    const paymentProvider = new RecordingPaymentProvider();
    paymentProvider.createFailuresRemaining = 1;
    const { auth } = await createHarness({ paymentProvider });
    const createHeaders = { ...auth, "idempotency-key": "provider-create-failure-release-0001" };
    const payload = { productId: "ai-9", productVersion: 1 };
    const failedCreate = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: createHeaders,
      payload,
    });
    assert.equal(failedCreate.statusCode, 500, failedCreate.body);
    const retriedCreate = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: createHeaders,
      payload,
    });
    assert.equal(retriedCreate.statusCode, 201, retriedCreate.body);
    assert.equal(paymentProvider.createInputs.length, 2);

    paymentProvider.queryFailuresRemaining = 1;
    const orderId = retriedCreate.json().order.id as string;
    const refreshHeaders = { ...auth, "idempotency-key": "provider-query-failure-release-0001" };
    const failedRefresh = await app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: refreshHeaders,
    });
    assert.equal(failedRefresh.statusCode, 500, failedRefresh.body);
    const retriedRefresh = await app.inject({
      method: "POST",
      url: `/api/v1/payment-orders/${orderId}/refresh`,
      headers: refreshHeaders,
    });
    assert.equal(retriedRefresh.statusCode, 200, retriedRefresh.body);
    assert.equal(paymentProvider.queryInputs.length, 3, "one recovery query plus two refresh attempts");
  });

  it("reserves pending capacity before provider calls and retains uncertain side effects", async () => {
    const paymentProvider = new RecordingPaymentProvider();
    paymentProvider.createFailuresRemaining = 5;
    const { auth } = await createHarness({ paymentProvider });
    const payload = { productId: "ai-9", productVersion: 1 };
    for (let index = 0; index < 5; index += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/v1/payment-orders",
        headers: { ...auth, "idempotency-key": `provider-uncertain-slot-000${index}` },
        payload,
      });
      assert.equal(failed.statusCode, 500, failed.body);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: { ...auth, "idempotency-key": "provider-uncertain-slot-overflow" },
      payload,
    });
    assert.equal(blocked.statusCode, 429, blocked.body);
    assert.equal(blocked.json().error.code, "PAYMENT_PENDING_LIMIT_EXCEEDED");
    assert.equal(paymentProvider.createInputs.length, 5);

    const sameIdentityRetry = await app.inject({
      method: "POST",
      url: "/api/v1/payment-orders",
      headers: { ...auth, "idempotency-key": "provider-uncertain-slot-0000" },
      payload,
    });
    assert.equal(sameIdentityRetry.statusCode, 201, sameIdentityRetry.body);
    assert.equal(paymentProvider.createInputs.length, 6);
    assert.equal(paymentProvider.createInputs[0]?.orderId, paymentProvider.createInputs[5]?.orderId);
  });

  it("rotates an expired ambiguous identity to a fresh merchant order number", async () => {
    const paymentProvider = new RecordingPaymentProvider();
    paymentProvider.createFailuresRemaining = 1;
    const { store, auth } = await createHarness({ paymentProvider });
    const headers = { ...auth, "idempotency-key": "provider-expired-slot-stable-0001" };
    const payload = { productId: "ai-9", productVersion: 1 };
    const failed = await app.inject({ method: "POST", url: "/api/v1/payment-orders", headers, payload });
    assert.equal(failed.statusCode, 500, failed.body);
    const slots = (store as unknown as {
      paymentOrderSlots: Map<string, { expiresAt: string }>;
    }).paymentOrderSlots;
    assert.equal(slots.size, 1);
    const [slot] = slots.values();
    assert.ok(slot);
    slot.expiresAt = "2000-01-01T00:00:00.000Z";

    const recovered = await app.inject({ method: "POST", url: "/api/v1/payment-orders", headers, payload });
    assert.equal(recovered.statusCode, 201, recovered.body);
    assert.equal(slots.size, 0, "formal order replaces the active reservation");
    assert.equal(paymentProvider.createInputs.length, 2);
    assert.notEqual(paymentProvider.createInputs[0]?.outTradeNo, paymentProvider.createInputs[1]?.outTradeNo);
    const attempts = (store as unknown as {
      paymentOrderAttempts: Map<string, { expiresAt: string; state: string }>;
    }).paymentOrderAttempts;
    assert.equal(attempts.size, 2);
    assert.ok([...attempts.values()].some((attempt) => attempt.state === "closed"));
  });

  it("does not commit a provider result after the payment-effect heartbeat loses its lease", async () => {
    const store = new BoundaryStore();
    const paymentProvider = new RecordingPaymentProvider();
    let releaseProvider = (): void => undefined;
    paymentProvider.createBarrier = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const renew = store.renewPaymentEffectClaim.bind(store);
    let renewCalls = 0;
    store.renewPaymentEffectClaim = async () => {
      renewCalls += 1;
      return false;
    };
    app = await buildApp({
      config,
      store,
      paymentProvider,
      paymentEffectLeaseMilliseconds: 90,
      logger: false,
    });
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: "支付失租测试" },
    });
    const headers = {
      authorization: `Bearer ${login.json().token as string}`,
      "idempotency-key": "provider-heartbeat-loss-0001",
    };
    const payload = { productId: "ai-9", productVersion: 1 };
    const request = app.inject({ method: "POST", url: "/api/v1/payment-orders", headers, payload });
    await waitFor(() => paymentProvider.createInputs.length === 1);
    await waitFor(() => renewCalls > 0);
    releaseProvider();
    const lost = await request;
    assert.equal(lost.statusCode, 503, lost.body);
    assert.equal(lost.json().error.code, "PAYMENT_EFFECT_LEASE_LOST");

    store.renewPaymentEffectClaim = renew;
    paymentProvider.createBarrier = null;
    const retried = await app.inject({ method: "POST", url: "/api/v1/payment-orders", headers, payload });
    assert.equal(retried.statusCode, 201, retried.body);
    assert.equal(paymentProvider.createInputs.length, 2);
    assert.equal(paymentProvider.createInputs[0]?.orderId, paymentProvider.createInputs[1]?.orderId);
    assert.notEqual(paymentProvider.createInputs[0]?.outTradeNo, paymentProvider.createInputs[1]?.outTradeNo);
    assert.deepEqual(paymentProvider.closedTrades, [paymentProvider.createInputs[0]!.outTradeNo]);
  });
});
