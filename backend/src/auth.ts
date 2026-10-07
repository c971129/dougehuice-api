import { createHash } from "node:crypto";

import type { FastifyRequest } from "fastify";

import type { AuthSession, User } from "./domain/models.js";
import { AppError } from "./errors.js";
import type { AppStore } from "./repositories/store.js";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: User;
    authSession?: AuthSession;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function requireBearerTokenHash(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new AppError(401, "AUTH_REQUIRED", "请先登录");
  }
  const token = header.slice("Bearer ".length).trim();
  if (token.length < 20) throw new AppError(401, "INVALID_TOKEN", "登录凭证无效");
  return hashToken(token);
}

export async function requireAuthSession(request: FastifyRequest, store: AppStore): Promise<AuthSession> {
  if (request.authSession) return request.authSession;
  const session = await store.resolveSession(requireBearerTokenHash(request));
  if (!session) throw new AppError(401, "SESSION_EXPIRED", "登录已过期，请重新登录");
  request.authSession = session;
  request.authUser = session.user;
  return session;
}

export async function requireAuth(request: FastifyRequest, store: AppStore): Promise<User> {
  // Large authenticated JSON routes resolve the session in `preParsing` so
  // unauthenticated callers are rejected before Fastify buffers their body.
  // Reuse that trusted result when the handler performs its normal auth check.
  if (request.authUser) return request.authUser;
  return (await requireAuthSession(request, store)).user;
}

/**
 * Anonymous access is allowed only when the Authorization header is absent.
 * Supplying a malformed, expired, or revoked credential still fails closed.
 */
export async function optionalAuth(request: FastifyRequest, store: AppStore): Promise<User | null> {
  if (request.headers.authorization === undefined) return null;
  return requireAuth(request, store);
}
