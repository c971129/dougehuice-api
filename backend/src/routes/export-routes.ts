import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuth } from "../auth.js";
import type { ExportArtifactRecord, ExportJobRecord } from "../domain/models.js";
import { USER_RATE_LIMITS } from "../domain/resource-limits.js";
import { AppError } from "../errors.js";
import { purgeExpiredExportArtifacts } from "../exports/artifact-cleanup.js";
import {
  DEFAULT_EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY,
  DEFAULT_EXPORT_DOWNLOAD_PER_USER_CONCURRENCY,
  DEFAULT_EXPORT_DOWNLOAD_READ_TIMEOUT_MILLISECONDS,
  DEFAULT_EXPORT_DOWNLOAD_WRITE_TIMEOUT_MILLISECONDS,
  ExportDownloadConcurrencyGate,
} from "../exports/download-concurrency.js";
import {
  normalizeExportBaseName,
  normalizeExportOptions,
  toWellFormedUnicode,
} from "../exports/renderer.js";
import { processNextExport } from "../exports/worker.js";
import { executeIdempotent, requireIdempotencyKey } from "../idempotency.js";
import { requireUserRateLimit } from "../rate-limit.js";
import { StorageObjectCorruptedError } from "../storage/storage-provider.js";
import type { RouteDependencies } from "./types.js";

const ExportIdParams = Type.Object(
  { exportId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const ExportOptionsSchema = Type.Object({
  paper: Type.Optional(Type.Literal("A4")),
  orientation: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("portrait"), Type.Literal("landscape")])),
  showCodes: Type.Optional(Type.Boolean()),
  showGrid: Type.Optional(Type.Boolean()),
  transparentBackground: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const CreateExportBody = Type.Object({
  projectId: Type.String({ format: "uuid" }),
  projectRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  format: Type.Union([Type.Literal("png"), Type.Literal("pdf")]),
  fileName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  options: Type.Optional(ExportOptionsSchema),
}, { additionalProperties: false });
const ListExportsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 })),
}, { additionalProperties: false });
const PurgeArtifactsBody = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
}, { additionalProperties: false });

function publicArtifact(artifact: ExportArtifactRecord | null): Omit<ExportArtifactRecord, "storageKey"> | null {
  if (!artifact) return null;
  return {
    id: artifact.id,
    jobId: artifact.jobId,
    mimeType: artifact.mimeType,
    fileName: artifact.fileName,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    expiresAt: artifact.expiresAt,
    createdAt: artifact.createdAt,
  };
}

function publicExport(job: ExportJobRecord) {
  return {
    id: job.id,
    projectId: job.projectId,
    projectRevision: job.projectRevision,
    format: job.format,
    fileName: job.fileName,
    options: job.options,
    status: job.status,
    progress: job.progress,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    artifact: publicArtifact(job.artifact),
  };
}

function headerText(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function requireInternalWorker(request: FastifyRequest, expected: string): void {
  const candidateDigest = createHash("sha256").update(headerText(request, "x-internal-worker-key")).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(candidateDigest, expectedDigest)) {
    throw new AppError(401, "INTERNAL_AUTH_REQUIRED", "内部任务凭证无效");
  }
}

