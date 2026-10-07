import "dotenv/config";

import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { purgeExpiredExportArtifacts } from "./exports/artifact-cleanup.js";
import { PostgresStore } from "./repositories/postgres-store.js";
import { createConfiguredStorageProvider } from "./storage/configured-storage.js";
import { closeStorageProvider } from "./storage/storage-provider.js";

const config = loadConfig(process.env, "export-purge");
const store = new PostgresStore(createPool(config));
const storage = createConfiguredStorageProvider(config);

try {
  await store.ready();
  await storage.ready();
  const summary = {
    batches: 0,
    scanned: 0,
    purged: 0,
    failed: 0,
    failures: [] as Array<{ artifactId: string; code: string; retryable: true }>,
    truncated: false,
    retryRequired: false,
  };
  while (summary.batches < config.assetPurgeMaxBatches) {
    const result = await purgeExpiredExportArtifacts({
      store,
      storage,
      now: new Date().toISOString(),
      limit: config.assetPurgeBatchSize,
    });
    summary.batches += 1;
    summary.scanned += result.scanned;
    summary.purged += result.purged;
    summary.failed += result.failed;
    summary.failures.push(...result.failures);
    if (result.failed > 0) {
      summary.retryRequired = true;
      break;
    }
    if (result.scanned < config.assetPurgeBatchSize) break;
    if (summary.batches === config.assetPurgeMaxBatches) {
      summary.truncated = true;
      summary.retryRequired = true;
    }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.retryRequired) process.exitCode = 1;
} finally {
  await Promise.allSettled([closeStorageProvider(storage), store.close()]);
}
