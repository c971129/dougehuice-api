import { processNextExport } from "../../exports/worker.js";
import type { StorageProvider } from "../../storage/storage-provider.js";
import { DEFAULT_TRIGGER_BATCH_SIZE, runBoundedBatch } from "./batch.js";
import { withCloudbaseWorkerRuntime } from "./runtime.js";

export async function runExportTrigger(input: {
  store: Parameters<typeof processNextExport>[0]["store"];
  storage: StorageProvider;
  limit?: number;
  now?: Date;
  leaseMilliseconds?: number;
  heartbeatIntervalMilliseconds?: number;
  render?: Parameters<typeof processNextExport>[0]["render"];
  signal?: AbortSignal;
}): Promise<Awaited<ReturnType<typeof runBoundedBatch>>> {
  return runBoundedBatch({
    limit: input.limit ?? DEFAULT_TRIGGER_BATCH_SIZE,
    ...(input.signal ? { signal: input.signal } : {}),
    processNext: (signal) => processNextExport({
      store: input.store,
      storage: input.storage,
      ...(input.now ? { now: input.now } : {}),
      ...(input.leaseMilliseconds !== undefined ? { leaseMilliseconds: input.leaseMilliseconds } : {}),
      ...(input.heartbeatIntervalMilliseconds !== undefined
        ? { heartbeatIntervalMilliseconds: input.heartbeatIntervalMilliseconds }
        : {}),
      ...(input.render ? { render: input.render } : {}),
      ...(signal ? { signal } : {}),
    }),
  });
}

/** CloudBase scheduled-function entrypoint. It processes one finite batch and exits. */
export async function main(_event?: unknown): Promise<Awaited<ReturnType<typeof runExportTrigger>>> {
  return withCloudbaseWorkerRuntime({
    role: "export-worker",
    storage: true,
    run: async ({ store, storage }) => {
      if (!storage) throw new Error("export trigger storage is unavailable");
      return runExportTrigger({ store, storage });
    },
  });
}
