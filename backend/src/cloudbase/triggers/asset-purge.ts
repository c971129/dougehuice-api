import { purgeExpiredAssets } from "../../assets/asset-service.js";
import type { AssetPurgeFailure } from "../../assets/asset-service.js";
import type { StorageProvider } from "../../storage/storage-provider.js";
import { boundedPurgeBatchSize, MAX_TRIGGER_PURGE_BATCH_SIZE } from "./batch.js";
import { withCloudbaseWorkerRuntime } from "./runtime.js";

export interface PurgeTriggerSummary<TFailure> {
  scanned: number;
  purged: number;
  failed: number;
  failures: TFailure[];
  skipped?: number;
  truncated: boolean;
  retryRequired: boolean;
}

export type AssetPurgeTriggerSummary = PurgeTriggerSummary<AssetPurgeFailure> & { skipped: number };

export async function runAssetPurgeTrigger(input: {
  store: Parameters<typeof purgeExpiredAssets>[0]["store"];
  storage: StorageProvider;
  now?: Date;
  limit?: number;
}): Promise<AssetPurgeTriggerSummary> {
  const limit = boundedPurgeBatchSize(input.limit);
  const result = await purgeExpiredAssets({
    store: input.store,
    storage: input.storage,
    now: (input.now ?? new Date()).toISOString(),
    limit,
  });
  const truncated = result.scanned === limit;
  return { ...result, truncated, retryRequired: result.failed > 0 || truncated };
}

/** CloudBase scheduled-function entrypoint. It runs exactly one bounded purge scan. */
export async function main(_event?: unknown): Promise<AssetPurgeTriggerSummary> {
  return withCloudbaseWorkerRuntime({
    role: "asset-purge",
    storage: true,
    run: async ({ config, store, storage }) => {
      if (!storage) throw new Error("asset purge trigger storage is unavailable");
      return runAssetPurgeTrigger({
        store,
        storage,
        limit: Math.min(config.assetPurgeBatchSize, MAX_TRIGGER_PURGE_BATCH_SIZE),
      });
    },
  });
}
