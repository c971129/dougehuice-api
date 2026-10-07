import { loadConfig, type ConfigRole, type AppConfig } from "../../config.js";
import { createPool } from "../../db.js";
import { PostgresStore } from "../../repositories/postgres-store.js";
import { createConfiguredStorageProvider } from "../../storage/configured-storage.js";
import { closeStorageProvider, type StorageProvider } from "../../storage/storage-provider.js";

export type CloudbaseWorkerRole = Extract<ConfigRole,
  | "generation-worker"
  | "export-worker"
  | "payment-reconciliation-worker"
  | "asset-purge"
  | "export-purge"
>;

export interface CloudbaseWorkerRuntime {
  config: AppConfig;
  store: PostgresStore;
  storage?: StorageProvider;
}

/** Opens only per-invocation resources; credentials come from the CloudBase runtime environment. */
export async function withCloudbaseWorkerRuntime<T>(input: {
  role: CloudbaseWorkerRole;
  storage: boolean;
  run: (runtime: CloudbaseWorkerRuntime) => Promise<T>;
}): Promise<T> {
  const config = loadConfig(process.env, input.role);
  const store = new PostgresStore(createPool(config));
  let storage: StorageProvider | undefined;
  try {
    storage = input.storage ? createConfiguredStorageProvider(config) : undefined;
    await store.ready();
    await storage?.ready();
    return await input.run({ config, store, ...(storage ? { storage } : {}) });
  } finally {
    await Promise.allSettled([
      ...(storage ? [closeStorageProvider(storage)] : []),
      store.close(),
    ]);
  }
}
