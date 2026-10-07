import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import { AppError } from "../errors.js";
import type { PaymentOrderRecord } from "../domain/models.js";
import type {
  MiniProgramPaymentParams,
  PaymentObservation,
  PaymentOrderIdentity,
  PaymentProvider,
  WechatPayNotification,
  WechatPayNotificationInput,
} from "./provider.js";
import { openPaymentProviderReference, sealPaymentProviderReference } from "./payment-recovery-token.js";

const DEFAULT_API_BASE_URL = "https://api.mch.weixin.qq.com";
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const MAX_SIGNED_MESSAGE_AGE_SECONDS = 300;
const MAX_ADDITIONAL_VERIFIERS = 8;

export interface WechatPayV3ProviderOptions {
  appId: string;
  merchantId: string;
  merchantCertificateSerial: string;
  merchantPrivateKeyPem: string | Buffer;
  verifierSerial: string;
  verifierPublicKeyPem: string | Buffer;
  additionalVerifierPublicKeys?: Readonly<Record<string, string | Buffer>>;
  apiV3Key: string | Buffer;
  notifyUrl: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMilliseconds?: number;
  now?: () => number;
  nonce?: () => string;
}

interface WechatApiErrorPayload {
  code?: unknown;
  message?: unknown;
}

interface WechatPrepayPayload {
  prepay_id?: unknown;
}

interface WechatQueryPayload {
  appid?: unknown;
  mchid?: unknown;
  out_trade_no?: unknown;
  attach?: unknown;
  amount?: unknown;
  transaction_id?: unknown;
  trade_state?: unknown;
  success_time?: unknown;
}

interface WechatNotificationEnvelope {
  id?: unknown;
  event_type?: unknown;
  resource_type?: unknown;
  resource?: unknown;
}

interface WechatEncryptedResource {
  algorithm?: unknown;
  ciphertext?: unknown;
  associated_data?: unknown;
  nonce?: unknown;
}

interface WechatTransactionNotification {
  appid?: unknown;
  mchid?: unknown;
  out_trade_no?: unknown;
  trade_type?: unknown;
  attach?: unknown;
  transaction_id?: unknown;
  trade_state?: unknown;
  success_time?: unknown;
  amount?: unknown;
}

