import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../auth.js";
import { MAX_INVENTORY_BATCH_ITEMS, USER_RATE_LIMITS } from "../domain/resource-limits.js";
import { calculateMaterials } from "../domain/grid.js";
import { compareMaterialsWithInventory } from "../domain/inventory.js";
import { AppError } from "../errors.js";
import { executeIdempotent, requireIdempotencyKey } from "../idempotency.js";
import { requireUserRateLimit } from "../rate-limit.js";
import { ProjectIdParamsSchema } from "./schemas.js";
import type { RouteDependencies } from "./types.js";

const InventoryQuery = Type.Object({
  paletteId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
}, { additionalProperties: false });

const InventoryItemParams = Type.Object({
  paletteId: Type.String({ minLength: 1, maxLength: 80 }),
  colorCode: Type.String({ minLength: 1, maxLength: 32 }),
}, { additionalProperties: false });

const SetInventoryItemBody = Type.Object({
  quantity: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  location: Type.Union([
    Type.String({ minLength: 1, maxLength: 100 }),
    Type.Null(),
  ]),
  baseRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
}, { additionalProperties: false });

const InventoryCalibrationEntry = Type.Object({
  paletteId: Type.String({ minLength: 1, maxLength: 80 }),
  colorCode: Type.String({ minLength: 1, maxLength: 32 }),
  quantity: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  location: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
  baseRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
}, { additionalProperties: false });

const InventoryDeltaEntry = Type.Object({
  paletteId: Type.String({ minLength: 1, maxLength: 80 }),
  colorCode: Type.String({ minLength: 1, maxLength: 32 }),
  delta: Type.Integer({ minimum: -2_147_483_647, maximum: 2_147_483_647 }),
  location: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: 100 }),
    Type.Null(),
  ])),
  baseRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
}, { additionalProperties: false });

const InventoryBatchBody = Type.Union([
  Type.Object({
    mode: Type.Literal("calibrate"),
    items: Type.Array(InventoryCalibrationEntry, { minItems: 1, maxItems: MAX_INVENTORY_BATCH_ITEMS }),
  }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal("delta"),
    items: Type.Array(InventoryDeltaEntry, { minItems: 1, maxItems: MAX_INVENTORY_BATCH_ITEMS }),
  }, { additionalProperties: false }),
]);

