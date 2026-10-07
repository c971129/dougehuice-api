import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuth } from "../auth.js";
import {
  assertAssetAvailable,
  deleteOwnedAsset,
  publicAsset,
  purgeExpiredAssets,
} from "../assets/asset-service.js";
import {
  assertSupportedDeclaredMimeType,
  sanitizeImage,
  SUPPORTED_ASSET_MIME_TYPES,
} from "../assets/image.js";
import { resolveAssetConsentPolicy } from "../domain/asset-consent.js";
import type { AssetConsentEvent, AssetPurpose, AssetRecord } from "../domain/models.js";
import {
  ASSET_STORAGE_WRITE_TIMEOUT_MILLISECONDS,
  USER_RATE_LIMITS,
} from "../domain/resource-limits.js";
import { AppError } from "../errors.js";
import { hashIdempotencyRequest, requireIdempotencyKey } from "../idempotency.js";
import { requireUserRateLimit } from "../rate-limit.js";
import { StorageObjectCorruptedError } from "../storage/storage-provider.js";
import { AssetIdParamsSchema } from "./schemas.js";
import type { RouteDependencies } from "./types.js";

const PurgeBodySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
}, { additionalProperties: false });

const ListAssetsQuerySchema = Type.Object({
  purpose: Type.Optional(Type.Union([Type.Literal("ai-source"), Type.Literal("ai-intermediate")])),
  includeDeleted: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
}, { additionalProperties: false });

const ListAssetConsentEventsQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
}, { additionalProperties: false });

const SUPPORTED_ASSET_PURPOSES = ["ai-source", "ai-intermediate"] as const satisfies
  readonly AssetPurpose[];
const ASSET_UPLOAD_SCOPE = "assets:create";
const ASSET_MULTIPART_FIELD_SIZE_BYTES = 256;

function assertGenericAsset(record: AssetRecord): void {
  if (record.purpose === "project-completion") {
    // Do not reveal that a project-scoped private photo exists through a
    // generic asset identifier. Its project route performs the authorization.
    throw new AppError(404, "ASSET_NOT_FOUND", "素材不存在");
  }
}

function publicAssetConsentEvent(event: AssetConsentEvent) {
  return {
    id: event.id,
    assetId: event.assetId,
    consentVersion: event.consentVersion,
    assetPurpose: event.assetPurpose,
    policySha256: event.policySha256,
    processor: event.processor,
    purpose: event.processingPurpose,
    retention: event.retention,
    source: event.source,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
  };
}

interface ParsedUpload {
  contents: Buffer;
  declaredMimeType: string;
  purpose: AssetPurpose;
  consentVersion: string;
}

function textHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isMultipartLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "FST_REQ_FILE_TOO_LARGE"
    || error.code === "FST_FILES_LIMIT"
    || error.code === "FST_FIELDS_LIMIT"
    || error.code === "FST_PARTS_LIMIT";
}

