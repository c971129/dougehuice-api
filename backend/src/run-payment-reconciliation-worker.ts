import "dotenv/config";

import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createConfiguredPaymentProvider } from "./payments/configured-provider.js";
import { processNextPaymentReconciliation } from "./payments/reconciliation-worker.js";
import { PostgresStore } from "./repositories/postgres-store.js";
import { waitForWorkerInterval } from "./workers/shutdown.js";

const config = loadConfig(process.env, "payment-reconciliation-worker");
const store = new PostgresStore(createPool(config));
const provider = await createConfiguredPaymentProvider(config);
if (!provider?.closeOrder) {
  throw new Error("支付对账 Worker 必须配置支持查单与安全关单的微信支付 Provider");
}

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
  while (!stopping) {
    try {
      const processed = await processNextPaymentReconciliation({
        store,
        provider,
        ...(config.paymentReconciliationLeaseMilliseconds !== undefined
          ? { leaseMilliseconds: config.paymentReconciliationLeaseMilliseconds }
          : {}),
        ...(config.paymentReconciliationPollMilliseconds !== undefined
          ? { notpayPollMilliseconds: config.paymentReconciliationPollMilliseconds }
          : {}),
        signal: shutdownController.signal,
      });
      if (!processed) {
        await waitForWorkerInterval(
          config.paymentReconciliationIdleMilliseconds ?? 750,
          shutdownController.signal,
        );
      }
      else {
        process.stdout.write(`${JSON.stringify({
          event: "payment.reconciliation.processed",
          orderId: processed.id,
          status: processed.status,
        })}\n`);
      }
    } catch (error) {
      if (stopping) break;
      process.stderr.write(`${JSON.stringify({
        event: "payment.reconciliation.worker_error",
        message: error instanceof Error ? error.message : "unknown",
      })}\n`);
      await waitForWorkerInterval(2_000, shutdownController.signal);
    }
  }
} finally {
  await store.close();
}
