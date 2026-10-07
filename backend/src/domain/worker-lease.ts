import { AppError } from "../errors.js";

export const MIN_WORKER_LEASE_MILLISECONDS = 100;
export const MAX_WORKER_LEASE_MILLISECONDS = 60 * 60 * 1000;

export function assertWorkerLeaseMilliseconds(value: number): number {
  if (!Number.isSafeInteger(value)
    || value < MIN_WORKER_LEASE_MILLISECONDS
    || value > MAX_WORKER_LEASE_MILLISECONDS) {
    throw new AppError(
      500,
      "WORKER_LEASE_CONFIGURATION_INVALID",
      "worker 租约时长配置无效",
      {
        minimumMilliseconds: MIN_WORKER_LEASE_MILLISECONDS,
        maximumMilliseconds: MAX_WORKER_LEASE_MILLISECONDS,
      },
      false,
    );
  }
  return value;
}

export function resolveInMemoryWorkerLeaseWindow(input: {
  now?: string;
  leaseMilliseconds: number;
}): {
  now: string;
  nowMilliseconds: number;
  leaseExpiresAt: string;
} {
  const leaseMilliseconds = assertWorkerLeaseMilliseconds(input.leaseMilliseconds);
  const nowMilliseconds = input.now === undefined ? Date.now() : Date.parse(input.now);
  if (!Number.isFinite(nowMilliseconds)) {
    throw new AppError(500, "WORKER_LEASE_CLOCK_INVALID", "worker 租约时钟无效", undefined, false);
  }
  return {
    now: new Date(nowMilliseconds).toISOString(),
    nowMilliseconds,
    leaseExpiresAt: new Date(nowMilliseconds + leaseMilliseconds).toISOString(),
  };
}
