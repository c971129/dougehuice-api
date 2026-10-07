import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import type { CreditProduct, PaymentOrderRecord } from "../src/domain/models.js";
import { INITIAL_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS } from "../src/domain/payment-reconciliation.js";
import { AppError } from "../src/errors.js";
import type { PaymentObservation, PaymentOrderIdentity, PaymentProvider } from "../src/payments/provider.js";
import { processNextPaymentReconciliation } from "../src/payments/reconciliation-worker.js";
import { MemoryStore } from "../src/repositories/memory-store.js";

class ReconciliationProvider implements PaymentProvider {
  readonly kind = "fake" as const;
  readonly queries: Array<PaymentOrderIdentity | PaymentOrderRecord> = [];
  readonly closes: PaymentOrderIdentity[] = [];
  observations: PaymentObservation[] = [];
  queryDelayMilliseconds = 0;
  queryAction: ((
    order: PaymentOrderIdentity | PaymentOrderRecord,
    signal?: AbortSignal,
  ) => Promise<PaymentObservation>) | null = null;
  closeAction: (() => void | Promise<void>) | null = null;

  async createOrder(): Promise<never> {
    throw new Error("not exercised");
  }

  async queryOrder(
    order: PaymentOrderIdentity | PaymentOrderRecord,
    signal?: AbortSignal,
  ): Promise<PaymentObservation> {
    this.queries.push(structuredClone(order));
    if (this.queryAction) return this.queryAction(order, signal);
    if (this.queryDelayMilliseconds > 0) await delay(this.queryDelayMilliseconds);
    return structuredClone(this.observations.shift()
      ?? { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null });
  }

  async closeOrder(order: PaymentOrderIdentity): Promise<void> {
    this.closes.push(structuredClone(order));
    await this.closeAction?.();
  }
}

async function setupOrder(input?: { expiresAt?: string; startingCredits?: number }): Promise<{
  store: MemoryStore;
  order: PaymentOrderRecord;
  product: CreditProduct;
}> {
  const store = new MemoryStore();
  const session = await store.createDevSession({
    displayName: "支付对账用户",
    tokenHash: "reconciliation-test-token",
    expiresAt: "2027-10-05T00:00:00.000Z",
    startingCredits: input?.startingCredits ?? 0,
  });
  const product = (await store.listCreditProducts())[0]!;
  const order = await store.createPaymentOrder({
    id: "00000000-0000-4000-8000-000000000701",
    userId: session.user.id,
    product,
    outTradeNo: "PD202610050000000000000701",
    providerReference: "redacted:test",
    paymentExpiresAt: input?.expiresAt ?? "2026-10-05T10:10:00.000Z",
    now: "2026-10-05T10:00:00.000Z",
  });
  return { store, order, product };
}

