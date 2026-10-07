import { createHash } from "node:crypto";

import type { USER_RATE_LIMITS } from "./domain/resource-limits.js";
import { AppError } from "./errors.js";
import type { AppStore } from "./repositories/store.js";

type RateLimitRule = (typeof USER_RATE_LIMITS)[keyof typeof USER_RATE_LIMITS];
type FixedWindowRateLimitRule = {
  action: string;
  limit: number;
  windowMilliseconds: number;
};

export function hashEffectiveClientIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

export async function requireIpRateLimit(
  store: AppStore,
  ip: string,
  rule: FixedWindowRateLimitRule,
  error: { code: string; message: string },
  now = new Date().toISOString(),
): Promise<void> {
  const result = await store.consumeAuthRateLimit({
    keyHash: hashEffectiveClientIp(ip),
    action: rule.action,
    now,
    limit: rule.limit,
    windowMilliseconds: rule.windowMilliseconds,
  });
  if (!result.allowed) {
    throw new AppError(429, error.code, error.message, {
      action: rule.action,
      limit: rule.limit,
      windowMilliseconds: rule.windowMilliseconds,
      retryAfterMilliseconds: result.retryAfterMilliseconds,
    }, true);
  }
}

export async function requireUserRateLimit(
  store: AppStore,
  userId: string,
  rule: RateLimitRule,
  now = new Date().toISOString(),
): Promise<void> {
  const result = await store.consumeUserRateLimit({
    userId,
    action: rule.action,
    now,
    limit: rule.limit,
    windowMilliseconds: rule.windowMilliseconds,
  });
  if (!result.allowed) {
    throw new AppError(429, "USER_RATE_LIMITED", "操作过于频繁，请稍后重试", {
      action: rule.action,
      limit: rule.limit,
      windowMilliseconds: rule.windowMilliseconds,
      retryAfterMilliseconds: result.retryAfterMilliseconds,
    }, true);
  }
}
