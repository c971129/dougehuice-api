import "dotenv/config";

import { buildApp } from "./app.js";
import { purgeExpiredAssets } from "./assets/asset-service.js";
import { loadConfig } from "./config.js";
import { purgeExpiredExportArtifacts } from "./exports/artifact-cleanup.js";
import { processNextExport } from "./exports/worker.js";
import { createConfiguredGenerationProvider } from "./generation/configured-provider.js";
import { processNextGeneration } from "./generation/worker.js";
import { FakePaymentProvider } from "./payments/fake-provider.js";
import { processNextPaymentReconciliation } from "./payments/reconciliation-worker.js";
import { MemoryStore } from "./repositories/memory-store.js";
import { VolatileMemoryStorage } from "./storage/volatile-memory-storage.js";
import { createConfiguredWechatAuthProvider } from "./wechat/mini-program-auth.js";

const config = loadConfig(process.env, "dev-memory");
if (config.nodeEnv === "production") {
  throw new Error("内存联调服务禁止在生产环境启动");
}

const store = new MemoryStore();
const storage = new VolatileMemoryStorage();
const generationProvider = createConfiguredGenerationProvider(config);
const paymentProvider = new FakePaymentProvider();
const wechatAuthProvider = createConfiguredWechatAuthProvider(config);
const app = await buildApp({
  config,
  store,
  storage,
  generationProvider,
  paymentProvider,
  ...(wechatAuthProvider ? { wechatAuthProvider } : {}),
});
let stopping = false;
let generationTimer: NodeJS.Timeout | null = null;
let exportTimer: NodeJS.Timeout | null = null;
let paymentTimer: NodeJS.Timeout | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;

async function runGenerationLoop(): Promise<void> {
  if (stopping) return;
  try {
    await processNextGeneration({ store, storage, provider: generationProvider });
  } catch (error) {
    app.log.error({ err: error }, "memory generation worker failed");
  } finally {
    if (!stopping) generationTimer = setTimeout(() => void runGenerationLoop(), 250);
  }
}

async function runExportLoop(): Promise<void> {
  if (stopping) return;
  try {
    await processNextExport({ store, storage });
  } catch (error) {
    app.log.error({ err: error }, "memory export worker failed");
  } finally {
    if (!stopping) exportTimer = setTimeout(() => void runExportLoop(), 250);
  }
}

async function runPaymentLoop(): Promise<void> {
  if (stopping) return;
  try {
    await processNextPaymentReconciliation({
      store,
      provider: paymentProvider,
      ...(config.paymentReconciliationLeaseMilliseconds !== undefined
        ? { leaseMilliseconds: config.paymentReconciliationLeaseMilliseconds }
        : {}),
      ...(config.paymentReconciliationPollMilliseconds !== undefined
        ? { notpayPollMilliseconds: config.paymentReconciliationPollMilliseconds }
        : {}),
    });
  } catch (error) {
    app.log.error({ err: error }, "memory payment reconciliation worker failed");
  } finally {
    if (!stopping) paymentTimer = setTimeout(
      () => void runPaymentLoop(),
      config.paymentReconciliationIdleMilliseconds ?? 750,
    );
  }
}

async function runMaintenanceLoop(): Promise<void> {
  if (stopping) return;
  try {
    const now = new Date().toISOString();
    const [assets, artifacts] = await Promise.all([
      purgeExpiredAssets({ store, storage, now, limit: config.assetPurgeBatchSize }),
      purgeExpiredExportArtifacts({ store, storage, now, limit: config.assetPurgeBatchSize }),
    ]);
    if (assets.failed > 0 || artifacts.failed > 0) {
      app.log.warn({ assets, artifacts }, "memory cleanup deferred failed objects");
    }
  } catch (error) {
    app.log.error({ err: error }, "memory cleanup worker failed");
  } finally {
    if (!stopping) maintenanceTimer = setTimeout(() => void runMaintenanceLoop(), 30_000);
  }
}

const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  if (generationTimer) clearTimeout(generationTimer);
  if (exportTimer) clearTimeout(exportTimer);
  if (paymentTimer) clearTimeout(paymentTimer);
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  app.log.info({ signal }, "shutting down memory integration server");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.warn("running volatile in-memory integration mode; all state is lost on restart");
  void runGenerationLoop();
  void runExportLoop();
  void runPaymentLoop();
  void runMaintenanceLoop();
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
