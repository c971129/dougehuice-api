import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

import { requireAuthSession } from "../auth.js";
import {
  INVITE_REWARD_INVITEE_CREDITS,
  INVITE_REWARD_INVITER_CREDITS_NEW_USER,
  INVITE_REWARD_INVITER_CREDITS_RETURNING_USER,
  INVITE_REWARD_LEDGER_REASON,
} from "../domain/models.js";
import { executeIdempotent, requireIdempotencyKey } from "../idempotency.js";
import type { RouteDependencies } from "./types.js";

const AcceptInviteBody = Type.Object({
  code: Type.String({ minLength: 8, maxLength: 32 }),
}, { additionalProperties: false });

const InviteRewardPolicySchema = Type.Object({
  creditAmountConfigured: Type.Literal(true),
  shareProofRequired: Type.Literal(false),
  ledgerReasonReserved: Type.Literal(INVITE_REWARD_LEDGER_REASON),
  awardsCredits: Type.Literal(true),
  inviterCreditAmountNewUser: Type.Literal(INVITE_REWARD_INVITER_CREDITS_NEW_USER),
  inviterCreditAmountReturningUser: Type.Literal(INVITE_REWARD_INVITER_CREDITS_RETURNING_USER),
  inviteeCreditAmount: Type.Literal(INVITE_REWARD_INVITEE_CREDITS),
}, { additionalProperties: false });

const InviteCodeSchema = Type.Object({
  userId: Type.String({ format: "uuid" }),
  code: Type.String({ minLength: 8, maxLength: 32 }),
  createdAt: Type.String({ format: "date-time" }),
}, { additionalProperties: false });

const InviteBindingSchema = Type.Object({
  inviteeUserId: Type.String({ format: "uuid" }),
  inviterUserId: Type.String({ format: "uuid" }),
  inviteCode: Type.String({ minLength: 8, maxLength: 32 }),
  boundAt: Type.String({ format: "date-time" }),
  inviteeWasNewUser: Type.Boolean(),
}, { additionalProperties: false });

const InviteEntitlementSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  bindingInviteeUserId: Type.String({ format: "uuid" }),
  beneficiaryUserId: Type.String({ format: "uuid" }),
  role: Type.Union([Type.Literal("inviter"), Type.Literal("invitee")]),
  status: Type.Union([
    Type.Literal("awaiting_external_proof"),
    Type.Literal("credited"),
    Type.Literal("rejected"),
  ]),
  creditLedgerId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
}, { additionalProperties: false });

const InviteSummarySchema = Type.Object({
  invite: InviteCodeSchema,
  binding: Type.Union([InviteBindingSchema, Type.Null()]),
  entitlements: Type.Array(InviteEntitlementSchema),
  rewardPolicy: InviteRewardPolicySchema,
}, { additionalProperties: false });

const InviteSummaryResponse = Type.Object({
  inviteSummary: InviteSummarySchema,
}, { additionalProperties: false });

const EnsureInviteCodeResponse = Type.Object({
  invite: InviteCodeSchema,
  inviteSummary: InviteSummarySchema,
}, { additionalProperties: false });

const InviteRewardAppliedSchema = Type.Object({
  beneficiaryRole: Type.Literal("inviter"),
  delta: Type.Union([
    Type.Literal(INVITE_REWARD_INVITER_CREDITS_NEW_USER),
    Type.Literal(INVITE_REWARD_INVITER_CREDITS_RETURNING_USER),
  ]),
  inviteeWasNewUser: Type.Boolean(),
}, { additionalProperties: false });

const AcceptInviteResponse = Type.Object({
  inviteSummary: InviteSummarySchema,
  rewardApplied: Type.Union([InviteRewardAppliedSchema, Type.Null()]),
}, { additionalProperties: false });

export async function registerInviteRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  app.get("/invites/me", {
    schema: {
      tags: ["invites"],
      summary: "读取本人邀请码、绑定关系与奖励策略",
      response: { 200: InviteSummaryResponse },
    },
  }, async (request) => {
    const session = await requireAuthSession(request, dependencies.store);
    return { inviteSummary: await dependencies.store.getInviteSummary(session.user.id) };
  });

  app.post("/invites/me/code", {
    schema: {
      tags: ["invites"],
      summary: "确保本人拥有受保护邀请码（幂等）",
      response: { 200: EnsureInviteCodeResponse },
    },
  }, async (request, reply) => {
    const session = await requireAuthSession(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    return executeIdempotent({
      store: dependencies.store,
      userId: session.user.id,
      scope: "invites:me:code",
      key,
      payload: {},
      reply,
      operation: async (transactionStore) => {
        const invite = await transactionStore.ensureUserInviteCode(session.user.id, new Date().toISOString());
        const inviteSummary = await transactionStore.getInviteSummary(session.user.id);
        return { statusCode: 200, body: { invite, inviteSummary } };
      },
    });
  });

  app.post<{ Body: Static<typeof AcceptInviteBody> }>("/invites/accept", {
    schema: {
      tags: ["invites"],
      summary: "接受邀请码：建立一次性绑定并为邀请人 exactly-once 入账（被邀请人 +0）",
      body: AcceptInviteBody,
      response: { 200: AcceptInviteResponse },
    },
  }, async (request, reply) => {
    const session = await requireAuthSession(request, dependencies.store);
    const key = requireIdempotencyKey(request);
    return executeIdempotent({
      store: dependencies.store,
      userId: session.user.id,
      scope: "invites:accept",
      key,
      payload: request.body,
      reply,
      operation: async (transactionStore) => {
        const result = await transactionStore.acceptInviteCode({
          inviteeUserId: session.user.id,
          code: request.body.code,
          now: new Date().toISOString(),
          inviteeWasNewUser: Boolean(session.createdNewUser),
        });
        return { statusCode: 200, body: result };
      },
    });
  });
}
