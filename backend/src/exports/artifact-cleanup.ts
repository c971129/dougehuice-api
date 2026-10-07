import type { AppStore } from "../repositories/store.js";
import type { StorageProvider } from "../storage/storage-provider.js";

export interface ExportArtifactPurgeFailure {
  artifactId: string;
  code: string;
  retryable: true;
}

export interface ExportArtifactPurgeResult {
  scanned: number;
  purged: number;
  failed: number;
  failures: ExportArtifactPurgeFailure[];
}

export async function purgeExpiredExportArtifacts(input: {
  store: AppStore;
  storage: StorageProvider;
  now: string;
  limit: number;
}): Promise<ExportArtifactPurgeResult> {
  const candidates = await input.store.listExportArtifactsForPurge(input.now, input.limit);
  let purged = 0;
  const failures: ExportArtifactPurgeFailure[] = [];
  for (const candidate of candidates) {
    try {
      const claimed = await input.store.claimExportArtifactForPurge(candidate.id, input.now);
      if (!claimed) continue;
      await input.storage.delete(claimed.storageKey);
      await input.store.markExportArtifactPurged(claimed.id, input.now);
      purged += 1;
    } catch (error) {
      await input.store.recordExportArtifactPurgeFailure(candidate.id, input.now).catch(() => undefined);
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : "EXPORT_ARTIFACT_PURGE_FAILED";
      failures.push({ artifactId: candidate.id, code, retryable: true });
    }
  }
  return {
    scanned: candidates.length,
    purged,
    failed: failures.length,
    failures,
  };
}
