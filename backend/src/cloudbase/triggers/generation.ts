import { createConfiguredGenerationProvider } from "../../generation/configured-provider.js";
import { processNextGeneration } from "../../generation/worker.js";
import type { StorageProvider } from "../../storage/storage-provider.js";
import { DEFAULT_TRIGGER_BATCH_SIZE, runBoundedBatch } from "./batch.js";
import { withCloudbaseWorkerRuntime } from "./runtime.js";

export async function runGenerationTrigger(input: {
  store: Parameters<typeof processNextGeneration>[0]["store"];
  storage: StorageProvider;
  provider: Parameters<typeof processNextGeneration>[0]["provider"];
  limit?: number;
  now?: Date;
  leaseMilliseconds?: number;
  heartbeatIntervalMilliseconds?: number;
  signal?: AbortSignal;
}): Promise<Awaited<ReturnType<typeof runBoundedBatch>>> {
  return runBoundedBatch({
    limit: input.limit ?? DEFAULT_TRIGGER_BATCH_SIZE,
    ...(input.signal ? { signal: input.signal } : {}),
    processNext: (signal) => processNextGeneration({
      store: input.store,
      storage: input.storage,
      provider: input.provider,
      ...(input.now ? { now: input.now } : {}),
      ...(input.leaseMilliseconds !== undefined ? { leaseMilliseconds: input.leaseMilliseconds } : {}),
      ...(input.heartbeatIntervalMilliseconds !== undefined
        ? { heartbeatIntervalMilliseconds: input.heartbeatIntervalMilliseconds }
        : {}),
      ...(signal ? { signal } : {}),
    }),
  });
}

/** CloudBase scheduled-function entrypoint. It processes one finite batch and exits. */
export async function main(_event?: unknown): Promise<Awaited<ReturnType<typeof runGenerationTrigger>>> {
  return withCloudbaseWorkerRuntime({
    role: "generation-worker",
    storage: true,
    run: async ({ config, store, storage }) => {
      if (!storage) throw new Error("generation trigger storage is unavailable");
      return runGenerationTrigger({
        store,
        storage,
        provider: createConfiguredGenerationProvider(config),
      });
    },
  });
}
