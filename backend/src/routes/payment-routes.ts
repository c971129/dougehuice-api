import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requireAuth } from "../auth.js";
import type { PaymentOrderRecord } from "../domain/models.js";
import { USER_RATE_LIMITS } from "../domain/resource-limits.js";
import { AppError } from "../errors.js";
import { FakePaymentProvider } from "../payments/fake-provider.js";
import type { MiniProgramPaymentParams, PaymentObservation, PaymentOrderIdentity } from "../payments/provider.js";
import {
  hashIdempotencyRequest,
  replayIdempotent,
  requireIdempotencyKey,
} from "../idempotency.js";
import type { AppStore, IdempotentExecutionResult } from "../repositories/store.js";
import { requireUserRateLimit } from "../rate-limit.js";
import { startLeaseHeartbeat } from "../workers/lease-heartbeat.js";
import type { RouteDependencies } from "./types.js";

const PAYMENT_EFFECT_WAIT_MILLISECONDS = 120;
const PAYMENT_EFFECT_POLL_MILLISECONDS = 10;

interface PaymentEffectLease {
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
  leaseToken: string;
}

const PaymentOrderIdParams = Type.Object(
  { paymentOrderId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const CreatePaymentOrderBody = Type.Object({
  productId: Type.String({ minLength: 1, maxLength: 80 }),
  productVersion: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
}, { additionalProperties: false });

function publicOrder(order: PaymentOrderRecord): Omit<
  PaymentOrderRecord,
  | "providerReference"
  | "outTradeNo"
  | "providerTransactionId"
  | "closedAt"
  | "lastReconciledAt"
  | "lateSuccessAt"
> {
  const {
    providerReference: _providerReference,
    outTradeNo: _outTradeNo,
    providerTransactionId: _providerTransactionId,
    closedAt: _closedAt,
    lastReconciledAt: _lastReconciledAt,
    lateSuccessAt: _lateSuccessAt,
    ...visible
  } = order;
  return visible;
}

function headerText(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function requireInternalWorker(request: FastifyRequest, expected: string): void {
  const candidateDigest = createHash("sha256").update(headerText(request, "x-internal-worker-key")).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(candidateDigest, expectedDigest)) {
    throw new AppError(401, "INTERNAL_AUTH_REQUIRED", "内部任务凭证无效");
  }
}

function stablePaymentIdentity(userId: string, idempotencyKey: string): { id: string; outTradeNo: string } {
  const digest = createHash("sha256")
    .update(`${userId}\0payment-orders:create\0${idempotencyKey}`)
    .digest();
  const uuidBytes = Buffer.from(digest.subarray(0, 16));
  uuidBytes[6] = ((uuidBytes[6] ?? 0) & 0x0f) | 0x40;
  uuidBytes[8] = ((uuidBytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = uuidBytes.toString("hex");
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    outTradeNo: `PD${digest.toString("hex").slice(0, 30).toUpperCase()}`,
  };
}

function stablePaymentTradeNo(userId: string, idempotencyKey: string, attemptNo: number): string {
  if (attemptNo === 1) return stablePaymentIdentity(userId, idempotencyKey).outTradeNo;
  const digest = createHash("sha256")
    .update(`${userId}\0payment-orders:create\0${idempotencyKey}\0attempt:${attemptNo}`)
    .digest("hex");
  return `PD${digest.slice(0, 30).toUpperCase()}`;
}

function providerCode(error: unknown): string | null {
  if (!(error instanceof AppError) || typeof error.details !== "object" || error.details === null) return null;
  const code = (error.details as Record<string, unknown>).providerCode;
  return typeof code === "string" ? code : null;
}

function paymentIdentity(input: {
  orderId: string;
  outTradeNo: string;
  amountCents: number;
  currency: "CNY";
}): PaymentOrderIdentity {
  return {
    orderId: input.orderId,
    outTradeNo: input.outTradeNo,
    amountCents: input.amountCents,
    currency: input.currency,
  };
}

type PublicPaymentOrder = ReturnType<typeof publicOrder>;
interface StoredPaymentCreateResponse {
  order: PublicPaymentOrder;
}

interface StoredPaymentRefreshResponse {
  order: PublicPaymentOrder;
  credited: boolean;
}

const CONVERGIBLE_REFRESH_ERROR_CODES = new Set([
  "WECHAT_PAY_UNAVAILABLE",
]);

function canConvergeRefreshFailureFromLocalSuccess(error: unknown): boolean {
  return error instanceof AppError
    && error.statusCode >= 500
    && error.retryable === true
    && CONVERGIBLE_REFRESH_ERROR_CODES.has(error.code);
}

function canConvergeRefreshState(status: PaymentOrderRecord["status"]): boolean {
  return status === "pending" || status === "closed";
}

async function persistLocalSucceededRefresh(input: {
  store: AppStore;
  lease: PaymentEffectLease;
  userId: string;
  orderId: string;
  fallbackError: unknown;
}): Promise<IdempotentExecutionResult<StoredPaymentRefreshResponse>> {
  return input.store.executePaymentEffectIdempotent<StoredPaymentRefreshResponse>(
    input.lease,
    async (transactionStore) => {
      const current = await transactionStore.getPaymentOrder(input.userId, input.orderId);
      if (!current || current.status !== "succeeded") throw input.fallbackError;
      return {
        statusCode: 200,
        body: { order: publicOrder(current), credited: false },
      };
    },
  );
}

async function restoredPaymentParams(input: {
  store: AppStore;
  provider: RouteDependencies["paymentProvider"];
  userId: string;
  order: PublicPaymentOrder;
}): Promise<MiniProgramPaymentParams | null> {
  if (input.order.status !== "pending" || !input.provider.recoverOrderSession) return null;
  const attempt = await input.store.getPaymentOrderRecoveryAttempt(input.userId, input.order.id);
  if (!attempt?.recoveryCiphertext || attempt.expired || attempt.state !== "created") return null;
  let recovered: Awaited<ReturnType<NonNullable<RouteDependencies["paymentProvider"]["recoverOrderSession"]>>>;
  try {
    recovered = await input.provider.recoverOrderSession({
      ...paymentIdentity({
        orderId: input.order.id,
        outTradeNo: attempt.outTradeNo,
        amountCents: input.order.amountCents,
        currency: input.order.currency,
      }),
      recoveryCiphertext: attempt.recoveryCiphertext,
    });
  } catch (error) {
    // A rotated/lost API v3 key must not leak ciphertext details or turn a
    // historical idempotent replay into a permanent 5xx loop.
    if (error instanceof AppError && error.code === "PAYMENT_RECOVERY_TOKEN_INVALID") return null;
    throw error;
  }
  const expectedHash = attempt.providerReferenceSha256;
  if (!expectedHash || createHash("sha256").update(recovered.providerReference).digest("hex") !== expectedHash) {
    throw new AppError(503, "PAYMENT_RECOVERY_RESULT_CONFLICT", "支付恢复结果校验失败，请稍后重试", null, true);
  }
  return recovered.paymentParams;
}

async function replayPaymentCreate(input: {
  store: AppStore;
  provider: RouteDependencies["paymentProvider"];
  userId: string;
  scope: string;
  key: string;
  payload: unknown;
  reply: FastifyReply;
}): Promise<boolean> {
  const existing = await input.store.getIdempotent<StoredPaymentCreateResponse & { paymentParams?: unknown }>({
    userId: input.userId,
    scope: input.scope,
    key: input.key,
    requestHash: hashIdempotencyRequest(input.payload),
  });
  if (!existing) return false;
  const paymentParams = await restoredPaymentParams({
    store: input.store,
    provider: input.provider,
    userId: input.userId,
    order: existing.body.order,
  });
  const paymentSessionStatus = paymentParams
    ? "ready"
    : existing.body.order.status === "pending" ? "unavailable" : "not-required";
  input.reply.header("Idempotency-Replayed", "true");
  input.reply.code(existing.statusCode).send({ order: existing.body.order, paymentParams, paymentSessionStatus });
  return true;
}

async function claimPaymentEffectOrReplay(input: {
  store: AppStore;
  userId: string;
  scope: string;
  key: string;
  payload: unknown;
  reply: Parameters<typeof replayIdempotent>[0]["reply"];
  leaseMilliseconds: number;
  replay?: () => Promise<boolean>;
}): Promise<PaymentEffectLease | null> {
  const requestHash = hashIdempotencyRequest(input.payload);
  const leaseToken = randomUUID();
  const waitDeadline = Date.now() + PAYMENT_EFFECT_WAIT_MILLISECONDS;
  let leaseExpiresAt = new Date(Date.now() + input.leaseMilliseconds).toISOString();

  while (true) {
    const now = new Date();
    leaseExpiresAt = new Date(now.getTime() + input.leaseMilliseconds).toISOString();
    const claim = await input.store.claimPaymentEffect({
      userId: input.userId,
      scope: input.scope,
      key: input.key,
      requestHash,
      leaseToken,
      now: now.toISOString(),
      leaseExpiresAt,
    });
    if (claim.acquired) {
      const replayed = input.replay ? await input.replay() : await replayIdempotent({
          store: input.store,
          userId: input.userId,
          scope: input.scope,
          key: input.key,
          payload: input.payload,
          reply: input.reply,
        });
      if (replayed) {
        await input.store.completePaymentEffectClaim({
          userId: input.userId,
          scope: input.scope,
          key: input.key,
          leaseToken,
        }).catch(() => false);
        return null;
      }
      return { userId: input.userId, scope: input.scope, key: input.key, requestHash, leaseToken };
    }

    if (Date.now() >= waitDeadline) {
      throw new AppError(409, "IDEMPOTENCY_IN_PROGRESS", "相同幂等请求正在处理中，请稍后重试", {
        retryAfterMilliseconds: Math.max(1, Date.parse(claim.leaseExpiresAt) - Date.now()),
      }, true);
    }
    await delay(PAYMENT_EFFECT_POLL_MILLISECONDS);
    const replayed = input.replay ? await input.replay() : await replayIdempotent({
        store: input.store,
        userId: input.userId,
        scope: input.scope,
        key: input.key,
        payload: input.payload,
        reply: input.reply,
      });
    if (replayed) return null;
  }
}

function assertPaymentEffectLease(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AppError(503, "PAYMENT_EFFECT_LEASE_LOST", "支付请求处理租约已失效，请重试", null, true);
  }
}

async function finalizePaymentEffectLease(
  store: AppStore,
  lease: PaymentEffectLease,
  committed: boolean,
  logFailure: (error: unknown) => void,
): Promise<void> {
  try {
    if (!committed) {
      await store.releasePaymentEffectClaim({ ...lease, releasedAt: new Date().toISOString() });
    }
  } catch (error) {
    logFailure(error);
  }
}

export async function registerPaymentRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  await app.register(async (notificationApp) => {
    notificationApp.removeContentTypeParser("application/json");
    notificationApp.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: 64 * 1024 },
      (_request, body, done) => done(null, body),
    );
    notificationApp.post<{ Body: string }>("/wechat-pay/notifications", {
      schema: { tags: ["payments"], summary: "接收、验签并幂等入账微信支付成功通知" },
    }, async (request, reply) => {
      try {
        if (!dependencies.paymentProvider.parseNotification || dependencies.paymentProvider.kind !== "wechat-v3") {
          throw new AppError(404, "WECHAT_PAY_NOTIFICATION_DISABLED", "微信支付通知尚未配置");
        }
        if (typeof request.body !== "string" || Buffer.byteLength(request.body, "utf8") > 64 * 1024) {
          throw new AppError(400, "WECHAT_PAY_NOTIFICATION_INVALID", "微信支付通知正文无效");
        }
        const notification = await dependencies.paymentProvider.parseNotification({
          rawBody: request.body,
          serial: headerText(request, "wechatpay-serial"),
          signature: headerText(request, "wechatpay-signature"),
          timestamp: headerText(request, "wechatpay-timestamp"),
          nonce: headerText(request, "wechatpay-nonce"),
        });
        const order = await dependencies.store.getPaymentOrderByOutTradeNo(notification.outTradeNo);
        if (!order) throw new AppError(404, "PAYMENT_ORDER_NOT_FOUND", "支付订单不存在");
        if (notification.attach !== order.id) {
          throw new AppError(409, "PAYMENT_ATTACH_MISMATCH", "微信支付通知绑定值与本地订单不一致");
        }
        if (order.amountCents !== notification.amountCents || order.currency !== notification.currency) {
          throw new AppError(409, "PAYMENT_AMOUNT_MISMATCH", "微信支付通知金额与本地订单不一致");
        }
        await dependencies.store.applyPaymentSuccess({
          orderId: order.id,
          observedOutTradeNo: notification.outTradeNo,
          eventKey: `notify:${notification.notificationId}`,
          providerTransactionId: notification.providerTransactionId,
          providerTradeState: "SUCCESS",
          paidAt: notification.paidAt,
          observedAt: new Date().toISOString(),
          source: "wechat-notify",
          notificationId: notification.notificationId,
          rawBodySha256: createHash("sha256").update(request.body).digest("hex"),
          wechatSerial: notification.serial,
        });
        return reply.code(204).send();
      } catch (error) {
        request.log.warn({ err: error }, "wechat payment notification rejected");
        const statusCode = error instanceof AppError ? error.statusCode : 500;
        return reply.code(statusCode).send({
          code: "FAIL",
          message: statusCode >= 500 ? "服务暂时不可用" : "通知验证失败",
        });
      }
    });
  });

  app.get("/credit-products", {
    schema: { tags: ["payments"], summary: "读取服务端定价的 AI 次数商品" },
  }, async (request) => {
    await requireAuth(request, dependencies.store);
    return { products: await dependencies.store.listCreditProducts() };
  });

  app.post<{ Body: Static<typeof CreatePaymentOrderBody> }>("/payment-orders", {
    schema: { tags: ["payments"], summary: "按服务端商品快照创建支付订单", body: CreatePaymentOrderBody },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const scope = "payment-orders:create";
    const tryReplay = () => replayPaymentCreate({
      store: dependencies.store,
      provider: dependencies.paymentProvider,
      userId: user.id,
      scope,
      key,
      payload: request.body,
      reply,
    });
    const replayed = await tryReplay();
    if (replayed) return reply;
    const product = await dependencies.store.getCreditProduct(request.body.productId, request.body.productVersion);
    if (!product) throw new AppError(404, "CREDIT_PRODUCT_NOT_FOUND", "次数商品不存在或已下架");
    await requireUserRateLimit(dependencies.store, user.id, USER_RATE_LIMITS.paymentCreate);
    const lease = await claimPaymentEffectOrReplay({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: request.body,
      reply,
      leaseMilliseconds: dependencies.paymentEffectLeaseMilliseconds,
      replay: tryReplay,
    });
    if (!lease) return reply;
    const heartbeat = startLeaseHeartbeat({
      intervalMilliseconds: Math.max(1, Math.floor(dependencies.paymentEffectLeaseMilliseconds / 3)),
      renew: async () => {
        const heartbeatNow = new Date();
        return dependencies.store.renewPaymentEffectClaim({
          ...lease,
          now: heartbeatNow.toISOString(),
          leaseExpiresAt: new Date(heartbeatNow.getTime() + dependencies.paymentEffectLeaseMilliseconds).toISOString(),
        });
      },
    });
    const { id, outTradeNo } = stablePaymentIdentity(user.id, key);
    const now = new Date();
    const proposedPaymentExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    let slotCreated = false;
    let providerCallStarted = false;
    let effectCommitted = false;
    try {
      let reservation = await dependencies.store.reservePaymentOrderSlot({
        userId: user.id,
        orderId: id,
        outTradeNo,
        expiresAt: proposedPaymentExpiresAt,
        now: now.toISOString(),
        effectFence: lease,
      });
      slotCreated = reservation.created;
      const payerOpenId = await dependencies.store.getWechatOpenId(user.id);
      if (dependencies.paymentProvider.requiresPayerOpenId && !payerOpenId) {
        throw new AppError(409, "WECHAT_IDENTITY_REQUIRED", "当前账号尚未绑定微信身份，请重新登录");
      }

      let paymentParams: MiniProgramPaymentParams | null = null;
      let providerReferenceSha256: string | null = null;
      let successfulObservation: Extract<PaymentObservation, { tradeState: "SUCCESS" }> | PaymentObservation | null = null;
      const providerUsedTradeNos = new Set<string>();

      // At most one legacy/ambiguous attempt plus a fresh rotated attempt is
      // normally needed. The bound prevents a faulty Provider from spinning a
      // request forever while every transition remains durably auditable.
      for (let recoveryStep = 0; recoveryStep < 4; recoveryStep += 1) {
        assertPaymentEffectLease(heartbeat.signal);
        const identity = paymentIdentity({
          orderId: id,
          outTradeNo: reservation.outTradeNo,
          amountCents: product.amountCents,
          currency: product.currency,
        });

        if (reservation.state === "created"
          && !reservation.expired
          && reservation.recoveryCiphertext
          && dependencies.paymentProvider.recoverOrderSession) {
          try {
            const recovered = await dependencies.paymentProvider.recoverOrderSession({
              ...identity,
              recoveryCiphertext: reservation.recoveryCiphertext,
            });
            const recoveredHash = createHash("sha256").update(recovered.providerReference).digest("hex");
            if (recoveredHash !== reservation.providerReferenceSha256) {
              throw new AppError(503, "PAYMENT_RECOVERY_RESULT_CONFLICT", "支付恢复结果校验失败，请稍后重试", null, true);
            }
            paymentParams = recovered.paymentParams;
            providerReferenceSha256 = recoveredHash;
            break;
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== "PAYMENT_RECOVERY_TOKEN_INVALID") throw error;
            request.log.warn({ orderId: id, attemptNo: reservation.attemptNo }, "payment recovery token unavailable; reconciling provider order");
          }
        }

        let mayCreateCurrentAttempt = reservation.state === "reserved" && !reservation.expired;
        let mustRotate = reservation.state === "reserved" && reservation.expired;
        if (!mayCreateCurrentAttempt && !mustRotate) {
          // The previous process may have reached WeChat even when no local
          // prepay envelope exists. Query first; never repeat create blindly.
          providerCallStarted = true;
          let observation = await dependencies.paymentProvider.queryOrder(identity);
          assertPaymentEffectLease(heartbeat.signal);
          if (observation.tradeState === "SUCCESS") {
            successfulObservation = observation;
            providerReferenceSha256 = createHash("sha256")
              .update(`unavailable\0${reservation.outTradeNo}`)
              .digest("hex");
            break;
          }
          if (observation.tradeState === "NOT_FOUND") {
            if (providerUsedTradeNos.has(reservation.outTradeNo)) {
              throw new AppError(
                503,
                "PAYMENT_PROVIDER_STATE_UNCERTAIN",
                "支付平台订单状态尚未收敛，请稍后重试",
                { providerCode: "OUT_TRADE_NO_USED" },
                true,
              );
            }
            mayCreateCurrentAttempt = !reservation.expired;
            mustRotate = reservation.expired;
          } else if (observation.tradeState === "CLOSED") {
            mustRotate = true;
          } else if (observation.tradeState === "NOTPAY") {
            if (!dependencies.paymentProvider.closeOrder) {
              throw new AppError(503, "PAYMENT_RECOVERY_UNSUPPORTED", "支付平台暂不支持安全恢复，请稍后重试", null, true);
            }
            let closeError: unknown = null;
            try {
              // Query and close are external calls and deliberately remain
              // outside every local database transaction.
              await dependencies.paymentProvider.closeOrder(identity);
            } catch (error) {
              closeError = error;
            }
            // Even a successful close response can be lost or race with a
            // payment. Query the exact same identity again and rotate only
            // after WeChat reports the terminal CLOSED state.
            observation = await dependencies.paymentProvider.queryOrder(identity);
            assertPaymentEffectLease(heartbeat.signal);
            if (observation.tradeState === "SUCCESS") {
              successfulObservation = observation;
              providerReferenceSha256 = createHash("sha256")
                .update(`unavailable\0${reservation.outTradeNo}`)
                .digest("hex");
              break;
            }
            if (observation.tradeState === "CLOSED") {
              mustRotate = true;
            } else {
              throw new AppError(503, "PAYMENT_PROVIDER_STATE_UNCERTAIN", "原支付订单关单结果尚未确认，请稍后重试", {
                providerCode: providerCode(closeError),
                tradeState: observation.tradeState,
              }, true);
            }
          }
        }

        if (successfulObservation) break;
        if (mustRotate) {
          const rotatedAt = new Date();
          const nextAttemptNo = reservation.attemptNo + 1;
          reservation = await dependencies.store.rotatePaymentOrderProviderAttempt({
            userId: user.id,
            orderId: id,
            previousOutTradeNo: reservation.outTradeNo,
            nextOutTradeNo: stablePaymentTradeNo(user.id, key, nextAttemptNo),
            expiresAt: new Date(rotatedAt.getTime() + 10 * 60_000).toISOString(),
            rotatedAt: rotatedAt.toISOString(),
            effectFence: lease,
          });
          continue;
        }
        if (!mayCreateCurrentAttempt) {
          throw new AppError(503, "PAYMENT_RECOVERY_RETRY", "支付订单恢复尚未完成，请稍后重试", null, true);
        }

        reservation = await dependencies.store.beginPaymentOrderProviderAttempt({
          userId: user.id,
          orderId: id,
          outTradeNo: reservation.outTradeNo,
          startedAt: new Date().toISOString(),
          effectFence: lease,
        });
        providerCallStarted = true;
        let providerResult: Awaited<ReturnType<RouteDependencies["paymentProvider"]["createOrder"]>>;
        try {
          providerResult = await dependencies.paymentProvider.createOrder({
            orderId: id,
            outTradeNo: reservation.outTradeNo,
            userId: user.id,
            payerOpenId,
            product,
            expiresAt: reservation.expiresAt,
          });
        } catch (error) {
          if (providerCode(error) !== "OUT_TRADE_NO_USED") throw error;
          // WeChat does not return the original prepay_id for a duplicate
          // merchant order number. Preserve this identity and converge through
          // query/close on the next recovery iteration.
          providerUsedTradeNos.add(reservation.outTradeNo);
          continue;
        }
        assertPaymentEffectLease(heartbeat.signal);
        paymentParams = providerResult.paymentParams;
        providerReferenceSha256 = createHash("sha256").update(providerResult.providerReference).digest("hex");
        if (providerResult.recoveryCiphertext) {
          reservation = await dependencies.store.recordPaymentOrderProviderResult({
            userId: user.id,
            orderId: id,
            outTradeNo: reservation.outTradeNo,
            recoveryCiphertext: providerResult.recoveryCiphertext,
            providerReferenceSha256,
            recordedAt: new Date().toISOString(),
            effectFence: lease,
          });
        }
        break;
      }

      if (!providerReferenceSha256 || (!paymentParams && successfulObservation?.tradeState !== "SUCCESS")) {
        throw new AppError(503, "PAYMENT_RECOVERY_RETRY", "支付订单恢复尚未完成，请稍后重试", null, true);
      }
      assertPaymentEffectLease(heartbeat.signal);
      const committedProviderReferenceSha256 = providerReferenceSha256;
      const committedObservation = successfulObservation;
      const result = await dependencies.store.executePaymentEffectIdempotent<StoredPaymentCreateResponse>(
        lease,
        async (transactionStore) => {
          let order = await transactionStore.createPaymentOrder({
            id,
            userId: user.id,
            product,
            outTradeNo: reservation.outTradeNo,
            providerReference: `sha256:${committedProviderReferenceSha256}`,
            paymentExpiresAt: reservation.expiresAt,
            now: new Date().toISOString(),
          });
          if (committedObservation?.tradeState === "SUCCESS") {
            if (!committedObservation.providerTransactionId || !committedObservation.paidAt) {
              throw new AppError(502, "PAYMENT_PROVIDER_RESPONSE_INVALID", "支付平台返回成功状态但缺少交易信息");
            }
            const applied = await transactionStore.applyPaymentSuccess({
              orderId: id,
              observedOutTradeNo: reservation.outTradeNo,
              eventKey: `query:${committedObservation.providerTransactionId}:SUCCESS`,
              providerTransactionId: committedObservation.providerTransactionId,
              providerTradeState: "SUCCESS",
              paidAt: committedObservation.paidAt,
              observedAt: new Date().toISOString(),
              source: dependencies.paymentProvider.kind === "fake" ? "fake" : "wechat-query",
            });
            order = applied.order;
          }
          return {
            statusCode: 201,
            // Never persist prepay_id/paymentParams in api_idempotency. Replays
            // dynamically decrypt the minimal attempt envelope and re-sign.
            body: { order: publicOrder(order) },
          };
        },
      );
      const responsePaymentParams = result.body.order.status === "pending"
        ? (result.replayed
          ? await restoredPaymentParams({
            store: dependencies.store,
            provider: dependencies.paymentProvider,
            userId: user.id,
            order: result.body.order,
          })
          : paymentParams)
        : null;
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      effectCommitted = true;
      return reply.code(result.statusCode).send({
        order: result.body.order,
        paymentParams: responsePaymentParams,
        paymentSessionStatus: responsePaymentParams
          ? "ready"
          : result.body.order.status === "pending" ? "unavailable" : "not-required",
      });
    } catch (error) {
      if (slotCreated && !providerCallStarted) {
        await dependencies.store.releasePaymentOrderSlot({
          userId: user.id,
          orderId: id,
          effectFence: lease,
        }).catch((releaseError) => {
          request.log.error({ err: releaseError }, "failed to release payment order slot");
        });
      }
      throw error;
    } finally {
      await heartbeat.stop();
      await finalizePaymentEffectLease(dependencies.store, lease, effectCommitted, (error) => {
        request.log.error({ err: error }, "failed to finalize payment effect claim");
      });
    }
  });

  app.get<{ Params: Static<typeof PaymentOrderIdParams> }>("/payment-orders/:paymentOrderId", {
    schema: { tags: ["payments"], summary: "读取本地权威支付订单状态", params: PaymentOrderIdParams },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const order = await dependencies.store.getPaymentOrder(user.id, request.params.paymentOrderId);
    if (!order) throw new AppError(404, "PAYMENT_ORDER_NOT_FOUND", "支付订单不存在");
    return { order: publicOrder(order) };
  });

  app.post<{ Params: Static<typeof PaymentOrderIdParams> }>("/payment-orders/:paymentOrderId/refresh", {
    schema: { tags: ["payments"], summary: "由服务端 Provider 查单并刷新权威状态", params: PaymentOrderIdParams },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const existing = await dependencies.store.getPaymentOrder(user.id, request.params.paymentOrderId);
    if (!existing) throw new AppError(404, "PAYMENT_ORDER_NOT_FOUND", "支付订单不存在");
    const scope = `payment-orders:${existing.id}:refresh`;
    const replayed = await replayIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: null,
      reply,
    });
    if (replayed) return reply;
    await requireUserRateLimit(dependencies.store, user.id, USER_RATE_LIMITS.paymentRefresh);
    const lease = await claimPaymentEffectOrReplay({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: null,
      reply,
      leaseMilliseconds: dependencies.paymentEffectLeaseMilliseconds,
    });
    if (!lease) return reply;
    const heartbeat = startLeaseHeartbeat({
      intervalMilliseconds: Math.max(1, Math.floor(dependencies.paymentEffectLeaseMilliseconds / 3)),
      renew: async () => {
        const heartbeatNow = new Date();
        return dependencies.store.renewPaymentEffectClaim({
          ...lease,
          now: heartbeatNow.toISOString(),
          leaseExpiresAt: new Date(heartbeatNow.getTime() + dependencies.paymentEffectLeaseMilliseconds).toISOString(),
        });
      },
    });
    let effectCommitted = false;
    try {
      const commitLocalSucceededResponse = async (fallbackError: unknown) => {
        assertPaymentEffectLease(heartbeat.signal);
        const result = await persistLocalSucceededRefresh({
          store: dependencies.store,
          lease,
          userId: user.id,
          orderId: existing.id,
          fallbackError,
        });
        if (result.replayed) reply.header("Idempotency-Replayed", "true");
        effectCommitted = true;
        return reply.code(result.statusCode).send(result.body);
      };

      // Re-read after acquiring the effect lease. A notification or the
      // reconciliation worker may have completed the order while this request
      // was waiting. A succeeded order is locally authoritative and needs no
      // further Provider call, but the new refresh key must still be persisted
      // through the same fenced idempotency transaction.
      const current = await dependencies.store.getPaymentOrder(user.id, existing.id);
      if (!current) throw new AppError(404, "PAYMENT_ORDER_NOT_FOUND", "支付订单不存在");
      if (current.status === "succeeded") {
        return await commitLocalSucceededResponse(
          new AppError(503, "PAYMENT_REFRESH_STATE_CHANGED", "支付订单状态尚未收敛，请稍后重试", null, true),
        );
      }

      let observation: PaymentObservation;
      try {
        observation = await dependencies.paymentProvider.queryOrder(current);
      } catch (error) {
        // Only the explicitly classified Provider availability failure may
        // converge to a concurrently committed local success. Integrity,
        // verification, and unknown failures retain their original semantics.
        if (!canConvergeRefreshState(current.status) || !canConvergeRefreshFailureFromLocalSuccess(error)) throw error;
        return await commitLocalSucceededResponse(error);
      }
      assertPaymentEffectLease(heartbeat.signal);
      if (observation.tradeState === "NOT_FOUND") {
        const notFoundError = new AppError(
          502,
          "PAYMENT_PROVIDER_ORDER_NOT_FOUND",
          "支付平台中未找到该订单",
          null,
          true,
        );
        if (canConvergeRefreshState(current.status)) return await commitLocalSucceededResponse(notFoundError);
        throw notFoundError;
      }
      const result = await dependencies.store.executePaymentEffectIdempotent(
        lease,
        async (transactionStore) => {
          const observedAt = new Date().toISOString();
          const providerTradeState = observation.tradeState;
          if (providerTradeState === "NOT_FOUND") {
            throw new AppError(502, "PAYMENT_PROVIDER_ORDER_NOT_FOUND", "支付平台中未找到该订单", null, true);
          }
          if (providerTradeState !== "SUCCESS") {
            const observed = await transactionStore.applyPaymentObservation({
              orderId: current.id,
              userId: user.id,
              providerTradeState,
              observedAt,
            });
            return { statusCode: 200, body: { order: publicOrder(observed), credited: false } };
          }
          if (!observation.providerTransactionId || !observation.paidAt) {
            throw new AppError(502, "PAYMENT_PROVIDER_RESPONSE_INVALID", "支付平台返回成功状态但缺少交易信息");
          }
          const applied = await transactionStore.applyPaymentSuccess({
            orderId: current.id,
            observedOutTradeNo: current.outTradeNo,
            eventKey: `query:${observation.providerTransactionId}:SUCCESS`,
            providerTransactionId: observation.providerTransactionId,
            providerTradeState: "SUCCESS",
            paidAt: observation.paidAt,
            observedAt,
            source: dependencies.paymentProvider.kind === "fake" ? "fake" : "wechat-query",
          });
          return { statusCode: 200, body: { order: publicOrder(applied.order), credited: applied.credited } };
        },
      );
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      effectCommitted = true;
      return reply.code(result.statusCode).send(result.body);
    } finally {
      await heartbeat.stop();
      await finalizePaymentEffectLease(dependencies.store, lease, effectCommitted, (error) => {
        request.log.error({ err: error }, "failed to finalize payment effect claim");
      });
    }
  });

  app.post<{ Params: Static<typeof PaymentOrderIdParams> }>("/internal/fake-payments/:paymentOrderId/succeed", {
    schema: { tags: ["payments-internal"], summary: "仅本地测试：让 Fake Provider 返回支付成功", params: PaymentOrderIdParams },
  }, async (request, reply) => {
    requireInternalWorker(request, dependencies.config.internalWorkerKey);
    if (!(dependencies.paymentProvider instanceof FakePaymentProvider) || dependencies.config.nodeEnv === "production") {
      throw new AppError(404, "ROUTE_NOT_FOUND", "接口不存在");
    }
    dependencies.paymentProvider.markSucceeded(request.params.paymentOrderId);
    return reply.code(202).send({ accepted: true });
  });
}
