import type { CreditProduct, PaymentOrderRecord } from "../domain/models.js";

export interface MiniProgramPaymentParams {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: "RSA";
  paySign: string;
}

export interface PaymentObservation {
  tradeState: "NOT_FOUND" | "NOTPAY" | "SUCCESS" | "CLOSED";
  providerTransactionId: string | null;
  paidAt: string | null;
}

/**
 * The minimum immutable identity needed to reconcile a provider-side order.
 * This is deliberately usable before a local PaymentOrderRecord exists.
 */
export interface PaymentOrderIdentity {
  orderId: string;
  outTradeNo: string;
  amountCents: number;
  currency: "CNY";
}

export interface WechatPayNotification {
  notificationId: string;
  serial: string;
  appId: string;
  merchantId: string;
  outTradeNo: string;
  attach: string;
  providerTransactionId: string;
  tradeState: "SUCCESS";
  paidAt: string;
  amountCents: number;
  currency: "CNY";
}

export interface WechatPayNotificationInput {
  rawBody: string;
  serial: string;
  signature: string;
  timestamp: string;
  nonce: string;
}

export interface PaymentProvider {
  readonly kind: "fake" | "wechat-v3";
  readonly requiresPayerOpenId?: boolean;
  createOrder(input: {
    orderId: string;
    outTradeNo: string;
    userId: string;
    payerOpenId: string | null;
    product: CreditProduct;
    expiresAt: string;
  }): Promise<{
    providerReference: string;
    paymentParams: MiniProgramPaymentParams;
    /** Authenticated ciphertext containing only the provider prepay reference. */
    recoveryCiphertext?: string;
  }>;
  queryOrder(order: PaymentOrderIdentity | PaymentOrderRecord, signal?: AbortSignal): Promise<PaymentObservation>;
  /** Regenerate short-lived client parameters from a persisted encrypted prepay reference. */
  recoverOrderSession?(input: PaymentOrderIdentity & { recoveryCiphertext: string }): Promise<{
    providerReference: string;
    paymentParams: MiniProgramPaymentParams;
  }>;
  /** Close an unpaid provider order before rotating to a fresh merchant order number. */
  closeOrder?(order: PaymentOrderIdentity, signal?: AbortSignal): Promise<void>;
  parseNotification?(input: WechatPayNotificationInput): Promise<WechatPayNotification>;
}
