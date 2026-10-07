export interface LeaseHeartbeat {
  signal: AbortSignal;
  stop(): Promise<void>;
}

export function startLeaseHeartbeat(input: {
  intervalMilliseconds: number;
  renew: () => Promise<boolean>;
  abortSignal?: AbortSignal;
}): LeaseHeartbeat {
  const controller = new AbortController();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const abortFromParent = (): void => {
    controller.abort(input.abortSignal?.reason ?? new Error("WORKER_SHUTTING_DOWN"));
  };
  if (input.abortSignal?.aborted) abortFromParent();
  else input.abortSignal?.addEventListener("abort", abortFromParent, { once: true });

  const schedule = (): void => {
    if (stopped || controller.signal.aborted) return;
    timer = setTimeout(() => {
      inFlight = (async () => {
        try {
          if (!await input.renew()) controller.abort(new Error("WORKER_LEASE_LOST"));
        } catch (error) {
          controller.abort(error);
        } finally {
          schedule();
        }
      })();
    }, input.intervalMilliseconds);
    timer.unref();
  };

  schedule();
  return {
    signal: controller.signal,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      input.abortSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export function throwIfLeaseAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("WORKER_LEASE_LOST");
  }
}
