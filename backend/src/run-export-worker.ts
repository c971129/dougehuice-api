import "dotenv/config";

import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { processNextExport } from "./exports/worker.js";
import { PostgresStore } from "./repositories/postgres-store.js";
import { createConfiguredStorageProvider } from "./storage/configured-storage.js";
import { closeStorageProvider } from "./storage/storage-provider.js";
import { waitForWorkerInterval } from "./workers/shutdown.js";

const config = loadConfig(process.env, "export-worker");
const store = new PostgresStore(createPool(config));
const storage = createConfiguredStorageProvider(config);
let stopping = false;
const shutdownController = new AbortController();

const stop = (): void => {
  stopping = true;
  if (!shutdownController.signal.aborted) {
    shutdownController.abort(new Error("WORKER_SHUTTING_DOWN"));
  }
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await store.ready();
  await storage.ready();
  while (!stopping) {
    try {
      const processed = await processNextExport({ store, storage, signal: shutdownController.signal });
      if (!processed) await waitForWorkerInterval(750, shutdownController.signal);
      else process.stdout.write(`${JSON.stringify({ event: "export.processed", jobId: processed.id, status: processed.status })}\n`);
    } catch (error) {
      if (stopping) break;
      process.stderr.write(`${JSON.stringify({ event: "export.worker_error", message: error instanceof Error ? error.message : "unknown" })}\n`);
      await waitForWorkerInterval(2_000, shutdownController.signal);
    }
  }
} finally {
  await Promise.allSettled([closeStorageProvider(storage), store.close()]);
}
