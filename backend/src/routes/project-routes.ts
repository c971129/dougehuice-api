import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuth } from "../auth.js";
import { assertValidGrid, calculateMaterials, MAX_GRID_CELLS } from "../domain/grid.js";
import {
  LEGACY_DEMO_MIGRATION_VERSION,
  LEGACY_DEMO_PALETTE_ID,
  LEGACY_DEMO_TARGET_PALETTE_ID,
  LEGACY_DEMO_TO_MARD_291,
} from "../domain/legacy-palette-migration.js";
import { remapGridPalette } from "../domain/palette-remap.js";
import { isPaletteSelectable } from "../domain/palettes.js";
import {
  MAX_PROJECT_SEARCH_LENGTH,
  MAX_PROJECT_TAG_LENGTH,
  MAX_PROJECT_TAGS,
  normalizeProjectSearch,
  normalizeProjectTagFilter,
  normalizeProjectTags,
} from "../domain/project-library.js";
import { USER_RATE_LIMITS } from "../domain/resource-limits.js";
import { AppError } from "../errors.js";
import { executeIdempotent, requireIdempotencyKey } from "../idempotency.js";
import { requireUserRateLimit } from "../rate-limit.js";
import { GRID_JSON_BODY_LIMIT_BYTES, GridSchema, ProjectIdParamsSchema } from "./schemas.js";
import type { RouteDependencies } from "./types.js";

const ProjectModeSchema = Type.Union([
  Type.Literal("normal"),
  Type.Literal("pixel"),
  Type.Literal("portrait"),
  Type.Literal("couple"),
]);

const ProjectDeviceSourceSchema = Type.Union([
  Type.Literal("mini-program"),
  Type.Literal("web"),
  Type.Literal("api"),
  Type.Literal("unknown"),
]);

const ProjectBuildStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
]);

const ProjectTagsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: MAX_PROJECT_TAG_LENGTH }),
  { maxItems: MAX_PROJECT_TAGS },
);

const ClientWritableProjectLifecycleStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("generating"),
  Type.Literal("editable"),
  Type.Literal("exported"),
]);

const ProjectBackgroundModeSchema = Type.Union([
  Type.Literal("white"),
  Type.Literal("transparent"),
  Type.Literal("solid"),
]);

const CreateProjectBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  paletteId: Type.String({ minLength: 1, maxLength: 80 }),
  grid: GridSchema,
  mode: Type.Optional(ProjectModeSchema),
  sourceAssetId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  previewAssetId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  backgroundMode: Type.Optional(ProjectBackgroundModeSchema),
  backgroundColor: Type.Optional(Type.Union([
    Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }),
    Type.Null(),
  ])),
  tags: Type.Optional(ProjectTagsSchema),
  deviceSource: Type.Optional(ProjectDeviceSourceSchema),
}, { additionalProperties: false });

const UpdateGridBody = Type.Object({
  baseRevision: Type.Integer({ minimum: 1 }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  grid: GridSchema,
  deviceSource: Type.Optional(ProjectDeviceSourceSchema),
}, { additionalProperties: false });

const RenameProjectBody = Type.Object({
  baseRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  name: Type.String({ minLength: 1, maxLength: 100 }),
  deviceSource: Type.Optional(ProjectDeviceSourceSchema),
}, { additionalProperties: false });

const RemapProjectPaletteBody = Type.Object({
  baseRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  paletteId: Type.String({ minLength: 1, maxLength: 80 }),
  maxColors: Type.Integer({ minimum: 5, maximum: 32 }),
  inventoryOnly: Type.Optional(Type.Boolean()),
  confirmUnreliableLegacyMappings: Type.Optional(Type.Boolean()),
  deviceSource: Type.Optional(ProjectDeviceSourceSchema),
}, { additionalProperties: false });

const UpdateProjectMetadataBody = Type.Object({
  baseRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  baseMetadataRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  mode: Type.Optional(ProjectModeSchema),
  lifecycleStatus: Type.Optional(ClientWritableProjectLifecycleStatusSchema),
  sourceAssetId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  previewAssetId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  backgroundMode: Type.Optional(ProjectBackgroundModeSchema),
  backgroundColor: Type.Optional(Type.Union([
    Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }),
    Type.Null(),
  ])),
  tags: Type.Optional(ProjectTagsSchema),
  deviceSource: Type.Optional(ProjectDeviceSourceSchema),
}, { additionalProperties: false });

