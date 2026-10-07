import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises, {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, it } from "node:test";

import { LocalEncryptedStorage } from "../src/storage/local-encrypted-storage.js";

const ENCRYPTION_KEY = Buffer.alloc(32, 0x31).toString("base64");

function localObjectPath(root: string, storageKey: string): string {
  const digest = createHash("sha256").update(storageKey).digest("hex");
  return join(root, digest.slice(0, 2), digest.slice(2, 4), `${digest}.pdae`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(5);
  }
}

describe("local encrypted private storage", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("round-trips bytes, keeps private permissions, and preserves the EEXIST winner", async () => {
    const root = await mkdtemp(join(tmpdir(), "pindou-local-storage-roundtrip-"));
    temporaryRoots.push(root);
    const first = new LocalEncryptedStorage({ root, keyBase64: ENCRYPTION_KEY });
    const second = new LocalEncryptedStorage({ root, keyBase64: ENCRYPTION_KEY });
    const context = { ownerId: "owner-local-roundtrip", assetId: "asset-local-roundtrip" };
    const storageKey = "local-roundtrip-key-0001";
    const original = Buffer.from("original private bytes");

    await first.put(original, context, storageKey);
    await assert.rejects(
      second.put(Buffer.from("replacement bytes"), context, storageKey),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST",
    );

    assert.deepEqual(await second.get(storageKey, context), original);
    if (process.platform !== "win32") {
      const metadata = await stat(localObjectPath(root, storageKey));
      assert.equal(metadata.mode & 0o777, 0o600);
    }
  });

  it("does not let an aborted writer remove another instance's same-key winner", async (testContext) => {
    const root = await mkdtemp(join(tmpdir(), "pindou-local-storage-race-"));
    temporaryRoots.push(root);
    const abortedStorage = new LocalEncryptedStorage({ root, keyBase64: ENCRYPTION_KEY });
    const winningStorage = new LocalEncryptedStorage({ root, keyBase64: ENCRYPTION_KEY });
    const context = { ownerId: "owner-local-race", assetId: "asset-local-race" };
    const storageKey = "local-concurrent-key-0001";
    const winningBytes = Buffer.from("the successful writer must remain readable");
    const controller = new AbortController();
    const writeStarted = deferred();
    const releaseAbortedWrite = deferred();
    const originalOpen = fsPromises.open;
    const originalWriteFile = fsPromises.writeFile;

    const waitBeforeSignalWrite = async (signal: AbortSignal | undefined): Promise<void> => {
      if (signal !== controller.signal) return;
      writeStarted.resolve();
      await releaseAbortedWrite.promise;
    };
    // Gate both the former path-level writer and the temporary FileHandle writer.
    // This fixes the ordering without relying on filesystem timing or payload size.
    const openMock = testContext.mock.method(fsPromises, "open", (async (...args: unknown[]) => {
      const handle = await Reflect.apply(originalOpen, fsPromises, args) as Awaited<ReturnType<typeof originalOpen>>;
      const originalHandleWriteFile = handle.writeFile;
      handle.writeFile = (async (...writeArgs: unknown[]) => {
        const options = writeArgs[1] as { signal?: AbortSignal } | undefined;
        await waitBeforeSignalWrite(options?.signal);
        return Reflect.apply(originalHandleWriteFile, handle, writeArgs) as Promise<void>;
      }) as typeof handle.writeFile;
      return handle;
    }) as typeof fsPromises.open);
    const writeFileMock = testContext.mock.method(fsPromises, "writeFile", (async (...args: unknown[]) => {
      const options = args[2] as { signal?: AbortSignal } | undefined;
      await waitBeforeSignalWrite(options?.signal);
      return Reflect.apply(originalWriteFile, fsPromises, args) as Promise<void>;
    }) as typeof fsPromises.writeFile);
    syncBuiltinESMExports();

    let abortedPut: Promise<{ storageKey: string }> | undefined;
    try {
      abortedPut = abortedStorage.put(Buffer.alloc(1024, 0x41), context, storageKey, controller.signal);
      await writeStarted.promise;
      await winningStorage.put(winningBytes, context, storageKey);

      controller.abort(new Error("cancel losing local writer"));
      releaseAbortedWrite.resolve();
      await assert.rejects(abortedPut, (error: unknown) => (
        error === controller.signal.reason
        || (error instanceof Error && error.name === "AbortError")
      ));

      assert.deepEqual(await winningStorage.get(storageKey, context), winningBytes);
      const remainingFiles = await readdir(root, { recursive: true });
      assert.equal(remainingFiles.some((entry) => entry.endsWith(".tmp")), false);
    } finally {
      controller.abort();
      releaseAbortedWrite.resolve();
      await abortedPut?.catch(() => undefined);
      openMock.mock.restore();
      writeFileMock.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("rejects a get with a pre-aborted signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pindou-local-storage-abort-"));
    temporaryRoots.push(root);
    const storage = new LocalEncryptedStorage({ root, keyBase64: ENCRYPTION_KEY });
    const context = { ownerId: "owner-local-abort", assetId: "asset-local-abort" };
    const storageKey = "local-aborted-read-key-0001";
    await storage.put(Buffer.from("private bytes"), context, storageKey);

    const reason = new Error("test local read deadline");
    const controller = new AbortController();
    controller.abort(reason);

    await assert.rejects(storage.get(storageKey, context, controller.signal), (error) => error === reason);
  });

  it("reclaims only stale provider temporary files across concurrent janitors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pindou-local-storage-janitor-"));
    temporaryRoots.push(root);
    const storageKey = "local-janitor-shard-key-0001";
    const shard = dirname(localObjectPath(root, storageKey));
    await mkdir(shard, { recursive: true });
    const staleLive = join(shard, `.pdae-${"a".repeat(32)}.tmp`);
    const staleClaim = join(shard, `.pdae-gc-${"b".repeat(32)}.tmp`);
    const activeWriter = join(shard, `.pdae-${"c".repeat(32)}.tmp`);
    const unrelated = join(shard, ".another-component.tmp");
    await Promise.all([
      writeFile(staleLive, "stale-live"),
      writeFile(staleClaim, "stale-claim"),
      writeFile(activeWriter, "active-writer"),
      writeFile(unrelated, "unrelated"),
    ]);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await Promise.all([
      utimes(staleLive, old, old),
      utimes(staleClaim, old, old),
      utimes(unrelated, old, old),
    ]);

    const first = new LocalEncryptedStorage({ root, keyBase64: ENCRYPTION_KEY });
    const second = new LocalEncryptedStorage({ root, keyBase64: ENCRYPTION_KEY });
    await Promise.all([first.ready(), second.ready()]);

    const remaining = await readdir(shard);
    assert.equal(remaining.includes(staleLive.split(/[\\/]/).at(-1) ?? ""), false);
    assert.equal(remaining.includes(staleClaim.split(/[\\/]/).at(-1) ?? ""), false);
    assert.equal(remaining.includes(activeWriter.split(/[\\/]/).at(-1) ?? ""), true);
    assert.equal(remaining.includes(unrelated.split(/[\\/]/).at(-1) ?? ""), true);
  });

  it("does not reclaim a heartbeating writer during another instance's stale scans", async (testContext) => {
    const root = await mkdtemp(join(tmpdir(), "pindou-local-storage-active-writer-"));
    temporaryRoots.push(root);
    const context = { ownerId: "owner-active-writer", assetId: "asset-active-writer" };
    const storageKey = "local-active-writer-key-0001";
    let logicalNow = Date.now();
    const writer = new LocalEncryptedStorage({
      root,
      keyBase64: ENCRYPTION_KEY,
      maintenance: {
        now: () => logicalNow,
        temporaryFileStaleMilliseconds: 100,
        temporaryFileHeartbeatMilliseconds: 5,
        temporaryFileJanitorIntervalMilliseconds: 10_000,
      },
    });
    const janitor = new LocalEncryptedStorage({
      root,
      keyBase64: ENCRYPTION_KEY,
      maintenance: {
        now: () => logicalNow,
        temporaryFileStaleMilliseconds: 100,
        temporaryFileHeartbeatMilliseconds: 5,
        temporaryFileJanitorIntervalMilliseconds: 20,
      },
    });
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const originalOpen = fsPromises.open;
    const openMock = testContext.mock.method(fsPromises, "open", (async (...args: unknown[]) => {
      const handle = await Reflect.apply(originalOpen, fsPromises, args) as Awaited<ReturnType<typeof originalOpen>>;
      const originalHandleWriteFile = handle.writeFile;
      handle.writeFile = (async (...writeArgs: unknown[]) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        return Reflect.apply(originalHandleWriteFile, handle, writeArgs) as Promise<void>;
      }) as typeof handle.writeFile;
      return handle;
    }) as typeof fsPromises.open);
    syncBuiltinESMExports();

    let pendingPut: Promise<{ storageKey: string }> | undefined;
    try {
      pendingPut = writer.put(Buffer.from("heartbeating private bytes"), context, storageKey);
      await writeStarted.promise;
      const temporaryEntry = (await readdir(root, { recursive: true })).find((entry) => entry.endsWith(".tmp"));
      assert.ok(temporaryEntry);
      const temporaryPath = join(root, temporaryEntry);

      // Make the creation time appear stale, then wait until the writer's
      // heartbeat proves liveness before a different instance scans the root.
      logicalNow += 1_000;
      await waitForCondition(async () => (
        (await stat(temporaryPath)).mtimeMs >= logicalNow - 2
      ), "temporary writer heartbeat");
      await janitor.ready();
      await delay(60);
      await stat(temporaryPath);

      await janitor.close();
      releaseWrite.resolve();
      await pendingPut;
      assert.deepEqual(await writer.get(storageKey, context), Buffer.from("heartbeating private bytes"));
    } finally {
      releaseWrite.resolve();
      await pendingPut?.catch(() => undefined);
      openMock.mock.restore();
      syncBuiltinESMExports();
      await Promise.all([writer.close(), janitor.close()]);
    }
  });

  it("eventually reclaims a published temporary hard link after unlink fails", async (testContext) => {
    const root = await mkdtemp(join(tmpdir(), "pindou-local-storage-unlink-retry-"));
    temporaryRoots.push(root);
    const storage = new LocalEncryptedStorage({ root, keyBase64: ENCRYPTION_KEY });
    const storageKey = "local-unlink-retry-key-0001";
    const context = { ownerId: "owner-unlink-retry", assetId: "asset-unlink-retry" };
    const contents = Buffer.from("published bytes must survive orphan reclamation");
    const originalRm = fsPromises.rm;
    const rmMock = testContext.mock.method(fsPromises, "rm", (async (...args: unknown[]) => {
      const path = String(args[0]);
      if (path.endsWith(".tmp")) {
        throw Object.assign(new Error("simulated temporary unlink failure"), { code: "EBUSY" });
      }
      return Reflect.apply(originalRm, fsPromises, args) as Promise<void>;
    }) as typeof fsPromises.rm);
    syncBuiltinESMExports();

    try {
      await storage.put(contents, context, storageKey);
    } finally {
      rmMock.mock.restore();
      syncBuiltinESMExports();
    }
    await storage.close();
    const filesAfterPut = await readdir(root, { recursive: true });
    const orphan = filesAfterPut.find((entry) => entry.endsWith(".tmp"));
    assert.ok(orphan, "the simulated unlink failure must leave an orphan for the janitor");
    const orphanPath = join(root, orphan);
    const orphanMetadata = await stat(orphanPath);
    let logicalNow = orphanMetadata.mtimeMs + 50;
    const restarted = new LocalEncryptedStorage({
      root,
      keyBase64: ENCRYPTION_KEY,
      maintenance: {
        now: () => logicalNow,
        temporaryFileStaleMilliseconds: 100,
        temporaryFileHeartbeatMilliseconds: 10,
        temporaryFileJanitorIntervalMilliseconds: 10,
      },
    });
    try {
      // Startup occurs before the orphan is stale, and there are deliberately
      // no later puts or ready() calls to trigger maintenance.
      await restarted.ready();
      await stat(orphanPath);
      logicalNow = orphanMetadata.mtimeMs + 200;
      await waitForCondition(async () => {
        try {
          await stat(orphanPath);
          return false;
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
            return true;
          }
          throw error;
        }
      }, "idle restarted storage to reclaim its stale orphan");

      assert.deepEqual(await restarted.get(storageKey, context), contents);
      const filesAfterJanitor = await readdir(root, { recursive: true });
      assert.equal(filesAfterJanitor.some((entry) => entry.endsWith(".tmp")), false);
    } finally {
      await restarted.close();
    }
  });
});
