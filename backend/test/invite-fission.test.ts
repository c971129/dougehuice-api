import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import type { WechatMiniProgramAuthProvider } from "../src/wechat/mini-program-auth.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused",
  databaseSsl: false,
  devAuthEnabled: true,
  corsOrigins: ["http://localhost:5173"],
  sessionTtlDays: 30,
  devStartingCredits: 20,
  assetStorageRoot: join(tmpdir(), "pindou-invite-fission-test-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

/** Per-code openId so first login creates user; second login with same code is returning. */
function openIdWechatProvider(): WechatMiniProgramAuthProvider {
  return {
    kind: "development",
    async exchangeCode(code: string) {
      const normalized = code.trim();
      if (!normalized) throw new Error("empty code");
      return { openId: `test-openid:${normalized}`, unionId: null };
    },
  };
}

describe("invite fission reward on login bind", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({
      config,
      store: new MemoryStore(),
      wechatAuthProvider: openIdWechatProvider(),
      logger: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function loginDev(displayName: string): Promise<{ token: string; userId: string; balance: number }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName },
    });
    assert.equal(response.statusCode, 201);
    return {
      token: response.json().token as string,
      userId: response.json().user.id as string,
      balance: response.json().credits.balance as number,
    };
  }

  async function loginWechat(code: string, displayName: string): Promise<{ token: string; userId: string; balance: number }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat-session",
      payload: { code, displayName },
    });
    assert.equal(response.statusCode, 201, response.body);
    return {
      token: response.json().token as string,
      userId: response.json().user.id as string,
      balance: response.json().credits.balance as number,
    };
  }

  async function ensureCode(token: string): Promise<string> {
    const ensure = await app.inject({
      method: "POST",
      url: "/api/v1/invites/me/code",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": `code-${token.slice(0, 12)}` },
      payload: {},
    });
    assert.equal(ensure.statusCode, 200, ensure.body);
    const policy = ensure.json().inviteSummary.rewardPolicy;
    assert.equal(policy.awardsCredits, true);
    assert.equal(policy.shareProofRequired, false);
    assert.equal(policy.creditAmountConfigured, true);
    assert.equal(policy.inviterCreditAmountNewUser, 3);
    assert.equal(policy.inviterCreditAmountReturningUser, 1);
    assert.equal(policy.inviteeCreditAmount, 0);
    return ensure.json().invite.code as string;
  }

  async function balance(token: string): Promise<number> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credits",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    return response.json().account.balance as number;
  }

  async function inviteRewardCount(token: string): Promise<number> {
    const ledger = await app.inject({
      method: "GET",
      url: "/api/v1/credits/ledger?limit=50&offset=0",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(ledger.statusCode, 200);
    return ledger.json().entries.filter((entry: { reason: string }) => entry.reason === "invite_reward").length;
  }

  it("credits inviter +3 when invitee is a new user; invitee +0", async () => {
    const inviter = await loginDev("邀请人A");
    const code = await ensureCode(inviter.token);
    const beforeA = await balance(inviter.token);

    const invitee = await loginWechat("new-invitee-alpha", "新用户B");
    const beforeB = invitee.balance;

    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/invites/accept",
      headers: { authorization: `Bearer ${invitee.token}`, "idempotency-key": "accept-new-1" },
      payload: { code },
    });
    assert.equal(accept.statusCode, 200, accept.body);
    assert.equal(accept.json().rewardApplied?.delta, 3);
    assert.equal(accept.json().rewardApplied?.inviteeWasNewUser, true);
    assert.equal(accept.json().inviteSummary.binding.inviteeWasNewUser, true);
    assert.equal(accept.json().inviteSummary.entitlements.length, 1);
    assert.equal(accept.json().inviteSummary.entitlements[0].role, "inviter");
    assert.equal(accept.json().inviteSummary.entitlements[0].status, "credited");
    assert.ok(accept.json().inviteSummary.entitlements[0].creditLedgerId);

    assert.equal(await balance(inviter.token), beforeA + 3);
    assert.equal(await balance(invitee.token), beforeB);
    assert.equal(await inviteRewardCount(inviter.token), 1);
    assert.equal(await inviteRewardCount(invitee.token), 0);
  });

  it("credits inviter +1 when invitee is a returning user; invitee +0", async () => {
    const inviter = await loginDev("邀请人A2");
    const code = await ensureCode(inviter.token);
    const beforeA = await balance(inviter.token);

    const first = await loginWechat("returning-invitee-beta", "老用户B");
    const second = await loginWechat("returning-invitee-beta", "老用户B再登");
    assert.equal(second.userId, first.userId);

    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/invites/accept",
      headers: { authorization: `Bearer ${second.token}`, "idempotency-key": "accept-old-1" },
      payload: { code },
    });
    assert.equal(accept.statusCode, 200, accept.body);
    assert.equal(accept.json().rewardApplied?.delta, 1);
    assert.equal(accept.json().rewardApplied?.inviteeWasNewUser, false);
    assert.equal(await balance(inviter.token), beforeA + 1);
    assert.equal(await inviteRewardCount(inviter.token), 1);
    assert.equal(await inviteRewardCount(second.token), 0);
  });

  it("replays accept without double-crediting inviter", async () => {
    const inviter = await loginDev("邀请人幂等");
    const code = await ensureCode(inviter.token);
    const invitee = await loginWechat("replay-invitee", "重放B");
    const beforeA = await balance(inviter.token);

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/invites/accept",
      headers: { authorization: `Bearer ${invitee.token}`, "idempotency-key": "accept-replay" },
      payload: { code },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().rewardApplied?.delta, 3);

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/invites/accept",
      headers: { authorization: `Bearer ${invitee.token}`, "idempotency-key": "accept-replay" },
      payload: { code },
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers["idempotency-replayed"], "true");

    const sameBinding = await app.inject({
      method: "POST",
      url: "/api/v1/invites/accept",
      headers: { authorization: `Bearer ${invitee.token}`, "idempotency-key": "accept-replay-2" },
      payload: { code },
    });
    assert.equal(sameBinding.statusCode, 200);
    assert.equal(sameBinding.json().rewardApplied, null);

    assert.equal(await balance(inviter.token), beforeA + 3);
    assert.equal(await inviteRewardCount(inviter.token), 1);
  });

  it("keeps self-invite / cross-bind / unknown-code guards without awards", async () => {
    const inviter = await loginDev("防护邀请人");
    const code = await ensureCode(inviter.token);
    const beforeA = await balance(inviter.token);

    const self = await app.inject({
      method: "POST",
      url: "/api/v1/invites/accept",
      headers: { authorization: `Bearer ${inviter.token}`, "idempotency-key": "invite-accept-self" },
      payload: { code },
    });
    assert.equal(self.statusCode, 409, self.body);
    assert.equal(self.json().error.code, "INVITE_SELF_NOT_ALLOWED");

    const invitee = await loginWechat("guard-invitee", "防护B");
    await app.inject({
      method: "POST",
      url: "/api/v1/invites/accept",
      headers: { authorization: `Bearer ${invitee.token}`, "idempotency-key": "invite-bind-once" },
      payload: { code },
    });

    const other = await loginDev("另一邀请人");
    const otherCode = await ensureCode(other.token);
    const cross = await app.inject({
      method: "POST",
      url: "/api/v1/invites/accept",
      headers: { authorization: `Bearer ${invitee.token}`, "idempotency-key": "invite-accept-cross" },
      payload: { code: otherCode },
    });
    assert.equal(cross.statusCode, 409);
    assert.equal(cross.json().error.code, "INVITE_ALREADY_BOUND");

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/invites/accept",
      headers: { authorization: `Bearer ${invitee.token}`, "idempotency-key": "invite-accept-missing" },
      payload: { code: "NOTEXIST1" },
    });
    assert.equal(missing.statusCode, 404);

    assert.equal(await balance(inviter.token), beforeA + 3);
    assert.equal(await inviteRewardCount(inviter.token), 1);
    assert.equal(await inviteRewardCount(other.token), 0);
  });

  it("OpenAPI freezes awarding rewardPolicy and omits share-proof claim routes", async () => {
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(response.statusCode, 200);
    const document = response.json() as {
      paths: Record<string, Record<string, {
        responses?: Record<string, {
          content?: Record<string, { schema?: unknown }>;
        }>;
      }>>;
    };
    const pathKeys = Object.keys(document.paths);
    assert.deepEqual(
      pathKeys.filter((path) => path.includes("invite")).sort(),
      ["/invites/accept", "/invites/me", "/invites/me/code"],
    );
    assert.equal(
      pathKeys.some((path) => /claim|share-proof|share_proof|share-callback|reward\/credit/i.test(path)),
      false,
    );

    const meSchema = document.paths["/invites/me"]?.get?.responses?.["200"]
      ?.content?.["application/json"]?.schema as Record<string, unknown> | undefined;
    assert.ok(meSchema);
    const text = JSON.stringify(meSchema);
    assert.match(text, /"awardsCredits":\{"type":"boolean","enum":\[true\]\}/);
    assert.match(text, /"shareProofRequired":\{"type":"boolean","enum":\[false\]\}/);
    assert.match(text, /"creditAmountConfigured":\{"type":"boolean","enum":\[true\]\}/);
    assert.match(text, /"inviterCreditAmountNewUser":\{"type":"(integer|number)","enum":\[3\]\}/);
    assert.match(text, /"inviterCreditAmountReturningUser":\{"type":"(integer|number)","enum":\[1\]\}/);
    assert.match(text, /"inviteeCreditAmount":\{"type":"(integer|number)","enum":\[0\]\}/);
    assert.match(text, /"ledgerReasonReserved":\{"type":"string","enum":\["invite_reward"\]\}/);
  });
});
