import { createHash, randomBytes } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

import { hashToken, requireAuth, requireBearerTokenHash } from "../auth.js";
import { isLocalDevelopmentAuthAllowed } from "../config.js";
import { AppError } from "../errors.js";
import { ANONYMOUS_AUTH_RATE_LIMITS, USER_RATE_LIMITS } from "../domain/resource-limits.js";
import { requireUserRateLimit } from "../rate-limit.js";
import type { RouteDependencies } from "./types.js";
import type { WechatMiniProgramAuthProvider, WechatMiniProgramIdentity } from "../wechat/mini-program-auth.js";

const MAX_WECHAT_LOGIN_INFLIGHT = 128;
const wechatLoginInflight = new WeakMap<WechatMiniProgramAuthProvider, Map<string, Promise<WechatMiniProgramIdentity>>>();

/**
 * Coalesce duplicate wx.login codes while keeping session issuance per request.
 * The code is hashed only for the in-memory key and is never logged or returned.
 */
async function exchangeWechatCode(provider: WechatMiniProgramAuthProvider, code: string): Promise<WechatMiniProgramIdentity> {
  const codeHash = createHash("sha256").update(code.trim()).digest("hex");
  let providerInflight = wechatLoginInflight.get(provider);
  if (!providerInflight) {
    providerInflight = new Map();
    wechatLoginInflight.set(provider, providerInflight);
  }
  const existing = providerInflight.get(codeHash);
  if (existing) return existing;
  if (providerInflight.size >= MAX_WECHAT_LOGIN_INFLIGHT) {
    throw new AppError(503, "WECHAT_AUTH_UNAVAILABLE", "微信登录服务暂时不可用", null, true);
  }

  const exchange = Promise.resolve().then(() => provider.exchangeCode(code));
  providerInflight.set(codeHash, exchange);
  try {
    return await exchange;
  } finally {
    if (providerInflight.get(codeHash) === exchange) providerInflight.delete(codeHash);
  }
}

const DevSessionBody = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
}, { additionalProperties: false });
const WechatSessionBody = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 128 }),
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
}, { additionalProperties: false });
const WebLoginConfirmBody = Type.Object({ code: Type.String({ pattern: "^[0-9]{6}$" }) }, { additionalProperties: false });

