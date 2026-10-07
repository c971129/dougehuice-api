import { createHash, randomUUID } from "node:crypto";

import { assertAssetAvailable } from "../assets/asset-service.js";
import { assertGenerationCandidatesStructure } from "../domain/generation-candidates.js";
import { assertValidGrid } from "../domain/grid.js";
import type { GenerationJob } from "../domain/models.js";
import { isPaletteSelectable } from "../domain/palettes.js";
import { MAX_GENERATION_CANDIDATES } from "../domain/resource-limits.js";
import { AppError } from "../errors.js";
import type { AppStore } from "../repositories/store.js";
import {
  StorageObjectCorruptedError,
  type StorageProvider,
} from "../storage/storage-provider.js";
import { startLeaseHeartbeat, throwIfLeaseAborted } from "../workers/lease-heartbeat.js";
import type { GenerationProvider } from "./provider.js";

const LEASE_MILLISECONDS = 2 * 60_000;

function currentTime(fixed: Date | undefined): Date {
  return fixed ? new Date(fixed.getTime()) : new Date();
}

function failureCode(error: unknown): string {
  return error instanceof AppError ? error.code : "GENERATION_PROVIDER_FAILED";
}

function failureMessage(error: unknown): string {
  return error instanceof AppError ? error.message : "生成处理暂时失败";
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof AppError)) return true;
  return !new Set([
    "GENERATION_SOURCE_ASSET_NOT_FOUND",
    "GENERATION_SOURCE_ASSET_UNAVAILABLE",
    "GENERATION_SOURCE_ASSET_CORRUPTED",
    "PALETTE_NOT_FOUND",
    "INVALID_GRID_ENCODING",
    "INVALID_GRID_SIZE",
    "INVALID_GRID_CELLS",
    "UNKNOWN_PALETTE_COLOR",
    "GENERATION_CANDIDATES_INVALID",
    "GENERATION_PROVIDER_RESPONSE_INVALID",
    "GENERATION_CANDIDATE_LIMIT_EXCEEDED",
    "GENERATION_INVENTORY_EMPTY",
    "GENERATION_COLOR_LIMIT_EXCEEDED",
    "GENERATION_INVENTORY_CONSTRAINT_VIOLATED",
    "GENERATION_SOURCE_REQUIRED",
    "GENERATION_SOURCE_TOO_LARGE",
    "GENERATION_SOURCE_FORMAT_UNSUPPORTED",
    "GENERATION_SOURCE_ANIMATED_UNSUPPORTED",
    "GENERATION_SOURCE_DIMENSIONS_EXCEEDED",
    "GENERATION_SOURCE_DECODE_FAILED",
    "GENERATION_SOURCE_TRANSFORM_FAILED",
    "GENERATION_CROP_INVALID",
    "GENERATION_CROP_OUTSIDE_SOURCE",
    "GENERATION_TARGET_SIZE_INVALID",
    "GENERATION_MAX_COLORS_INVALID",
    "GENERATION_RASTER_MODE_UNSUPPORTED",
    "GENERATION_PALETTE_INVALID",
  ]).has(error.code) && error.statusCode >= 500;
}

async function getSourceContents(input: {
  job: GenerationJob;
  store: AppStore;
  storage: StorageProvider;
  now: Date;
  signal: AbortSignal;
}): Promise<Buffer | null> {
  if (!input.job.sourceAssetId) return null;
  const asset = await input.store.getAsset(input.job.userId, input.job.sourceAssetId);
  if (!asset || asset.purpose !== "ai-source") {
    throw new AppError(404, "GENERATION_SOURCE_ASSET_NOT_FOUND", "AI 原始素材不存在");
  }
  try {
    assertAssetAvailable(asset, input.now.getTime());
  } catch {
    throw new AppError(410, "GENERATION_SOURCE_ASSET_UNAVAILABLE", "AI 原始素材已删除或过期");
  }
  let contents: Buffer | null;
  try {
    contents = await input.storage.get(
      asset.storageKey,
      { ownerId: asset.userId, assetId: asset.id },
      input.signal,
    );
  } catch (error) {
    if (error instanceof StorageObjectCorruptedError) {
      throw new AppError(410, "GENERATION_SOURCE_ASSET_CORRUPTED", "AI 原始素材校验失败");
    }
    throw error;
  }
  if (!contents) throw new AppError(410, "GENERATION_SOURCE_ASSET_UNAVAILABLE", "AI 原始素材内容已清理");
  const digest = createHash("sha256").update(contents).digest("hex");
  if (contents.length !== asset.sizeBytes || digest !== asset.sha256) {
    throw new AppError(410, "GENERATION_SOURCE_ASSET_CORRUPTED", "AI 原始素材校验失败");
  }
  return contents;
}

