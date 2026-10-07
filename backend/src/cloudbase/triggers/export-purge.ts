import { purgeExpiredExportArtifacts } from "../../exports/artifact-cleanup.js";
import type { ExportArtifactPurgeFailure } from "../../exports/artifact-cleanup.js";
import type { StorageProvider } from "../../storage/storage-provider.js";
import { boundedPurgeBatchSize, MAX_TRIGGER_PURGE_BATCH_SIZE } from "./batch.js";
import { withCloudbaseWorkerRuntime } from "./runtime.js";
import type { PurgeTriggerSummary } from "./asset-purge.js";

export async function runExportPurgeTrigger(input: {
  store: Parameters<typeof purgeExpiredExportArtifacts>[0]["store"];
  storage: StorageProvider;
  now?: Date;
  limit?: number;
}): Promise<PurgeTriggerSummary<ExportArtifactPurgeFailure>> {
  const limit = boundedPurgeBatchSize(input.limit);
  const result = await purgeExpiredExportArtifacts({
    store: input.store,
    storage: input.storage,
    now: (input.now ?? new Date()).toISOString(),
    limit,
  });
  const truncated = result.scanned === limit;
  return { ...result, truncated, retryRequired: result.failed > 0 || truncated };
}

/** CloudBase scheduled-function entrypoint. It runs exactly one bounded purge scan. */
export async function main(_event?: unknown): Promise<PurgeTriggerSummary<ExportArtifactPurgeFailure>> {
  return withCloudbaseWorkerRuntime({
    role: "export-purge",
    storage: true,
    run: async ({ config, store, storage }) => {
      if (!storage) throw new Error("export purge trigger storage is unavailable");
      return runExportPurgeTrigger({
        store,
        storage,
        limit: Math.min(config.assetPurgeBatchSize, MAX_TRIGGER_PURGE_BATCH_SIZE),
      });
    },
  });
}
