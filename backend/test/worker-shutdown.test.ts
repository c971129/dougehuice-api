import assert from "node:assert/strict";
import { it } from "node:test";

import { waitForWorkerInterval } from "../src/workers/shutdown.js";

it("wakes an idle worker immediately when process shutdown is requested", { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const waiting = waitForWorkerInterval(60_000, controller.signal);
  controller.abort(new Error("WORKER_SHUTTING_DOWN"));
  await waiting;
  assert.ok(Date.now() - startedAt < 1_000);
});
