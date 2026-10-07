import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../auth.js";
import { assertAssetAvailable } from "../assets/asset-service.js";
import { normalizeGenerationOptions as normalizeDomainGenerationOptions } from "../domain/generation-options.js";
import { assertValidGrid, MAX_GRID_SIDE } from "../domain/grid.js";
import type { GenerationOptions } from "../domain/models.js";
import { defaultMaxColorsForPaletteId, isPaletteSelectable } from "../domain/palettes.js";
import { USER_RATE_LIMITS } from "../domain/resource-limits.js";
import { AppError } from "../errors.js";
import { executeIdempotent, requireIdempotencyKey } from "../idempotency.js";
import { requireUserRateLimit } from "../rate-limit.js";
import { GRID_JSON_BODY_LIMIT_BYTES, GridSchema } from "./schemas.js";
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

const SaveCreationDraftBody = Type.Object({
  draftId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  baseDraftRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  name: Type.String({ minLength: 1, maxLength: 100 }),
  kind: Type.Union([
    Type.Literal("normal"),
    Type.Literal("pixel"),
    Type.Literal("portrait"),
    Type.Literal("couple"),
  ]),
  setupStep: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
  paletteId: Type.String({ minLength: 1, maxLength: 80 }),
  sourceAssetId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  width: Type.Integer({ minimum: 1, maximum: MAX_GRID_SIDE }),
  height: Type.Integer({ minimum: 1, maximum: MAX_GRID_SIDE }),
  options: Type.Optional(GenerationOptionsSchema),
  grid: Type.Union([GridSchema, Type.Null()]),
}, { additionalProperties: false });

const CreationDraftVersionBody = Type.Object({
  draftId: Type.String({ format: "uuid" }),
  draftRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
}, { additionalProperties: false });

function normalizeGenerationOptions(
  input: Static<typeof GenerationOptionsSchema> | undefined,
  paletteId: string,
): GenerationOptions {
  return normalizeDomainGenerationOptions(input, defaultMaxColorsForPaletteId(paletteId));
}

export async function registerCreationDraftRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  app.get("/creation-draft", {
    schema: { tags: ["creation-draft"], summary: "读取尚未建项目的创建流程草稿" },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    return { draft: await dependencies.store.getCreationDraft(user.id) };
  });

  app.put<{ Body: Static<typeof SaveCreationDraftBody> }>("/creation-draft", {
    bodyLimit: GRID_JSON_BODY_LIMIT_BYTES,
    preParsing: async (request, _reply, payload) => {
      await requireAuth(request, dependencies.store);
      return payload;
    },
    schema: {
      tags: ["creation-draft"],
      summary: "以乐观锁覆盖保存尚未建项目的创建流程",
      body: SaveCreationDraftBody,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const name = request.body.name.trim();
    if (!name) throw new AppError(400, "PROJECT_NAME_REQUIRED", "项目名称不能为空");
    const palette = await dependencies.store.getPalette(request.body.paletteId, user.id);
    if (!palette) throw new AppError(404, "PALETTE_NOT_FOUND", "色卡不存在");
    if (!isPaletteSelectable(palette)) {
      throw new AppError(409, "PALETTE_RETIRED", "该色卡已停用，请先迁移到当前可用的 MARD 非官方参考色卡");
    }
    if (request.body.grid) {
      if (request.body.grid.width !== request.body.width || request.body.grid.height !== request.body.height) {
        throw new AppError(400, "CREATION_DRAFT_GRID_SIZE_MISMATCH", "草稿图纸尺寸与创建设置不一致");
      }
      assertValidGrid(request.body.grid, palette);
    }
    if (request.body.sourceAssetId) {
      const asset = await dependencies.store.getAsset(user.id, request.body.sourceAssetId);
      if (!asset || asset.purpose !== "ai-source") {
        throw new AppError(404, "CREATION_DRAFT_SOURCE_ASSET_NOT_FOUND", "创建草稿引用的原始素材不存在");
      }
      try {
        assertAssetAvailable(asset);
      } catch {
        throw new AppError(410, "CREATION_DRAFT_SOURCE_ASSET_UNAVAILABLE", "创建草稿引用的原始素材已删除或过期");
      }
    }
    await requireUserRateLimit(dependencies.store, user.id, USER_RATE_LIMITS.creationDraftMutation);
    const draft = await dependencies.store.saveCreationDraft({
      userId: user.id,
      draftId: request.body.draftId,
      baseDraftRevision: request.body.baseDraftRevision,
      name,
      kind: request.body.kind,
      setupStep: request.body.setupStep,
      paletteId: request.body.paletteId,
      sourceAssetId: request.body.sourceAssetId,
      width: request.body.width,
      height: request.body.height,
      options: normalizeGenerationOptions(request.body.options, palette.id),
      grid: request.body.grid,
    });
    return { draft };
  });

  app.post<{ Body: Static<typeof CreationDraftVersionBody> }>("/creation-draft/commit", {
    schema: {
      tags: ["creation-draft"],
      summary: "将创建草稿原子提交为项目首个不可变版本",
      body: CreationDraftVersionBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `creation-draft:${request.body.draftId}:commit`,
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const project = await transactionStore.commitCreationDraft({ userId: user.id, ...request.body });
        return { statusCode: 201, body: { project } };
      },
    });
  });

  app.delete<{ Body: Static<typeof CreationDraftVersionBody> }>("/creation-draft", {
    schema: {
      tags: ["creation-draft"],
      summary: "丢弃指定版本的创建流程草稿",
      body: CreationDraftVersionBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `creation-draft:${request.body.draftId}:discard`,
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const discarded = await transactionStore.discardCreationDraft({ userId: user.id, ...request.body });
        if (!discarded) throw new AppError(404, "CREATION_DRAFT_NOT_FOUND", "创建草稿不存在");
        return { statusCode: 204, body: null };
      },
    });
  });
}
