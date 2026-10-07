import { createConfiguredPaymentProvider } from "../../payments/configured-provider.js";
import { processNextPaymentReconciliation } from "../../payments/reconciliation-worker.js";
import type { PaymentProvider } from "../../payments/provider.js";
import { runBoundedBatch, DEFAULT_TRIGGER_BATCH_SIZE } from "./batch.js";
import { withCloudbaseWorkerRuntime } from "./runtime.js";

export async function runPaymentReconciliationTrigger(input: {
  store: Parameters<typeof processNextPaymentReconciliation>[0]["store"];
  provider: PaymentProvider;
  limit?: number;
  now?: Date;
  leaseMilliseconds?: number;
  heartbeatIntervalMilliseconds?: number;
  signal?: AbortSignal;
}): Promise<Awaited<ReturnType<typeof runBoundedBatch>>> {
  return runBoundedBatch({
    limit: input.limit ?? DEFAULT_TRIGGER_BATCH_SIZE,
    ...(input.signal ? { signal: input.signal } : {}),
    processNext: (signal) => processNextPaymentReconciliation({
      store: input.store,
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
export async function main(_event?: unknown): Promise<Awaited<ReturnType<typeof runPaymentReconciliationTrigger>>> {
  return withCloudbaseWorkerRuntime({
    role: "payment-reconciliation-worker",
    storage: false,
    run: async ({ config, store }) => {
      const provider = await createConfiguredPaymentProvider(config);
      if (!provider?.closeOrder) {
        throw new Error("支付对账触发器必须配置支持查单与安全关单的微信支付 Provider");
      }
      return runPaymentReconciliationTrigger({ store, provider });
    },
  });
}