const CopyProjectBody = Type.Object({
  revision: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  deviceSource: Type.Optional(ProjectDeviceSourceSchema),
}, { additionalProperties: false });

const RevisionQuery = Type.Object({
  revision: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

const ListProjectsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 })),
  q: Type.Optional(Type.String({ maxLength: MAX_PROJECT_SEARCH_LENGTH })),
  status: Type.Optional(ProjectBuildStatusSchema),
  mode: Type.Optional(ProjectModeSchema),
  lifecycleStatus: Type.Optional(Type.Union([
    Type.Literal("draft"),
    Type.Literal("generating"),
    Type.Literal("editable"),
    Type.Literal("exported"),
  ])),
  tag: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROJECT_TAG_LENGTH })),
}, { additionalProperties: false });

const ListProjectRevisionsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 })),
}, { additionalProperties: false });

const ProjectRevisionParamsSchema = Type.Object({
  projectId: Type.String({ format: "uuid" }),
  revision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
}, { additionalProperties: false });

const RestoreProjectRevisionBody = Type.Object({
  baseRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  deviceSource: Type.Optional(ProjectDeviceSourceSchema),
}, { additionalProperties: false });

const BuildNavigationCursorSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("color"),
    colorCode: Type.String({ minLength: 1, maxLength: 80 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("region"),
    regionIndex: Type.Integer({ minimum: 0, maximum: 3 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("row-column"),
    axis: Type.Union([Type.Literal("row"), Type.Literal("column")]),
    index: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  }, { additionalProperties: false }),
]);

const SaveProgressBody = Type.Object({
  projectRevision: Type.Integer({ minimum: 1 }),
  baseProgressRevision: Type.Integer({ minimum: 0 }),
  mode: Type.Optional(Type.Union([
    Type.Literal("color"),
    Type.Literal("region"),
    Type.Literal("row-column"),
  ])),
  navigationCursor: Type.Optional(Type.Union([BuildNavigationCursorSchema, Type.Null()])),
  completedIndices: Type.Array(Type.Integer({ minimum: 0 }), { maxItems: MAX_GRID_CELLS }),
  elapsedTime: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
}, { additionalProperties: false });

const SaveProjectDraftBody = Type.Object({
  baseProjectRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  baseDraftRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  grid: GridSchema,
}, { additionalProperties: false });

const ProjectDraftVersionBody = Type.Object({
  baseProjectRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  draftRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  deviceSource: Type.Optional(ProjectDeviceSourceSchema),
}, { additionalProperties: false });

