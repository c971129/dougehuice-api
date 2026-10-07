import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VolatileMemoryStorage } from "../src/storage/volatile-memory-storage.js";

describe("volatile integration storage", () => {
  it("copies bytes, scopes reads to the owner and asset, and deletes idempotently", async () => {
    const storage = new VolatileMemoryStorage();
    const source = Buffer.from("private-source");
    const context = {
      ownerId: "00000000-0000-4000-8000-000000000001",
      assetId: "00000000-0000-4000-8000-000000000002",
    };
    const { storageKey } = await storage.put(source, context, "volatile-object-key-0001");
    source.fill(0);

    assert.equal((await storage.get(storageKey, context))?.toString(), "private-source");
    await assert.rejects(
      storage.get(storageKey, { ...context, ownerId: "00000000-0000-4000-8000-000000000003" }),
      /无法验证/,
    );
    await storage.delete(storageKey);
    await storage.delete(storageKey);
    assert.equal(await storage.get(storageKey, context), null);
  });

  it("rejects a get with a pre-aborted signal", async () => {
    const storage = new VolatileMemoryStorage();
    const context = {
      ownerId: "00000000-0000-4000-8000-000000000001",
      assetId: "00000000-0000-4000-8000-000000000002",
    };
    const storageKey = "volatile-aborted-read-key-0001";
    await storage.put(Buffer.from("private-source"), context, storageKey);
    const reason = new Error("test volatile read deadline");
    const controller = new AbortController();
    controller.abort(reason);

    await assert.rejects(storage.get(storageKey, context, controller.signal), (error) => error === reason);
  });
});

