import "dotenv/config";

import { purgeExpiredAssets } from "./assets/asset-service.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { PostgresStore } from "./repositories/postgres-store.js";
import { createConfiguredStorageProvider } from "./storage/configured-storage.js";
import { closeStorageProvider } from "./storage/storage-provider.js";

const config = loadConfig(process.env, "asset-purge");
const store = new PostgresStore(createPool(config));
const storage = createConfiguredStorageProvider(config);

try {
  await store.ready();
  await storage.ready();
  const summary = {
    batches: 0,
    scanned: 0,
    purged: 0,
    skipped: 0,
    failed: 0,
    failures: [] as Array<{ assetId: string; code: string; retryable: true }>,
    truncated: false,
    retryRequired: false,
  };
  while (summary.batches < config.assetPurgeMaxBatches) {
    const result = await purgeExpiredAssets({
      store,
      storage,
      now: new Date().toISOString(),
      limit: config.assetPurgeBatchSize,
    });
    summary.batches += 1;
    summary.scanned += result.scanned;
    summary.purged += result.purged;
    summary.skipped += result.skipped;
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