export async function registerAuthRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  app.post("/auth/web-login-challenges", {
    schema: { tags: ["auth"], summary: "创建一次性 Web 与微信账号配对码" },
  }, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const rateKey = createHash("sha256").update(`web-login-create:${request.ip}`).digest("hex");
    const rate = await dependencies.store.consumeAuthRateLimit({ keyHash: rateKey, action: "web-login-create", now: new Date().toISOString(), limit: 20, windowMilliseconds: 10 * 60_000 });
    if (!rate.allowed) throw new AppError(429, "WEB_LOGIN_RATE_LIMITED", "配对请求过于频繁，请稍后重试", { retryAfterMilliseconds: rate.retryAfterMilliseconds }, true);
    const token = randomBytes(32).toString("base64url");
    let sessionToken = randomBytes(32).toString("base64url");
    while (sessionToken === token) sessionToken = randomBytes(32).toString("base64url");
    const code = String(Number.parseInt(randomBytes(4).toString("hex"), 16) % 1_000_000).padStart(6, "0");
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await dependencies.store.createWebLoginChallenge({
      tokenHash: hashToken(token),
      sessionTokenHash: hashToken(sessionToken),
      code,
      expiresAt,
    });
    return reply.code(201).send({ token, sessionToken, code, expiresAt });
  });

  app.get("/auth/web-login-challenges/current", {
    schema: { tags: ["auth"], summary: "轮询一次性 Web 登录配对状态" },
  }, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const token = String(request.headers["x-web-login-token"] ?? "");
    if (token.length < 20) throw new AppError(401, "WEB_LOGIN_TOKEN_REQUIRED", "Web 登录凭证无效");
    const challenge = await dependencies.store.getWebLoginChallenge(hashToken(token));
    if (!challenge) throw new AppError(404, "WEB_LOGIN_CHALLENGE_NOT_FOUND", "Web 登录请求不存在");
    return reply.send(challenge);
  });

  app.post<{ Body: Static<typeof WebLoginConfirmBody> }>("/auth/web-login-challenges/confirm", {
    schema: { tags: ["auth"], summary: "由已登录微信端确认 Web 配对码", body: WebLoginConfirmBody },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const rateKey = createHash("sha256").update(`web-login-confirm:${request.ip}`).digest("hex");
    const anonymousRate = await dependencies.store.consumeAuthRateLimit({ keyHash: rateKey, action: "web-login-confirm", now: new Date().toISOString(), limit: 40, windowMilliseconds: 10 * 60_000 });
    if (!anonymousRate.allowed) throw new AppError(429, "WEB_LOGIN_RATE_LIMITED", "配对尝试过于频繁，请稍后重试", { retryAfterMilliseconds: anonymousRate.retryAfterMilliseconds }, true);
    await requireUserRateLimit(dependencies.store, user.id, USER_RATE_LIMITS.webLoginConfirm);
    const sessionExpiresAt = new Date(Date.now() + dependencies.config.sessionTtlDays * 86_400_000).toISOString();
    const confirmed = await dependencies.store.confirmWebLoginChallenge({
      code: request.body.code,
      userId: user.id,
      sessionExpiresAt,
      createPollTokenSession: isLocalDevelopmentAuthAllowed(dependencies.config),
    });
    if (!confirmed) throw new AppError(404, "WEB_LOGIN_CODE_INVALID", "配对码不存在、已使用或已过期");
    return { confirmed: true };
  });

  app.post<{ Body: Static<typeof WechatSessionBody> }>("/auth/wechat-session", {
    schema: {
      tags: ["auth"],
      summary: "用 wx.login 临时凭证创建或续建微信小程序会话",
      body: WechatSessionBody,
    },
  }, async (request, reply) => {
    if (!dependencies.wechatAuthProvider) {
      throw new AppError(404, "WECHAT_AUTH_DISABLED", "微信登录尚未配置");
    }
    const rule = ANONYMOUS_AUTH_RATE_LIMITS.wechatSession;
    const rateKey = createHash("sha256").update(`${rule.action}:${request.ip}`).digest("hex");
    const rate = await dependencies.store.consumeAuthRateLimit({
      keyHash: rateKey,
      action: rule.action,
      now: new Date().toISOString(),
      limit: rule.limit,
      windowMilliseconds: rule.windowMilliseconds,
    });
    if (!rate.allowed) {
      throw new AppError(
        429,
        "WECHAT_SESSION_RATE_LIMITED",
        "微信登录尝试过于频繁，请稍后重试",
        { retryAfterMilliseconds: rate.retryAfterMilliseconds },
        true,
      );
    }
    const identity = await exchangeWechatCode(dependencies.wechatAuthProvider, request.body.code);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + dependencies.config.sessionTtlDays * 86_400_000).toISOString();
    const session = await dependencies.store.createWechatSession({
      openId: identity.openId,
      displayName: request.body.displayName?.trim() || "微信用户",
      tokenHash: hashToken(token),
      expiresAt,
      ...(dependencies.wechatAuthProvider.kind === "development"
        ? { developmentStartingCredits: dependencies.config.devStartingCredits }
        : {}),
    });
    const credits = await dependencies.store.getCreditAccount(session.user.id);
    return reply.code(201).send({ token, tokenType: "Bearer", ...session, credits });
  });

  app.get("/me", {
    schema: {
      tags: ["auth"],
      summary: "读取当前用户、次数与首页/个人页聚合统计",
    },
  }, async (request) => {
    const user = await requireAuth(request, dependencies.store);
    const [account, projects, inventory, activeGenerationJobs, exports] = await Promise.all([
      dependencies.store.getCreditAccount(user.id),
      dependencies.store.getProjectStatusStats(user.id),
      dependencies.store.getInventoryStats(user.id),
      dependencies.store.countActiveGenerationJobs(user.id),
      dependencies.store.getExportJobStats(user.id),
    ]);
    return {
      user,
      account,
      stats: {
        projects,
        inventory,
        activeGenerationJobs,
        exports,
      },
    };
  });

  app.delete("/auth/session", {
    schema: {
      tags: ["auth"],
      summary: "撤销当前会话并退出登录",
    },
  }, async (request, reply) => {
    const tokenHash = requireBearerTokenHash(request);
    await requireAuth(request, dependencies.store);
    await dependencies.store.revokeSession(tokenHash);
    return reply.code(204).send();
  });

  app.post<{ Body: Static<typeof DevSessionBody> }>("/auth/dev-session", {
    schema: {
      tags: ["auth"],
      summary: "创建本地开发会话",
      body: DevSessionBody,
    },
  }, async (request, reply) => {
    if (!dependencies.config.devAuthEnabled) {
      throw new AppError(404, "DEV_AUTH_DISABLED", "开发登录未启用");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + dependencies.config.sessionTtlDays * 86_400_000).toISOString();
    const session = await dependencies.store.createDevSession({
      displayName: request.body.displayName?.trim() || "拼豆体验用户",
      tokenHash: hashToken(token),
      expiresAt,
      startingCredits: dependencies.config.devStartingCredits,
    });
    const credits = await dependencies.store.getCreditAccount(session.user.id);
    return reply.code(201).send({ token, tokenType: "Bearer", ...session, credits });
  });
}
