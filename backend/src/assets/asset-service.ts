import type { AssetMetadata, AssetRecord } from "../domain/models.js";
import { AppError } from "../errors.js";
import type { AppStore } from "../repositories/store.js";
import type { StorageProvider } from "../storage/storage-provider.js";

export interface AssetPurgeFailure {
  assetId: string;
  code: string;
  retryable: true;
}

export interface AssetPurgeResult {
  scanned: number;
  purged: number;
  skipped: number;
  failed: number;
  failures: AssetPurgeFailure[];
}

export function publicAsset(record: AssetRecord): AssetMetadata {
  return {
    id: record.id,
    userId: record.userId,
    purpose: record.purpose,
    consentVersion: record.consentVersion,
    sha256: record.sha256,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    width: record.width,
    height: record.height,
    expiresAt: record.expiresAt,
    deletedAt: record.deletedAt,
    createdAt: record.createdAt,
  };
}

export function assertAssetAvailable(record: AssetRecord, now = Date.now()): void {
  if (record.readyAt === null || record.deletedAt !== null
    || (record.expiresAt !== null && Date.parse(record.expiresAt) <= now)) {
    throw new AppError(410, "ASSET_UNAVAILABLE", "素材尚未就绪、已删除或已过期");
  }
}

export async function deleteOwnedAsset(input: {
  store: AppStore;
  storage: StorageProvider;
  userId: string;
  assetId: string;
  now: string;
}): Promise<void> {
  const existing = await input.store.getAsset(input.userId, input.assetId);
  if (!existing) throw new AppError(404, "ASSET_NOT_FOUND", "素材不存在");
  const deleted = await input.store.markAssetDeleted(input.userId, input.assetId, input.now);
  if (!deleted) throw new AppError(404, "ASSET_NOT_FOUND", "素材不存在");
  if (deleted.purgedAt === null) {
    await input.storage.delete(deleted.storageKey);
    await input.store.markAssetPurged(deleted.id, input.now);
  }
}

export async function purgeExpiredAssets(input: {
  store: AppStore;
  storage: StorageProvider;
  now: string;
  limit: number;
}): Promise<AssetPurgeResult> {
  const candidates = await input.store.listAssetsForPurge(input.now, input.limit);
  let purged = 0;
  let skipped = 0;
  const failures: AssetPurgeFailure[] = [];
  for (const candidate of candidates) {
    try {
      const deleted = await input.store.claimAssetForPurge(candidate.userId, candidate.id, input.now);
      if (!deleted || deleted.purgedAt !== null) {
        skipped += 1;
        continue;
      }
      await input.storage.delete(deleted.storageKey);
      await input.store.markAssetPurged(deleted.id, input.now);
      purged += 1;
    } catch (error) {
      await input.store.recordAssetPurgeFailure(candidate.id, input.now).catch(() => undefined);
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : "ASSET_PURGE_FAILED";
      failures.push({ assetId: candidate.id, code, retryable: true });
    }
  }
  return {
    scanned: candidates.length,
    purged,
    skipped,
    failed: failures.length,
    failures,
  };
}