describe("payment reconciliation worker", () => {
  it("schedules new orders after 30 seconds and recovers a lost SUCCESS callback exactly once", async () => {
    const { store, order, product } = await setupOrder({ startingCredits: 3 });
    const initialJob = await store.getPaymentReconciliationJob(order.id);
    assert.equal(
      initialJob?.availableAt,
      new Date(Date.parse(order.createdAt) + INITIAL_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS).toISOString(),
    );
    const provider = new ReconciliationProvider();
    provider.observations.push({
      tradeState: "SUCCESS",
      providerTransactionId: "FAKE-RECONCILIATION-701",
      paidAt: "2026-10-05T10:00:20.000Z",
    });

    const applied = await processNextPaymentReconciliation({
      store,
      provider,
      now: new Date("2026-10-05T10:00:31.000Z"),
    });
    assert.equal(applied?.status, "succeeded");
    assert.equal((await store.getCreditAccount(order.userId))?.balance, 3 + product.creditAmount);
    assert.equal((await store.listCreditLedger(order.userId, 20, 0)).filter((entry) => entry.reason === "payment_credit").length, 1);
    assert.equal((await store.getPaymentReconciliationJob(order.id))?.state, "completed");
    assert.equal(await processNextPaymentReconciliation({
      store,
      provider,
      now: new Date("2026-10-05T10:01:31.000Z"),
    }), null);
  });

  it("keeps NOTPAY pending before expiry, then closes only after a second query confirms CLOSED", async () => {
    const { store, order } = await setupOrder();
    const provider = new ReconciliationProvider();
    provider.observations.push(
      { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null },
      { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null },
      { tradeState: "CLOSED", providerTransactionId: null, paidAt: null },
    );

    const pending = await processNextPaymentReconciliation({
      store,
      provider,
      now: new Date("2026-10-05T10:00:31.000Z"),
      notpayPollMilliseconds: 60_000,
    });
    assert.equal(pending?.status, "pending");
    assert.equal(provider.closes.length, 0);

    const closed = await processNextPaymentReconciliation({
      store,
      provider,
      now: new Date("2026-10-05T10:11:00.000Z"),
    });
    assert.equal(provider.closes.length, 1);
    assert.equal(provider.queries.length, 3, "expired NOTPAY must be followed by a post-close query");
    assert.equal(closed?.status, "closed");
    assert.equal(closed?.closedAt, "2026-10-05T10:11:00.000Z");
    assert.equal((await store.getPaymentReconciliationJob(order.id))?.state, "completed");
  });

  it("re-queries after ORDERPAID and lets SUCCESS win the close race", async () => {
    const { store, order, product } = await setupOrder({
      expiresAt: "2026-10-05T09:59:00.000Z",
      startingCredits: 1,
    });
    const provider = new ReconciliationProvider();
    provider.observations.push(
      { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null },
      {
        tradeState: "SUCCESS",
        providerTransactionId: "FAKE-CLOSE-RACE-701",
        paidAt: "2026-10-05T10:00:29.000Z",
      },
    );
    provider.closeAction = () => {
      throw new AppError(409, "WECHAT_PAY_REJECTED", "订单已支付", { providerCode: "ORDERPAID" }, true);
    };

    const result = await processNextPaymentReconciliation({
      store,
      provider,
      now: new Date("2026-10-05T10:00:31.000Z"),
    });
    assert.equal(provider.closes.length, 1);
    assert.equal(provider.queries.length, 2);
    assert.equal(result?.status, "succeeded");
    assert.equal((await store.getCreditAccount(order.userId))?.balance, 1 + product.creditAmount);
  });

  it("keeps an ambiguous close pending and persists only a fixed redacted error", async () => {
    const { store, order } = await setupOrder({ expiresAt: "2026-10-05T09:59:00.000Z" });
    const provider = new ReconciliationProvider();
    provider.observations.push(
      { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null },
      { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null },
    );
    provider.closeAction = () => {
      throw new Error("raw provider body\nsecret-token=must-not-persist");
    };

    const result = await processNextPaymentReconciliation({
      store,
      provider,
      now: new Date("2026-10-05T10:00:31.000Z"),
    });
    assert.equal(result?.status, "pending");
    assert.equal(provider.queries.length, 2);
    const job = await store.getPaymentReconciliationJob(order.id);
    assert.equal(job?.state, "scheduled");
    assert.equal(job?.lastErrorCode, "PAYMENT_CLOSE_RESULT_UNKNOWN");
    assert.equal(job?.lastErrorMessage, "关单调用结果不明确，二次查单仍未确认终态");
    assert.equal(JSON.stringify(job).includes("secret-token"), false);
  });

  it("converges a terminal job left running by an older in-memory writer", async () => {
    const { store, order } = await setupOrder();
    const state = store as unknown as {
      paymentOrders: Map<string, PaymentOrderRecord>;
      paymentReconciliationJobs: Map<string, {
        state: "scheduled" | "running" | "completed";
        leaseToken: string | null;
        leaseExpiresAt: string | null;
        lastObservedTradeState: "NOT_FOUND" | "NOTPAY" | "SUCCESS" | "CLOSED" | null;
        completedAt: string | null;
      }>;
    };
    const persistedOrder = state.paymentOrders.get(order.id)!;
    persistedOrder.status = "succeeded";
    persistedOrder.providerTradeState = "SUCCESS";
    const persistedJob = state.paymentReconciliationJobs.get(order.id)!;
    persistedJob.state = "running";
    persistedJob.leaseToken = "00000000-0000-4000-8000-000000000799";
    persistedJob.leaseExpiresAt = "2099-10-05T10:00:00.000Z";

    assert.equal(await store.claimNextPaymentReconciliation({
      leaseToken: "00000000-0000-4000-8000-000000000798",
      leaseMilliseconds: 60_000,
      now: "2026-10-05T10:01:00.000Z",
    }), null);
    const converged = await store.getPaymentReconciliationJob(order.id);
    assert.equal(converged?.state, "completed");
    assert.equal(converged?.leaseToken, null);
    assert.equal(converged?.lastObservedTradeState, "SUCCESS");
    assert.equal(converged?.completedAt, "2026-10-05T10:01:00.000Z");
  });

  it("still commits monotonic SUCCESS after heartbeat lease loss", async () => {
    const { store, order, product } = await setupOrder({ startingCredits: 2 });
    const provider = new ReconciliationProvider();
    provider.queryDelayMilliseconds = 35;
    provider.observations.push({
      tradeState: "SUCCESS",
      providerTransactionId: "FAKE-LEASE-LOSS-701",
      paidAt: "2026-10-05T10:00:30.000Z",
    });
    const originalRenew = store.renewPaymentReconciliationLease.bind(store);
    store.renewPaymentReconciliationLease = async () => false;
    try {
      const result = await processNextPaymentReconciliation({
        store,
        provider,
        now: new Date("2026-10-05T10:00:31.000Z"),
        leaseMilliseconds: 100,
        heartbeatIntervalMilliseconds: 5,
      });
      assert.equal(result?.status, "succeeded");
      assert.equal((await store.getCreditAccount(order.userId))?.balance, 2 + product.creditAmount);
      assert.equal((await store.listCreditLedger(order.userId, 20, 0)).filter((entry) => entry.reason === "payment_credit").length, 1);
    } finally {
      store.renewPaymentReconciliationLease = originalRenew;
    }
  });

  it("never writes CLOSED from a worker that lost its lease", async () => {
    const { store, order } = await setupOrder();
    const provider = new ReconciliationProvider();
    provider.queryDelayMilliseconds = 35;
    provider.observations.push({ tradeState: "CLOSED", providerTransactionId: null, paidAt: null });
    const originalRenew = store.renewPaymentReconciliationLease.bind(store);
    store.renewPaymentReconciliationLease = async () => false;
    try {
      const result = await processNextPaymentReconciliation({
        store,
        provider,
        now: new Date("2026-10-05T10:00:31.000Z"),
        leaseMilliseconds: 100,
        heartbeatIntervalMilliseconds: 5,
      });
      assert.equal(result?.status, "pending");
      assert.equal((await store.getPaymentOrder(order.userId, order.id))?.status, "pending");
    } finally {
      store.renewPaymentReconciliationLease = originalRenew;
    }
  });

  it("aborts an in-flight provider query on process shutdown without rescheduling the claimed job", { timeout: 2_000 }, async () => {
    const { store, order } = await setupOrder();
    const provider = new ReconciliationProvider();
    const shutdown = new AbortController();
    const shutdownReason = new Error("WORKER_SHUTTING_DOWN");
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let observedReason: unknown;
    provider.queryAction = async (_order, signal) => {
      assert.ok(signal);
      resolveStarted();
      return new Promise((_resolve, reject) => {
        const abort = () => {
          observedReason = signal.reason;
          reject(signal.reason);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    };

    const processing = processNextPaymentReconciliation({
      store,
      provider,
      now: new Date("2026-10-05T10:00:31.000Z"),
      heartbeatIntervalMilliseconds: 60_000,
      signal: shutdown.signal,
    });
    await started;
    shutdown.abort(shutdownReason);
    const result = await processing;

    assert.equal(observedReason, shutdownReason);
    assert.equal(result?.id, order.id);
    assert.equal(result?.status, "pending");
    const job = await store.getPaymentReconciliationJob(order.id);
    assert.equal(job?.state, "running");
    assert.equal(job?.lastErrorCode, null);
  });
});