function exportDownloadStream(contents: Buffer): Readable {
  let offset = 0;
  let readScheduled = false;
  return new Readable({
    highWaterMark: 64 * 1024,
    read() {
      if (readScheduled) return;
      readScheduled = true;
      setImmediate(() => {
        readScheduled = false;
        if (this.destroyed) return;
        if (offset >= contents.length) {
          this.push(null);
          return;
        }
        const nextOffset = Math.min(contents.length, offset + 64 * 1024);
        const chunk = contents.subarray(offset, nextOffset);
        offset = nextOffset;
        this.push(chunk);
      });
    },
  });
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(toWellFormedUnicode(value)).replace(/['()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

export async function registerExportRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  const downloadGate = new ExportDownloadConcurrencyGate(
    dependencies.config.exportDownloadGlobalConcurrency ?? DEFAULT_EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY,
    dependencies.config.exportDownloadPerUserConcurrency ?? DEFAULT_EXPORT_DOWNLOAD_PER_USER_CONCURRENCY,
  );
  const downloadReadTimeoutMilliseconds = dependencies.config.exportDownloadReadTimeoutMilliseconds
    ?? DEFAULT_EXPORT_DOWNLOAD_READ_TIMEOUT_MILLISECONDS;
  const downloadWriteTimeoutMilliseconds = dependencies.config.exportDownloadWriteTimeoutMilliseconds
    ?? DEFAULT_EXPORT_DOWNLOAD_WRITE_TIMEOUT_MILLISECONDS;
  app.post<{ Body: Static<typeof CreateExportBody> }>("/exports", {
    schema: { tags: ["exports"], summary: "创建锁定项目版本的异步导出任务", body: CreateExportBody },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const options = normalizeExportOptions(request.body.options);
    const fileName = normalizeExportBaseName(request.body.fileName ?? "拼豆图纸");
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: "exports:create",
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        const now = new Date().toISOString();
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.exportCreate, now);
        const job = await transactionStore.createExportJob({
          id: randomUUID(),
          userId: user.id,
          projectId: request.body.projectId,
          projectRevision: request.body.projectRevision,
          format: request.body.format,
          fileName,
          options,
          now,
        });
        return { statusCode: 202, body: { export: publicExport(job) } };
      },
    });
  });

  app.get<{ Querystring: Static<typeof ListExportsQuery> }>("/exports", {
    schema: { tags: ["exports"], summary: "列出当前用户的导出任务", querystring: ListExportsQuery },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const limit = request.query.limit ?? 30;
    const offset = request.query.offset ?? 0;
    const page = await dependencies.store.listExportJobs(user.id, limit + 1, offset);
    const hasMore = page.length > limit;
    return {
      exports: page.slice(0, limit).map(publicExport),
      pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null },
    };
  });

  app.get<{ Params: Static<typeof ExportIdParams> }>("/exports/:exportId", {
    schema: { tags: ["exports"], summary: "读取导出任务状态", params: ExportIdParams },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const job = await dependencies.store.getExportJob(user.id, request.params.exportId);
    if (!job) throw new AppError(404, "EXPORT_JOB_NOT_FOUND", "导出任务不存在");
    return { export: publicExport(job) };
  });

  app.post<{ Params: Static<typeof ExportIdParams> }>("/exports/:exportId/cancel", {
    schema: { tags: ["exports"], summary: "取消尚未完成的导出任务", params: ExportIdParams },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `exports:${request.params.exportId}:cancel`,
      key,
      payload: null,
      reply,
      operation: async (transactionStore) => {
        const now = new Date().toISOString();
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.exportCancel, now);
        const job = await transactionStore.cancelExportJob(user.id, request.params.exportId, now);
        return { statusCode: 200, body: { export: publicExport(job) } };
      },
    });
  });

  app.get<{ Params: Static<typeof ExportIdParams> }>("/exports/:exportId/content", {
    schema: { tags: ["exports"], summary: "下载已完成的私有导出文件", params: ExportIdParams },
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const user = await requireAuth(request, dependencies.store);
    const job = await dependencies.store.getExportJob(user.id, request.params.exportId);
    if (!job) throw new AppError(404, "EXPORT_JOB_NOT_FOUND", "导出任务不存在");
    if (job.status === "succeeded" && !job.artifact) {
      throw new AppError(500, "EXPORT_ARTIFACT_METADATA_MISSING", "导出任务缺少文件元数据");
    }
    if (job.status !== "succeeded" || !job.artifact) {
      if (job.status === "failed" || job.status === "canceled") {
        throw new AppError(410, "EXPORT_TERMINAL_WITHOUT_ARTIFACT", "导出任务已结束且没有可下载文件", {
          status: job.status,
        });
      }
      reply.header("Retry-After", "2");
      throw new AppError(409, "EXPORT_NOT_READY", "导出文件尚未生成完成", { status: job.status });
    }
    const expiresAt = Date.parse(job.artifact.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new AppError(500, "EXPORT_ARTIFACT_METADATA_INVALID", "导出文件元数据无效");
    }
    if (expiresAt <= Date.now()) {
      throw new AppError(410, "EXPORT_ARTIFACT_EXPIRED", "导出文件已过期，请重新生成");
    }
    const permit = downloadGate.tryAcquire(user.id);
    if (!permit) {
      throw new AppError(
        429,
        "EXPORT_DOWNLOAD_BUSY",
        "当前下载较多，请稍后重试",
        { retryAfterMilliseconds: 1_000 },
        true,
      );
    }
    const controller = new AbortController();
    const timeoutReason = new Error("EXPORT_ARTIFACT_READ_TIMEOUT");
    const disconnectReason = new Error("EXPORT_DOWNLOAD_CLIENT_DISCONNECTED");
    const abortForRequest = () => controller.abort(disconnectReason);
    const abortForResponseClose = () => {
      if (!reply.raw.writableFinished) controller.abort(disconnectReason);
    };
    const readTimer = setTimeout(() => controller.abort(timeoutReason), downloadReadTimeoutMilliseconds);
    readTimer.unref();
    request.raw.once("aborted", abortForRequest);
    reply.raw.once("close", abortForResponseClose);
    let responseOwnsPermit = false;
    let releaseAfterResponse: (() => void) | undefined;
    let writeTimer: NodeJS.Timeout | undefined;
    let responseStream: Readable | undefined;
    try {
      const contents = await dependencies.storage.get(job.artifact.storageKey, {
        ownerId: user.id,
        assetId: job.artifact.id,
      }, controller.signal);
      controller.signal.throwIfAborted();
      if (!contents) throw new AppError(410, "EXPORT_ARTIFACT_UNAVAILABLE", "导出文件已清理，请重新生成");
      if (contents.length !== job.artifact.sizeBytes) {
        throw new AppError(410, "EXPORT_ARTIFACT_CORRUPTED", "导出文件校验失败，请重新生成");
      }
      const expectedDigest = Buffer.from(job.artifact.sha256, "hex");
      const actualDigest = createHash("sha256").update(contents).digest();
      if (expectedDigest.length !== actualDigest.length || !timingSafeEqual(expectedDigest, actualDigest)) {
        throw new AppError(410, "EXPORT_ARTIFACT_CORRUPTED", "导出文件校验失败，请重新生成");
      }

      clearTimeout(readTimer);
      request.raw.off("aborted", abortForRequest);
      reply.raw.off("close", abortForResponseClose);
      releaseAfterResponse = () => {
        if (!releaseAfterResponse) return;
        if (writeTimer) {
          clearTimeout(writeTimer);
          writeTimer = undefined;
        }
        reply.raw.off("finish", releaseAfterResponse);
        reply.raw.off("close", releaseAfterResponse);
        releaseAfterResponse = undefined;
        permit.release();
      };
      reply.raw.once("finish", releaseAfterResponse);
      reply.raw.once("close", releaseAfterResponse);
      responseOwnsPermit = true;
      const writeTimeoutReason = new Error("EXPORT_DOWNLOAD_WRITE_TIMEOUT");
      responseStream = exportDownloadStream(contents);
      writeTimer = setTimeout(() => {
        responseStream?.destroy(writeTimeoutReason);
        if (!reply.raw.destroyed) reply.raw.destroy(writeTimeoutReason);
        releaseAfterResponse?.();
      }, downloadWriteTimeoutMilliseconds);
      writeTimer.unref();
      return reply
        .header("Content-Type", job.artifact.mimeType)
        .header("Content-Length", contents.length)
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeRfc5987Value(job.artifact.fileName)}`)
        .header("X-Content-Type-Options", "nosniff")
        .send(responseStream);
    } catch (error) {
      if (responseOwnsPermit) {
        releaseAfterResponse?.();
        responseOwnsPermit = false;
      }
      // Socket state wins over AbortController's first-writer reason: a read
      // timeout and disconnect can race, and no error response can be written
      // after the peer has already gone away.
      if (request.raw.aborted || request.raw.destroyed || reply.raw.destroyed) {
        return reply;
      }
      if (controller.signal.aborted && controller.signal.reason === timeoutReason) {
        throw new AppError(
          503,
          "EXPORT_ARTIFACT_READ_TIMEOUT",
          "导出文件读取超时，请稍后重试",
          { retryAfterMilliseconds: 1_000 },
          true,
        );
      }
      if (error instanceof StorageObjectCorruptedError) {
        throw new AppError(410, "EXPORT_ARTIFACT_CORRUPTED", "导出文件校验失败，请重新生成");
      }
      throw error;
    } finally {
      clearTimeout(readTimer);
      request.raw.off("aborted", abortForRequest);
      reply.raw.off("close", abortForResponseClose);
      if (!responseOwnsPermit) permit.release();
    }
  });

  app.post("/internal/export-jobs/process-next", {
    schema: { tags: ["exports-internal"], summary: "由内部 worker 领取并处理一个导出任务" },
  }, async (request, reply) => {
    requireInternalWorker(request, dependencies.config.internalWorkerKey);
    const processed = await processNextExport({ store: dependencies.store, storage: dependencies.storage });
    if (!processed) return reply.code(204).send();
    return reply.code(200).send({ export: publicExport(processed) });
  });

  app.post<{ Body: Static<typeof PurgeArtifactsBody> }>("/internal/export-artifacts/purge-expired", {
    schema: {
      tags: ["exports-internal"],
      summary: "由内部清理任务删除已过期的导出文件",
      body: PurgeArtifactsBody,
    },
  }, async (request, reply) => {
    requireInternalWorker(request, dependencies.config.internalWorkerKey);
    const result = await purgeExpiredExportArtifacts({
      store: dependencies.store,
      storage: dependencies.storage,
      now: new Date().toISOString(),
      limit: request.body.limit ?? dependencies.config.assetPurgeBatchSize,
    });
    return reply.code(result.failed > 0 ? 207 : 200).send(result);
  });
}
