import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExportDownloadConcurrencyGate } from "../src/exports/download-concurrency.js";

describe("export download concurrency gate", () => {
  it("rejects acquisitions after the global limit is reached", () => {
    const gate = new ExportDownloadConcurrencyGate(2, 2);
    const first = gate.tryAcquire("user-0001");
    const second = gate.tryAcquire("user-0002");

    assert.ok(first);
    assert.ok(second);
    assert.equal(gate.tryAcquire("user-0003"), null);

    first.release();
    second.release();
  });

  it("rejects one user at the per-user limit without blocking another user", () => {
    const gate = new ExportDownloadConcurrencyGate(3, 2);
    const first = gate.tryAcquire("user-0001");
    const second = gate.tryAcquire("user-0001");

    assert.ok(first);
    assert.ok(second);
    assert.equal(gate.tryAcquire("user-0001"), null);
    const otherUser = gate.tryAcquire("user-0002");
    assert.ok(otherUser);

    first.release();
    second.release();
    otherUser.release();
  });

  it("releases a permit idempotently", () => {
    const gate = new ExportDownloadConcurrencyGate(1, 1);
    const first = gate.tryAcquire("user-0001");
    assert.ok(first);

    first.release();
    first.release();

    const second = gate.tryAcquire("user-0002");
    assert.ok(second);
    assert.equal(gate.tryAcquire("user-0003"), null);
    second.release();
  });

  it("allows the same user to acquire again after release", () => {
    const gate = new ExportDownloadConcurrencyGate(1, 1);
    const first = gate.tryAcquire("user-0001");
    assert.ok(first);
    assert.equal(gate.tryAcquire("user-0001"), null);

    first.release();

    const next = gate.tryAcquire("user-0001");
    assert.ok(next);
    next.release();
  });
});