const InventoryTransactionQuery = Type.Object({
  paletteId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  projectId: Type.Optional(Type.String({ format: "uuid" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
}, { additionalProperties: false });

const InventoryOperationQuery = Type.Object({
  projectId: Type.Optional(Type.String({ format: "uuid" })),
  idempotencyReference: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
}, { additionalProperties: false });

const ConsumeProjectInventoryBody = Type.Object({
  projectRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
}, { additionalProperties: false });

const RevisionQuery = Type.Object({
  revision: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
}, { additionalProperties: false });

export async function registerInventoryRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  app.get<{ Querystring: Static<typeof InventoryQuery> }>("/inventory", {
    schema: {
      tags: ["inventory"],
      summary: "读取当前用户的豆仓库存",
      querystring: InventoryQuery,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    if (request.query.paletteId && !await dependencies.store.getPalette(request.query.paletteId, user.id)) {
      throw new AppError(404, "PALETTE_NOT_FOUND", "色卡不存在");
    }
    return { items: await dependencies.store.listInventory(user.id, request.query.paletteId) };
  });

  app.get<{ Querystring: Static<typeof InventoryOperationQuery> }>("/inventory/operations", {
    schema: {
      tags: ["inventory"],
      summary: "分页读取当前用户的库存操作审计",
      querystring: InventoryOperationQuery,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const limit = request.query.limit ?? 20;
    const offset = request.query.offset ?? 0;
    const page = await dependencies.store.listInventoryOperations({
      userId: user.id,
      ...(request.query.projectId ? { projectId: request.query.projectId } : {}),
      ...(request.query.idempotencyReference
        ? { idempotencyReference: request.query.idempotencyReference }
        : {}),
      limit: limit + 1,
      offset,
    });
    const hasMore = page.length > limit;
    return {
      operations: page.slice(0, limit),
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
    };
  });

  app.get<{ Querystring: Static<typeof InventoryTransactionQuery> }>("/inventory/transactions", {
    schema: {
      tags: ["inventory"],
      summary: "分页读取当前用户的库存流水",
      querystring: InventoryTransactionQuery,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    if (request.query.paletteId && !await dependencies.store.getPalette(request.query.paletteId, user.id)) {
      throw new AppError(404, "PALETTE_NOT_FOUND", "色卡不存在");
    }
    const limit = request.query.limit ?? 20;
    const offset = request.query.offset ?? 0;
    const page = await dependencies.store.listInventoryTransactions({
      userId: user.id,
      ...(request.query.paletteId ? { paletteId: request.query.paletteId } : {}),
      ...(request.query.projectId ? { projectId: request.query.projectId } : {}),
      limit: limit + 1,
      offset,
    });
    const hasMore = page.length > limit;
    return {
      transactions: page.slice(0, limit),
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
    };
  });

  app.post<{ Body: Static<typeof InventoryBatchBody> }>("/inventory/batch", {
    schema: {
      tags: ["inventory"],
      summary: "原子批量校准或手工增减库存",
      body: InventoryBatchBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const scope = "inventory:batch";
    const seen = new Set<string>();
    const entries = request.body.items.map((entry) => {
      const rowKey = `${entry.paletteId}:${entry.colorCode}`;
      if (seen.has(rowKey)) {
        throw new AppError(400, "INVENTORY_BATCH_DUPLICATE_COLOR", "批量库存不能包含重复的色卡色号", {
          paletteId: entry.paletteId,
          colorCode: entry.colorCode,
        });
      }
      seen.add(rowKey);
      const location = entry.location === undefined ? undefined : entry.location?.trim() ?? null;
      if (entry.location !== undefined && entry.location !== null && !location) {
        throw new AppError(400, "INVENTORY_LOCATION_REQUIRED", "存放位置不能为空字符串");
      }
      if (request.body.mode === "delta" && "delta" in entry && entry.delta === 0) {
        throw new AppError(400, "INVENTORY_DELTA_INVALID", "手工增减数量不能为 0");
      }
      return { ...entry, ...(location === undefined ? {} : { location }) };
    });
    const normalized = { mode: request.body.mode, items: entries };
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: normalized,
      reply,
      operation: async (transactionStore) => {
        const now = new Date().toISOString();
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.inventoryMutation, now);
        const result = await transactionStore.applyInventoryBatch({
          userId: user.id,
          mode: request.body.mode,
          entries,
          idempotencyReference: `${scope}:${key}`,
          now,
        });
        return { statusCode: 200, body: result };
      },
    });
  });

  app.put<{
    Params: Static<typeof InventoryItemParams>;
    Body: Static<typeof SetInventoryItemBody>;
  }>("/inventory/:paletteId/:colorCode", {
    schema: {
      tags: ["inventory"],
      summary: "以乐观锁校准单个色号库存",
      params: InventoryItemParams,
      body: SetInventoryItemBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const scope = `inventory:${request.params.paletteId}:${request.params.colorCode}`;
    const location = request.body.location?.trim() ?? null;
    if (request.body.location !== null && !location) {
      throw new AppError(400, "INVENTORY_LOCATION_REQUIRED", "存放位置不能为空字符串");
    }
    const normalized = { ...request.body, location };
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: normalized,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.inventoryMutation, new Date().toISOString());
        const item = await transactionStore.setInventoryItem({
          userId: user.id,
          paletteId: request.params.paletteId,
          colorCode: request.params.colorCode,
          quantity: request.body.quantity,
          location,
          baseRevision: request.body.baseRevision,
          now: new Date().toISOString(),
          idempotencyReference: `${scope}:${key}`,
        });
        return {
          statusCode: request.body.baseRevision === 0 ? 201 : 200,
          body: { item },
        };
      },
    });
  });

  app.post<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Body: Static<typeof ConsumeProjectInventoryBody>;
  }>("/projects/:projectId/inventory-consumption", {
    schema: {
      tags: ["inventory"],
      summary: "制作完成后显式确认并原子扣减项目材料库存",
      params: ProjectIdParamsSchema,
      body: ConsumeProjectInventoryBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const scope = `projects:${request.params.projectId}:inventory-consumption`;
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        const now = new Date().toISOString();
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.inventoryConsumption, now);
        const consumption = await transactionStore.consumeProjectInventory({
          userId: user.id,
          projectId: request.params.projectId,
          projectRevision: request.body.projectRevision,
          idempotencyReference: `${scope}:${key}`,
          now,
        });
        return { statusCode: 200, body: { consumption } };
      },
    });
  });

  app.get<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Querystring: Static<typeof RevisionQuery>;
  }>("/projects/:projectId/shortages", {
    schema: {
      tags: ["inventory"],
      summary: "比较项目材料与豆仓并生成缺货采购清单",
      params: ProjectIdParamsSchema,
      querystring: RevisionQuery,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const project = await dependencies.store.getProject(
      user.id,
      request.params.projectId,
      request.query.revision,
    );
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "项目或指定版本不存在");
    const palette = await dependencies.store.getPalette(project.paletteId, user.id);
    if (!palette) throw new AppError(500, "PALETTE_NOT_FOUND", "项目色卡不存在");
    const materials = calculateMaterials(project.id, project.currentRevision, project.grid, palette);
    const inventory = await dependencies.store.listInventory(user.id, project.paletteId);
    return {
      shortages: compareMaterialsWithInventory(palette, materials, inventory),
    };
  });
}
