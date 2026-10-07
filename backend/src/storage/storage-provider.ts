export interface StorageObjectContext {
  ownerId: string;
  assetId: string;
}

export interface StorageProvider {
  ready(): Promise<void>;
  /** Releases provider-owned sockets or clients. In-memory/local providers may omit it. */
  close?(): Promise<void> | void;
  put(
    contents: Buffer,
    context: StorageObjectContext,
    storageKey?: string,
    signal?: AbortSignal,
  ): Promise<{ storageKey: string }>;
  get(storageKey: string, context: StorageObjectContext, signal?: AbortSignal): Promise<Buffer | null>;
  delete(storageKey: string): Promise<void>;
}

export async function closeStorageProvider(storage: StorageProvider): Promise<void> {
  await storage.close?.();
}

export class StorageObjectCorruptedError extends Error {
  constructor() {
    super("私有素材密文无法验证");
    this.name = "StorageObjectCorruptedError";
  }
}

export class StorageDependencyUnavailableError extends Error {
  constructor(cause: unknown) {
    super("私有存储依赖暂时不可用", { cause });
    this.name = "StorageDependencyUnavailableError";
  }
}

/**
 * A well-formed encrypted object references key material that is not loaded in
 * this process. This is operationally recoverable by restoring the complete
 * keyring and must not be reported as permanent object corruption.
 */
export class StorageEncryptionKeyUnavailableError extends StorageDependencyUnavailableError {
  constructor() {
    super(new Error("私有存储加密密钥未配置"));
    this.name = "StorageEncryptionKeyUnavailableError";
  }
}