async function parseUpload(request: FastifyRequest, maxFileSize: number): Promise<ParsedUpload> {
  const fields = new Map<string, string>();
  let contents: Buffer | null = null;
  let declaredMimeType: string | null = null;
  try {
    for await (const part of request.parts({
      limits: {
        fileSize: maxFileSize,
        files: 1,
        fields: 2,
        parts: 3,
        fieldSize: ASSET_MULTIPART_FIELD_SIZE_BYTES,
      },
    })) {
      if (part.type === "field") {
        if (part.valueTruncated || part.fieldnameTruncated) {
          throw new AppError(413, "ASSET_TOO_LARGE", "上传字段超过大小限制");
        }
        if (fields.has(part.fieldname)) {
          throw new AppError(400, "DUPLICATE_ASSET_FIELD", `字段 ${part.fieldname} 不能重复`);
        }
        fields.set(part.fieldname, String(part.value));
        continue;
      }
      if (part.fieldname !== "file" || contents !== null) {
        part.file.resume();
        throw new AppError(400, "SINGLE_ASSET_FILE_REQUIRED", "每次只能上传一个 file 文件");
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
    throw new AppError(400, "ASSET_FILE_REQUIRED", "请在 file 字段上传图片");
  }
  const purpose = fields.get("purpose") ?? textHeader(request, "x-asset-purpose") ?? "ai-source";
  if (purpose !== "ai-source" && purpose !== "ai-intermediate") {
    throw new AppError(400, "INVALID_ASSET_PURPOSE", "素材用途必须是 ai-source 或 ai-intermediate");
  }
  const consentVersion = (fields.get("consentVersion") ?? textHeader(request, "x-consent-version") ?? "").trim();
  if (!consentVersion || consentVersion.length > 64) {
    throw new AppError(400, "CONSENT_VERSION_REQUIRED", "上传素材需要 1-64 字符的 consentVersion");
  }
  return { contents, declaredMimeType, purpose, consentVersion };
}

function requireInternalWorker(request: FastifyRequest, expected: string): void {
  const candidate = textHeader(request, "x-internal-worker-key") ?? "";
  const candidateDigest = createHash("sha256").update(candidate).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(candidateDigest, expectedDigest)) {
    throw new AppError(401, "INTERNAL_AUTH_REQUIRED", "内部任务凭证无效");
  }
}

async function getStoredAssetContents(
  dependencies: RouteDependencies,
  asset: AssetRecord,
): Promise<Buffer | null> {
  try {
    return await dependencies.storage.get(
      asset.storageKey,
      { ownerId: asset.userId, assetId: asset.id },
    );
  } catch (error) {
    if (error instanceof StorageObjectCorruptedError) {
      throw new AppError(410, "ASSET_CONTENT_CORRUPTED", "素材内容校验失败");
    }
    throw error;
  }
}

async function ensureStoredAssetBytes(input: {
  dependencies: RouteDependencies;
  asset: AssetRecord;
  contents: Buffer;
  uploadLeaseExpiresAt: string;
}): Promise<void> {
  const context = { ownerId: input.asset.userId, assetId: input.asset.id };
  const assertExpected = (stored: Buffer): void => {
    const digest = createHash("sha256").update(stored).digest("hex");
    if (digest !== input.asset.sha256 || !stored.equals(input.contents)) {
      throw new AppError(409, "ASSET_STORAGE_CONFLICT", "幂等上传对应的私有对象内容不一致");
    }
  };

  const existing = await getStoredAssetContents(input.dependencies, input.asset);
  if (existing) {
    assertExpected(existing);
    return;
  }
  const writeBudget = Math.min(
    ASSET_STORAGE_WRITE_TIMEOUT_MILLISECONDS,
    Date.parse(input.uploadLeaseExpiresAt) - Date.now() - 1_000,
  );
  if (!Number.isFinite(writeBudget) || writeBudget <= 0) {
    throw new AppError(409, "ASSET_UPLOAD_LEASE_LOST", "素材上传租约已过期，请重试", undefined, true);
  }
  const controller = new AbortController();
  const writeTimeout = setTimeout(
    () => controller.abort(new Error("asset storage write timeout")),
    writeBudget,
  );
  writeTimeout.unref();
  try {
    const stored = await input.dependencies.storage.put(
      input.contents,
      context,
      input.asset.storageKey,
      controller.signal,
    );
    if (stored.storageKey !== input.asset.storageKey) {
      throw new AppError(500, "ASSET_STORAGE_KEY_MISMATCH", "私有存储返回了不匹配的存储键");
    }
  } catch (error) {
    // A concurrent replay, or a process that lost its publish acknowledgement,
    // may already have written the stable key. Authenticate and reuse it.
    const recovered = await getStoredAssetContents(input.dependencies, input.asset);
    if (!recovered) {
      if (controller.signal.aborted) {
        throw new AppError(503, "ASSET_STORAGE_TIMEOUT", "素材存储超时，请重试", undefined, true);
      }
      throw error;
    }
    assertExpected(recovered);
  } finally {
    clearTimeout(writeTimeout);
  }
}

async function cleanUpTerminalAssetUpload(input: {
  dependencies: RouteDependencies;
  asset: AssetRecord;
}): Promise<void> {
  const cleanupAt = new Date().toISOString();
  try {
    await input.dependencies.storage.delete(input.asset.storageKey);
  } catch {
    // Never acknowledge purge here: another same-token writer may still be in
    // flight. The ordinary purge worker owns final confirmation after the
    // durable upload lease expires.
    await input.dependencies.store.recordAssetPurgeFailure(input.asset.id, cleanupAt).catch(() => undefined);
  }
}

export async function registerAssetRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  const consentPolicy = resolveAssetConsentPolicy(dependencies.config);

  app.get("/privacy/ai-processing-consent", {
    schema: {
      tags: ["privacy"],
      summary: "读取 AI 素材上传前的当前隐私同意与上传约束",
    },
  }, async (_request, reply) => reply
    .header("Cache-Control", "no-store")
    .send({
      consentVersion: dependencies.config.assetConsentVersion,
      policySha256: consentPolicy.policySha256,
      processor: consentPolicy.processor,
      purpose: consentPolicy.processingPurpose,
      upload: {
        maxBytes: dependencies.config.assetMaxBytes,
        supportedMimeTypes: [...SUPPORTED_ASSET_MIME_TYPES],
        supportedPurposes: [...SUPPORTED_ASSET_PURPOSES],
      },
      retention: {
        defaultHours: dependencies.config.assetDefaultTtlHours,
        description: consentPolicy.retention,
      },
    }));

  app.get<{ Querystring: Static<typeof ListAssetConsentEventsQuerySchema> }>(
    "/privacy/ai-processing-consent/events",
    {
      schema: {
        tags: ["privacy"],
        summary: "分页读取当前用户不可变的 AI 素材同意审计历史",
        querystring: ListAssetConsentEventsQuerySchema,
      },
    },
    async (request, reply) => {
      const user = await requireAuth(request, dependencies.store);
      const limit = request.query.limit ?? 50;
      const offset = request.query.offset ?? 0;
      const page = await dependencies.store.listAssetConsentEvents({
        userId: user.id,
        limit: limit + 1,
        offset,
      });
      const hasMore = page.length > limit;
      return reply
        .header("Cache-Control", "private, no-store")
        .send({
          events: page.slice(0, limit).map(publicAssetConsentEvent),
          pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null },
        });
    },
  );

  app.post("/assets", {
    schema: {
      tags: ["assets"],
      summary: "上传经脱敏重编码与加密的私有 AI 素材",
      consumes: ["multipart/form-data"],
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    await requireUserRateLimit(dependencies.store, user.id, USER_RATE_LIMITS.assetUploadAttempt);
    const upload = await parseUpload(request, dependencies.config.assetMaxBytes);
    if (upload.consentVersion !== dependencies.config.assetConsentVersion) {
      throw new AppError(409, "CONSENT_VERSION_OUTDATED", "请阅读并同意当前隐私说明后重试", {
        currentConsentVersion: dependencies.config.assetConsentVersion,
      });
    }
    assertSupportedDeclaredMimeType(upload.declaredMimeType);
    if (upload.contents.length > dependencies.config.assetMaxBytes) {
      throw new AppError(413, "ASSET_TOO_LARGE", "上传图片超过大小限制");
    }
    const sanitized = await sanitizeImage(
      upload.contents,
      upload.declaredMimeType,
      dependencies.config.assetMaxBytes,
    );
    const requestHash = hashIdempotencyRequest({
      purpose: upload.purpose,
      consentVersion: dependencies.config.assetConsentVersion,
      policySha256: consentPolicy.policySha256,
      declaredMimeType: upload.declaredMimeType,
      sourceSha256: createHash("sha256").update(upload.contents).digest("hex"),
      sha256: sanitized.sha256,
      mimeType: sanitized.mimeType,
      sizeBytes: sanitized.contents.length,
      width: sanitized.width,
      height: sanitized.height,
    });
    const now = new Date();
    const nowIso = now.toISOString();
    const reservation = await dependencies.store.reserveAssetUpload({
      userId: user.id,
      scope: ASSET_UPLOAD_SCOPE,
      idempotencyKey: key,
      requestHash,
      uploadLeaseToken: randomUUID(),
      uploadLeaseAcquiredAt: nowIso,
      asset: {
        id: randomUUID(),
        userId: user.id,
        purpose: upload.purpose,
        consentVersion: dependencies.config.assetConsentVersion,
        sha256: sanitized.sha256,
        mimeType: sanitized.mimeType,
        sizeBytes: sanitized.contents.length,
        width: sanitized.width,
        height: sanitized.height,
        storageKey: randomBytes(24).toString("base64url"),
        expiresAt: new Date(now.getTime() + dependencies.config.assetDefaultTtlHours * 3_600_000).toISOString(),
        createdAt: nowIso,
      },
    });
    if (reservation.replayed) reply.header("Idempotency-Replayed", "true");
    if (reservation.asset.readyAt !== null) {
      return reply.code(201).send({ asset: publicAsset(reservation.asset) });
    }

    await ensureStoredAssetBytes({
      dependencies,
      asset: reservation.asset,
      contents: sanitized.contents,
      uploadLeaseExpiresAt: reservation.uploadLeaseExpiresAt,
    });
    try {
      const asset = await dependencies.store.publishAssetUpload({
        userId: user.id,
        scope: ASSET_UPLOAD_SCOPE,
        idempotencyKey: key,
        assetId: reservation.asset.id,
        uploadLeaseToken: reservation.uploadLeaseToken,
        readyAt: new Date().toISOString(),
        consentPolicy,
      });
      return reply.code(201).send({ asset: publicAsset(asset) });
    } catch (error) {
      if (error instanceof AppError && error.code === "ASSET_UPLOAD_UNAVAILABLE") {
        await cleanUpTerminalAssetUpload({ dependencies, asset: reservation.asset });
      }
      throw error;
    }
  });

  app.get<{ Querystring: Static<typeof ListAssetsQuerySchema> }>("/assets", {
    schema: {
      tags: ["assets"],
      summary: "列出当前用户的私有素材与清理状态",
      querystring: ListAssetsQuerySchema,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const limit = request.query.limit ?? 50;
    const offset = request.query.offset ?? 0;
    const page = await dependencies.store.listAssets({
      userId: user.id,
      ...(request.query.purpose ? { purpose: request.query.purpose } : {}),
      purposes: [...SUPPORTED_ASSET_PURPOSES],
      includeDeleted: request.query.includeDeleted ?? false,
      now: new Date().toISOString(),
      limit: limit + 1,
      offset,
    });
    const hasMore = page.length > limit;
    return {
      assets: page.slice(0, limit).map(publicAsset),
      pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null },
    };
  });

  app.get<{ Params: Static<typeof AssetIdParamsSchema> }>("/assets/:assetId", {
    schema: { tags: ["assets"], summary: "读取私有素材元数据", params: AssetIdParamsSchema },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const asset = await dependencies.store.getAsset(user.id, request.params.assetId);
    if (!asset) throw new AppError(404, "ASSET_NOT_FOUND", "素材不存在");
    assertGenericAsset(asset);
    assertAssetAvailable(asset);
    return { asset: publicAsset(asset) };
  });

  app.get<{ Params: Static<typeof AssetIdParamsSchema> }>("/assets/:assetId/content", {
    schema: { tags: ["assets"], summary: "读取私有素材内容", params: AssetIdParamsSchema },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const asset = await dependencies.store.getAsset(user.id, request.params.assetId);
    if (!asset) throw new AppError(404, "ASSET_NOT_FOUND", "素材不存在");
    assertGenericAsset(asset);
    assertAssetAvailable(asset);
    const contents = await getStoredAssetContents(dependencies, asset);
    if (!contents) throw new AppError(410, "ASSET_CONTENT_UNAVAILABLE", "素材内容已清理");
    const digest = createHash("sha256").update(contents).digest("hex");
    if (contents.length !== asset.sizeBytes || digest !== asset.sha256) {
      throw new AppError(410, "ASSET_CONTENT_CORRUPTED", "素材内容校验失败");
    }
    return reply
      .header("Cache-Control", "private, no-store")
      .header("Content-Type", asset.mimeType)
      .header("Content-Length", contents.length)
      .header("X-Content-Type-Options", "nosniff")
      .send(contents);
  });

  app.delete<{ Params: Static<typeof AssetIdParamsSchema> }>("/assets/:assetId", {
    schema: { tags: ["assets"], summary: "删除并清理单个私有素材", params: AssetIdParamsSchema },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    await requireUserRateLimit(dependencies.store, user.id, USER_RATE_LIMITS.assetDelete);
    const asset = await dependencies.store.getAsset(user.id, request.params.assetId);
    if (!asset) throw new AppError(404, "ASSET_NOT_FOUND", "素材不存在");
    assertGenericAsset(asset);
    await deleteOwnedAsset({
      store: dependencies.store,
      storage: dependencies.storage,
      userId: user.id,
      assetId: request.params.assetId,
      now: new Date().toISOString(),
    });
    return reply.code(204).send();
  });

  app.post<{ Body: Static<typeof PurgeBodySchema> }>("/privacy/delete-expired", {
    schema: {
      tags: ["privacy-internal"],
      summary: "由内部 worker 清理已过期或已删除的素材",
      body: PurgeBodySchema,
    },
  }, async (request, reply) => {
    requireInternalWorker(request, dependencies.config.internalWorkerKey);
    const result = await purgeExpiredAssets({
      store: dependencies.store,
      storage: dependencies.storage,
      now: new Date().toISOString(),
      limit: request.body.limit ?? 100,
    });
    return reply.code(result.failed > 0 ? 207 : 200).send(result);
  });
}
