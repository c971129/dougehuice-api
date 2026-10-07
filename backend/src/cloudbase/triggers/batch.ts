export const DEFAULT_TRIGGER_BATCH_SIZE = 5;
export const MAX_TRIGGER_BATCH_SIZE = 50;
export const MAX_TRIGGER_PURGE_BATCH_SIZE = 100;

export interface TriggerBatchSummary {
  processed: number;
  stoppedBy: "idle" | "limit" | "aborted";
}

export function boundedPurgeBatchSize(limit: number | undefined): number {
  const value = limit ?? MAX_TRIGGER_PURGE_BATCH_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRIGGER_PURGE_BATCH_SIZE) {
    throw new Error(`CloudBase purge batch limit must be between 1 and ${MAX_TRIGGER_PURGE_BATCH_SIZE}`);
  }
  return value;
}

/** Runs sequentially and stops at the first idle result, abort, or fixed item cap. */
export async function runBoundedBatch<T>(input: {
  processNext: (signal?: AbortSignal) => Promise<T | null>;
  limit?: number;
  signal?: AbortSignal;
}): Promise<TriggerBatchSummary> {
  const limit = input.limit ?? DEFAULT_TRIGGER_BATCH_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRIGGER_BATCH_SIZE) {
    throw new Error(`CloudBase trigger batch limit must be between 1 and ${MAX_TRIGGER_BATCH_SIZE}`);
  }

  let processed = 0;
  while (processed < limit) {
    if (input.signal?.aborted) return { processed, stoppedBy: "aborted" };
    const result = await input.processNext(input.signal);
    if (result === null) return { processed, stoppedBy: "idle" };
    processed += 1;
  }
  return {
    processed,
    stoppedBy: input.signal?.aborted ? "aborted" : "limit",
  };
}