export async function registerProjectRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  const authenticateBeforeGridParsing = async (
    request: FastifyRequest,
    _reply: unknown,
    payload: NodeJS.ReadableStream,
  ): Promise<NodeJS.ReadableStream> => {
    await requireAuth(request, dependencies.store);
    return payload;
  };

  app.post<{ Body: Static<typeof CreateProjectBody> }>("/projects", {
    bodyLimit: GRID_JSON_BODY_LIMIT_BYTES,
    preParsing: authenticateBeforeGridParsing,
    schema: { tags: ["projects"], summary: "创建项目及首个不可变版本", body: CreateProjectBody },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const scope = "projects:create";
    const name = request.body.name.trim();
    const tags = normalizeProjectTags(request.body.tags ?? []);
    if (!name) throw new AppError(400, "PROJECT_NAME_REQUIRED", "项目名称不能为空");
    const palette = await dependencies.store.getPalette(request.body.paletteId, user.id);
    if (!palette) throw new AppError(404, "PALETTE_NOT_FOUND", "色卡不存在");
    if (!isPaletteSelectable(palette)) {
      throw new AppError(409, "PALETTE_RETIRED", "该色卡已停用，请先迁移到当前可用的 MARD 非官方参考色卡");
    }
    assertValidGrid(request.body.grid, palette);
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const project = await transactionStore.createProject(user.id, {
          name,
          paletteId: request.body.paletteId,
          grid: request.body.grid,
          ...(request.body.mode === undefined ? {} : { mode: request.body.mode }),
          ...(request.body.sourceAssetId === undefined ? {} : { sourceAssetId: request.body.sourceAssetId }),
          ...(request.body.previewAssetId === undefined ? {} : { previewAssetId: request.body.previewAssetId }),
          ...(request.body.backgroundMode === undefined ? {} : { backgroundMode: request.body.backgroundMode }),
          ...(request.body.backgroundColor === undefined ? {} : { backgroundColor: request.body.backgroundColor }),
          tags,
          ...(request.body.deviceSource === undefined ? {} : { deviceSource: request.body.deviceSource }),
        });
        return { statusCode: 201, body: { project } };
      },
    });
  });

  app.get<{ Querystring: Static<typeof ListProjectsQuery> }>("/projects", {
    schema: { tags: ["projects"], summary: "分页列出当前用户项目", querystring: ListProjectsQuery },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const limit = request.query.limit ?? 20;
    const offset = request.query.offset ?? 0;
    const q = request.query.q === undefined ? undefined : normalizeProjectSearch(request.query.q);
    const tag = request.query.tag === undefined ? undefined : normalizeProjectTagFilter(request.query.tag);
    const page = await dependencies.store.listProjects({
      userId: user.id,
      limit: limit + 1,
      offset,
      ...(q === undefined ? {} : { q }),
      ...(request.query.status === undefined ? {} : { status: request.query.status }),
      ...(request.query.mode === undefined ? {} : { mode: request.query.mode }),
      ...(request.query.lifecycleStatus === undefined
        ? {}
        : { lifecycleStatus: request.query.lifecycleStatus }),
      ...(tag === undefined ? {} : { tag }),
    });
    const hasMore = page.length > limit;
    return {
      projects: page.slice(0, limit),
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
    };
  });

  app.get<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Querystring: Static<typeof ListProjectRevisionsQuery>;
  }>("/projects/:projectId/revisions", {
    schema: {
      tags: ["projects"],
      summary: "分页列出项目不可变版本元数据",
      params: ProjectIdParamsSchema,
      querystring: ListProjectRevisionsQuery,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const project = await dependencies.store.getProject(user.id, request.params.projectId);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    const limit = request.query.limit ?? 20;
    const offset = request.query.offset ?? 0;
    const page = await dependencies.store.listProjectRevisions({
      userId: user.id,
      projectId: request.params.projectId,
      limit: limit + 1,
      offset,
    });
    const hasMore = page.length > limit;
    return {
      revisions: page.slice(0, limit),
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
    };
  });

  app.post<{
    Params: Static<typeof ProjectRevisionParamsSchema>;
    Body: Static<typeof RestoreProjectRevisionBody>;
  }>("/projects/:projectId/revisions/:revision/restore", {
    schema: {
      tags: ["projects"],
      summary: "将历史快照复制为新的不可变版本",
      description: "恢复始终创建 currentRevision + 1，不会倒退当前版本指针。",
      params: ProjectRevisionParamsSchema,
      body: RestoreProjectRevisionBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `projects:${request.params.projectId}:revisions:${request.params.revision}:restore`,
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const project = await transactionStore.restoreProjectRevision({
          userId: user.id,
          projectId: request.params.projectId,
          revision: request.params.revision,
          baseRevision: request.body.baseRevision,
          ...(request.body.deviceSource === undefined ? {} : { deviceSource: request.body.deviceSource }),
        });
        return { statusCode: 200, body: { project } };
      },
    });
  });

  app.get<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Querystring: Static<typeof RevisionQuery>;
  }>("/projects/:projectId", {
    schema: {
      tags: ["projects"],
      summary: "读取项目当前或历史版本",
      params: ProjectIdParamsSchema,
      querystring: RevisionQuery,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const project = await dependencies.store.getProject(user.id, request.params.projectId, request.query.revision);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "项目或指定版本不存在");
    return { project };
  });

  app.put<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Body: Static<typeof UpdateGridBody>;
  }>("/projects/:projectId/grid", {
    bodyLimit: GRID_JSON_BODY_LIMIT_BYTES,
    preParsing: authenticateBeforeGridParsing,
    schema: {
      tags: ["projects"],
      summary: "以乐观锁保存新的不可变项目版本",
      params: ProjectIdParamsSchema,
      body: UpdateGridBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const scope = `projects:${request.params.projectId}:grid`;
    const current = await dependencies.store.getProject(user.id, request.params.projectId);
    if (!current) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    const palette = await dependencies.store.getPalette(current.paletteId, user.id);
    if (!palette) throw new AppError(500, "PALETTE_NOT_FOUND", "项目色卡不存在");
    assertValidGrid(request.body.grid, palette);
    const name = request.body.name?.trim();
    if (request.body.name !== undefined && !name) {
      throw new AppError(400, "PROJECT_NAME_REQUIRED", "项目名称不能为空");
    }
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const project = await transactionStore.updateProjectGrid({
          userId: user.id,
          projectId: request.params.projectId,
          baseRevision: request.body.baseRevision,
          ...(name === undefined ? {} : { name }),
          grid: request.body.grid,
          ...(request.body.deviceSource === undefined ? {} : { deviceSource: request.body.deviceSource }),
        });
        return { statusCode: 200, body: { project } };
      },
    });
  });

  app.post<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Body: Static<typeof RemapProjectPaletteBody>;
  }>("/projects/:projectId/remap-palette", {
    schema: {
      tags: ["projects"],
      summary: "将当前图纸原子换卡并创建新的不可变 revision",
      description: "普通换卡使用全候选 CIEDE2000；旧演示色卡迁移固定使用审计映射，并要求明确确认不可靠颜色。",
      params: ProjectIdParamsSchema,
      body: RemapProjectPaletteBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `projects:${request.params.projectId}:remap-palette`,
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const current = await transactionStore.getProject(user.id, request.params.projectId);
        if (!current) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
        if (current.currentRevision !== request.body.baseRevision) {
          throw new AppError(409, "PROJECT_REVISION_CONFLICT", "项目已在其他设备更新", {
            currentRevision: current.currentRevision,
          });
        }
        const [sourcePalette, targetPalette] = await Promise.all([
          transactionStore.getPalette(current.paletteId, user.id),
          transactionStore.getPalette(request.body.paletteId, user.id),
        ]);
        if (!sourcePalette) throw new AppError(500, "PALETTE_NOT_FOUND", "项目原色卡不存在");
        if (!targetPalette) throw new AppError(404, "PALETTE_NOT_FOUND", "目标色卡不存在");
        if (!isPaletteSelectable(targetPalette)) {
          throw new AppError(409, "PALETTE_RETIRED", "目标色卡已停用，请选择可用色卡");
        }
        const availableColorCodes = request.body.inventoryOnly
          ? (await transactionStore.listInventory(user.id, targetPalette.id))
            .filter((item) => item.quantity > 0)
            .map((item) => item.colorCode)
          : null;
        let migrationAudit: Parameters<typeof transactionStore.remapProjectPalette>[0]["migrationAudit"];
        let migrationResult: {
          version: string;
          targetPaletteId: string;
          confirmedUnreliableCodes: string[];
        } | null = null;
        let grid;
        if (sourcePalette.id === LEGACY_DEMO_PALETTE_ID) {
          if (targetPalette.id !== LEGACY_DEMO_TARGET_PALETTE_ID) {
            throw new AppError(
              409,
              "LEGACY_PALETTE_MIGRATION_TARGET_REQUIRED",
              "旧演示色卡只能按固定审计映射迁移到 MARD 291 非官方参考色卡",
              { targetPaletteId: LEGACY_DEMO_TARGET_PALETTE_ID },
            );
          }
          const byOldCode = new Map(LEGACY_DEMO_TO_MARD_291.map((mapping) => [mapping.oldCode, mapping]));
          const usedOldCodes = [...new Set(current.grid.cells.filter(
            (cell): cell is string => cell !== null,
          ))];
          const missingMappings = usedOldCodes.filter((code) => !byOldCode.has(code));
          if (missingMappings.length > 0) {
            throw new AppError(
              409,
              "LEGACY_PALETTE_MIGRATION_MAPPING_MISSING",
              "旧色卡图纸包含未审计颜色，已阻止迁移",
              { colorCodes: missingMappings },
            );
          }
          const usedMappings = usedOldCodes.map((code) => byOldCode.get(code)!);
          const unreliableMappings = usedMappings.filter((mapping) => !mapping.reliable);
          if (unreliableMappings.length > 0 && request.body.confirmUnreliableLegacyMappings !== true) {
            throw new AppError(
              409,
              "LEGACY_PALETTE_CONFIRMATION_REQUIRED",
              "旧色卡包含颜色差异较大的映射，需要用户明确确认后才能创建新版本",
              {
                migrationVersion: LEGACY_DEMO_MIGRATION_VERSION,
                targetPaletteId: LEGACY_DEMO_TARGET_PALETTE_ID,
                mappings: unreliableMappings,
              },
            );
          }
          const mappedCodes = new Set(usedMappings.map((mapping) => mapping.newCode));
          if (mappedCodes.size > request.body.maxColors) {
            throw new AppError(
              409,
              "LEGACY_PALETTE_MIGRATION_MAX_COLORS_TOO_LOW",
              "maxColors 小于固定审计映射所需颜色数，不能静默限色",
              { requiredMaxColors: mappedCodes.size },
            );
          }
          if (availableColorCodes) {
            const available = new Set(availableColorCodes);
            const missingInventory = [...mappedCodes].filter((code) => !available.has(code));
            if (missingInventory.length > 0) {
              throw new AppError(
                409,
                "LEGACY_PALETTE_MIGRATION_INVENTORY_MISSING",
                "豆仓缺少固定审计映射所需颜色，不能用其他颜色替换",
                { colorCodes: missingInventory },
              );
            }
          }
          grid = {
            ...current.grid,
            cells: current.grid.cells.map((cell) => cell === null ? null : byOldCode.get(cell)!.newCode),
          };
          const nextRevision = current.currentRevision + 1;
          migrationAudit = usedMappings.map((mapping) => ({
            entityType: "project_revision" as const,
            entityId: `${current.id}:${nextRevision}`,
            oldPaletteId: sourcePalette.id,
            oldColorCode: mapping.oldCode,
            oldHex: mapping.oldHex,
            newPaletteId: targetPalette.id,
            newColorCode: mapping.newCode,
            newHex: mapping.newHex,
            deltaE2000: mapping.deltaE2000,
            reliable: mapping.reliable,
            migrationVersion: LEGACY_DEMO_MIGRATION_VERSION,
          }));
          migrationResult = {
            version: LEGACY_DEMO_MIGRATION_VERSION,
            targetPaletteId: targetPalette.id,
            confirmedUnreliableCodes: unreliableMappings.map((mapping) => mapping.oldCode),
          };
        } else {
          grid = remapGridPalette({
            grid: current.grid,
            sourcePalette,
            targetPalette,
            maxColors: request.body.maxColors,
            availableColorCodes,
          });
        }
        assertValidGrid(grid, targetPalette);
        const project = await transactionStore.remapProjectPalette({
          userId: user.id,
          projectId: current.id,
          baseRevision: request.body.baseRevision,
          paletteId: targetPalette.id,
          grid,
          ...(migrationAudit === undefined ? {} : { migrationAudit }),
          ...(request.body.deviceSource === undefined ? {} : { deviceSource: request.body.deviceSource }),
        });
        return {
          statusCode: 200,
          body: {
            project,
            materials: calculateMaterials(project.id, project.currentRevision, project.grid, targetPalette),
            migration: migrationResult,
          },
        };
      },
    });
  });

  app.patch<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Body: Static<typeof RenameProjectBody>;
  }>("/projects/:projectId", {
    schema: {
      tags: ["projects"],
      summary: "以新 revision 重命名项目",
      params: ProjectIdParamsSchema,
      body: RenameProjectBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const name = request.body.name.trim();
    if (!name) throw new AppError(400, "PROJECT_NAME_REQUIRED", "项目名称不能为空");
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `projects:${request.params.projectId}:rename`,
      key,
      payload: {
        baseRevision: request.body.baseRevision,
        name,
        deviceSource: request.body.deviceSource ?? null,
      },
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const source = await transactionStore.getProject(
          user.id,
          request.params.projectId,
          request.body.baseRevision,
        );
        if (!source) throw new AppError(404, "PROJECT_NOT_FOUND", "项目或指定版本不存在");
        const project = await transactionStore.updateProjectGrid({
          userId: user.id,
          projectId: request.params.projectId,
          baseRevision: request.body.baseRevision,
          name,
          grid: source.grid,
          ...(request.body.deviceSource === undefined ? {} : { deviceSource: request.body.deviceSource }),
        });
        return { statusCode: 200, body: { project } };
      },
    });
  });

  app.patch<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Body: Static<typeof UpdateProjectMetadataBody>;
  }>("/projects/:projectId/metadata", {
    schema: {
      tags: ["projects"],
      summary: "更新作品模式、生命周期、素材引用与背景元数据",
      description: "lifecycleStatus 与列表中的制作进度 status 是两个独立字段。该操作不创建图纸 revision，并使用独立的 baseMetadataRevision 防止并发覆盖。",
      params: ProjectIdParamsSchema,
      body: UpdateProjectMetadataBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const {
      baseRevision,
      baseMetadataRevision,
      mode,
      lifecycleStatus,
      sourceAssetId,
      previewAssetId,
      backgroundMode,
      backgroundColor,
      tags,
      deviceSource,
    } = request.body;
    if (mode === undefined
      && lifecycleStatus === undefined
      && sourceAssetId === undefined
      && previewAssetId === undefined
      && backgroundMode === undefined
      && backgroundColor === undefined
      && tags === undefined
      && deviceSource === undefined) {
      throw new AppError(400, "PROJECT_METADATA_REQUIRED", "至少需要提供一个作品元数据字段");
    }
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `projects:${request.params.projectId}:metadata`,
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const project = await transactionStore.updateProjectMetadata({
          userId: user.id,
          projectId: request.params.projectId,
          baseRevision,
          baseMetadataRevision,
          ...(mode === undefined ? {} : { mode }),
          ...(lifecycleStatus === undefined ? {} : { lifecycleStatus }),
          ...(sourceAssetId === undefined ? {} : { sourceAssetId }),
          ...(previewAssetId === undefined ? {} : { previewAssetId }),
          ...(backgroundMode === undefined ? {} : { backgroundMode }),
          ...(backgroundColor === undefined ? {} : { backgroundColor }),
          ...(tags === undefined ? {} : { tags: normalizeProjectTags(tags) }),
          ...(deviceSource === undefined ? {} : { deviceSource }),
        });
        return { statusCode: 200, body: { project } };
      },
    });
  });

  app.post<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Body: Static<typeof CopyProjectBody>;
  }>("/projects/:projectId/copy", {
    schema: {
      tags: ["projects"],
      summary: "复制项目当前或指定 revision",
      params: ProjectIdParamsSchema,
      body: CopyProjectBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const requestedName = request.body.name?.trim();
    if (request.body.name !== undefined && !requestedName) {
      throw new AppError(400, "PROJECT_NAME_REQUIRED", "项目名称不能为空");
    }
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `projects:${request.params.projectId}:copy`,
      key,
      payload: {
        revision: request.body.revision ?? null,
        name: requestedName ?? null,
        deviceSource: request.body.deviceSource ?? null,
      },
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const project = await transactionStore.copyProject({
          userId: user.id,
          projectId: request.params.projectId,
          ...(request.body.revision === undefined ? {} : { revision: request.body.revision }),
          ...(requestedName === undefined ? {} : { name: requestedName }),
          ...(request.body.deviceSource === undefined ? {} : { deviceSource: request.body.deviceSource }),
        });
        if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "项目或指定版本不存在");
        return { statusCode: 201, body: { project } };
      },
    });
  });

  app.delete<{ Params: Static<typeof ProjectIdParamsSchema> }>("/projects/:projectId", {
    schema: { tags: ["projects"], summary: "删除项目", params: ProjectIdParamsSchema },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const scope = `projects:${request.params.projectId}:delete`;
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: null,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        if (!await transactionStore.deleteProject(user.id, request.params.projectId)) {
          throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
        }
        return { statusCode: 204, body: null };
      },
    });
  });

  app.get<{ Params: Static<typeof ProjectIdParamsSchema> }>("/projects/:projectId/draft", {
    schema: {
      tags: ["projects"],
      summary: "读取不产生历史 revision 的编辑草稿",
      params: ProjectIdParamsSchema,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const project = await dependencies.store.getProject(user.id, request.params.projectId);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    const draft = await dependencies.store.getProjectDraft(user.id, request.params.projectId);
    return { draft, baseProjectRevision: project.currentRevision };
  });

  app.put<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Body: Static<typeof SaveProjectDraftBody>;
  }>("/projects/:projectId/draft", {
    bodyLimit: GRID_JSON_BODY_LIMIT_BYTES,
    preParsing: authenticateBeforeGridParsing,
    schema: {
      tags: ["projects"],
      summary: "高频覆盖保存编辑草稿，不新增不可变 revision",
      params: ProjectIdParamsSchema,
      body: SaveProjectDraftBody,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const project = await dependencies.store.getProject(user.id, request.params.projectId);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    const palette = await dependencies.store.getPalette(project.paletteId, user.id);
    if (!palette) throw new AppError(500, "PALETTE_NOT_FOUND", "项目色卡不存在");
    assertValidGrid(request.body.grid, palette);
    const name = request.body.name?.trim();
    if (request.body.name !== undefined && !name) {
      throw new AppError(400, "PROJECT_NAME_REQUIRED", "项目名称不能为空");
    }
    await requireUserRateLimit(dependencies.store, user.id, USER_RATE_LIMITS.projectDraftMutation);
    const draft = await dependencies.store.saveProjectDraft({
      userId: user.id,
      projectId: request.params.projectId,
      baseProjectRevision: request.body.baseProjectRevision,
      baseDraftRevision: request.body.baseDraftRevision,
      ...(name === undefined ? {} : { name }),
      grid: request.body.grid,
    });
    return { draft };
  });

  app.post<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Body: Static<typeof ProjectDraftVersionBody>;
  }>("/projects/:projectId/draft/commit", {
    schema: {
      tags: ["projects"],
      summary: "将编辑草稿提交为一个新的不可变 revision",
      params: ProjectIdParamsSchema,
      body: ProjectDraftVersionBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `projects:${request.params.projectId}:draft:commit`,
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const project = await transactionStore.commitProjectDraft({
          userId: user.id,
          projectId: request.params.projectId,
          ...request.body,
        });
        return { statusCode: 200, body: { project } };
      },
    });
  });

  app.delete<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Body: Static<typeof ProjectDraftVersionBody>;
  }>("/projects/:projectId/draft", {
    schema: {
      tags: ["projects"],
      summary: "丢弃指定版本的编辑草稿",
      params: ProjectIdParamsSchema,
      body: ProjectDraftVersionBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: `projects:${request.params.projectId}:draft:discard`,
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const discarded = await transactionStore.discardProjectDraft({
          userId: user.id,
          projectId: request.params.projectId,
          ...request.body,
        });
        if (!discarded) throw new AppError(404, "PROJECT_DRAFT_NOT_FOUND", "项目草稿不存在");
        return { statusCode: 204, body: null };
      },
    });
  });

  app.get<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Querystring: Static<typeof RevisionQuery>;
  }>("/projects/:projectId/materials", {
    schema: {
      tags: ["projects"],
      summary: "由服务端计算材料统计",
      params: ProjectIdParamsSchema,
      querystring: RevisionQuery,
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const project = await dependencies.store.getProject(user.id, request.params.projectId, request.query.revision);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "项目或指定版本不存在");
    const palette = await dependencies.store.getPalette(project.paletteId, user.id);
    if (!palette) throw new AppError(500, "PALETTE_NOT_FOUND", "项目色卡不存在");
    return { materials: calculateMaterials(project.id, project.currentRevision, project.grid, palette) };
  });

  app.get<{ Params: Static<typeof ProjectIdParamsSchema> }>("/projects/:projectId/build-progress", {
    schema: { tags: ["build-progress"], summary: "读取绑定项目版本的制作进度", params: ProjectIdParamsSchema },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const progress = await dependencies.store.getBuildProgress(user.id, request.params.projectId);
    if (!progress) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    return { progress };
  });

  app.put<{
    Params: Static<typeof ProjectIdParamsSchema>;
    Body: Static<typeof SaveProgressBody>;
  }>("/projects/:projectId/build-progress", {
    schema: {
      tags: ["build-progress"],
      summary: "以双版本乐观锁保存制作进度",
      params: ProjectIdParamsSchema,
      body: SaveProgressBody,
    },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    const scope = `projects:${request.params.projectId}:build-progress`;
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope,
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.buildProgressMutation);
        const progress = await transactionStore.saveBuildProgress({
          userId: user.id,
          projectId: request.params.projectId,
          ...request.body,
        });
        return { statusCode: 200, body: { progress } };
      },
    });
  });
}
