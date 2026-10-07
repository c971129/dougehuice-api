import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { AppError } from "../src/errors.js";
import { MAX_PAYMENT_EFFECT_CLAIMS_PER_USER } from "../src/domain/resource-limits.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const migrationPaths = [
  "../migrations/0001_foundation.sql",
  "../migrations/0002_private_assets.sql",
  "../migrations/0003_exports.sql",
  "../migrations/0004_payments.sql",
  "../migrations/0005_inventory.sql",
  "../migrations/0006_project_lifecycle.sql",
  "../migrations/0007_generation_worker.sql",
  "../migrations/0008_export_artifact_cleanup.sql",
  "../migrations/0009_generation_options.sql",
  "../migrations/0010_generation_redraw.sql",
  "../migrations/0011_asset_readiness.sql",
  "../migrations/0012_payment_effect_claims.sql",
  "../migrations/0013_resource_controls.sql",
  "../migrations/0014_wechat_identity_and_payment_notifications.sql",
  "../migrations/0015_project_drafts.sql",
  "../migrations/0016_generation_solo_candidates.sql",
  "../migrations/0017_creation_drafts.sql",
  "../migrations/0018_build_progress_metadata.sql",
  "../migrations/0019_project_metadata.sql",
  "../migrations/0020_project_metadata_revision.sql",
  "../migrations/0021_palette_contract.sql",
  "../migrations/0022_generation_variants.sql",
  "../migrations/0034_payment_create_recovery.sql",
  "../migrations/0037_payment_reconciliation.sql",
  "../migrations/0038_payment_reconciliation_self_heal.sql",
  "../migrations/0039_payment_reconciliation_lock_order.sql",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

const userId = "00000000-0000-4000-8000-000000000101";
const firstOrderId = "00000000-0000-4000-8000-000000000102";
const secondOrderId = "00000000-0000-4000-8000-000000000103";
const closedOrderId = "00000000-0000-4000-8000-000000000104";
const providerTransactionId = "wx-transaction-20261004-0001";

function poolFor(database: PGlite): Pool {
  const query = (text: string, values?: unknown[]) =>
    values === undefined ? database.query(text) : database.query(text, values as never[]);
  let connectionTail = Promise.resolve();
  return {
    query,
    connect: async () => {
      const previous = connectionTail;
      let releaseConnection = (): void => undefined;
      const gate = new Promise<void>((resolve) => { releaseConnection = resolve; });
      connectionTail = previous.then(() => gate);
      await previous;
      return { query, release: releaseConnection } as unknown as PoolClient;
    },
    end: () => database.close(),
  } as unknown as Pool;
}

