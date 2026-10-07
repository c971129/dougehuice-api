import { createHash, randomUUID } from "node:crypto";

import type { PaymentOrderRecord } from "../domain/models.js";
import { AppError } from "../errors.js";
import type { AppStore } from "../repositories/store.js";
import { startLeaseHeartbeat } from "../workers/lease-heartbeat.js";
import type { PaymentObservation, PaymentProvider } from "./provider.js";

const DEFAULT_LEASE_MILLISECONDS = 60_000;
const DEFAULT_NOTPAY_POLL_MILLISECONDS = 60_000;
const RETRY_BASE_MILLISECONDS = 30_000;
const RETRY_MAX_MILLISECONDS = 60 * 60_000;

function currentTime(fixed: Date | undefined): Date {
  return fixed ? new Date(fixed.getTime()) : new Date();
}

function retryDelayMilliseconds(orderId: string, attemptCount: number): number {
  const exponent = Math.min(7, Math.max(0, attemptCount - 1));
  const base = Math.min(RETRY_MAX_MILLISECONDS, RETRY_BASE_MILLISECONDS * 2 ** exponent);
  const byte = createHash("sha256").update(`${orderId}:${attemptCount}`).digest()[0] ?? 0;
  const jitter = Math.floor(base * 0.2 * (byte / 255));
  return Math.min(RETRY_MAX_MILLISECONDS, base + jitter);
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof AppError && /^[A-Z0-9_:-]{1,80}$/.test(error.code)) return error.code;
  return fallback;
}

async function latestOrder(store: AppStore, order: PaymentOrderRecord): Promise<PaymentOrderRecord> {
  return await store.getPaymentOrder(order.userId, order.id) ?? order;
}

async function applySuccess(input: {
  store: AppStore;
  provider: PaymentProvider;
  order: PaymentOrderRecord;
  observation: PaymentObservation;
  observedAt: string;
}): Promise<PaymentOrderRecord> {
  if (input.observation.tradeState !== "SUCCESS"
    || !input.observation.providerTransactionId
    || !input.observation.paidAt) {
    throw new AppError(502, "PAYMENT_PROVIDER_RESPONSE_INVALID", "支付平台成功状态缺少交易信息", null, true);
  }
  const applied = await input.store.applyPaymentSuccess({
    orderId: input.order.id,
    observedOutTradeNo: input.order.outTradeNo,
    eventKey: `query:${input.observation.providerTransactionId}:SUCCESS`,
    providerTransactionId: input.observation.providerTransactionId,
    providerTradeState: "SUCCESS",
    paidAt: input.observation.paidAt,
    observedAt: input.observedAt,
    source: input.provider.kind === "fake" ? "fake" : "wechat-query",
  });
  return applied.order;
}

