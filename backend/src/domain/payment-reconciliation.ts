import { AppError } from "../errors.js";

export const MAX_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const INITIAL_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS = 30_000;
export const PAYMENT_RECONCILIATION_REPAIR_LIMIT = 100;

export function assertPaymentReconciliationDelayMilliseconds(value: number): number {
  if (!Number.isSafeInteger(value)
    || value < 0
    || value > MAX_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS) {
    throw new AppError(
      500,
      "PAYMENT_RECONCILIATION_DELAY_INVALID",
      "支付对账重试间隔无效",
      { maximumMilliseconds: MAX_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS },
      false,
    );
  }
  return value;
}

export function assertPaymentReconciliationError(input: {
  code?: string;
  message?: string;
}): { code: string | null; message: string | null } {
  const code = input.code?.trim() || null;
  const message = input.message?.trim() || null;
  if (code && (code.length > 80 || !/^[A-Z0-9_:-]+$/.test(code))) {
    throw new AppError(500, "PAYMENT_RECONCILIATION_ERROR_INVALID", "支付对账错误码无效", null, false);
  }
  if (message && (message.length > 500 || /[\u0000-\u001f\u007f]/.test(message))) {
    throw new AppError(500, "PAYMENT_RECONCILIATION_ERROR_INVALID", "支付对账错误信息无效", null, false);
  }
  return { code, message };
}