function requiredText(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} 不能为空`);
  return normalized;
}

function normalizeVerifierSerial(name: string, value: string): string {
  const normalized = requiredText(name, value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) {
    throw new Error(`${name} 必须是有效的微信支付证书序列号或公钥 ID`);
  }
  return normalized;
}

function header(response: Response, name: string): string {
  return response.headers.get(name)?.trim() ?? "";
}

function parseJsonObject(raw: string, errorCode: string, message: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(502, errorCode, message, null, true);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(502, errorCode, message, null, true);
  }
  return parsed as Record<string, unknown>;
}

function integerTimestamp(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("微信支付 API 地址必须使用 HTTPS");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("微信支付 API 地址不能包含路径、查询串或片段");
  }
  return url.origin;
}

function validateNotifyUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.search || url.hash) {
    throw new Error("WECHAT_PAY_NOTIFY_URL 必须是无查询串和片段的 HTTPS 地址");
  }
  return url.toString();
}

function readApiV3Key(value: string | Buffer): Buffer {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (key.length !== 32) throw new Error("WECHAT_PAY_API_V3_KEY 必须恰好为 32 字节");
  return key;
}

export class WechatPayV3Provider implements PaymentProvider {
  readonly kind = "wechat-v3" as const;
  readonly requiresPayerOpenId = true;
  private readonly appId: string;
  private readonly merchantId: string;
  private readonly merchantCertificateSerial: string;
  private readonly merchantPrivateKey: KeyObject;
  private readonly primaryVerifierSerial: string;
  private readonly verifierPublicKeys: ReadonlyMap<string, KeyObject>;
  private readonly apiV3Key: Buffer;
  private readonly notifyUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMilliseconds: number;
  private readonly now: () => number;
  private readonly nonce: () => string;

  constructor(options: WechatPayV3ProviderOptions) {
    this.appId = requiredText("WECHAT_APP_ID", options.appId);
    this.merchantId = requiredText("WECHAT_PAY_MCH_ID", options.merchantId);
    this.merchantCertificateSerial = requiredText(
      "WECHAT_PAY_MERCHANT_CERT_SERIAL",
      options.merchantCertificateSerial,
    );
    this.merchantPrivateKey = createPrivateKey(options.merchantPrivateKeyPem);
    if (this.merchantPrivateKey.asymmetricKeyType !== "rsa") {
      throw new Error("微信支付商户私钥必须是 RSA 私钥");
    }
    const primaryVerifierSerial = normalizeVerifierSerial("WECHAT_PAY_VERIFIER_SERIAL", options.verifierSerial);
    this.primaryVerifierSerial = primaryVerifierSerial;
    const additionalVerifierEntries = Object.entries(options.additionalVerifierPublicKeys ?? {});
    if (additionalVerifierEntries.length > MAX_ADDITIONAL_VERIFIERS) {
      throw new Error(`微信支付 additional verifier 最多允许 ${MAX_ADDITIONAL_VERIFIERS} 个`);
    }
    const verifierPublicKeys = new Map<string, KeyObject>();
    const verifierEntries: Array<readonly [string, string | Buffer]> = [
      [primaryVerifierSerial, options.verifierPublicKeyPem],
      ...additionalVerifierEntries,
    ];
    for (const [serial, pem] of verifierEntries) {
      const normalizedSerial = normalizeVerifierSerial("微信支付 verifier serial", serial);
      if (verifierPublicKeys.has(normalizedSerial)) {
        throw new Error(`微信支付 verifier serial 重复：${normalizedSerial}`);
      }
      const publicKey = createPublicKey(pem);
      if (publicKey.asymmetricKeyType !== "rsa") throw new Error("微信支付验签公钥必须是 RSA 公钥");
      verifierPublicKeys.set(normalizedSerial, publicKey);
    }
    this.verifierPublicKeys = verifierPublicKeys;
    this.apiV3Key = readApiV3Key(options.apiV3Key);
    this.notifyUrl = validateNotifyUrl(options.notifyUrl);
    this.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(this.timeoutMilliseconds)
      || this.timeoutMilliseconds < 100
      || this.timeoutMilliseconds > 30_000) {
      throw new Error("微信支付请求超时必须介于 100 和 30000 毫秒之间");
    }
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(16).toString("hex"));
  }

  async createOrder(input: Parameters<PaymentProvider["createOrder"]>[0]): Promise<{
    providerReference: string;
    paymentParams: MiniProgramPaymentParams;
    recoveryCiphertext: string;
  }> {
    if (!input.payerOpenId) {
      throw new AppError(409, "WECHAT_IDENTITY_REQUIRED", "当前账号尚未绑定微信身份，请重新登录");
    }
    const path = "/v3/pay/transactions/jsapi";
    const raw = await this.request("POST", path, {
      appid: this.appId,
      mchid: this.merchantId,
      description: `豆格绘册-${input.product.name}`.slice(0, 127),
      out_trade_no: input.outTradeNo,
      time_expire: input.expiresAt,
      notify_url: this.notifyUrl,
      attach: input.orderId,
      amount: { total: input.product.amountCents, currency: input.product.currency },
      payer: { openid: input.payerOpenId },
    });
    const payload = parseJsonObject(raw, "WECHAT_PAY_INVALID_RESPONSE", "微信支付下单响应无效") as WechatPrepayPayload;
    if (typeof payload.prepay_id !== "string" || payload.prepay_id.length < 1 || payload.prepay_id.length > 128) {
      throw new AppError(502, "WECHAT_PAY_INVALID_RESPONSE", "微信支付未返回有效预支付标识", null, true);
    }
    return {
      providerReference: payload.prepay_id,
      paymentParams: this.paymentParams(payload.prepay_id),
      recoveryCiphertext: sealPaymentProviderReference({
        providerReference: payload.prepay_id,
        keyMaterial: this.apiV3Key,
        orderId: input.orderId,
        outTradeNo: input.outTradeNo,
      }),
    };
  }

  async queryOrder(
    order: PaymentOrderIdentity | PaymentOrderRecord,
    signal?: AbortSignal,
  ): Promise<PaymentObservation> {
    const orderId = "orderId" in order ? order.orderId : order.id;
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.outTradeNo)}?mchid=${encodeURIComponent(this.merchantId)}`;
    let raw: string;
    try {
      raw = await this.request("GET", path, undefined, signal);
    } catch (error) {
      if (this.providerCode(error) === "ORDER_NOT_EXIST") {
        return { tradeState: "NOT_FOUND", providerTransactionId: null, paidAt: null };
      }
      throw error;
    }
    const payload = parseJsonObject(raw, "WECHAT_PAY_INVALID_RESPONSE", "微信支付查单响应无效") as WechatQueryPayload;
    const amount = payload.amount;
    if (payload.appid !== this.appId
      || payload.mchid !== this.merchantId
      || payload.out_trade_no !== order.outTradeNo
      || payload.attach !== orderId
      || typeof amount !== "object" || amount === null || Array.isArray(amount)
      || (amount as Record<string, unknown>).total !== order.amountCents
      || (amount as Record<string, unknown>).currency !== order.currency) {
      throw new AppError(502, "WECHAT_PAY_IDENTITY_MISMATCH", "微信支付查单响应与本地订单不匹配", null, true);
    }
    const state = typeof payload.trade_state === "string" ? payload.trade_state : "";
    if (state === "SUCCESS") {
      if (typeof payload.transaction_id !== "string" || !payload.transaction_id
        || typeof payload.success_time !== "string" || !Number.isFinite(Date.parse(payload.success_time))) {
        throw new AppError(502, "WECHAT_PAY_INVALID_RESPONSE", "微信支付成功响应缺少交易信息", null, true);
      }
      return {
        tradeState: "SUCCESS",
        providerTransactionId: payload.transaction_id,
        paidAt: new Date(payload.success_time).toISOString(),
      };
    }
    if (["CLOSED", "REFUND", "REVOKED", "PAYERROR"].includes(state)) {
      return { tradeState: "CLOSED", providerTransactionId: null, paidAt: null };
    }
    if (["NOTPAY", "USERPAYING"].includes(state)) {
      return { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null };
    }
    throw new AppError(502, "WECHAT_PAY_INVALID_RESPONSE", "微信支付返回了未知交易状态", {
      tradeState: state,
    }, true);
  }

  async recoverOrderSession(input: PaymentOrderIdentity & { recoveryCiphertext: string }) {
    const providerReference = openPaymentProviderReference({
      recoveryCiphertext: input.recoveryCiphertext,
      keyMaterial: this.apiV3Key,
      orderId: input.orderId,
      outTradeNo: input.outTradeNo,
    });
    return { providerReference, paymentParams: this.paymentParams(providerReference) };
  }

  async closeOrder(order: PaymentOrderIdentity, signal?: AbortSignal): Promise<void> {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.outTradeNo)}/close`;
    try {
      await this.request("POST", path, { mchid: this.merchantId }, signal);
    } catch (error) {
      // The close endpoint is documented as re-entrant. Treat an already closed
      // provider order as the same successful terminal outcome.
      if (this.providerCode(error) === "ORDER_CLOSED") return;
      throw error;
    }
  }

  async parseNotification(input: WechatPayNotificationInput): Promise<WechatPayNotification> {
    this.verifySignedMessage(input.serial, input.signature, input.timestamp, input.nonce, input.rawBody);
    const envelope = parseJsonObject(
      input.rawBody,
      "WECHAT_PAY_NOTIFICATION_INVALID",
      "微信支付通知格式无效",
    ) as WechatNotificationEnvelope;
    if (typeof envelope.id !== "string" || envelope.id.length < 1 || envelope.id.length > 128
      || envelope.event_type !== "TRANSACTION.SUCCESS"
      || envelope.resource_type !== "encrypt-resource"
      || typeof envelope.resource !== "object" || envelope.resource === null || Array.isArray(envelope.resource)) {
      throw new AppError(400, "WECHAT_PAY_NOTIFICATION_INVALID", "微信支付通知字段无效");
    }
    const resource = envelope.resource as WechatEncryptedResource;
    if (resource.algorithm !== "AEAD_AES_256_GCM"
      || typeof resource.ciphertext !== "string"
      || typeof resource.nonce !== "string"
      || typeof resource.associated_data !== "string") {
      throw new AppError(400, "WECHAT_PAY_NOTIFICATION_INVALID", "微信支付通知加密资源无效");
    }
    const decrypted = this.decryptResource(resource.ciphertext, resource.nonce, resource.associated_data);
    const transaction = parseJsonObject(
      decrypted,
      "WECHAT_PAY_NOTIFICATION_INVALID",
      "微信支付通知解密内容无效",
    ) as WechatTransactionNotification;
    const amount = transaction.amount;
    if (transaction.appid !== this.appId
      || transaction.mchid !== this.merchantId
      || typeof transaction.out_trade_no !== "string" || !transaction.out_trade_no
      || transaction.trade_type !== "JSAPI"
      || typeof transaction.attach !== "string" || transaction.attach.length < 1
      || Buffer.byteLength(transaction.attach, "utf8") > 128
      || typeof transaction.transaction_id !== "string" || !transaction.transaction_id
      || transaction.trade_state !== "SUCCESS"
      || typeof transaction.success_time !== "string" || !Number.isFinite(Date.parse(transaction.success_time))
      || typeof amount !== "object" || amount === null || Array.isArray(amount)) {
      throw new AppError(400, "WECHAT_PAY_NOTIFICATION_INVALID", "微信支付通知交易字段无效");
    }
    const total = (amount as Record<string, unknown>).total;
    const currency = (amount as Record<string, unknown>).currency;
    if (!Number.isSafeInteger(total) || (total as number) <= 0 || currency !== "CNY") {
      throw new AppError(400, "WECHAT_PAY_NOTIFICATION_INVALID", "微信支付通知金额字段无效");
    }
    return {
      notificationId: envelope.id,
      serial: input.serial,
      appId: this.appId,
      merchantId: this.merchantId,
      outTradeNo: transaction.out_trade_no,
      attach: transaction.attach,
      providerTransactionId: transaction.transaction_id,
      tradeState: "SUCCESS",
      paidAt: new Date(transaction.success_time).toISOString(),
      amountCents: total as number,
      currency: "CNY",
    };
  }

  private sign(message: string): string {
    return sign("RSA-SHA256", Buffer.from(message, "utf8"), this.merchantPrivateKey).toString("base64");
  }

  private paymentParams(providerReference: string): MiniProgramPaymentParams {
    const timeStamp = Math.floor(this.now() / 1_000).toString();
    const nonceStr = this.nonce();
    const packageValue = `prepay_id=${providerReference}`;
    const paySign = this.sign(`${this.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`);
    return { timeStamp, nonceStr, package: packageValue, signType: "RSA", paySign };
  }

  private providerCode(error: unknown): string | null {
    if (!(error instanceof AppError) || typeof error.details !== "object" || error.details === null) return null;
    const providerCode = (error.details as Record<string, unknown>).providerCode;
    return typeof providerCode === "string" ? providerCode : null;
  }

  private authorization(method: string, canonicalUrl: string, body: string, timestamp: string, nonce: string): string {
    const signature = this.sign(`${method}\n${canonicalUrl}\n${timestamp}\n${nonce}\n${body}\n`);
    return "WECHATPAY2-SHA256-RSA2048 "
      + `mchid="${this.merchantId}",nonce_str="${nonce}",signature="${signature}",`
      + `timestamp="${timestamp}",serial_no="${this.merchantCertificateSerial}"`;
  }

  private verifySignedMessage(serial: string, signature: string, timestamp: string, nonce: string, body: string): void {
    const verifierPublicKey = this.verifierPublicKeys.get(serial);
    if (!verifierPublicKey) {
      throw new AppError(401, "WECHAT_PAY_UNKNOWN_SERIAL", "微信支付签名序列号不受信任");
    }
    if (signature.startsWith("WECHATPAY/SIGNTEST/")) {
      throw new AppError(401, "WECHAT_PAY_SIGNATURE_PROBE", "微信支付签名探测请求已拒绝");
    }
    const seconds = integerTimestamp(timestamp);
    if (!Number.isFinite(seconds) || Math.abs(Math.floor(this.now() / 1_000) - seconds) > MAX_SIGNED_MESSAGE_AGE_SECONDS) {
      throw new AppError(401, "WECHAT_PAY_STALE_SIGNATURE", "微信支付签名时间戳无效或已过期");
    }
    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(signature, "base64");
    } catch {
      throw new AppError(401, "WECHAT_PAY_SIGNATURE_INVALID", "微信支付签名无效");
    }
    if (signatureBytes.length === 0 || !verify(
      "RSA-SHA256",
      Buffer.from(`${timestamp}\n${nonce}\n${body}\n`, "utf8"),
      verifierPublicKey,
      signatureBytes,
    )) {
      throw new AppError(401, "WECHAT_PAY_SIGNATURE_INVALID", "微信支付签名无效");
    }
  }

  private decryptResource(ciphertext: string, nonce: string, associatedData: string): string {
    let encrypted: Buffer;
    try {
      encrypted = Buffer.from(ciphertext, "base64");
    } catch {
      throw new AppError(400, "WECHAT_PAY_NOTIFICATION_DECRYPT_FAILED", "微信支付通知无法解密");
    }
    if (encrypted.length <= 16 || Buffer.byteLength(nonce, "utf8") !== 12) {
      throw new AppError(400, "WECHAT_PAY_NOTIFICATION_DECRYPT_FAILED", "微信支付通知无法解密");
    }
    try {
      const authTag = encrypted.subarray(encrypted.length - 16);
      const content = encrypted.subarray(0, encrypted.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", this.apiV3Key, Buffer.from(nonce, "utf8"));
      decipher.setAAD(Buffer.from(associatedData, "utf8"));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(content), decipher.final()]).toString("utf8");
    } catch {
      throw new AppError(400, "WECHAT_PAY_NOTIFICATION_DECRYPT_FAILED", "微信支付通知无法解密");
    }
  }

  private async request(
    method: "GET" | "POST",
    canonicalUrl: string,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const body = payload ? JSON.stringify(payload) : "";
    const timestamp = Math.floor(this.now() / 1_000).toString();
    const nonce = this.nonce();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${canonicalUrl}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: this.authorization(method, canonicalUrl, body, timestamp, nonce),
          "wechatpay-serial": this.primaryVerifierSerial,
          ...(payload ? { "content-type": "application/json" } : {}),
        },
        ...(payload ? { body } : {}),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMilliseconds)])
          : AbortSignal.timeout(this.timeoutMilliseconds),
      });
    } catch (error) {
      throw new AppError(503, "WECHAT_PAY_UNAVAILABLE", "微信支付服务暂时不可用", {
        cause: error instanceof Error ? error.name : "network-error",
      }, true);
    }
    const raw = await response.text();
    try {
      this.verifySignedMessage(
        header(response, "wechatpay-serial"),
        header(response, "wechatpay-signature"),
        header(response, "wechatpay-timestamp"),
        header(response, "wechatpay-nonce"),
        raw,
      );
    } catch (error) {
      throw new AppError(503, "WECHAT_PAY_RESPONSE_UNVERIFIED", "微信支付响应验证失败，请稍后重试", {
        verificationCode: error instanceof AppError ? error.code : "WECHAT_PAY_SIGNATURE_INVALID",
        providerStatus: response.status,
      }, true);
    }
    if (!response.ok) {
      let providerCode: string | null = null;
      try {
        const parsed = JSON.parse(raw) as WechatApiErrorPayload;
        providerCode = typeof parsed.code === "string" ? parsed.code : null;
      } catch {
        // The verified body is still safe to reject without exposing it.
      }
      const retryable = response.status >= 500 || response.status === 429;
      throw new AppError(
        retryable ? 503 : 409,
        retryable ? "WECHAT_PAY_UNAVAILABLE" : "WECHAT_PAY_REJECTED",
        retryable ? "微信支付服务暂时不可用" : "微信支付拒绝了本次请求",
        { providerCode, providerStatus: response.status },
        retryable,
      );
    }
    return raw;
  }
}
