import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { AppError } from "../errors.js";

const TOKEN_PREFIX = "PDP1";

function recoveryKey(keyMaterial: string | Buffer): Buffer {
  return createHash("sha256")
    .update("pindou/payment-prepay-recovery/v1\0")
    .update(keyMaterial)
    .digest();
}

function aad(orderId: string, outTradeNo: string): Buffer {
  return Buffer.from(`${TOKEN_PREFIX}\0${orderId}\0${outTradeNo}`, "utf8");
}

export function sealPaymentProviderReference(input: {
  providerReference: string;
  keyMaterial: string | Buffer;
  orderId: string;
  outTradeNo: string;
}): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", recoveryKey(input.keyMaterial), iv);
  cipher.setAAD(aad(input.orderId, input.outTradeNo));
  const ciphertext = Buffer.concat([
    cipher.update(input.providerReference, "utf8"),
    cipher.final(),
  ]);
  return [
    TOKEN_PREFIX,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openPaymentProviderReference(input: {
  recoveryCiphertext: string;
  keyMaterial: string | Buffer;
  orderId: string;
  outTradeNo: string;
}): string {
  const parts = input.recoveryCiphertext.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) {
    throw new AppError(503, "PAYMENT_RECOVERY_TOKEN_INVALID", "支付恢复记录无效，请稍后重试", null, true);
  }
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", recoveryKey(input.keyMaterial), iv);
    decipher.setAAD(aad(input.orderId, input.outTradeNo));
    decipher.setAuthTag(tag);
    const providerReference = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (providerReference.length < 1 || providerReference.length > 128) throw new Error("invalid reference");
    return providerReference;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, "PAYMENT_RECOVERY_TOKEN_INVALID", "支付恢复记录无法解密，请稍后重试", null, true);
  }
}
