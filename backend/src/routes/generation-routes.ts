import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuth } from "../auth.js";
import { assertAssetAvailable } from "../assets/asset-service.js";
import {
  deserializeGenerationOptions,
  normalizeGenerationOptions as normalizeDomainGenerationOptions,
} from "../domain/generation-options.js";
import {
  calculateMaterials,
  generationCost,
  MAX_GENERATION_GRID_SIDE,
} from "../domain/grid.js";
import type {
  GenerationCandidateOutputSlot,
  GenerationJob,
  GenerationOptions,
} from "../domain/models.js";
import { defaultMaxColorsForPaletteId, isPaletteSelectable } from "../domain/palettes.js";
import {
  MAX_GENERATION_CANDIDATE_ID_LENGTH,
  MIN_GENERATION_CANDIDATE_ID_LENGTH,
  USER_RATE_LIMITS,
} from "../domain/resource-limits.js";
import { aggregateVariantMaterials } from "../domain/variant-materials.js";
import { AppError } from "../errors.js";
import { processNextGeneration } from "../generation/worker.js";
import { executeIdempotent, replayIdempotent, requireIdempotencyKey } from "../idempotency.js";
import { requireUserRateLimit } from "../rate-limit.js";
import { JobIdParamsSchema } from "./schemas.js";
import type { RouteDependencies } from "./types.js";

