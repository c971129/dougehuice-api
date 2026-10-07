import { createHash } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { AppError } from "./errors.js";
import type { AppStore } from "./repositories/store.js";

export function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  const key = Array.isArray(value) ? value[0] : value;
  if (!key || key.length < 8 || key.length > 128) {
    throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "写操作需要 8-128 字符的 Idempotency-Key");
  }
  return key;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function hashIdempotencyRequest(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export async function executeIdempotent<T>(input: {
  store: AppStore;
  userId: string;
  scope: string;
  key: string;
  payload: unknown;
  reply: FastifyReply;
  mapResponse?: (body: T) => T;
  operation: (transactionStore: AppStore) => Promise<{ statusCode: number; body: T }>;
}): Promise<FastifyReply> {
  const result = await input.store.executeIdempotent({
    userId: input.userId,
    scope: input.scope,
    key: input.key,
    requestHash: hashIdempotencyRequest(input.payload),
  }, input.operation);
  if (result.replayed) input.reply.header("Idempotency-Replayed", "true");
  const body = input.mapResponse ? input.mapResponse(result.body) : result.body;
  return input.reply.code(result.statusCode).send(body);
}

export async function replayIdempotent<T>(input: {
  store: AppStore;
  userId: string;
  scope: string;
  key: string;
  payload: unknown;
  reply: FastifyReply;
  mapResponse?: (body: T) => T;
}): Promise<boolean> {
  const existing = await input.store.getIdempotent<T>({
    userId: input.userId,
    scope: input.scope,
    key: input.key,
    requestHash: hashIdempotencyRequest(input.payload),
  });
  if (!existing) return false;
  input.reply.header("Idempotency-Replayed", "true");
  const body = input.mapResponse ? input.mapResponse(existing.body) : existing.body;
  input.reply.code(existing.statusCode).send(body);
  return true;
}
