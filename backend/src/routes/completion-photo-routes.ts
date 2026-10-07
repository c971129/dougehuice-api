import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuth } from "../auth.js";
import { assertSupportedDeclaredMimeType, sanitizeImage } from "../assets/image.js";
import type { ProjectCompletionPhotoRecord } from "../domain/models.js";
import {
  COMPLETION_PHOTO_STORAGE_WRITE_TIMEOUT_MILLISECONDS,
  USER_RATE_LIMITS,
} from "../domain/resource-limits.js";
import { AppError } from "../errors.js";
import { hashIdempotencyRequest, requireIdempotencyKey } from "../idempotency.js";
import { requireUserRateLimit } from "../rate-limit.js";
import { StorageObjectCorruptedError } from "../storage/storage-provider.js";
import { ProjectIdParamsSchema } from "./schemas.js";
import type { RouteDependencies } from "./types.js";

const PhotoParamsSchema = Type.Object({
  projectId: Type.String({ format: "uuid" }),
  photoId: Type.String({ format: "uuid" }),
}, { additionalProperties: false });

const UploadQuerySchema = Type.Object({
  projectRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

const ListQuerySchema = Type.Object({
  revision: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
}, { additionalProperties: false });

const COMPLETION_PHOTO_MULTIPART_FIELD_SIZE_BYTES = 256;

interface ParsedPhotoUpload {
  contents: Buffer;
  declaredMimeType: string;
}

function isMultipartLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "FST_REQ_FILE_TOO_LARGE"
    || error.code === "FST_FILES_LIMIT"
    || error.code === "FST_FIELDS_LIMIT"
    || error.code === "FST_PARTS_LIMIT";
}

async function parsePhotoUpload(request: FastifyRequest, maxFileSize: number): Promise<ParsedPhotoUpload> {
  let contents: Buffer | null = null;
  let declaredMimeType: string | null = null;
  try {
    for await (const part of request.parts({
      limits: {
        fileSize: maxFileSize,
        files: 1,
        fields: 0,
        parts: 1,
        fieldSize: COMPLETION_PHOTO_MULTIPART_FIELD_SIZE_BYTES,
      },
    })) {
      if (part.type === "field") {
        throw new AppError(400, "COMPLETION_PHOTO_FIELDS_NOT_ALLOWED", "完工照片上传只接受一个 file 文件");
      }
      if (part.fieldname !== "file" || contents !== null) {
        part.file.resume();
        throw new AppError(400, "SINGLE_COMPLETION_PHOTO_REQUIRED", "每次只能上传一个 file 完工照片");
      }
      declaredMimeType = part.mimetype;
      contents = await part.toBuffer();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isMultipartLimitError(error)) {
      throw new AppError(413, "ASSET_TOO_LARGE", "上传图片超过大小限制");
    }
    throw new AppError(400, "INVALID_MULTIPART_UPLOAD", "上传内容不是有效的 multipart 请求");
  }
  if (!contents || !declaredMimeType) {
    throw new AppError(400, "COMPLETION_PHOTO_REQUIRED", "请在 file 字段上传完工照片");
  }
  return { contents, declaredMimeType };
}

function publicCompletionPhoto(record: ProjectCompletionPhotoRecord) {
  return {
    id: record.id,
    projectId: record.projectId,
    projectRevision: record.projectRevision,
    mimeType: record.asset.mimeType,
    sizeBytes: record.asset.sizeBytes,
    width: record.asset.width,
    height: record.asset.height,
    sha256: record.asset.sha256,
    createdAt: record.createdAt,
  };
}

function photoRequestHash(input: {
  projectRevision: number;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
}): string {
  return hashIdempotencyRequest(input);
}

async function getStoredCompletionPhotoContents(
  dependencies: RouteDependencies,
  asset: ProjectCompletionPhotoRecord["asset"],
): Promise<Buffer | null> {
  try {
    return await dependencies.storage.get(asset.storageKey, {
      ownerId: asset.userId,
      assetId: asset.id,
    });
  } catch (error) {
    if (error instanceof StorageObjectCorruptedError) {
      throw new AppError(410, "COMPLETION_PHOTO_CONTENT_CORRUPTED", "完工照片内容校验失败");
    }
    throw error;
  }
}

async function ensureStoredPhotoBytes(input: {
  dependencies: RouteDependencies;
  record: ProjectCompletionPhotoRecord;
  contents: Buffer;
  uploadLeaseExpiresAt: string;
}): Promise<void> {
  const { asset } = input.record;
  const context = { ownerId: asset.userId, assetId: asset.id };
  const assertExpected = (stored: Buffer): void => {
    const digest = createHash("sha256").update(stored).digest("hex");
    if (digest !== asset.sha256 || !stored.equals(input.contents)) {
      throw new AppError(409, "COMPLETION_PHOTO_STORAGE_CONFLICT", "幂等上传对应的私有对象内容不一致");
    }
  };

  const existing = await getStoredCompletionPhotoContents(input.dependencies, asset);
  if (existing) {
    assertExpected(existing);
    return;
  }
  const writeBudget = Math.min(
    COMPLETION_PHOTO_STORAGE_WRITE_TIMEOUT_MILLISECONDS,
    Date.parse(input.uploadLeaseExpiresAt) - Date.now() - 1_000,
  );
  if (!Number.isFinite(writeBudget) || writeBudget <= 0) {
    throw new AppError(409, "COMPLETION_PHOTO_UPLOAD_LEASE_LOST", "完工照片上传租约已过期，请重试", undefined, true);
  }
  const controller = new AbortController();
  const writeTimeout = setTimeout(
    () => controller.abort(new Error("completion photo storage write timeout")),
    writeBudget,
  );
  writeTimeout.unref();
  try {
    const stored = await input.dependencies.storage.put(
      input.contents,
      context,
      asset.storageKey,
      controller.signal,
    );
    if (stored.storageKey !== asset.storageKey) {
      throw new AppError(500, "ASSET_STORAGE_KEY_MISMATCH", "私有存储返回了不匹配的存储键");
    }
  } catch (error) {
    // A concurrent request, or a process that wrote bytes before losing its
    // publish acknowledgement, may already own this stable key. Read back and
    // authenticate the plaintext instead of deleting the winner's object.
    const recovered = await getStoredCompletionPhotoContents(input.dependencies, asset);
    if (!recovered) {
      if (controller.signal.aborted) {
        throw new AppError(503, "COMPLETION_PHOTO_STORAGE_TIMEOUT", "完工照片存储超时，请重试", undefined, true);
      }
      throw error;
    }
    assertExpected(recovered);
  } finally {
    clearTimeout(writeTimeout);
  }
}

async function cleanUpTerminalCompletionUpload(input: {
  dependencies: RouteDependencies;
  record: ProjectCompletionPhotoRecord;
}): Promise<void> {
  const cleanupAt = new Date().toISOString();
  try {
    await input.dependencies.storage.delete(input.record.asset.storageKey);
  } catch {
    // Keep the tombstone retryable. Even a successful best-effort delete is
    // deliberately not acknowledged here: another same-token writer may still
    // be inside its lease and recreate this stable key after the delete.
    await input.dependencies.store.recordAssetPurgeFailure(
      input.record.asset.id,
      cleanupAt,
    ).catch(() => undefined);
  }
}

export async function registerCompletionPhotoRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  app.post<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Querystring: Static<typeof UploadQuerySchema>;
  }>("/projects/:projectId/completion-photos", {
    schema: {
      tags: ["build-progress"],
      summary: "为已完成的当前作品版本幂等上传加密完工照片",
      consumes: ["multipart/form-data"],
      params: ProjectIdParamsSchema,
      querystring: UploadQuerySchema,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    // This independent, deliberately broader window runs before multipart
    // parsing and Sharp. The stricter 30/hour product limit is consumed only
    // when a new durable reservation is committed, never by its replay.
    await requireUserRateLimit(
      dependencies.store,
      user.id,
      USER_RATE_LIMITS.completionPhotoUploadAttempt,
    );
    const key = requireIdempotencyKey(request);
    const upload = await parsePhotoUpload(request, dependencies.config.assetMaxBytes);
    assertSupportedDeclaredMimeType(upload.declaredMimeType);
    if (upload.contents.length > dependencies.config.assetMaxBytes) {
      throw new AppError(413, "ASSET_TOO_LARGE", "上传图片超过大小限制");
    }
    const sanitized = await sanitizeImage(
      upload.contents,
      upload.declaredMimeType,
      dependencies.config.assetMaxBytes,
    );
    const requestHash = photoRequestHash({
      projectRevision: request.query.projectRevision,
      sha256: sanitized.sha256,
      mimeType: sanitized.mimeType,
      sizeBytes: sanitized.contents.length,
      width: sanitized.width,
      height: sanitized.height,
    });
    const now = new Date().toISOString();
    const reservation = await dependencies.store.reserveProjectCompletionPhotoUpload({
      photoId: randomUUID(),
      userId: user.id,
      projectId: request.params.projectId,
      projectRevision: request.query.projectRevision,
      idempotencyKey: key,
      requestHash,
      uploadLeaseToken: randomUUID(),
      uploadLeaseAcquiredAt: now,
      asset: {
        id: randomUUID(),
        userId: user.id,
        purpose: "project-completion",
        consentVersion: null,
        sha256: sanitized.sha256,
        mimeType: sanitized.mimeType,
        sizeBytes: sanitized.contents.length,
        width: sanitized.width,
        height: sanitized.height,
        storageKey: randomBytes(24).toString("base64url"),
        expiresAt: null,
        createdAt: now,
      },
    });
    if (reservation.replayed) reply.header("Idempotency-Replayed", "true");
    if (reservation.photo.asset.sha256 !== sanitized.sha256) {
      throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
    }
    if (reservation.photo.asset.readyAt !== null) {
      return reply.code(201).send({ photo: publicCompletionPhoto(reservation.photo) });
    }

    await ensureStoredPhotoBytes({
      dependencies,
      record: reservation.photo,
      contents: sanitized.contents,
      uploadLeaseExpiresAt: reservation.uploadLeaseExpiresAt,
    });
    try {
      const photo = await dependencies.store.publishProjectCompletionPhoto({
        userId: user.id,
        projectId: request.params.projectId,
        photoId: reservation.photo.id,
        assetId: reservation.photo.asset.id,
        uploadLeaseToken: reservation.uploadLeaseToken,
        readyAt: new Date().toISOString(),
      });
      return reply.code(201).send({ photo: publicCompletionPhoto(photo) });
    } catch (error) {
      if (error instanceof AppError && [
        "PROJECT_COMPLETION_STATE_CHANGED",
        "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE",
      ].includes(error.code)) {
        await cleanUpTerminalCompletionUpload({ dependencies, record: reservation.photo });
      }
      throw error;
    }
  });

  app.get<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Querystring: Static<typeof ListQuerySchema>;
  }>("/projects/:projectId/completion-photos", {
    schema: {
      tags: ["build-progress"],
      summary: "分页列出作品指定版本的私有完工照片（默认当前版本）",
      params: ProjectIdParamsSchema,
      querystring: ListQuerySchema,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const current = await dependencies.store.getProject(user.id, request.params.projectId);
    if (!current) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    const revision = request.query.revision ?? current.currentRevision;
    if (revision !== current.currentRevision) {
      const historical = await dependencies.store.getProject(user.id, request.params.projectId, revision);
      if (!historical) throw new AppError(404, "PROJECT_REVISION_NOT_FOUND", "项目版本不存在");
    }
    const limit = request.query.limit ?? 20;
    const offset = request.query.offset ?? 0;
    const page = await dependencies.store.listProjectCompletionPhotos({
      userId: user.id,
      projectId: request.params.projectId,
      projectRevision: revision,
      limit: limit + 1,
      offset,
      now: new Date().toISOString(),
    });
    const hasMore = page.length > limit;
    return {
      photos: page.slice(0, limit).map(publicCompletionPhoto),
      revision,
      pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null },
    };
  });

  app.get<{ Params: Static<typeof PhotoParamsSchema> }>(
    "/projects/:projectId/completion-photos/:photoId/content",
    {
      schema: {
        tags: ["build-progress"],
        summary: "读取作品私有完工照片内容",
        params: PhotoParamsSchema,
      },
    },
    async (request, reply) => {
      const user = await requireAuth(request, dependencies.store);
      const photo = await dependencies.store.getProjectCompletionPhoto({
        userId: user.id,
        projectId: request.params.projectId,
        photoId: request.params.photoId,
        now: new Date().toISOString(),
      });
      if (!photo) throw new AppError(404, "COMPLETION_PHOTO_NOT_FOUND", "完工照片不存在");
      const contents = await getStoredCompletionPhotoContents(dependencies, photo.asset);
      if (!contents) throw new AppError(410, "COMPLETION_PHOTO_CONTENT_UNAVAILABLE", "完工照片内容已清理");
      const digest = createHash("sha256").update(contents).digest("hex");
      if (contents.length !== photo.asset.sizeBytes || digest !== photo.asset.sha256) {
        throw new AppError(410, "COMPLETION_PHOTO_CONTENT_CORRUPTED", "完工照片内容校验失败");
      }
      return reply
        .header("Cache-Control", "private, no-store")
        .header("Content-Type", photo.asset.mimeType)
        .header("Content-Length", contents.length)
        .header("X-Content-Type-Options", "nosniff")
        .send(contents);
    },
  );

  app.delete<{ Params: Static<typeof PhotoParamsSchema> }>(
    "/projects/:projectId/completion-photos/:photoId",
    {
      schema: {
        tags: ["build-progress"],
        summary: "幂等删除并清理作品私有完工照片",
        params: PhotoParamsSchema,
      },
    },
    async (request, reply) => {
      const user = await requireAuth(request, dependencies.store);
      const key = requireIdempotencyKey(request);
      let deleted: ProjectCompletionPhotoRecord | null = null;
      const result = await dependencies.store.executeIdempotent({
        userId: user.id,
        scope: `projects:${request.params.projectId}:completion-photos:${request.params.photoId}:delete`,
        key,
        requestHash: hashIdempotencyRequest(null),
      }, async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        deleted = await transactionStore.deleteProjectCompletionPhoto({
          userId: user.id,
          projectId: request.params.projectId,
          photoId: request.params.photoId,
          deletedAt: new Date().toISOString(),
        });
        if (!deleted) throw new AppError(404, "COMPLETION_PHOTO_NOT_FOUND", "完工照片不存在");
        return { statusCode: 204, body: null };
      });
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      const removed = deleted as ProjectCompletionPhotoRecord | null;
      if (removed && removed.asset.purgedAt === null) {
        const cleanupAt = new Date().toISOString();
        try {
          await dependencies.storage.delete(removed.asset.storageKey);
        } catch {
          await dependencies.store.recordAssetPurgeFailure(removed.asset.id, cleanupAt).catch(() => undefined);
        }
      }
      return reply.code(204).send();
    },
  );
}