export async function processNextGeneration(input: {
  store: AppStore;
  storage: StorageProvider;
  provider: GenerationProvider;
  now?: Date;
  leaseMilliseconds?: number;
  heartbeatIntervalMilliseconds?: number;
  signal?: AbortSignal;
}): Promise<GenerationJob | null> {
  const claimTime = currentTime(input.now);
  const leaseToken = randomUUID();
  const leaseMilliseconds = input.leaseMilliseconds ?? LEASE_MILLISECONDS;
  const claimed = await input.store.claimNextGenerationJob({
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
      return input.store.renewGenerationJobLease({
        jobId: claimed.id,
        leaseToken,
        now: now.toISOString(),
        leaseMilliseconds,
      });
    },
  });

  try {
    throwIfLeaseAborted(heartbeat.signal);
    await input.store.advanceGenerationJob({
      jobId: claimed.id,
      leaseToken,
      status: "preprocessing",
      progress: 15,
      now: currentTime(input.now).toISOString(),
    });
    const sourceContents = await getSourceContents({
      job: claimed,
      store: input.store,
      storage: input.storage,
      now: currentTime(input.now),
      signal: heartbeat.signal,
    });
    throwIfLeaseAborted(heartbeat.signal);
    const palette = await input.store.getPalette(claimed.paletteId, claimed.userId);
    if (!palette) throw new AppError(404, "PALETTE_NOT_FOUND", "生成任务色卡不存在");
    if (!isPaletteSelectable(palette)) {
      throw new AppError(409, "PALETTE_RETIRED", "该色卡已停用，生成任务已终止并退还次数");
    }
    const availableColorCodes = claimed.options.inventoryOnly
      ? (await input.store.listInventory(claimed.userId, claimed.paletteId))
        .filter((item) => item.quantity > 0)
        .map((item) => item.colorCode)
      : null;
    if (availableColorCodes && availableColorCodes.length === 0) {
      throw new AppError(409, "GENERATION_INVENTORY_EMPTY", "豆仓中没有可用于当前色卡的颜色");
    }
    await input.store.advanceGenerationJob({
      jobId: claimed.id,
      leaseToken,
      status: "generating",
      progress: 45,
      now: currentTime(input.now).toISOString(),
    });
    const candidates = await input.provider.generate({
      job: claimed,
      palette,
      sourceContents,
      availableColorCodes,
      signal: heartbeat.signal,
      now: currentTime(input.now).toISOString(),
    });
    throwIfLeaseAborted(heartbeat.signal);
    await input.store.advanceGenerationJob({
      jobId: claimed.id,
      leaseToken,
      status: "mapping_colors",
      progress: 75,
      now: currentTime(input.now).toISOString(),
    });
    if (!candidates.length || candidates.some((candidate) => candidate.jobId !== claimed.id)) {
      throw new AppError(500, "GENERATION_CANDIDATES_INVALID", "生成 Provider 返回了无效候选");
    }
    if (candidates.length > MAX_GENERATION_CANDIDATES) {
      throw new AppError(
        500,
        "GENERATION_CANDIDATE_LIMIT_EXCEEDED",
        `生成 Provider 返回的候选数量超过上限 ${MAX_GENERATION_CANDIDATES}`,
      );
    }
    assertGenerationCandidatesStructure({
      jobId: claimed.id,
      kind: claimed.kind,
      options: claimed.options,
      width: claimed.width,
      height: claimed.height,
      candidates,
    });
    for (const candidate of candidates) {
      if (candidate.grid.width !== claimed.width || candidate.grid.height !== claimed.height) {
        throw new AppError(500, "GENERATION_CANDIDATES_INVALID", "生成候选尺寸与任务不一致");
      }
      assertValidGrid(candidate.grid, palette);
      const usedColors = new Set(candidate.grid.cells.filter((color): color is string => color !== null));
      if (usedColors.size > claimed.options.maxColors) {
        throw new AppError(500, "GENERATION_COLOR_LIMIT_EXCEEDED", "生成候选超过最大颜色数量");
      }
      if (availableColorCodes) {
        const available = new Set(availableColorCodes);
        if ([...usedColors].some((color) => !available.has(color))) {
          throw new AppError(500, "GENERATION_INVENTORY_CONSTRAINT_VIOLATED", "生成候选使用了豆仓之外的颜色");
        }
      }
    }
    await input.store.advanceGenerationJob({
      jobId: claimed.id,
      leaseToken,
      status: "finalizing",
      progress: 95,
      now: currentTime(input.now).toISOString(),
    });
    throwIfLeaseAborted(heartbeat.signal);
    return input.store.completeGenerationJob({
      jobId: claimed.id,
      leaseToken,
      candidates,
      now: currentTime(input.now).toISOString(),
    });
  } catch (error) {
    const current = await input.store.getGenerationJob(claimed.userId, claimed.id).catch(() => null);
    if (heartbeat.signal.aborted || (current && (current.status === "canceled" || current.leaseToken !== leaseToken))) {
      return current;
    }
    const failedAt = currentTime(input.now);
    const delaySeconds = Math.min(300, 10 * 2 ** Math.max(0, claimed.attemptCount - 1));
    try {
      return await input.store.failGenerationJob({
        jobId: claimed.id,
        leaseToken,
        code: failureCode(error),
        message: failureMessage(error),
        retryable: isRetryable(error),
        availableAt: new Date(failedAt.getTime() + delaySeconds * 1_000).toISOString(),
        now: failedAt.toISOString(),
      });
    } catch (stateError) {
      if (stateError instanceof AppError && stateError.code === "GENERATION_LEASE_LOST") {
        return input.store.getGenerationJob(claimed.userId, claimed.id);
      }
      throw stateError;
    }
  } finally {
    await heartbeat.stop();
  }
}