const GenerationCropOptionsSchema = Type.Object({
  ratio: Type.Optional(Type.Union([
    Type.Literal("free"),
    Type.Literal("original"),
    Type.Literal("1:1"),
    Type.Literal("4:3"),
    Type.Literal("3:4"),
  ])),
  freeRatio: Type.Optional(Type.Number({ minimum: 0.65, maximum: 1.5 })),
  rotation: Type.Optional(Type.Union([
    Type.Literal(0),
    Type.Literal(90),
    Type.Literal(180),
    Type.Literal(270),
  ])),
  scale: Type.Optional(Type.Number({ minimum: 0.8, maximum: 2 })),
  offsetX: Type.Optional(Type.Number({ minimum: -300, maximum: 300 })),
  offsetY: Type.Optional(Type.Number({ minimum: -300, maximum: 300 })),
  flipX: Type.Optional(Type.Boolean()),
  flipY: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const GenerationOptionsSchema = Type.Object({
  crop: Type.Optional(GenerationCropOptionsSchema),
  removeBackground: Type.Optional(Type.Boolean()),
  figureStyle: Type.Optional(Type.Union([
    Type.Literal("chibi-full"),
    Type.Literal("chibi-half"),
    Type.Literal("pixel-avatar"),
  ])),
  coupleLayout: Type.Optional(Type.Union([
    Type.Literal("together"),
    Type.Literal("split"),
    Type.Literal("solo"),
  ])),
  maxColors: Type.Optional(Type.Integer({ minimum: 5, maximum: 32 })),
  transparentBackground: Type.Optional(Type.Boolean()),
  inventoryOnly: Type.Optional(Type.Boolean()),
  brightness: Type.Optional(Type.Integer({ minimum: -100, maximum: 100 })),
  contrast: Type.Optional(Type.Integer({ minimum: -100, maximum: 100 })),
  saturation: Type.Optional(Type.Integer({ minimum: -100, maximum: 100 })),
  dither: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const CreateJobBody = Type.Object({
  kind: Type.Union([
    Type.Literal("normal"),
    Type.Literal("pixel"),
    Type.Literal("portrait"),
    Type.Literal("couple"),
  ]),
  paletteId: Type.String({ minLength: 1, maxLength: 80 }),
  sourceAssetId: Type.Optional(Type.String({ format: "uuid" })),
  width: Type.Integer({ minimum: 8, maximum: MAX_GENERATION_GRID_SIDE }),
  height: Type.Integer({ minimum: 8, maximum: MAX_GENERATION_GRID_SIDE }),
  seed: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  options: Type.Optional(GenerationOptionsSchema),
}, { additionalProperties: false });

const AcceptCandidateBody = Type.Object({
  candidateId: Type.String({
    minLength: MIN_GENERATION_CANDIDATE_ID_LENGTH,
    maxLength: MAX_GENERATION_CANDIDATE_ID_LENGTH,
  }),
  projectName: Type.String({ minLength: 1, maxLength: 100 }),
}, { additionalProperties: false });

const GenerationOutputSlotSchema = Type.Union([
  Type.Literal("combined"),
  Type.Literal("left"),
  Type.Literal("right"),
  Type.Literal("subject-1"),
  Type.Literal("subject-2"),
]);

const AcceptVariantParams = Type.Object({
  jobId: Type.String({ format: "uuid" }),
  variantOrdinal: Type.Integer({ minimum: 1, maximum: 4 }),
}, { additionalProperties: false });

const AcceptVariantBody = Type.Object({
  projects: Type.Array(Type.Object({
    outputSlot: GenerationOutputSlotSchema,
    projectName: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 2 }),
}, { additionalProperties: false });

const GenerationJobStatusQuery = Type.Union([
  Type.Literal("active"),
  Type.Literal("queued"),
  Type.Literal("retry_wait"),
  Type.Literal("preprocessing"),
  Type.Literal("generating"),
  Type.Literal("mapping_colors"),
  Type.Literal("finalizing"),
  Type.Literal("completed"),
  Type.Literal("accepted"),
  Type.Literal("failed"),
  Type.Literal("canceled"),
]);

const ListGenerationJobsQuery = Type.Object({
  status: Type.Optional(GenerationJobStatusQuery),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
}, { additionalProperties: false });

const ACTIVE_RECOVERY_STATUSES: GenerationJob["status"][] = [
  "queued",
  "retry_wait",
  "preprocessing",
  "generating",
  "mapping_colors",
  "finalizing",
];

function publicJob(job: GenerationJob) {
  const variants = new Map<number, GenerationJob["candidates"]>();
  for (const candidate of [...job.candidates].sort((left, right) => left.ordinal - right.ordinal)) {
    const outputs = variants.get(candidate.variantOrdinal) ?? [];
    outputs.push(candidate);
    variants.set(candidate.variantOrdinal, outputs);
  }
  return {
    id: job.id,
    parentJobId: job.parentJobId,
    kind: job.kind,
    status: job.status,
    paletteId: job.paletteId,
    sourceAssetId: job.sourceAssetId,
    options: job.options,
    cost: job.cost,
    width: job.width,
    height: job.height,
    progress: job.progress,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    canceledAt: job.canceledAt,
    acceptedCandidateId: job.acceptedCandidateId,
    candidates: job.candidates,
    variants: [...variants]
      .sort(([left], [right]) => left - right)
      .map(([variantOrdinal, outputs]) => ({ variantOrdinal, outputs })),
  };
}

function normalizeGenerationOptions(
  input: Static<typeof GenerationOptionsSchema> | undefined,
  paletteId: string,
): GenerationOptions {
  return normalizeDomainGenerationOptions(input, defaultMaxColorsForPaletteId(paletteId));
}

function normalizeGenerationResponseBody<T>(body: T): T {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const job = record.job;
  if (typeof job !== "object" || job === null || Array.isArray(job)) return body;
  const jobRecord = job as Record<string, unknown>;
  if (!("options" in jobRecord)) return body;
  return {
    ...record,
    job: { ...jobRecord, options: deserializeGenerationOptions(jobRecord.options) },
  } as T;
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

export async function registerGenerationRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  app.post<{ Body: Static<typeof CreateJobBody> }>("/generation-jobs", {
    schema: {
      tags: ["generation"],
      summary: "创建可恢复的异步生成任务",
      description: "创建时预留次数；Worker 完成后结算，失败或取消后自动返还。",
      body: CreateJobBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const scope = "generation-jobs:create";
    const replayed = await replayIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: request.body,
      reply,
      mapResponse: normalizeGenerationResponseBody,
    });
    if (replayed) return reply;
    const palette = await dependencies.store.getPalette(request.body.paletteId, user.id);
    if (!palette) throw new AppError(404, "PALETTE_NOT_FOUND", "色卡不存在");
    if (!isPaletteSelectable(palette)) {
      throw new AppError(409, "PALETTE_RETIRED", "该色卡已停用，请先迁移到当前可用的 MARD 非官方参考色卡");
    }

    const requiresSource = request.body.kind === "portrait"
      || request.body.kind === "couple"
      || dependencies.config.nodeEnv === "production";
    if (requiresSource && !request.body.sourceAssetId) {
      throw new AppError(400, "GENERATION_SOURCE_ASSET_REQUIRED", "当前生成模式需要先上传私有原始素材");
    }
    let sourceDigest: string | null = null;
    if (request.body.sourceAssetId) {
      const asset = await dependencies.store.getAsset(user.id, request.body.sourceAssetId);
      if (!asset || asset.purpose !== "ai-source") {
        throw new AppError(404, "GENERATION_SOURCE_ASSET_NOT_FOUND", "AI 原始素材不存在");
      }
      try {
        assertAssetAvailable(asset);
      } catch {
        throw new AppError(410, "GENERATION_SOURCE_ASSET_UNAVAILABLE", "AI 原始素材已删除或过期");
      }
      sourceDigest = asset.sha256;
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();
    const seed = request.body.seed ?? sourceDigest ?? `${user.id}:${jobId}`;
    const options = normalizeGenerationOptions(request.body.options, palette.id);
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: request.body,
      reply,
      mapResponse: normalizeGenerationResponseBody,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.generationCreate, now);
        const job = await transactionStore.createGenerationJob({
          userId: user.id,
          kind: request.body.kind,
          paletteId: palette.id,
          sourceAssetId: request.body.sourceAssetId ?? null,
          options,
          cost: generationCost(request.body.kind),
          seed,
          width: request.body.width,
          height: request.body.height,
          now,
          jobId,
        });
        return { statusCode: 202, body: { job: publicJob(job) } };
      },
    });
  });

  app.get<{ Querystring: Static<typeof ListGenerationJobsQuery> }>("/generation-jobs", {
    schema: {
      tags: ["generation"],
      summary: "列出生成任务并恢复仍在处理的任务",
      querystring: ListGenerationJobsQuery,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const status = request.query.status;
    const limit = request.query.limit ?? 20;
    const offset = request.query.offset ?? 0;
    const statuses = status === "active"
      ? ACTIVE_RECOVERY_STATUSES
      : status ? [status] : undefined;
    const page = await dependencies.store.listGenerationJobs({
      userId: user.id,
      ...(statuses ? { statuses } : {}),
      limit: limit + 1,
      offset,
    });
    const hasMore = page.length > limit;
    return {
      jobs: page.slice(0, limit).map(publicJob),
      pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null },
    };
  });

  app.get<{ Params: Static<typeof JobIdParamsSchema> }>("/generation-jobs/:jobId", {
    schema: { tags: ["generation"], summary: "读取生成任务真实状态与候选", params: JobIdParamsSchema },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const job = await dependencies.store.getGenerationJob(user.id, request.params.jobId);
    if (!job) throw new AppError(404, "GENERATION_JOB_NOT_FOUND", "生成任务不存在");
    return { job: publicJob(job) };
  });

  app.post<{ Params: Static<typeof JobIdParamsSchema> }>("/generation-jobs/:jobId/cancel", {
    schema: { tags: ["generation"], summary: "取消生成任务并返还预留次数", params: JobIdParamsSchema },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `generation-jobs:${request.params.jobId}:cancel`,
      key,
      payload: null,
      reply,
      mapResponse: normalizeGenerationResponseBody,
      operation: async (transactionStore) => {
        const now = new Date().toISOString();
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.generationCancel, now);
        const job = await transactionStore.cancelGenerationJob(
          user.id,
          request.params.jobId,
          now,
        );
        return { statusCode: 200, body: { job: publicJob(job) } };
      },
    });
  });

  app.post<{ Params: Static<typeof JobIdParamsSchema> }>("/generation-jobs/:jobId/redraw", {
    schema: {
      tags: ["generation"],
      summary: "复用原始照片与参数换一批候选，并固定扣 1 次",
      params: JobIdParamsSchema,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const scope = `generation-jobs:${request.params.jobId}:redraw`;
    const replayed = await replayIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: null,
      reply,
      mapResponse: normalizeGenerationResponseBody,
    });
    if (replayed) return reply;

    const original = await dependencies.store.getGenerationJob(user.id, request.params.jobId);
    if (!original) throw new AppError(404, "GENERATION_JOB_NOT_FOUND", "生成任务不存在");
    if (original.kind !== "portrait" && original.kind !== "couple") {
      throw new AppError(409, "GENERATION_REDRAW_UNSUPPORTED", "只有 AI 真人或情侣任务支持换一批");
    }
    if (original.status !== "completed") {
      throw new AppError(409, "GENERATION_REDRAW_NOT_READY", "只有已生成且尚未采用的任务可以换一批", {
        status: original.status,
      });
    }
    if (!original.sourceAssetId) {
      throw new AppError(409, "GENERATION_SOURCE_ASSET_REQUIRED", "换一批需要仍可用的原始素材");
    }
    const source = await dependencies.store.getAsset(user.id, original.sourceAssetId);
    if (!source || source.purpose !== "ai-source") {
      throw new AppError(404, "GENERATION_SOURCE_ASSET_NOT_FOUND", "AI 原始素材不存在");
    }
    try {
      assertAssetAvailable(source);
    } catch {
      throw new AppError(410, "GENERATION_SOURCE_ASSET_UNAVAILABLE", "AI 原始素材已删除或过期");
    }

    const redrawJobId = randomUUID();
    const now = new Date().toISOString();
    const seed = createHash("sha256")
      .update(`${original.seed}\0redraw\0${key}`)
      .digest("hex");
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: null,
      reply,
      mapResponse: normalizeGenerationResponseBody,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.generationCreate, now);
        const lockedOriginal = await transactionStore.getGenerationJob(user.id, original.id);
        if (!lockedOriginal) throw new AppError(404, "GENERATION_JOB_NOT_FOUND", "生成任务不存在");
        if (lockedOriginal.status !== "completed") {
          throw new AppError(409, "GENERATION_REDRAW_NOT_READY", "只有已生成且尚未采用的任务可以换一批", {
            status: lockedOriginal.status,
          });
        }
        const job = await transactionStore.createGenerationJob({
          userId: user.id,
          parentJobId: lockedOriginal.id,
          kind: lockedOriginal.kind,
          paletteId: lockedOriginal.paletteId,
          sourceAssetId: lockedOriginal.sourceAssetId,
          options: lockedOriginal.options,
          cost: 1,
          seed,
          width: lockedOriginal.width,
          height: lockedOriginal.height,
          now,
          jobId: redrawJobId,
        });
        return { statusCode: 202, body: { job: publicJob(job) } };
      },
    });
  });

  app.post<{
    Params: Static<typeof JobIdParamsSchema>;
    Body: Static<typeof AcceptCandidateBody>;
  }>("/generation-jobs/:jobId/accept", {
    schema: {
      tags: ["generation"],
      summary: "兼容采用单一 combined 候选并生成项目首版本",
      description: "split/solo 等多输出方案必须使用 variant 采用接口，不能部分创建项目。",
      params: JobIdParamsSchema,
      body: AcceptCandidateBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const scope = `generation-jobs:${request.params.jobId}:accept`;
    const projectName = request.body.projectName.trim();
    if (!projectName) throw new AppError(400, "PROJECT_NAME_REQUIRED", "项目名称不能为空");
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: request.body,
      reply,
      mapResponse: normalizeGenerationResponseBody,
      operation: async (transactionStore) => {
        const accepted = await transactionStore.acceptGenerationCandidate({
          userId: user.id,
          jobId: request.params.jobId,
          candidateId: request.body.candidateId,
          projectName,
        });
        return {
          statusCode: 201,
          body: { job: publicJob(accepted.job), project: accepted.project },
        };
      },
    });
  });

  app.post<{
    Params: Static<typeof AcceptVariantParams>;
    Body: Static<typeof AcceptVariantBody>;
  }>("/generation-jobs/:jobId/variants/:variantOrdinal/accept", {
    schema: {
      tags: ["generation"],
      summary: "原子采用一个完整生成方案并创建其全部输出项目",
      description: "combined 创建一个项目；split/solo 分别创建两个项目，并返回逐输出与合计材料。",
      params: AcceptVariantParams,
      body: AcceptVariantBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const projects = request.body.projects.map((item) => ({
      outputSlot: item.outputSlot as GenerationCandidateOutputSlot,
      projectName: item.projectName.trim(),
    }));
    if (projects.some((item) => !item.projectName)) {
      throw new AppError(400, "PROJECT_NAME_REQUIRED", "项目名称不能为空");
    }
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `generation-jobs:${request.params.jobId}:variant-accept`,
      key,
      payload: { variantOrdinal: request.params.variantOrdinal, projects },
      reply,
      mapResponse: normalizeGenerationResponseBody,
      operation: async (transactionStore) => {
        const accepted = await transactionStore.acceptGenerationVariant({
          userId: user.id,
          jobId: request.params.jobId,
          variantOrdinal: request.params.variantOrdinal,
          projects,
        });
        const palette = await transactionStore.getPalette(accepted.job.paletteId, user.id);
        if (!palette) throw new AppError(500, "PALETTE_NOT_FOUND", "生成任务色卡不存在");
        const outputs = accepted.outputs.map((output) => ({
          ...output,
          materials: calculateMaterials(
            output.project.id,
            output.project.currentRevision,
            output.project.grid,
            palette,
          ),
        }));
        return {
          statusCode: 201,
          body: {
            job: publicJob(accepted.job),
            variant: { variantOrdinal: accepted.variantOrdinal, outputs },
            totalMaterials: aggregateVariantMaterials(outputs.map((output) => output.materials)),
          },
        };
      },
    });
  });

  app.post("/internal/generation-jobs/process-next", {
    schema: { tags: ["generation-internal"], summary: "由内部 Worker 处理一个生成任务" },
  }, async (request, reply) => {
    requireInternalWorker(request, dependencies.config.internalWorkerKey);
    if (!dependencies.generationProvider) {
      throw new AppError(
        503,
        "GENERATION_PROVIDER_NOT_ATTACHED",
        "API 进程未装配生成 Provider，请由独立 Generation Worker 处理任务",
        null,
        true,
      );
    }
    const processed = await processNextGeneration({
      store: dependencies.store,
      storage: dependencies.storage,
      provider: dependencies.generationProvider,
    });
    if (!processed) return reply.code(204).send();
    return reply.code(200).send({ job: publicJob(processed) });
  });
}
