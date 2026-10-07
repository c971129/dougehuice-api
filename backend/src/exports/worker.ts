import { createHash, randomUUID } from "node:crypto";

import type { ExportArtifactRecord, ExportJobRecord } from "../domain/models.js";
import { AppError } from "../errors.js";
import type { AppStore } from "../repositories/store.js";
import type { StorageProvider } from "../storage/storage-provider.js";
import { startLeaseHeartbeat, throwIfLeaseAborted } from "../workers/lease-heartbeat.js";
import { renderProjectExport } from "./renderer.js";

const LEASE_MILLISECONDS = 2 * 60_000;
const ARTIFACT_TTL_MILLISECONDS = 7 * 24 * 60 * 60_000;

function publicFailureMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return "导出处理暂时失败";
}

function failureCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  return "EXPORT_WORKER_FAILED";
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof AppError)) return true;
  return !new Set([
    "EXPORT_PALETTE_MISMATCH",
    "EXPORT_GRID_CORRUPTED",
    "EXPORT_COLOR_NOT_FOUND",
    "EXPORT_PALETTE_CORRUPTED",
    "EXPORT_RENDER_EMPTY",
    "PROJECT_REVISION_NOT_FOUND",
    "PALETTE_NOT_FOUND",
  ]).has(error.code) && error.statusCode >= 500;
}

function currentTime(fixed: Date | undefined): Date {
  return fixed ? new Date(fixed.getTime()) : new Date();
}

function assertLeaseOwnership(job: ExportJobRecord, leaseToken: string): void {
  if (job.status !== "running" || job.leaseToken !== leaseToken) {
    throw new AppError(409, "EXPORT_LEASE_LOST", "导出任务租约已失效");
  }
}

function artifactStorageKey(jobId: string, attemptCount: number): string {
  return createHash("sha256").update(`export:${jobId}:attempt:${attemptCount}`).digest("base64url");
}

async function cleanupPreparedArtifact(input: {
  store: AppStore;
  storage: StorageProvider;
  artifactId: string;
  storageKey: string;
  now: string;
}): Promise<void> {
  try {
    await input.storage.delete(input.storageKey);
    await input.store.markExportArtifactPurged(input.artifactId, input.now);
  } catch {
    // Keep the pending metadata authoritative when physical deletion is
    // uncertain. The janitor can then retry without losing the object key.
    await input.store.recordExportArtifactPurgeFailure(input.artifactId, input.now).catch(() => undefined);
  }
}

