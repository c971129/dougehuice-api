import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../auth.js";
import type { RouteDependencies } from "./types.js";

const LedgerQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 })),
}, { additionalProperties: false });

export async function registerCreditRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  app.get("/credits", {
    schema: { tags: ["credits"], summary: "读取次数余额" },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    return { account: await dependencies.store.getCreditAccount(user.id) };
  });

  app.get<{ Querystring: Static<typeof LedgerQuery> }>("/credits/ledger", {
    schema: { tags: ["credits"], summary: "读取次数账本", querystring: LedgerQuery },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const limit = request.query.limit ?? 30;
    const offset = request.query.offset ?? 0;
    const rows = await dependencies.store.listCreditLedger(user.id, limit + 1, offset);
    const hasMore = rows.length > limit;
    return {
      entries: rows.slice(0, limit),
      pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null },
    };
  });
}
