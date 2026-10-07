import { randomBytes } from "node:crypto";

import type { StorageObjectContext, StorageProvider } from "./storage-provider.js";

interface VolatileObject {
  contents: Buffer;
  ownerId: string;
  assetId: string;
}

/**
 * Process-local storage for the explicitly volatile integration server.
 * Metadata and bytes share the same lifetime, so a restart cannot leave
 * persistent encrypted objects that the fresh MemoryStore can no longer find.
 */
export class VolatileMemoryStorage implements StorageProvider {
  private readonly objects = new Map<string, VolatileObject>();

  async ready(): Promise<void> {}

  async put(
    contents: Buffer,
    context: StorageObjectContext,
    storageKey = randomBytes(24).toString("base64url"),
    signal?: AbortSignal,
  ): Promise<{ storageKey: string }> {
    signal?.throwIfAborted();
    if (this.objects.has(storageKey)) {
      throw new Error("私有存储键已存在");
    }
    this.objects.set(storageKey, {
      contents: Buffer.from(contents),
      ownerId: context.ownerId,
      assetId: context.assetId,
    });
    return { storageKey };
  }

  async get(storageKey: string, context: StorageObjectContext, signal?: AbortSignal): Promise<Buffer | null> {
    signal?.throwIfAborted();
    const object = this.objects.get(storageKey);
    if (!object) return null;
    if (object.ownerId !== context.ownerId || object.assetId !== context.assetId) {
      throw new Error("私有存储对象无法验证");
    }
    const contents = Buffer.from(object.contents);
    signal?.throwIfAborted();
    return contents;
  }

  async delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey);
  }
}

