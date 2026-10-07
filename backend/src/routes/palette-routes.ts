import { randomUUID } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

import { optionalAuth, requireAuth } from "../auth.js";
import { BUILTIN_PALETTES } from "../domain/palettes.js";
import { USER_RATE_LIMITS } from "../domain/resource-limits.js";
import { AppError } from "../errors.js";
import { executeIdempotent, requireIdempotencyKey } from "../idempotency.js";
import { requireUserRateLimit } from "../rate-limit.js";
import type { RouteDependencies } from "./types.js";

const CreatePaletteBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  brand: Type.String({ minLength: 1, maxLength: 100 }),
  series: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  material: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  beadSizeMm: Type.Number({ exclusiveMinimum: 0, maximum: 20 }),
  colors: Type.Array(Type.Object({
    code: Type.String({ minLength: 1, maxLength: 32 }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    hex: Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }),
    unitPriceCents: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000 })),
    finish: Type.Optional(Type.Union([
      Type.Literal("solid"), Type.Literal("pearlescent"), Type.Literal("thermochromic"),
      Type.Literal("translucent"), Type.Literal("transparent"), Type.Literal("glow-in-the-dark"),
      Type.Literal("photochromic"), Type.Literal("special"),
    ])),
  }, { additionalProperties: false }), { minItems: 2, maxItems: 256 }),
}, { additionalProperties: false });

export async function registerPaletteRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  app.get("/palettes", {
    schema: { tags: ["palettes"], summary: "匿名读取内置 MARD 非官方参考色卡；登录后同时读取私有色卡" },
  }, async (request) => {
    const user = await optionalAuth(request, dependencies.store);
    return {
      palettes: user
        ? await dependencies.store.listPalettes(user.id)
        : BUILTIN_PALETTES,
    };
  });

  app.post<{ Body: Static<typeof CreatePaletteBody> }>("/palettes", {
    schema: { tags: ["palettes"], summary: "导入用户私有的不可变自定义色卡", body: CreatePaletteBody },
  }, async (request, reply) => {
    const user = await requireAuth(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    if (dependencies.config.customPalettesEnabled === false) {
      throw new AppError(503, "CUSTOM_PALETTES_DISABLED", "自定义色卡功能尚未完成安全发布切换", null, true);
    }
    const name = request.body.name.trim();
    const brand = request.body.brand.trim();
    const series = request.body.series?.trim() || name;
    const material = request.body.material?.trim() || "PE";
    const colors = request.body.colors.map((color) => ({
      code: color.code.trim().toUpperCase(),
      name: color.name.trim(),
      hex: color.hex.toUpperCase(),
      unitPriceCents: color.unitPriceCents ?? 0,
      finish: color.finish ?? "solid",
    }));
    if (!name || !brand || !series || colors.some((color) => !color.code || !color.name)) {
      throw new AppError(400, "PALETTE_TEXT_REQUIRED", "色卡名称、品牌、系列、色号和颜色名称不能为空");
    }
    const codes = colors.map((color) => color.code);
    if (new Set(codes).size !== codes.length) {
      throw new AppError(400, "PALETTE_COLOR_DUPLICATE", "色卡色号不能重复");
    }
    return executeIdempotent({
      store: dependencies.store,
      userId: user.id,
      scope: "palettes:create",
      key,
      payload: { name, brand, series, material, beadSizeMm: request.body.beadSizeMm, colors },
      reply,
      operation: async (transactionStore) => {
        await requireUserRateLimit(transactionStore, user.id, USER_RATE_LIMITS.projectMutation);
        const palette = await transactionStore.createPalette(user.id, {
          id: `custom-${randomUUID()}`,
          name,
          brand,
          series,
          material,
          beadSizeMm: request.body.beadSizeMm,
          verified: false,
          version: 1,
          retired: false,
          source: {
            name: "user import",
            url: "",
            revision: "1",
            license: "user supplied",
          },
          colors: colors.map((color, index) => ({
            code: codes[index]!,
            name: color.name,
            hex: color.hex,
            finish: color.finish,
            unitPriceCents: color.unitPriceCents,
            available: true,
          })),
        });
        return { statusCode: 201, body: { palette } };
      },
    });
  });
}