export async function processNextPaymentReconciliation(input: {
  store: AppStore;
  provider: PaymentProvider;
  now?: Date;
  leaseMilliseconds?: number;
  heartbeatIntervalMilliseconds?: number;
  notpayPollMilliseconds?: number;
  signal?: AbortSignal;
}): Promise<PaymentOrderRecord | null> {
  const leaseToken = randomUUID();
  const leaseMilliseconds = input.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
  const claim = await input.store.claimNextPaymentReconciliation({
    leaseToken,
    leaseMilliseconds,
    ...(input.now ? { now: currentTime(input.now).toISOString() } : {}),
  });
  if (!claim) return null;

  const heartbeat = startLeaseHeartbeat({
    ...(input.signal ? { abortSignal: input.signal } : {}),
    intervalMilliseconds: input.heartbeatIntervalMilliseconds
      ?? Math.max(1, Math.floor(leaseMilliseconds / 3)),
    renew: async () => input.store.renewPaymentReconciliationLease({
      orderId: claim.order.id,
      leaseToken,
      leaseMilliseconds,
      ...(input.now ? { now: currentTime(input.now).toISOString() } : {}),
    }),
  });

  const retry = async (details: {
    providerTradeState?: "NOT_FOUND" | "NOTPAY" | "CLOSED";
    code: string;
    message: string;
  }): Promise<PaymentOrderRecord> => {
    await input.store.reschedulePaymentReconciliation({
      orderId: claim.order.id,
      leaseToken,
      ...(details.providerTradeState ? { providerTradeState: details.providerTradeState } : {}),
      errorCode: details.code,
      // Persist only fixed, redacted operational text; never an exception or provider body.
      errorMessage: details.message,
      delayMilliseconds: retryDelayMilliseconds(claim.order.id, claim.job.attemptCount),
      ...(input.now ? { now: currentTime(input.now).toISOString() } : {}),
    });
    return latestOrder(input.store, claim.order);
  };

  const observeTerminal = async (observation: PaymentObservation): Promise<PaymentOrderRecord> => {
    const observedAt = currentTime(input.now).toISOString();
    if (observation.tradeState === "SUCCESS") {
      // SUCCESS is monotonic and protected by applyPaymentSuccess's order lock and
      // unique ledger/event constraints. It must still converge after lease loss.
      return applySuccess({ store: input.store, provider: input.provider, order: claim.order, observation, observedAt });
    }
    if (heartbeat.signal.aborted) return latestOrder(input.store, claim.order);
    if (observation.tradeState === "CLOSED") {
      return input.store.applyPaymentObservation({
        orderId: claim.order.id,
        userId: claim.order.userId,
        providerTradeState: "CLOSED",
        observedAt,
        reconciliationLeaseToken: leaseToken,
      });
    }
    throw new AppError(500, "PAYMENT_RECONCILIATION_STATE_INVALID", "支付对账终态无效", null, false);
  };

  try {
    let observation: PaymentObservation;
    try {
      // Provider calls are deliberately outside every store transaction.
      observation = await input.provider.queryOrder(claim.order, heartbeat.signal);
    } catch (error) {
      if (heartbeat.signal.aborted) return latestOrder(input.store, claim.order);
      return await retry({
        code: errorCode(error, "PAYMENT_RECONCILIATION_QUERY_FAILED"),
        message: "支付平台查单暂时失败",
      });
    }

    if (observation.tradeState === "SUCCESS" || observation.tradeState === "CLOSED") {
      return await observeTerminal(observation);
    }
    if (observation.tradeState === "NOT_FOUND") {
      return await retry({
        providerTradeState: "NOT_FOUND",
        code: "PAYMENT_PROVIDER_ORDER_NOT_FOUND",
        message: "支付平台暂未找到该订单",
      });
    }

    const expiredAtClaim = Date.parse(claim.order.paymentExpiresAt) <= Date.parse(claim.claimedAt);
    if (!expiredAtClaim) {
      if (heartbeat.signal.aborted) return latestOrder(input.store, claim.order);
      const untilExpiry = Math.max(0, Date.parse(claim.order.paymentExpiresAt) - Date.parse(claim.claimedAt));
      const delayMilliseconds = Math.min(
        input.notpayPollMilliseconds ?? DEFAULT_NOTPAY_POLL_MILLISECONDS,
        untilExpiry,
      );
      return input.store.applyPaymentObservation({
        orderId: claim.order.id,
        userId: claim.order.userId,
        providerTradeState: "NOTPAY",
        observedAt: currentTime(input.now).toISOString(),
        reconciliationLeaseToken: leaseToken,
        nextReconciliationDelayMilliseconds: delayMilliseconds,
      });
    }

    if (!input.provider.closeOrder) {
      return await retry({
        providerTradeState: "NOTPAY",
        code: "PAYMENT_CLOSE_UNSUPPORTED",
        message: "支付 Provider 未配置安全关单能力",
      });
    }

    let closeFailed = false;
    try {
      await input.provider.closeOrder({
        orderId: claim.order.id,
        outTradeNo: claim.order.outTradeNo,
        amountCents: claim.order.amountCents,
        currency: claim.order.currency,
      }, heartbeat.signal);
    } catch {
      if (heartbeat.signal.aborted) return latestOrder(input.store, claim.order);
      closeFailed = true;
    }

    // Always arbitrate a close attempt with a second provider query. A close
    // timeout, ORDERPAID race, or process takeover must never become local CLOSED.
    let confirmation: PaymentObservation;
    try {
      confirmation = await input.provider.queryOrder(claim.order, heartbeat.signal);
    } catch (error) {
      if (heartbeat.signal.aborted) return latestOrder(input.store, claim.order);
      return await retry({
        providerTradeState: "NOTPAY",
        code: errorCode(error, "PAYMENT_CLOSE_CONFIRMATION_FAILED"),
        message: "关单后二次查单暂时失败",
      });
    }

    if (confirmation.tradeState === "SUCCESS" || confirmation.tradeState === "CLOSED") {
      return await observeTerminal(confirmation);
    }
    if (confirmation.tradeState === "NOT_FOUND") {
      return await retry({
        providerTradeState: "NOT_FOUND",
        code: "PAYMENT_CLOSE_CONFIRMATION_NOT_FOUND",
        message: "关单后二次查单暂未找到订单",
      });
    }
    if (heartbeat.signal.aborted) return latestOrder(input.store, claim.order);
    return input.store.applyPaymentObservation({
      orderId: claim.order.id,
      userId: claim.order.userId,
      providerTradeState: "NOTPAY",
      observedAt: currentTime(input.now).toISOString(),
      reconciliationLeaseToken: leaseToken,
      nextReconciliationDelayMilliseconds: retryDelayMilliseconds(claim.order.id, claim.job.attemptCount),
      reconciliationErrorCode: closeFailed ? "PAYMENT_CLOSE_RESULT_UNKNOWN" : "PAYMENT_CLOSE_UNCONFIRMED",
      reconciliationErrorMessage: closeFailed
        ? "关单调用结果不明确，二次查单仍未确认终态"
        : "关单后二次查单仍未确认终态",
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "PAYMENT_RECONCILIATION_LEASE_LOST") {
      return latestOrder(input.store, claim.order);
    }
    return await retry({
      code: errorCode(error, "PAYMENT_RECONCILIATION_FAILED"),
      message: "支付对账处理暂时失败",
    });
  } finally {
    await heartbeat.stop();
  }
}