async function applyMigrations(database: PGlite): Promise<void> {
  for (const migrationPath of migrationPaths) {
    await database.exec(await readFile(migrationPath, "utf8"));
  }
  for (const migrationName of [
    "0056_invite_fission_prep.sql",
    "0057_invite_reward_login_bind.sql",
    "0058_credit_product_pricing.sql",
  ]) {
    const migrationPath = fileURLToPath(new URL(`../migrations/${migrationName}`, import.meta.url));
    await database.exec(await readFile(migrationPath, "utf8"));
  }
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

describe("PostgresStore payment SQL", () => {
  it("reuses one user/account for repeated WeChat sessions and keeps the openid private", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      const first = await store.createWechatSession({
        openId: "openid-postgres-private-0001",
        displayName: "首个微信名称",
        tokenHash: "1".repeat(64),
        expiresAt: "2027-10-04T00:00:00.000Z",
        developmentStartingCredits: 20,
      });
      const second = await store.createWechatSession({
        openId: "openid-postgres-private-0001",
        displayName: "不覆盖已有名称",
        tokenHash: "2".repeat(64),
        expiresAt: "2027-11-04T00:00:00.000Z",
        developmentStartingCredits: 999,
      });
      assert.equal(first.user.id, second.user.id);
      assert.equal(second.user.displayName, "首个微信名称");
      assert.equal(await store.getWechatOpenId(first.user.id), "openid-postgres-private-0001");
      assert.deepEqual(await store.getCreditAccount(first.user.id), {
        userId: first.user.id,
        balance: 20,
        updatedAt: (await store.getCreditAccount(first.user.id)).updatedAt,
      });
      const persisted = await database.query<{ users: number; accounts: number; sessions: number; welcome_credits: number }>(
        `SELECT
           (SELECT count(*)::integer FROM users WHERE wechat_openid = $1) AS users,
           (SELECT count(*)::integer FROM credit_accounts WHERE user_id = $2) AS accounts,
           (SELECT count(*)::integer FROM sessions WHERE user_id = $2) AS sessions,
           (SELECT count(*)::integer FROM credit_ledger
             WHERE user_id = $2 AND reason = 'dev_welcome_credit'
               AND delta = 20 AND balance_after = 20) AS welcome_credits`,
        ["openid-postgres-private-0001", first.user.id],
      );
      assert.deepEqual(persisted.rows[0], { users: 1, accounts: 1, sessions: 2, welcome_credits: 1 });
    } finally {
      await store.close();
    }
  });

  it("atomically claims, renews, releases, and takes over payment effects", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      await database.query(
        `INSERT INTO users(id, display_name) VALUES ($1, '支付租约用户')`,
        [userId],
      );
      const base = {
        userId,
        scope: "payment-orders:create",
        key: "postgres-payment-claim-0001",
        requestHash: "a".repeat(64),
      };
      // Absolute application time is deliberately far in the future. PostgreSQL must
      // use only the requested duration and arbitrate ownership with its own clock.
      const now = "2099-10-04T10:00:00.000Z";
      const expiresAt = "2099-10-04T10:01:00.000Z";
      const tokenA = "00000000-0000-4000-8000-000000000201";
      const tokenB = "00000000-0000-4000-8000-000000000202";
      const claims = await Promise.all([
        store.claimPaymentEffect({ ...base, leaseToken: tokenA, now, leaseExpiresAt: expiresAt }),
        store.claimPaymentEffect({ ...base, leaseToken: tokenB, now, leaseExpiresAt: expiresAt }),
      ]);
      assert.deepEqual(claims.map((claim) => claim.acquired).sort(), [false, true]);
      const databaseLeaseRemaining = Date.parse(claims.find((claim) => claim.acquired)!.leaseExpiresAt) - Date.now();
      assert.ok(databaseLeaseRemaining > 50_000 && databaseLeaseRemaining <= 65_000);
      const ownerToken = claims[0]?.acquired ? tokenA : tokenB;
      const contenderToken = ownerToken === tokenA ? tokenB : tokenA;

      const skewedContender = await store.claimPaymentEffect({
        ...base,
        leaseToken: contenderToken,
        now: "2199-10-04T10:00:00.000Z",
        leaseExpiresAt: "2199-10-04T10:01:00.000Z",
      });
      assert.equal(skewedContender.acquired, false);

      await assert.rejects(
        store.claimPaymentEffect({
          ...base,
          requestHash: "b".repeat(64),
          leaseToken: contenderToken,
          now,
          leaseExpiresAt: expiresAt,
        }),
        rejectsWithCode("IDEMPOTENCY_CONFLICT"),
      );
      assert.equal(await store.renewPaymentEffectClaim({
        userId,
        scope: base.scope,
        key: base.key,
        leaseToken: contenderToken,
        now: "2026-10-04T10:00:10.000Z",
        leaseExpiresAt: "2026-10-04T10:02:00.000Z",
      }), false);
      assert.equal(await store.renewPaymentEffectClaim({
        userId,
        scope: base.scope,
        key: base.key,
        leaseToken: ownerToken,
        now: "2026-10-04T10:00:10.000Z",
        leaseExpiresAt: "2026-10-04T10:02:00.000Z",
      }), true);
      assert.equal(await store.releasePaymentEffectClaim({
        userId,
        scope: base.scope,
        key: base.key,
        leaseToken: contenderToken,
        releasedAt: "2026-10-04T10:00:15.000Z",
      }), false);
      assert.equal(await store.releasePaymentEffectClaim({
        userId,
        scope: base.scope,
        key: base.key,
        leaseToken: ownerToken,
        releasedAt: "2026-10-04T10:00:15.000Z",
      }), true);

      const afterRelease = await store.claimPaymentEffect({
        ...base,
        leaseToken: contenderToken,
        now: "2026-10-04T10:00:20.000Z",
        leaseExpiresAt: "2026-10-04T10:01:20.000Z",
      });
      assert.equal(afterRelease.acquired, true);
      await database.query(
        `WITH db_clock AS MATERIALIZED (
           SELECT clock_timestamp() - interval '1 second' AS expired_at
         )
         UPDATE payment_effect_claims
         SET lease_expires_at = db_clock.expired_at,
             updated_at = db_clock.expired_at
         FROM db_clock
         WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3`,
        [userId, base.scope, base.key],
      );
      const takeover = await store.claimPaymentEffect({
        ...base,
        leaseToken: ownerToken,
        now: "2026-10-04T10:01:20.000Z",
        leaseExpiresAt: "2026-10-04T10:02:20.000Z",
      });
      assert.equal(takeover.acquired, true);
      assert.equal(await store.releasePaymentEffectClaim({
        userId,
        scope: base.scope,
        key: base.key,
        leaseToken: contenderToken,
        releasedAt: "2026-10-04T10:01:30.000Z",
      }), false);
      assert.equal(await store.releasePaymentEffectClaim({
        userId,
        scope: base.scope,
        key: base.key,
        leaseToken: ownerToken,
        releasedAt: "2026-10-04T10:01:30.000Z",
      }), true);

      const completedClaim = await store.claimPaymentEffect({
        ...base,
        leaseToken: ownerToken,
        now: "2026-10-04T10:02:00.000Z",
        leaseExpiresAt: "2026-10-04T10:03:00.000Z",
      });
      assert.equal(completedClaim.acquired, true);
      assert.equal(await store.completePaymentEffectClaim({
        userId,
        scope: base.scope,
        key: base.key,
        leaseToken: ownerToken,
      }), true);
      assert.equal((await database.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM payment_effect_claims WHERE user_id = $1",
        [userId],
      )).rows[0]?.count, 0);
      const slotFence = {
        ...base,
        key: "postgres-payment-slot-0001",
        leaseToken: tokenA,
      };
      assert.equal((await store.claimPaymentEffect({
        ...slotFence,
        now: "2099-10-04T10:00:00.000Z",
        leaseExpiresAt: "2099-10-04T11:00:00.000Z",
      })).acquired, true);

      const firstSlot = await store.reservePaymentOrderSlot({
        userId,
        orderId: "00000000-0000-4000-8000-000000000211",
        outTradeNo: "PDSLOT000000000000000000000001",
        now: "2099-10-04T10:00:00.000Z",
        expiresAt: "2099-10-04T10:10:00.000Z",
        effectFence: slotFence,
      });
      assert.equal(firstSlot.created, true);
      const sameSlot = await store.reservePaymentOrderSlot({
        userId,
        orderId: "00000000-0000-4000-8000-000000000211",
        outTradeNo: "PDSLOT000000000000000000000001",
        now: "2099-10-04T10:09:00.000Z",
        expiresAt: "2099-10-04T10:19:00.000Z",
        effectFence: slotFence,
      });
      assert.deepEqual(sameSlot, { ...firstSlot, created: false });
      await database.query(
        "UPDATE payment_order_slots SET expires_at = clock_timestamp() - interval '1 second' WHERE order_id = $1",
        ["00000000-0000-4000-8000-000000000211"],
      );
      const expiredSlot = await store.reservePaymentOrderSlot({
        userId,
        orderId: "00000000-0000-4000-8000-000000000211",
        outTradeNo: "PDSLOT000000000000000000000001",
        now: "2099-10-04T10:20:00.000Z",
        expiresAt: "2099-10-04T10:30:00.000Z",
        effectFence: slotFence,
      });
      assert.equal(expiredSlot.expired, true);
      assert.equal(expiredSlot.created, false);
      assert.notEqual(expiredSlot.expiresAt, "2099-10-04T10:30:00.000Z");
      assert.deepEqual(await store.reservePaymentOrderSlot({
        userId,
        orderId: "00000000-0000-4000-8000-000000000211",
        outTradeNo: "PDSLOT000000000000000000000001",
        now: "2099-10-04T10:21:00.000Z",
        expiresAt: "2099-10-04T10:31:00.000Z",
        effectFence: slotFence,
      }), expiredSlot);
      assert.equal(await store.completePaymentEffectClaim(slotFence), true);

      await database.query(
        `INSERT INTO payment_effect_claims(
           user_id, scope, idempotency_key, request_hash, lease_token,
           lease_expires_at, created_at, updated_at
         )
         SELECT $1, 'claim-cap', 'claim-key-' || series, $2, $3,
                clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp()
         FROM generate_series(1, $4::integer) AS series`,
        [userId, "c".repeat(64), tokenA, MAX_PAYMENT_EFFECT_CLAIMS_PER_USER],
      );
      await assert.rejects(store.claimPaymentEffect({
        userId,
        scope: "claim-cap",
        key: "overflow",
        requestHash: "d".repeat(64),
        leaseToken: tokenB,
        now: "2099-10-04T10:00:00.000Z",
        leaseExpiresAt: "2099-10-04T10:01:00.000Z",
      }), rejectsWithCode("PAYMENT_EFFECT_CLAIM_LIMIT_EXCEEDED"));
    } finally {
      await store.close();
    }
  });

  it("rejects every stale payment owner mutation and atomically commits order plus reconciliation job", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '支付 fence 用户')", [userId]);
      await database.query(
        "INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES ($1, 0, clock_timestamp())",
        [userId],
      );
      const base = {
        userId,
        scope: "payment-orders:create",
        key: "postgres-payment-fence-0001",
        requestHash: "9".repeat(64),
      };
      const staleFence = { ...base, leaseToken: "00000000-0000-4000-8000-000000000261" };
      const activeFence = { ...base, leaseToken: "00000000-0000-4000-8000-000000000262" };
      assert.equal((await store.claimPaymentEffect({
        ...staleFence,
        now: "2099-10-04T10:00:00.000Z",
        leaseExpiresAt: "2099-10-04T10:20:00.000Z",
      })).acquired, true);
      const orderId = "00000000-0000-4000-8000-000000000263";
      const firstTrade = "PDPGFENCE0000000000000000000001";
      const secondTrade = "PDPGFENCE0000000000000000000002";
      await store.reservePaymentOrderSlot({
        userId,
        orderId,
        outTradeNo: firstTrade,
        now: "2099-10-04T10:00:00.000Z",
        expiresAt: "2099-10-04T10:10:00.000Z",
        effectFence: staleFence,
      });
      await database.query(
        `UPDATE payment_effect_claims
         SET lease_expires_at = created_at, updated_at = created_at
         WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3`,
        [userId, base.scope, base.key],
      );
      assert.equal((await store.claimPaymentEffect({
        ...activeFence,
        now: "1900-01-01T00:00:00.000Z",
        leaseExpiresAt: "1900-01-01T00:20:00.000Z",
      })).acquired, true, "database clock, not caller absolute time, permits takeover");

      const capacityBeforeStaleReserve = (await database.query<{ slots: number; attempts: number }>(
        `SELECT
           (SELECT count(*)::integer FROM payment_order_slots WHERE user_id = $1) AS slots,
           (SELECT count(*)::integer FROM payment_order_attempts WHERE user_id = $1) AS attempts`,
        [userId],
      )).rows[0];
      await assert.rejects(store.reservePaymentOrderSlot({
        userId,
        orderId: "00000000-0000-4000-8000-000000000266",
        outTradeNo: "PDPGFENCE0000000000000000000099",
        now: "2099-10-04T10:00:01.000Z",
        expiresAt: "2099-10-04T10:10:01.000Z",
        effectFence: staleFence,
      }), rejectsWithCode("PAYMENT_EFFECT_LEASE_LOST"));
      assert.deepEqual((await database.query<{ slots: number; attempts: number }>(
        `SELECT
           (SELECT count(*)::integer FROM payment_order_slots WHERE user_id = $1) AS slots,
           (SELECT count(*)::integer FROM payment_order_attempts WHERE user_id = $1) AS attempts`,
        [userId],
      )).rows[0], capacityBeforeStaleReserve, "stale reserve cannot consume SQL capacity or append an attempt");

      await assert.rejects(store.beginPaymentOrderProviderAttempt({
        userId,
        orderId,
        outTradeNo: firstTrade,
        startedAt: "2099-10-04T10:00:01.000Z",
        effectFence: staleFence,
      }), rejectsWithCode("PAYMENT_EFFECT_LEASE_LOST"));
      await assert.rejects(store.recordPaymentOrderProviderResult({
        userId,
        orderId,
        outTradeNo: firstTrade,
        recoveryCiphertext: "PDP1.stale-provider-envelope",
        providerReferenceSha256: "8".repeat(64),
        recordedAt: "2099-10-04T10:00:02.000Z",
        effectFence: staleFence,
      }), rejectsWithCode("PAYMENT_EFFECT_LEASE_LOST"));
      await assert.rejects(store.rotatePaymentOrderProviderAttempt({
        userId,
        orderId,
        previousOutTradeNo: firstTrade,
        nextOutTradeNo: secondTrade,
        rotatedAt: "2099-10-04T10:00:03.000Z",
        expiresAt: "2099-10-04T10:10:03.000Z",
        effectFence: staleFence,
      }), rejectsWithCode("PAYMENT_EFFECT_LEASE_LOST"));
      await assert.rejects(store.releasePaymentOrderSlot({
        userId,
        orderId,
        effectFence: staleFence,
      }), rejectsWithCode("PAYMENT_EFFECT_LEASE_LOST"));
      let staleOperationRan = false;
      await assert.rejects(store.executePaymentEffectIdempotent(staleFence, async () => {
        staleOperationRan = true;
        return { statusCode: 201, body: { unexpected: true } };
      }), rejectsWithCode("PAYMENT_EFFECT_LEASE_LOST"));
      assert.equal(staleOperationRan, false);
      assert.equal((await database.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM payment_order_slots WHERE order_id = $1",
        [orderId],
      )).rows[0]?.count, 1, "stale release cannot delete the active owner's slot");

      await store.rotatePaymentOrderProviderAttempt({
        userId,
        orderId,
        previousOutTradeNo: firstTrade,
        nextOutTradeNo: secondTrade,
        rotatedAt: "2099-10-04T10:00:04.000Z",
        expiresAt: "2099-10-04T10:10:04.000Z",
        effectFence: activeFence,
      });
      await store.beginPaymentOrderProviderAttempt({
        userId,
        orderId,
        outTradeNo: secondTrade,
        startedAt: "2099-10-04T10:00:04.000Z",
        effectFence: activeFence,
      });
      const product = await store.getCreditProduct("ai-9", 1);
      assert.ok(product);
      const committed = await store.executePaymentEffectIdempotent(activeFence, async (transactionStore) => {
        const order = await transactionStore.createPaymentOrder({
          id: orderId,
          userId,
          product,
          outTradeNo: secondTrade,
          providerReference: `sha256:${"7".repeat(64)}`,
          paymentExpiresAt: "2099-10-04T10:10:00.000Z",
          now: "2099-10-04T10:00:05.000Z",
        });
        return { statusCode: 201, body: { orderId: order.id } };
      });
      assert.equal(committed.replayed, false);
      const persisted = await database.query<{ orders: number; jobs: number; claims: number; slots: number }>(
        `SELECT
           (SELECT count(*)::integer FROM payment_orders WHERE id = $1) AS orders,
           (SELECT count(*)::integer FROM payment_reconciliation_jobs WHERE order_id = $1) AS jobs,
           (SELECT count(*)::integer FROM payment_effect_claims WHERE user_id = $2) AS claims,
           (SELECT count(*)::integer FROM payment_order_slots WHERE order_id = $1) AS slots`,
        [orderId, userId],
      );
      assert.deepEqual(persisted.rows[0], { orders: 1, jobs: 1, claims: 0, slots: 0 });

      const lateOldAttempt = {
        orderId,
        observedOutTradeNo: firstTrade,
        eventKey: "notify:postgres-old-attempt-success",
        providerTransactionId: "wx-postgres-old-attempt-success",
        providerTradeState: "SUCCESS" as const,
        paidAt: "2099-10-04T10:05:00.000Z",
        observedAt: "2099-10-04T10:05:01.000Z",
        source: "wechat-notify" as const,
        notificationId: "EV-postgres-old-attempt-success",
        rawBodySha256: "e".repeat(64),
        wechatSerial: "PUB_KEY_ID_postgres_old_attempt",
      };
      assert.equal((await store.applyPaymentSuccess(lateOldAttempt)).credited, true);
      assert.equal((await store.applyPaymentSuccess(lateOldAttempt)).credited, false);
      const oldAttemptAudit = await database.query<{ out_trade_no: string; balance: number; ledger_count: number }>(
        `SELECT
           (SELECT out_trade_no FROM payment_events WHERE event_key = $1) AS out_trade_no,
           (SELECT balance FROM credit_accounts WHERE user_id = $2) AS balance,
           (SELECT count(*)::integer FROM credit_ledger
             WHERE user_id = $2 AND reason = 'payment_credit' AND reference_id = $3::text) AS ledger_count`,
        [lateOldAttempt.eventKey, userId, orderId],
      );
      assert.deepEqual(oldAttemptAudit.rows[0], {
        out_trade_no: firstTrade,
        balance: product.creditAmount,
        ledger_count: 1,
      });
      await assert.rejects(store.applyPaymentSuccess({
        ...lateOldAttempt,
        eventKey: "notify:postgres-forged-attempt-success",
        observedOutTradeNo: "PDPGFENCE0000000000000000000098",
        providerTransactionId: "wx-postgres-forged-attempt-success",
      }), rejectsWithCode("PAYMENT_OUT_TRADE_NO_MISMATCH"));

      const expiringOrderId = "00000000-0000-4000-8000-000000000264";
      const expiringFence = {
        userId,
        scope: "payment-orders:create",
        key: "postgres-payment-final-cas-0001",
        requestHash: "6".repeat(64),
        leaseToken: "00000000-0000-4000-8000-000000000265",
      };
      assert.equal((await store.claimPaymentEffect({
        ...expiringFence,
        now: "2099-10-04T10:00:00.000Z",
        leaseExpiresAt: "2099-10-04T10:00:00.100Z",
      })).acquired, true);
      await assert.rejects(store.executePaymentEffectIdempotent(expiringFence, async (transactionStore) => {
        await transactionStore.createPaymentOrder({
          id: expiringOrderId,
          userId,
          product,
          outTradeNo: "PDPGFINALCAS000000000000000001",
          providerReference: `sha256:${"5".repeat(64)}`,
          paymentExpiresAt: "2099-10-04T10:10:00.000Z",
          now: "2099-10-04T10:00:05.000Z",
        });
        await delay(150);
        return { statusCode: 201, body: { orderId: expiringOrderId } };
      }), rejectsWithCode("PAYMENT_EFFECT_LEASE_LOST"));
      const rolledBack = await database.query<{ orders: number; jobs: number; idempotency: number }>(
        `SELECT
           (SELECT count(*)::integer FROM payment_orders WHERE id = $1) AS orders,
           (SELECT count(*)::integer FROM payment_reconciliation_jobs WHERE order_id = $1) AS jobs,
           (SELECT count(*)::integer FROM api_idempotency
            WHERE user_id = $2 AND scope = $3 AND idempotency_key = $4) AS idempotency`,
        [expiringOrderId, userId, expiringFence.scope, expiringFence.key],
      );
      assert.deepEqual(rolledBack.rows[0], { orders: 0, jobs: 0, idempotency: 0 });
    } finally {
      await store.close();
    }
  });

  it("journals encrypted provider results and atomically rotates ambiguous attempts", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '支付恢复审计用户')", [userId]);
      const orderId = "00000000-0000-4000-8000-000000000291";
      const firstTrade = "PDRECOVERY000000000000000000001";
      const secondTrade = "PDRECOVERY000000000000000000002";
      const effectFence = {
        userId,
        scope: "payment-orders:create",
        key: "postgres-payment-recovery-0001",
        requestHash: "f".repeat(64),
        leaseToken: "00000000-0000-4000-8000-000000000292",
      };
      assert.equal((await store.claimPaymentEffect({
        ...effectFence,
        now: "2099-10-04T10:00:00.000Z",
        leaseExpiresAt: "2099-10-04T10:30:00.000Z",
      })).acquired, true);
      const reserved = await store.reservePaymentOrderSlot({
        userId,
        orderId,
        outTradeNo: firstTrade,
        now: "2099-10-04T10:00:00.000Z",
        expiresAt: "2099-10-04T10:10:00.000Z",
        effectFence,
      });
      assert.equal(reserved.state, "reserved");
      const creating = await store.beginPaymentOrderProviderAttempt({
        userId,
        orderId,
        outTradeNo: firstTrade,
        startedAt: "2099-10-04T10:00:01.000Z",
        effectFence,
      });
      assert.equal(creating.state, "creating");
      const recoveryCiphertext = "PDP1.encrypted-envelope-without-prepay-id";
      const providerReferenceSha256 = "e".repeat(64);
      const recorded = await store.recordPaymentOrderProviderResult({
        userId,
        orderId,
        outTradeNo: firstTrade,
        recoveryCiphertext,
        providerReferenceSha256,
        recordedAt: "2099-10-04T10:00:02.000Z",
        effectFence,
      });
      assert.equal(recorded.state, "created");
      const persisted = await database.query<{
        state: string;
        recovery_ciphertext: string;
        provider_reference_sha256: string;
      }>(
        `SELECT state, recovery_ciphertext, provider_reference_sha256
         FROM payment_order_attempts WHERE order_id = $1`,
        [orderId],
      );
      assert.deepEqual(persisted.rows, [{
        state: "created",
        recovery_ciphertext: recoveryCiphertext,
        provider_reference_sha256: providerReferenceSha256,
      }]);
      assert.equal(JSON.stringify(persisted.rows).includes("prepay_id="), false);

      const rotated = await store.rotatePaymentOrderProviderAttempt({
        userId,
        orderId,
        previousOutTradeNo: firstTrade,
        nextOutTradeNo: secondTrade,
        rotatedAt: "2099-10-04T10:01:00.000Z",
        expiresAt: "2099-10-04T10:11:00.000Z",
        effectFence,
      });
      assert.equal(rotated.attemptNo, 2);
      assert.equal(rotated.outTradeNo, secondTrade);
      assert.equal(rotated.state, "reserved");
      const audit = await database.query<{ attempt_no: number; out_trade_no: string; state: string }>(
        `SELECT attempt_no, out_trade_no, state
         FROM payment_order_attempts WHERE order_id = $1 ORDER BY attempt_no`,
        [orderId],
      );
      assert.deepEqual(audit.rows, [
        { attempt_no: 1, out_trade_no: firstTrade, state: "closed" },
        { attempt_no: 2, out_trade_no: secondTrade, state: "reserved" },
      ]);
      await assert.rejects(
        database.query("UPDATE payment_order_attempts SET out_trade_no = 'PD-TAMPER' WHERE order_id = $1", [orderId]),
      );
    } finally {
      await store.close();
    }
  });

  it("claims one reconciliation owner and takes over an expired lease using the database clock", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const reconciliationUserId = "00000000-0000-4000-8000-000000000150";
    const reconciliationOrderId = "00000000-0000-4000-8000-000000000151";
    try {
      await applyMigrations(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '对账租约用户')", [reconciliationUserId]);
      await database.query(
        "INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES ($1, 0, clock_timestamp())",
        [reconciliationUserId],
      );
      const product = await store.getCreditProduct("ai-9", 1);
      assert.ok(product);
      await store.createPaymentOrder({
        id: reconciliationOrderId,
        userId: reconciliationUserId,
        product,
        outTradeNo: "PD202610040000000000000151",
        providerReference: "redacted:reconciliation",
        paymentExpiresAt: "2099-10-04T10:30:00.000Z",
        now: "2026-10-04T10:00:00.000Z",
      });
      await database.query(
        "UPDATE payment_reconciliation_jobs SET available_at = clock_timestamp() WHERE order_id = $1",
        [reconciliationOrderId],
      );

      const [first, concurrent] = await Promise.all([
        store.claimNextPaymentReconciliation({
          leaseToken: "00000000-0000-4000-8000-000000000152",
          leaseMilliseconds: 100,
          now: "2099-01-01T00:00:00.000Z",
        }),
        store.claimNextPaymentReconciliation({
          leaseToken: "00000000-0000-4000-8000-000000000153",
          leaseMilliseconds: 100,
          now: "1900-01-01T00:00:00.000Z",
        }),
      ]);
      assert.equal(first?.order.id, reconciliationOrderId);
      assert.equal(first?.job.attemptCount, 1);
      assert.equal(concurrent, null, "concurrent callers and caller clock must not steal a live database lease");

      await delay(140);
      const takeover = await store.claimNextPaymentReconciliation({
        leaseToken: "00000000-0000-4000-8000-000000000154",
        leaseMilliseconds: 1_000,
        now: "1900-01-01T00:00:00.000Z",
      });
      assert.equal(takeover?.order.id, reconciliationOrderId);
      assert.equal(takeover?.job.attemptCount, 2);
      await assert.rejects(
        store.applyPaymentObservation({
          orderId: reconciliationOrderId,
          userId: reconciliationUserId,
          providerTradeState: "NOTPAY",
          observedAt: new Date().toISOString(),
          reconciliationLeaseToken: "00000000-0000-4000-8000-000000000152",
          nextReconciliationDelayMilliseconds: 1_000,
        }),
        rejectsWithCode("PAYMENT_RECONCILIATION_LEASE_LOST"),
      );
      const pending = await store.applyPaymentObservation({
        orderId: reconciliationOrderId,
        userId: reconciliationUserId,
        providerTradeState: "NOTPAY",
        observedAt: new Date().toISOString(),
        reconciliationLeaseToken: "00000000-0000-4000-8000-000000000154",
        nextReconciliationDelayMilliseconds: 1_000,
      });
      assert.equal(pending.status, "pending");
      assert.deepEqual(
        { state: (await store.getPaymentReconciliationJob(reconciliationOrderId))?.state,
          attemptCount: (await store.getPaymentReconciliationJob(reconciliationOrderId))?.attemptCount },
        { state: "scheduled", attemptCount: 2 },
      );
    } finally {
      await store.close();
    }
  });

  it("repairs only a bounded batch of legacy pending orders before claiming", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const legacyUserId = "00000000-0000-4000-8000-000000000155";
    try {
      await applyMigrations(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '旧版支付写入用户')", [legacyUserId]);
      await database.query(
        `INSERT INTO payment_orders(
           id, user_id, product_id, product_version, product_name,
           credit_amount, amount_cents, currency, out_trade_no, status,
           provider_reference, provider_trade_state, payment_expires_at, created_at, updated_at
         )
         SELECT
           ('00000000-0000-4000-8000-' || lpad((990000 + sequence)::text, 12, '0'))::uuid,
           $1, 'ai-5', 1, '5 次', 5, 600, 'CNY',
           'PD' || lpad((990000 + sequence)::text, 30, '0'),
           'pending', 'redacted:legacy:' || sequence::text, 'NOTPAY',
           clock_timestamp() + interval '10 minutes',
           clock_timestamp() + sequence * interval '1 millisecond',
           clock_timestamp() + sequence * interval '1 millisecond'
         FROM generate_series(1, 101) AS sequence`,
        [legacyUserId],
      );

      const scanIndex = await database.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE indexname = 'payment_orders_pending_reconciliation_scan_idx'`,
      );
      assert.match(scanIndex.rows[0]?.indexdef ?? "", /\(created_at, id\)/i);
      assert.match(scanIndex.rows[0]?.indexdef ?? "", /WHERE.*status.*pending/i);

      const first = await store.claimNextPaymentReconciliation({
        leaseToken: "00000000-0000-4000-8000-000000000156",
        leaseMilliseconds: 60_000,
        now: "2099-01-01T00:00:00.000Z",
      });
      assert.equal(first?.order.id, "00000000-0000-4000-8000-000000990001");
      const firstRepair = await database.query<{ jobs: number; orphans: number }>(
        `SELECT
           (SELECT count(*)::integer FROM payment_reconciliation_jobs) AS jobs,
           (SELECT count(*)::integer
              FROM payment_orders AS payment_order
              LEFT JOIN payment_reconciliation_jobs AS job ON job.order_id = payment_order.id
             WHERE payment_order.status = 'pending' AND job.order_id IS NULL) AS orphans`,
      );
      assert.deepEqual(firstRepair.rows[0], { jobs: 100, orphans: 1 });

      const second = await store.claimNextPaymentReconciliation({
        leaseToken: "00000000-0000-4000-8000-000000000157",
        leaseMilliseconds: 60_000,
        now: "1900-01-01T00:00:00.000Z",
      });
      assert.equal(second?.order.id, "00000000-0000-4000-8000-000000990002");
      const fullyRepaired = await database.query<{ jobs: number; orphans: number }>(
        `SELECT
           (SELECT count(*)::integer FROM payment_reconciliation_jobs) AS jobs,
           (SELECT count(*)::integer
              FROM payment_orders AS payment_order
              LEFT JOIN payment_reconciliation_jobs AS job ON job.order_id = payment_order.id
             WHERE payment_order.status = 'pending' AND job.order_id IS NULL) AS orphans`,
      );
      assert.deepEqual(fullyRepaired.rows[0], { jobs: 101, orphans: 0 });
    } finally {
      await store.close();
    }
  });

  it("migrates unfinished terminal jobs and installs the bounded convergence index", async () => {
    const database = new PGlite();
    const migrationUserId = "00000000-0000-4000-8000-000000000165";
    const migrationOrderId = "00000000-0000-4000-8000-000000000166";
    try {
      for (const migrationPath of migrationPaths.slice(0, -1)) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '终态迁移用户')", [migrationUserId]);
      await database.query(
        `INSERT INTO payment_orders(
           id, user_id, product_id, product_version, product_name,
           credit_amount, amount_cents, currency, out_trade_no, status,
           provider_reference, provider_trade_state, provider_transaction_id,
           payment_expires_at, paid_at, created_at, updated_at
         ) VALUES (
           $1, $2, 'ai-5', 1, '5 次', 5, 600, 'CNY',
           'PD202610040000000000000166', 'succeeded', 'redacted:migration-terminal',
           'SUCCESS', 'migration-terminal-transaction', clock_timestamp(),
           clock_timestamp(), clock_timestamp(), clock_timestamp()
         )`,
        [migrationOrderId, migrationUserId],
      );
      await database.query(
        `INSERT INTO payment_reconciliation_jobs(
           order_id, state, available_at, attempt_count, created_at, updated_at
         ) VALUES ($1, 'scheduled', clock_timestamp(), 0, clock_timestamp(), clock_timestamp())`,
        [migrationOrderId],
      );

      const migration0039 = migrationPaths.at(-1);
      assert.ok(migration0039);
      await database.exec(await readFile(migration0039, "utf8"));

      const migrated = await database.query<{
        state: string;
        last_observed_trade_state: string | null;
        completed_at: Date | string | null;
      }>(
        `SELECT state, last_observed_trade_state, completed_at
         FROM payment_reconciliation_jobs WHERE order_id = $1`,
        [migrationOrderId],
      );
      assert.equal(migrated.rows[0]?.state, "completed");
      assert.equal(migrated.rows[0]?.last_observed_trade_state, "SUCCESS");
      assert.ok(migrated.rows[0]?.completed_at);
      const scanIndex = await database.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE indexname = 'payment_reconciliation_jobs_unfinished_scan_idx'`,
      );
      assert.match(scanIndex.rows[0]?.indexdef ?? "", /\(updated_at, order_id\)/i);
      assert.match(scanIndex.rows[0]?.indexdef ?? "", /WHERE.*state.*completed/i);
    } finally {
      await database.close();
    }
  });

  it("converges only a bounded batch of terminal jobs before each claim", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const legacyUserId = "00000000-0000-4000-8000-000000000167";
    try {
      await applyMigrations(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '旧版终态批量用户')", [legacyUserId]);
      await database.query(
        `INSERT INTO payment_orders(
           id, user_id, product_id, product_version, product_name,
           credit_amount, amount_cents, currency, out_trade_no, status,
           provider_reference, provider_trade_state, provider_transaction_id,
           payment_expires_at, paid_at, created_at, updated_at
         )
         SELECT
           ('00000000-0000-4000-8000-' || lpad((980000 + sequence)::text, 12, '0'))::uuid,
           $1, 'ai-5', 1, '5 次', 5, 600, 'CNY',
           'PD' || lpad((980000 + sequence)::text, 30, '0'),
           'succeeded', 'redacted:legacy-terminal:' || sequence::text, 'SUCCESS',
           'legacy-terminal-transaction-' || sequence::text,
           clock_timestamp(), clock_timestamp(),
           clock_timestamp() + sequence * interval '1 millisecond',
           clock_timestamp() + sequence * interval '1 millisecond'
         FROM generate_series(1, 101) AS sequence`,
        [legacyUserId],
      );
      await database.query(
        `INSERT INTO payment_reconciliation_jobs(
           order_id, state, available_at, attempt_count, created_at, updated_at
         )
         SELECT id, 'scheduled', clock_timestamp(), 0, created_at, created_at
         FROM payment_orders WHERE user_id = $1`,
        [legacyUserId],
      );

      assert.equal(await store.claimNextPaymentReconciliation({
        leaseToken: "00000000-0000-4000-8000-000000000168",
        leaseMilliseconds: 60_000,
      }), null);
      const firstPass = await database.query<{ unfinished: number }>(
        `SELECT count(*)::integer AS unfinished
         FROM payment_reconciliation_jobs AS job
         JOIN payment_orders AS payment_order ON payment_order.id = job.order_id
         WHERE payment_order.user_id = $1 AND job.state <> 'completed'`,
        [legacyUserId],
      );
      assert.equal(firstPass.rows[0]?.unfinished, 1);

      assert.equal(await store.claimNextPaymentReconciliation({
        leaseToken: "00000000-0000-4000-8000-000000000169",
        leaseMilliseconds: 60_000,
      }), null);
      const secondPass = await database.query<{ unfinished: number }>(
        `SELECT count(*)::integer AS unfinished
         FROM payment_reconciliation_jobs AS job
         JOIN payment_orders AS payment_order ON payment_order.id = job.order_id
         WHERE payment_order.user_id = $1 AND job.state <> 'completed'`,
        [legacyUserId],
      );
      assert.equal(secondPass.rows[0]?.unfinished, 0);
    } finally {
      await store.close();
    }
  });

  it("self-heals a legacy orphan without deadlocking a concurrent success callback", { timeout: 10_000 }, async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const legacyUserId = "00000000-0000-4000-8000-000000000158";
    const legacyOrderId = "00000000-0000-4000-8000-000000000159";
    try {
      await applyMigrations(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '旧版回调竞态用户')", [legacyUserId]);
      await database.query(
        "INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES ($1, 0, clock_timestamp())",
        [legacyUserId],
      );
      await database.query(
        `INSERT INTO payment_orders(
           id, user_id, product_id, product_version, product_name,
           credit_amount, amount_cents, currency, out_trade_no, status,
           provider_reference, provider_trade_state, payment_expires_at, created_at, updated_at
         ) VALUES (
           $1, $2, 'ai-5', 1, '5 次', 5, 600, 'CNY',
           'PD202610040000000000000159', 'pending', 'redacted:legacy-race', 'NOTPAY',
           clock_timestamp() + interval '10 minutes', clock_timestamp(), clock_timestamp()
         )`,
        [legacyOrderId, legacyUserId],
      );

      const [claim, success] = await Promise.all([
        store.claimNextPaymentReconciliation({
          leaseToken: "00000000-0000-4000-8000-000000000160",
          leaseMilliseconds: 60_000,
        }),
        store.applyPaymentSuccess({
          orderId: legacyOrderId,
          observedOutTradeNo: "PD202610040000000000000159",
          eventKey: "query:legacy-race-transaction:SUCCESS",
          providerTransactionId: "legacy-race-transaction",
          providerTradeState: "SUCCESS",
          paidAt: "2026-10-05T12:00:00.000Z",
          observedAt: "2026-10-05T12:00:01.000Z",
          source: "wechat-query",
        }),
      ]);

      assert.equal(claim?.order.id, legacyOrderId);
      assert.equal(success.credited, true);
      assert.equal(success.order.status, "succeeded");
      assert.equal((await store.getPaymentReconciliationJob(legacyOrderId))?.state, "completed");
      assert.equal((await store.getCreditAccount(legacyUserId))?.balance, 5);
      const persisted = await database.query<{ ledger: number; events: number; outbox: number }>(
        `SELECT
           (SELECT count(*)::integer FROM credit_ledger
             WHERE user_id = $1 AND reason = 'payment_credit' AND reference_id = $2::uuid::text) AS ledger,
           (SELECT count(*)::integer FROM payment_events WHERE order_id = $2::uuid) AS events,
           (SELECT count(*)::integer FROM outbox_events
             WHERE aggregate_id = $2::uuid AND topic = 'payment.succeeded') AS outbox`,
        [legacyUserId, legacyOrderId],
      );
      assert.deepEqual(persisted.rows[0], { ledger: 1, events: 1, outbox: 1 });
      assert.equal(await store.claimNextPaymentReconciliation({
        leaseToken: "00000000-0000-4000-8000-000000000161",
        leaseMilliseconds: 60_000,
      }), null);
    } finally {
      await store.close();
    }
  });

  it("converges a repaired job when its order becomes terminal after the scan snapshot", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const legacyUserId = "00000000-0000-4000-8000-000000000162";
    const legacyOrderId = "00000000-0000-4000-8000-000000000163";
    try {
      await applyMigrations(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '旧快照收敛用户')", [legacyUserId]);
      await database.query(
        `INSERT INTO payment_orders(
           id, user_id, product_id, product_version, product_name,
           credit_amount, amount_cents, currency, out_trade_no, status,
           provider_reference, provider_trade_state,
           payment_expires_at, created_at, updated_at
         ) VALUES (
           $1, $2, 'ai-5', 1, '5 次', 5, 600, 'CNY',
           'PD202610040000000000000163', 'pending', 'redacted:stale-repair', 'NOTPAY',
           clock_timestamp() + interval '10 minutes', clock_timestamp(), clock_timestamp()
         )`,
        [legacyOrderId, legacyUserId],
      );
      // Deterministically model the real PostgreSQL interleaving where the
      // repair SELECT sees pending, its FK check waits, and a callback commits
      // SUCCESS before the INSERT resumes. The trigger moves the order between
      // the INSERT source snapshot and the following fresh cleanup snapshot.
      await database.exec(`
        CREATE FUNCTION test_terminalize_repaired_payment() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.order_id = '${legacyOrderId}'::uuid THEN
            UPDATE payment_orders
            SET status = 'succeeded', provider_trade_state = 'SUCCESS',
                provider_transaction_id = 'stale-repair-transaction',
                paid_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE id = NEW.order_id;
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER test_terminalize_repaired_payment_before_insert
        BEFORE INSERT ON payment_reconciliation_jobs
        FOR EACH ROW EXECUTE FUNCTION test_terminalize_repaired_payment();
      `);

      const claim = await store.claimNextPaymentReconciliation({
        leaseToken: "00000000-0000-4000-8000-000000000164",
        leaseMilliseconds: 60_000,
      });
      assert.equal(claim, null);
      const converged = await store.getPaymentReconciliationJob(legacyOrderId);
      assert.equal(converged?.state, "completed");
      assert.equal(converged?.lastObservedTradeState, "SUCCESS");
      assert.ok(converged?.completedAt);
    } finally {
      await store.close();
    }
  });

  it("converges a job terminalized late by a pre-0037 writer", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const legacyUserId = "00000000-0000-4000-8000-000000000170";
    const legacyOrderId = "00000000-0000-4000-8000-000000000171";
    try {
      await applyMigrations(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '旧版迟到终态用户')", [legacyUserId]);
      const product = await store.getCreditProduct("ai-9", 1);
      assert.ok(product);
      await store.createPaymentOrder({
        id: legacyOrderId,
        userId: legacyUserId,
        product,
        outTradeNo: "PD202610040000000000000171",
        providerReference: "redacted:late-terminal",
        paymentExpiresAt: "2099-10-04T10:30:00.000Z",
        now: "2026-10-04T10:00:00.000Z",
      });
      await database.query(
        "UPDATE payment_reconciliation_jobs SET available_at = clock_timestamp() WHERE order_id = $1",
        [legacyOrderId],
      );
      const claimed = await store.claimNextPaymentReconciliation({
        leaseToken: "00000000-0000-4000-8000-000000000172",
        leaseMilliseconds: 60_000,
      });
      assert.equal(claimed?.order.id, legacyOrderId);

      // Model an old writer: it commits the terminal order but knows nothing
      // about payment_reconciliation_jobs.
      await database.query(
        `UPDATE payment_orders
         SET status = 'succeeded', provider_trade_state = 'SUCCESS',
             provider_transaction_id = 'late-terminal-transaction',
             paid_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [legacyOrderId],
      );
      assert.equal((await store.getPaymentReconciliationJob(legacyOrderId))?.state, "running");

      assert.equal(await store.claimNextPaymentReconciliation({
        leaseToken: "00000000-0000-4000-8000-000000000173",
        leaseMilliseconds: 60_000,
      }), null);
      const converged = await store.getPaymentReconciliationJob(legacyOrderId);
      assert.equal(converged?.state, "completed");
      assert.equal(converged?.lastObservedTradeState, "SUCCESS");
      assert.ok(converged?.completedAt);
    } finally {
      await store.close();
    }
  });

  it("credits one order exactly once across callback replay and equivalent events", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      await database.query(
        `INSERT INTO users(id, display_name) VALUES ($1, '支付测试用户')`,
        [userId],
      );
      await database.query(
        `INSERT INTO sessions(token_hash, user_id, expires_at)
         VALUES ($1, $2, $3)`,
        ["b".repeat(64), userId, "2027-10-04T00:00:00.000Z"],
      );
      await database.query(
        `INSERT INTO credit_accounts(user_id, balance, updated_at)
         VALUES ($1, 7, $2)`,
        [userId, "2026-10-04T09:00:00.000Z"],
      );

      const products = await store.listCreditProducts();
      assert.deepEqual(
        products.map(({ id, version, creditAmount, amountCents, currency, enabled }) => ({
          id,
          version,
          creditAmount,
          amountCents,
          currency,
          enabled,
        })),
        [
          { id: "ai-9", version: 1, creditAmount: 9, amountCents: 390, currency: "CNY", enabled: true },
          { id: "ai-49", version: 1, creditAmount: 49, amountCents: 1990, currency: "CNY", enabled: true },
          { id: "ai-99", version: 1, creditAmount: 99, amountCents: 3990, currency: "CNY", enabled: true },
          { id: "ai-lifetime", version: 1, creditAmount: 999999, amountCents: 19900, currency: "CNY", enabled: true },
        ],
      );
      const product = await store.getCreditProduct("ai-9", 1);
      assert.ok(product);
      assert.equal(await store.getCreditProduct("ai-5", 99), null);

      const orderCreatedAt = "2026-10-04T10:00:00.000Z";
      const firstOrder = await store.createPaymentOrder({
        id: firstOrderId,
        userId,
        product,
        outTradeNo: "PD202610040000000000000001",
        providerReference: "fake-prepay-first",
        paymentExpiresAt: "2026-10-04T10:30:00.000Z",
        now: orderCreatedAt,
      });
      assert.deepEqual(
        {
          id: firstOrder.id,
          userId: firstOrder.userId,
          productId: firstOrder.productId,
          productVersion: firstOrder.productVersion,
          productName: firstOrder.productName,
          creditAmount: firstOrder.creditAmount,
          amountCents: firstOrder.amountCents,
          currency: firstOrder.currency,
          outTradeNo: firstOrder.outTradeNo,
          status: firstOrder.status,
          providerReference: firstOrder.providerReference,
          providerTradeState: firstOrder.providerTradeState,
          providerTransactionId: firstOrder.providerTransactionId,
        },
        {
          id: firstOrderId,
          userId,
          productId: "ai-9",
          productVersion: 1,
          productName: "9 次",
          creditAmount: 9,
          amountCents: 390,
          currency: "CNY",
          outTradeNo: "PD202610040000000000000001",
          status: "pending",
          providerReference: "fake-prepay-first",
          providerTradeState: "NOTPAY",
          providerTransactionId: null,
        },
      );
      assert.deepEqual(await store.getPaymentOrder(userId, firstOrderId), firstOrder);

      const paidAt = "2026-10-04T10:01:00.000Z";
      const firstEvent = {
        orderId: firstOrderId,
        observedOutTradeNo: firstOrder.outTradeNo,
        eventKey: "fake-notify:wx-transaction-20261004-0001",
        providerTransactionId,
        providerTradeState: "SUCCESS" as const,
        paidAt,
        observedAt: "2026-10-04T10:01:01.000Z",
        source: "fake" as const,
      };
      const credited = await store.applyPaymentSuccess(firstEvent);
      assert.equal(credited.credited, true);
      assert.equal(credited.account.balance, 16);
      assert.equal(credited.order.status, "succeeded");
      assert.equal(credited.order.providerTransactionId, providerTransactionId);
      assert.equal(credited.order.paidAt, paidAt);

      const sameEventReplay = await store.applyPaymentSuccess(firstEvent);
      assert.equal(sameEventReplay.credited, false);
      assert.equal(sameEventReplay.account.balance, 16);

      const equivalentEvent = await store.applyPaymentSuccess({
        ...firstEvent,
        eventKey: "fake-query:wx-transaction-20261004-0001",
        observedAt: "2026-10-04T10:02:00.000Z",
        source: "wechat-query" as const,
      });
      assert.equal(equivalentEvent.credited, false);
      assert.equal(equivalentEvent.account.balance, 16);
      assert.equal(equivalentEvent.order.providerTransactionId, providerTransactionId);

      const notificationEvent = await store.applyPaymentSuccess({
        ...firstEvent,
        eventKey: "notify:EV-20261004-0001",
        observedAt: "2026-10-04T10:02:30.000Z",
        source: "wechat-notify" as const,
        notificationId: "EV-20261004-0001",
        rawBodySha256: "e".repeat(64),
        wechatSerial: "PUB_KEY_ID_3000000001",
      });
      assert.equal(notificationEvent.credited, false);
      assert.equal(notificationEvent.account.balance, 16);

      const persisted = await database.query<{
        balance: number;
        ledger_count: number;
        ledger_delta: number;
        event_count: number;
        outbox_count: number;
        order_count: number;
      }>(
        `SELECT
           (SELECT balance FROM credit_accounts WHERE user_id = $1) AS balance,
           (SELECT count(*)::integer FROM credit_ledger
              WHERE user_id = $1 AND reason = 'payment_credit' AND reference_id = $2::text) AS ledger_count,
           (SELECT coalesce(sum(delta), 0)::integer FROM credit_ledger
              WHERE user_id = $1 AND reason = 'payment_credit' AND reference_id = $2::text) AS ledger_delta,
           (SELECT count(*)::integer FROM payment_events WHERE order_id = $2::uuid) AS event_count,
           (SELECT count(*)::integer FROM outbox_events
              WHERE aggregate_id = $2::uuid AND topic = 'payment.succeeded') AS outbox_count,
           (SELECT count(*)::integer FROM payment_orders WHERE id = $2::uuid AND status = 'succeeded') AS order_count`,
        [userId, firstOrderId],
      );
      assert.deepEqual(persisted.rows[0], {
        balance: 16,
        ledger_count: 1,
        ledger_delta: 9,
        event_count: 3,
        outbox_count: 1,
        order_count: 1,
      });

      const events = await database.query<{
        event_key: string;
        provider_transaction_id: string;
        source: string;
        notification_id: string | null;
        raw_body_sha256: string | null;
        wechat_serial: string | null;
      }>(
        `SELECT event_key, provider_transaction_id, source,
                notification_id, raw_body_sha256, wechat_serial
         FROM payment_events WHERE order_id = $1 ORDER BY event_key`,
        [firstOrderId],
      );
      assert.deepEqual(events.rows, [
        {
          event_key: "fake-notify:wx-transaction-20261004-0001",
          provider_transaction_id: providerTransactionId,
          source: "fake",
          notification_id: null,
          raw_body_sha256: null,
          wechat_serial: null,
        },
        {
          event_key: "fake-query:wx-transaction-20261004-0001",
          provider_transaction_id: providerTransactionId,
          source: "wechat-query",
          notification_id: null,
          raw_body_sha256: null,
          wechat_serial: null,
        },
        {
          event_key: "notify:EV-20261004-0001",
          provider_transaction_id: providerTransactionId,
          source: "wechat-notify",
          notification_id: "EV-20261004-0001",
          raw_body_sha256: "e".repeat(64),
          wechat_serial: "PUB_KEY_ID_3000000001",
        },
      ]);

      const outbox = await database.query<{ payload: { orderId: string; userId: string } }>(
        `SELECT payload FROM outbox_events
         WHERE aggregate_id = $1 AND topic = 'payment.succeeded'`,
        [firstOrderId],
      );
      assert.deepEqual(outbox.rows, [{ payload: { orderId: firstOrderId, userId } }]);

      const secondOrder = await store.createPaymentOrder({
        id: secondOrderId,
        userId,
        product,
        outTradeNo: "PD202610040000000000000002",
        providerReference: "fake-prepay-second",
        paymentExpiresAt: "2026-10-04T10:35:00.000Z",
        now: "2026-10-04T10:05:00.000Z",
      });
      assert.equal(secondOrder.status, "pending");

      await assert.rejects(
        store.applyPaymentSuccess({
          orderId: secondOrderId,
          observedOutTradeNo: secondOrder.outTradeNo,
          eventKey: "fake-notify:conflicting-order",
          providerTransactionId,
          providerTradeState: "SUCCESS",
          paidAt: "2026-10-04T10:06:00.000Z",
          observedAt: "2026-10-04T10:06:01.000Z",
          source: "fake",
        }),
        rejectsWithCode("PAYMENT_TRANSACTION_CONFLICT"),
      );
      await assert.rejects(
        store.applyPaymentSuccess({
          ...firstEvent,
          eventKey: "fake-notify:different-transaction",
          providerTransactionId: "wx-transaction-20261004-conflict",
        }),
        rejectsWithCode("PAYMENT_TRANSACTION_CONFLICT"),
      );

      const unchanged = await database.query<{
        balance: number;
        ledger_count: number;
        event_count: number;
        outbox_count: number;
        second_status: string;
      }>(
        `SELECT
           (SELECT balance FROM credit_accounts WHERE user_id = $1) AS balance,
           (SELECT count(*)::integer FROM credit_ledger WHERE reason = 'payment_credit') AS ledger_count,
           (SELECT count(*)::integer FROM payment_events) AS event_count,
           (SELECT count(*)::integer FROM outbox_events WHERE topic = 'payment.succeeded') AS outbox_count,
           (SELECT status FROM payment_orders WHERE id = $2) AS second_status`,
        [userId, secondOrderId],
      );
      assert.deepEqual(unchanged.rows[0], {
        balance: 16,
        ledger_count: 1,
        event_count: 3,
        outbox_count: 1,
        second_status: "pending",
      });

      await store.createPaymentOrder({
        id: closedOrderId,
        userId,
        product,
        outTradeNo: "PD202610040000000000000003",
        providerReference: "fake-prepay-closed",
        paymentExpiresAt: "2026-10-04T10:40:00.000Z",
        now: "2026-10-04T10:10:00.000Z",
      });
      const closed = await store.applyPaymentObservation({
        orderId: closedOrderId,
        userId,
        providerTradeState: "CLOSED",
        observedAt: "2026-10-04T10:11:00.000Z",
      });
      assert.equal(closed.status, "closed");
      assert.equal(closed.providerTradeState, "CLOSED");
      const closedReplay = await store.applyPaymentObservation({
        orderId: closedOrderId,
        userId,
        providerTradeState: "NOTPAY",
        observedAt: "2026-10-04T10:12:00.000Z",
      });
      assert.equal(closedReplay.status, "closed");
      assert.equal(closedReplay.providerTradeState, "CLOSED");
      const lateSuccessInput = {
        orderId: closedOrderId,
        observedOutTradeNo: "PD202610040000000000000003",
        eventKey: "fake-notify:closed-order",
        providerTransactionId: "wx-transaction-closed-order",
        providerTradeState: "SUCCESS" as const,
        paidAt: "2026-10-04T10:13:00.000Z",
        observedAt: "2026-10-04T10:13:01.000Z",
        source: "fake" as const,
      };
      const lateSuccess = await store.applyPaymentSuccess(lateSuccessInput);
      assert.equal(lateSuccess.credited, true);
      assert.equal(lateSuccess.order.status, "succeeded");
      assert.equal(lateSuccess.order.closedAt, "2026-10-04T10:11:00.000Z");
      assert.equal(lateSuccess.order.lateSuccessAt, "2026-10-04T10:13:01.000Z");
      assert.equal((await store.applyPaymentSuccess(lateSuccessInput)).credited, false);
      const afterClosure = await database.query<{
        balance: number;
        ledger_count: number;
        event_count: number;
        outbox_count: number;
        late_payload: { orderId: string; userId: string; lateAfterClose: boolean };
        reconcile_state: string;
      }>(
        `SELECT
           (SELECT balance FROM credit_accounts WHERE user_id = $1) AS balance,
           (SELECT count(*)::integer FROM credit_ledger WHERE reason = 'payment_credit') AS ledger_count,
           (SELECT count(*)::integer FROM payment_events) AS event_count,
           (SELECT count(*)::integer FROM outbox_events WHERE topic = 'payment.succeeded') AS outbox_count,
           (SELECT payload FROM outbox_events WHERE aggregate_id = $2 AND topic = 'payment.succeeded') AS late_payload,
           (SELECT state FROM payment_reconciliation_jobs WHERE order_id = $2) AS reconcile_state`,
        [userId, closedOrderId],
      );
      assert.deepEqual(afterClosure.rows[0], {
        balance: 25,
        ledger_count: 2,
        event_count: 4,
        outbox_count: 2,
        late_payload: { orderId: closedOrderId, userId, lateAfterClose: true },
        reconcile_state: "completed",
      });
    } finally {
      await store.close();
    }
  });
});
