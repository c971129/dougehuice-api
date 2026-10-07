import { createHash, randomBytes } from "node:crypto";

import { AppError } from "../errors.js";
import { openPaymentProviderReference, sealPaymentProviderReference } from "./payment-recovery-token.js";
import type {
  MiniProgramPaymentParams,
  PaymentObservation,
  PaymentOrderIdentity,
  PaymentProvider,
} from "./provider.js";

const FAKE_RECOVERY_KEY = "pindou-fake-payment-recovery-key-v1";

export class FakePaymentProvider implements PaymentProvider {
  readonly kind = "fake" as const;
  private readonly observations = new Map<string, PaymentObservation>();
  private readonly currentTradeByOrderId = new Map<string, string>();

  private paymentParams(orderId: string, outTradeNo: string, providerReference: string): MiniProgramPaymentParams {
    const nonceStr = randomBytes(16).toString("hex");
    const timeStamp = Math.floor(Date.now() / 1_000).toString();
    const paySign = createHash("sha256")
      .update(`${orderId}\0${outTradeNo}\0${timeStamp}\0${nonceStr}`)
      .digest("base64");
    return {
      timeStamp,
      nonceStr,
      package: `prepay_id=${providerReference}`,
      signType: "RSA",
      paySign,
    };
  }

  async createOrder(input: Parameters<PaymentProvider["createOrder"]>[0]): Promise<{
    providerReference: string;
    paymentParams: MiniProgramPaymentParams;
    recoveryCiphertext: string;
  }> {
    const providerReference = `fake-prepay-${input.orderId}`;
    this.observations.set(input.outTradeNo, { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null });
    this.currentTradeByOrderId.set(input.orderId, input.outTradeNo);
    return {
      providerReference,
      paymentParams: this.paymentParams(input.orderId, input.outTradeNo, providerReference),
      recoveryCiphertext: sealPaymentProviderReference({
        providerReference,
        keyMaterial: FAKE_RECOVERY_KEY,
        orderId: input.orderId,
        outTradeNo: input.outTradeNo,
      }),
    };
  }

  async queryOrder(order: PaymentOrderIdentity, signal?: AbortSignal): Promise<PaymentObservation> {
    signal?.throwIfAborted();
    return this.observations.get(order.outTradeNo)
      ?? { tradeState: "NOT_FOUND", providerTransactionId: null, paidAt: null };
  }

  async recoverOrderSession(input: PaymentOrderIdentity & { recoveryCiphertext: string }) {
    const providerReference = openPaymentProviderReference({
      recoveryCiphertext: input.recoveryCiphertext,
      keyMaterial: FAKE_RECOVERY_KEY,
      orderId: input.orderId,
      outTradeNo: input.outTradeNo,
    });
    return {
      providerReference,
      paymentParams: this.paymentParams(input.orderId, input.outTradeNo, providerReference),
    };
  }

  async closeOrder(order: PaymentOrderIdentity, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const observation = this.observations.get(order.outTradeNo);
    if (!observation || observation.tradeState === "CLOSED") return;
    if (observation.tradeState === "SUCCESS") {
      throw new AppError(409, "WECHAT_PAY_REJECTED", "订单已支付，不能关闭", {
        providerCode: "ORDERPAID",
        providerStatus: 409,
      });
    }
    this.observations.set(order.outTradeNo, {
      tradeState: "CLOSED",
      providerTransactionId: null,
      paidAt: null,
    });
  }

  markSucceeded(orderId: string, paidAt = new Date().toISOString()): PaymentObservation {
    const outTradeNo = this.currentTradeByOrderId.get(orderId);
    if (!outTradeNo || !this.observations.has(outTradeNo)) {
      throw new AppError(404, "FAKE_PAYMENT_NOT_FOUND", "测试支付订单不存在");
    }
    const observation: PaymentObservation = {
      tradeState: "SUCCESS",
      providerTransactionId: `FAKE-${orderId}`,
      paidAt,
    };
    this.observations.set(outTradeNo, observation);
    return observation;
  }
}
