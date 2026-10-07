import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { StorageObjectContext, StorageProvider } from "./storage-provider.js";
import {
  assertStorageKey,
  createStorageEncryptionKeyring,
  decryptStorageObject,
  encryptStorageObject,
  type StorageEncryptionKeyConfig,
  type StorageEncryptionKeyring,
} from "./encrypted-object.js";

const STORAGE_SHARD_DIRECTORY_PATTERN = /^[0-9a-f]{2}$/;
const STORAGE_TEMPORARY_FILE_PATTERN = /^\.pdae-(?:[0-9a-f]{32}|gc-[0-9a-f]{32})\.tmp$/;
const STORAGE_TEMPORARY_FILE_STALE_MILLISECONDS = 30 * 60_000;
const STORAGE_TEMPORARY_FILE_HEARTBEAT_MILLISECONDS = 60_000;
const STORAGE_TEMPORARY_FILE_JANITOR_INTERVAL_MILLISECONDS = 5 * 60_000;

export interface LocalEncryptedStorageMaintenanceOptions {
  /** Test seam for deterministic stale-file and periodic-maintenance coverage. */
  now?: () => number;
  temporaryFileStaleMilliseconds?: number;
  temporaryFileHeartbeatMilliseconds?: number;
  temporaryFileJanitorIntervalMilliseconds?: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function createTemporaryFile(
  directory: string,
  signal?: AbortSignal,
): Promise<{ handle: FileHandle; path: string }> {
  for (;;) {
    signal?.throwIfAborted();
    const path = join(directory, `.pdae-${randomBytes(16).toString("hex")}.tmp`);
    try {
      return { handle: await open(path, "wx", 0o600), path };
    } catch (error) {
      // A random-name collision is not a collision on the requested storage key.
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
  }
}

async function readDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

function positiveMilliseconds(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} 必须为正整数毫秒`);
  }
  return resolved;
}

async function removeStaleTemporaryFiles(
  root: string,
  nowMilliseconds: number,
  staleMilliseconds: number,
): Promise<void> {
  const firstLevel = await readDirectory(root);
  for (const first of firstLevel) {
    if (!first.isDirectory() || !STORAGE_SHARD_DIRECTORY_PATTERN.test(first.name)) continue;
    const firstPath = join(root, first.name);
    const secondLevel = await readDirectory(firstPath);
    for (const second of secondLevel) {
      if (!second.isDirectory() || !STORAGE_SHARD_DIRECTORY_PATTERN.test(second.name)) continue;
      const shardPath = join(firstPath, second.name);
      const entries = await readDirectory(shardPath);
      for (const entry of entries) {
        if (!entry.isFile() || !STORAGE_TEMPORARY_FILE_PATTERN.test(entry.name)) continue;
        const candidatePath = join(shardPath, entry.name);
        let candidateMetadata: Awaited<ReturnType<typeof lstat>>;
        try {
          candidateMetadata = await lstat(candidatePath);
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) continue;
          // A single inaccessible orphan must not make the whole storage
          // provider unavailable. Leave it for a later janitor pass.
          continue;
        }
        if (!candidateMetadata.isFile()
          || nowMilliseconds - candidateMetadata.mtimeMs < staleMilliseconds) {
          continue;
        }

        // Rename is the cross-process claim: only one process can move this
        // exact random name. Claimed names stay in our namespace so a crash or
        // another unlink failure is retried by the next pass.
        const claimedPath = join(shardPath, `.pdae-gc-${randomBytes(16).toString("hex")}.tmp`);
        try {
          await rename(candidatePath, claimedPath);
        } catch {
          continue;
        }
        try {
          const claimedMetadata = await lstat(claimedPath);
          // An active writer refreshes mtime while its handle is open. Recheck
          // after the atomic claim to close the stat/rename race.
          if (nowMilliseconds - claimedMetadata.mtimeMs < staleMilliseconds) {
            await rename(claimedPath, candidatePath).catch(() => undefined);
            continue;
          }
          await rm(claimedPath, { force: true });
        } catch {
          // Keep the claimed name for a future pass. Never broaden deletion to
          // arbitrary .tmp files or directories under the configured root.
        }
      }
    }
  }
}

function startTemporaryFileHeartbeat(
  path: string,
  intervalMilliseconds: number,
  now: () => number,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    const timestamp = new Date(now());
    void utimes(path, timestamp, timestamp).catch(() => undefined);
  }, intervalMilliseconds);
  timer.unref();
  return timer;
}

export class LocalEncryptedStorage implements StorageProvider {
  private readonly root: string;
  private readonly keyring: StorageEncryptionKeyring;
  private readonly now: () => number;
  private readonly temporaryFileStaleMilliseconds: number;
  private readonly temporaryFileHeartbeatMilliseconds: number;
  private readonly temporaryFileJanitorIntervalMilliseconds: number;
  private temporaryFileJanitor: Promise<void> | undefined;
  private temporaryFileJanitorTimer: NodeJS.Timeout | undefined;
  private nextTemporaryFileJanitorAt = 0;
  private maintenanceClosed = false;

  constructor(input: {
    root: string;
    maintenance?: LocalEncryptedStorageMaintenanceOptions;
  } & StorageEncryptionKeyConfig) {
    this.root = resolve(input.root);
    this.keyring = createStorageEncryptionKeyring(input);
    this.now = input.maintenance?.now ?? Date.now;
    this.temporaryFileStaleMilliseconds = positiveMilliseconds(
      input.maintenance?.temporaryFileStaleMilliseconds,
      STORAGE_TEMPORARY_FILE_STALE_MILLISECONDS,
      "临时文件过期时间",
    );
    this.temporaryFileHeartbeatMilliseconds = positiveMilliseconds(
      input.maintenance?.temporaryFileHeartbeatMilliseconds,
      STORAGE_TEMPORARY_FILE_HEARTBEAT_MILLISECONDS,
      "临时文件心跳间隔",
    );
    this.temporaryFileJanitorIntervalMilliseconds = positiveMilliseconds(
      input.maintenance?.temporaryFileJanitorIntervalMilliseconds,
      STORAGE_TEMPORARY_FILE_JANITOR_INTERVAL_MILLISECONDS,
      "临时文件清理间隔",
    );
    if (this.temporaryFileHeartbeatMilliseconds >= this.temporaryFileStaleMilliseconds) {
      throw new Error("临时文件心跳间隔必须小于过期时间");
    }
  }

  async ready(): Promise<void> {
    if (this.maintenanceClosed) throw new Error("本地私有存储已关闭");
    await mkdir(this.root, { recursive: true });
    if (this.maintenanceClosed) throw new Error("本地私有存储已关闭");
    await this.runTemporaryFileJanitor();
    this.ensureTemporaryFileJanitorTimer();
  }

  async close(): Promise<void> {
    this.maintenanceClosed = true;
    if (this.temporaryFileJanitorTimer) {
      clearInterval(this.temporaryFileJanitorTimer);
      this.temporaryFileJanitorTimer = undefined;
    }
    await this.temporaryFileJanitor?.catch(() => undefined);
  }

  private async runTemporaryFileJanitor(): Promise<void> {
    if (this.maintenanceClosed) return;
    if (this.temporaryFileJanitor) return this.temporaryFileJanitor;
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error("本地私有存储时钟无效");
    if (now < this.nextTemporaryFileJanitorAt) return;
    this.nextTemporaryFileJanitorAt = now + this.temporaryFileJanitorIntervalMilliseconds;
    const janitor = removeStaleTemporaryFiles(
      this.root,
      now,
      this.temporaryFileStaleMilliseconds,
    );
    this.temporaryFileJanitor = janitor;
    try {
      await janitor;
    } catch (error) {
      this.nextTemporaryFileJanitorAt = 0;
      throw error;
    } finally {
      if (this.temporaryFileJanitor === janitor) this.temporaryFileJanitor = undefined;
    }
  }

  private ensureTemporaryFileJanitorTimer(): void {
    if (this.maintenanceClosed || this.temporaryFileJanitorTimer) return;
    this.temporaryFileJanitorTimer = setInterval(() => {
      void this.runTemporaryFileJanitor().catch(() => undefined);
    }, this.temporaryFileJanitorIntervalMilliseconds);
    this.temporaryFileJanitorTimer.unref();
  }

  async put(
    contents: Buffer,
    context: StorageObjectContext,
    requestedStorageKey?: string,
    signal?: AbortSignal,
  ): Promise<{ storageKey: string }> {
    signal?.throwIfAborted();
    await this.ready();
    signal?.throwIfAborted();
    const storageKey = requestedStorageKey ?? randomBytes(24).toString("base64url");
    assertStorageKey(storageKey);
    const target = this.pathFor(storageKey);
    const targetDirectory = dirname(target);
    await mkdir(targetDirectory, { recursive: true });
    signal?.throwIfAborted();

    const payload = encryptStorageObject(contents, this.keyring, storageKey, context);
    let temporaryHandle: FileHandle | undefined;
    let temporaryPath: string | undefined;
    let temporaryHeartbeat: NodeJS.Timeout | undefined;
    try {
      ({ handle: temporaryHandle, path: temporaryPath } = await createTemporaryFile(targetDirectory, signal));
      temporaryHeartbeat = startTemporaryFileHeartbeat(
        temporaryPath,
        this.temporaryFileHeartbeatMilliseconds,
        this.now,
      );
      await temporaryHandle.writeFile(payload, signal ? { signal } : undefined);

      // Windows can reject linking or unlinking an open file, so close the private
      // temporary file before the atomic, create-only publish step.
      await temporaryHandle.close();
      temporaryHandle = undefined;
      signal?.throwIfAborted();

      // A hard link in the same directory is atomic and never replaces `target`.
      // EEXIST therefore continues to mean that another writer won this key.
      await link(temporaryPath, target);
    } finally {
      if (temporaryHeartbeat) clearInterval(temporaryHeartbeat);
      await temporaryHandle?.close().catch(() => undefined);
      if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return { storageKey };
  }

  async get(storageKey: string, context: StorageObjectContext, signal?: AbortSignal): Promise<Buffer | null> {
    signal?.throwIfAborted();
    let payload: Buffer;
    try {
      payload = await readFile(this.pathFor(storageKey), signal ? { signal } : undefined);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    }
    signal?.throwIfAborted();
    const contents = decryptStorageObject(payload, this.keyring, storageKey, context);
    signal?.throwIfAborted();
    return contents;
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }

  private pathFor(storageKey: string): string {
    const digest = createHash("sha256").update(storageKey).digest("hex");
    return join(this.root, digest.slice(0, 2), digest.slice(2, 4), `${digest}.pdae`);
  }
}