export async function processNextExport(input: {
  store: AppStore;
  storage: StorageProvider;
  now?: Date;
  leaseMilliseconds?: number;
  heartbeatIntervalMilliseconds?: number;
  render?: typeof renderProjectExport;
  signal?: AbortSignal;
}): Promise<ExportJobRecord | null> {
  const claimTime = currentTime(input.now);
  const leaseToken = randomUUID();
  const leaseMilliseconds = input.leaseMilliseconds ?? LEASE_MILLISECONDS;
  const claimed = await input.store.claimNextExportJob({
    now: claimTime.toISOString(),
    leaseToken,
    leaseMilliseconds,
  });
  if (!claimed) return null;
  const heartbeat = startLeaseHeartbeat({
    ...(input.signal ? { abortSignal: input.signal } : {}),
    intervalMilliseconds: input.heartbeatIntervalMilliseconds ?? Math.max(1, Math.floor(leaseMilliseconds / 3)),
    renew: async () => {
      const now = currentTime(input.now);
      return input.store.renewExportJobLease({
        jobId: claimed.id,
        leaseToken,
        now: now.toISOString(),
        leaseMilliseconds,
      });
    },
  });

  // A stable per-attempt key lets a later retry remove bytes left behind if a
  // previous process died after storage.put but before it could clean up.
  for (let attempt = 1; attempt < claimed.attemptCount; attempt += 1) {
    await input.storage.delete(artifactStorageKey(claimed.id, attempt)).catch(() => undefined);
  }

  let storedKey: string | null = null;
  let artifactId: string | null = null;
  let preparedArtifact: ExportArtifactRecord | null = null;
  let completionAttempted = false;
  try {
    throwIfLeaseAborted(heartbeat.signal);
    const project = await input.store.getProjectForExport({
      userId: claimed.userId,
      projectId: claimed.projectId,
      projectRevision: claimed.projectRevision,
    });
    if (!project) throw new AppError(404, "PROJECT_REVISION_NOT_FOUND", "项目或指定版本不存在");
    const palette = await input.store.getPalette(project.paletteId, claimed.userId);
    if (!palette) throw new AppError(404, "PALETTE_NOT_FOUND", "项目色卡不存在");
    const rendered = await (input.render ?? renderProjectExport)({
      project: { ...project, name: claimed.fileName },
      palette,
      format: claimed.format,
      fileName: claimed.fileName,
      options: claimed.options,
      signal: heartbeat.signal,
    });
    throwIfLeaseAborted(heartbeat.signal);

    const beforeStore = await input.store.getExportJob(claimed.userId, claimed.id);
    if (!beforeStore) return null;
    if (beforeStore.status !== "running" || beforeStore.leaseToken !== leaseToken) return beforeStore;
    assertLeaseOwnership(beforeStore, leaseToken);

    artifactId = randomUUID();
    const preparedAt = currentTime(input.now);
    preparedArtifact = {
      id: artifactId,
      jobId: claimed.id,
      storageKey: artifactStorageKey(claimed.id, claimed.attemptCount),
      mimeType: rendered.mimeType,
      fileName: rendered.fileName,
      sizeBytes: rendered.contents.length,
      sha256: rendered.sha256,
      expiresAt: new Date(preparedAt.getTime() + ARTIFACT_TTL_MILLISECONDS).toISOString(),
      createdAt: preparedAt.toISOString(),
    };
    await input.store.prepareExportArtifact({
      jobId: claimed.id,
      leaseToken,
      artifact: preparedArtifact,
      now: preparedAt.toISOString(),
    });
    const stored = await input.storage.put(
      rendered.contents,
      { ownerId: claimed.userId, assetId: artifactId },
      preparedArtifact.storageKey,
      heartbeat.signal,
    );
    storedKey = stored.storageKey;
    throwIfLeaseAborted(heartbeat.signal);
    const beforeComplete = await input.store.getExportJob(claimed.userId, claimed.id);
    if (!beforeComplete) {
      await cleanupPreparedArtifact({
        store: input.store,
        storage: input.storage,
        artifactId,
        storageKey: storedKey,
        now: currentTime(input.now).toISOString(),
      });
      storedKey = null;
      return null;
    }
    if (beforeComplete.status !== "running" || beforeComplete.leaseToken !== leaseToken) {
      await cleanupPreparedArtifact({
        store: input.store,
        storage: input.storage,
        artifactId,
        storageKey: storedKey,
        now: currentTime(input.now).toISOString(),
      });
      storedKey = null;
      return beforeComplete;
    }
    assertLeaseOwnership(beforeComplete, leaseToken);
    throwIfLeaseAborted(heartbeat.signal);

    const completedAt = currentTime(input.now);
    completionAttempted = true;
    return await input.store.completeExportJob({
      jobId: claimed.id,
      leaseToken,
      artifact: { ...preparedArtifact, storageKey: stored.storageKey },
      now: completedAt.toISOString(),
    });
  } catch (error) {
    let current: ExportJobRecord | null = null;
    try {
      current = await input.store.getExportJob(claimed.userId, claimed.id);
    } catch {
      // A completion acknowledgement can be lost after the database commits. In
      // that ambiguous state, retaining the encrypted object is safer than
      // deleting the artifact referenced by a possibly successful transaction.
      if (completionAttempted && storedKey) throw error;
    }
    if (completionAttempted && storedKey && current?.status === "succeeded"
      && current.artifact?.storageKey === storedKey) {
      return current;
    }
    if (storedKey) {
      if (artifactId) {
        await cleanupPreparedArtifact({
          store: input.store,
          storage: input.storage,
          artifactId,
          storageKey: storedKey,
          now: currentTime(input.now).toISOString(),
        });
      } else {
        await input.storage.delete(storedKey).catch(() => undefined);
      }
      storedKey = null;
    }
    if (heartbeat.signal.aborted) return current;
    if (current && (current.status !== "running" || current.leaseToken !== leaseToken)) return current;

    const failedAt = currentTime(input.now);
    const delaySeconds = Math.min(300, 10 * 2 ** Math.max(0, claimed.attemptCount - 1));
    try {
      return await input.store.failExportJob({
        jobId: claimed.id,
        leaseToken,
        code: failureCode(error),
        message: publicFailureMessage(error),
        retryable: isRetryable(error),
        availableAt: new Date(failedAt.getTime() + delaySeconds * 1_000).toISOString(),
        now: failedAt.toISOString(),
      });
    } catch (stateError) {
      if (stateError instanceof AppError && stateError.code === "EXPORT_LEASE_LOST") {
        return input.store.getExportJob(claimed.userId, claimed.id);
      }
      throw stateError;
    }
  } finally {
    await heartbeat.stop();
  }
}
