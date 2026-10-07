import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";

import pg from "pg";

import { copyDefaultGenerationOptions } from "../src/domain/generation-options.js";
import { AppError } from "../src/errors.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";
import {
  assertRealPostgresTestDatabaseIsIsolated,
  loadRealPostgresTestConfig,
} from "./support/real-postgres-config.js";

const { Pool } = pg;
const realPostgres = loadRealPostgresTestConfig(process.env, [
  "PINDOU_REQUIRE_REAL_POSTGRES_RELEASE",
  "PINDOU_REQUIRE_REAL_POSTGRES_LOCK_ORDER",
]);

function settledFailure(result: PromiseSettledResult<unknown>): string {
  if (result.status === "fulfilled") return "fulfilled";
  const reason = result.reason as { code?: unknown; message?: unknown };
  return `${String(reason?.code ?? "unknown")}: ${String(reason?.message ?? reason)}`;
}

async function waitForAssetTriggerSleep(pool: pg.Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const sleeping = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE application_name = $1 AND state = 'active'
         AND wait_event_type = 'Timeout' AND wait_event = 'PgSleep'`,
      [applicationName],
    );
    if (sleeping.rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("asset update never reached the PostgreSQL trigger barrier");
}

async function waitForLockWaiters(
  pool: pg.Pool,
  applicationName: string,
  minimumCount: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ waiter_count: number }>(
      `SELECT count(*)::integer AS waiter_count
       FROM pg_stat_activity
       WHERE application_name = $1 AND state = 'active' AND wait_event_type = 'Lock'`,
      [applicationName],
    );
    if ((waiting.rows[0]?.waiter_count ?? 0) >= minimumCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`expected at least ${minimumCount} PostgreSQL lock waiters`);
}

it(
  "serializes project, asset, generation, and payment repair writes without PostgreSQL deadlocks",
  { skip: realPostgres.enabled ? false : realPostgres.skipReason },
  async () => {
    if (!realPostgres.enabled) return;
    await assertRealPostgresTestDatabaseIsIsolated(realPostgres);

    const suffix = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const applicationName = `pindou_lock_order_${suffix}`;
    const triggerName = `test_asset_lock_order_trigger_${suffix}`;
    const functionName = `test_asset_lock_order_sleep_${suffix}`;
    const pool = new Pool({
      connectionString: realPostgres.databaseUrl,
      ssl: realPostgres.poolSsl,
      application_name: applicationName,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      max: 8,
    });
    const store = new PostgresStore(pool);
    const userId = randomUUID();
    const paletteId = `lock-order-${randomUUID()}`;
    let userCreated = false;
    let paletteCreated = false;
    const assetIds = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ] as const;

    try {
      await pool.query("SELECT 1");
      await pool.query(
        "INSERT INTO users(id, display_name) VALUES ($1, '锁顺序并发回归')",
        [userId],
      );
      userCreated = true;
      await pool.query(
        "INSERT INTO credit_accounts(user_id, balance) VALUES ($1, 0)",
        [userId],
      );
      await pool.query(
        `INSERT INTO palettes(id, name, brand, bead_size_mm, verified, version)
         VALUES ($1, '锁顺序测试色卡', '测试', 5, true, 1)`,
        [paletteId],
      );
      paletteCreated = true;
      await pool.query(
        `INSERT INTO palette_colors(
           palette_id, code, name, hex, unit_price_cents, sort_order, available
         ) VALUES ($1, 'T01', '测试白', '#FFFFFF', 1, 0, true)`,
        [paletteId],
      );
      await pool.query(
        `INSERT INTO palettes(
           id, name, brand, bead_size_mm, verified, version, owner_user_id
         )
         SELECT $2 || '-' || sequence, '并发配额色卡 ' || sequence,
                '测试', 5, false, 1, $1
         FROM generate_series(1, 49) AS sequence`,
        [userId, `lock-order-quota-${suffix}`],
      );
      const quotaOutcomes = await Promise.allSettled([
        store.createPalette(userId, {
          id: `lock-order-quota-${suffix}-candidate-a`,
          name: "并发配额候选 A",
          brand: "测试",
          beadSizeMm: 5,
          verified: false,
          version: 1,
          colors: [
            { code: "QA", name: "候选 A", hex: "#AABBCC", unitPriceCents: 1, available: true },
          ],
        }),
        store.createPalette(userId, {
          id: `lock-order-quota-${suffix}-candidate-b`,
          name: "并发配额候选 B",
          brand: "测试",
          beadSizeMm: 5,
          verified: false,
          version: 1,
          colors: [
            { code: "QB", name: "候选 B", hex: "#BBCCDD", unitPriceCents: 1, available: true },
          ],
        }),
      ]);
      assert.equal(quotaOutcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const quotaFailures = quotaOutcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      assert.equal(quotaFailures.length, 1, quotaOutcomes.map(settledFailure).join(", "));
      assert.ok(quotaFailures[0]?.reason instanceof AppError);
      assert.equal(quotaFailures[0].reason.code, "CUSTOM_PALETTE_LIMIT_EXCEEDED");
      const quotaCount = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM palettes WHERE owner_user_id = $1",
        [userId],
      );
      assert.equal(quotaCount.rows[0]?.count, 50);
      for (const [index, assetId] of assetIds.entries()) {
        await pool.query(
          `INSERT INTO assets(
             id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
             width, height, storage_key, expires_at, ready_at, purge_available_at, created_at
           ) VALUES (
             $1, $2, 'ai-source', 'privacy-v1', $3, 'image/png', 10,
             1, 1, $4, clock_timestamp() + interval '1 day', clock_timestamp(),
             clock_timestamp() - interval '1 minute', clock_timestamp()
           )`,
          [assetId, userId, (index + 1).toString(16).repeat(64), `lock-order/${suffix}/${index}`],
        );
      }

      const referencedProjects = [];
      for (let index = 0; index < 3; index += 1) {
        referencedProjects.push(await store.createProject(userId, {
          name: `锁顺序作品 ${index + 1}`,
          paletteId,
          sourceAssetId: assetIds[index]!,
          grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["T01"] },
        }));
      }
      const nullReferenceProject = await store.createProject(userId, {
        name: "锁顺序空引用作品",
        paletteId,
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["T01"] },
      });
      await pool.query(
        `UPDATE assets
         SET created_at = clock_timestamp() - interval '2 days',
             ready_at = clock_timestamp() - interval '1 day',
             expires_at = clock_timestamp() - interval '1 minute'
         WHERE id = $1`,
        [assetIds[1]],
      );

      await pool.query(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger
        LANGUAGE plpgsql AS $body$
        BEGIN
          IF NEW.user_id = '${userId}'::uuid THEN
            PERFORM pg_sleep(0.75);
          END IF;
          RETURN NEW;
        END
        $body$;
      `);
      await pool.query(`
        CREATE TRIGGER "${triggerName}"
        BEFORE UPDATE OF deleted_at, purged_at ON assets
        FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
      `);

      const cleanupOperations: Array<() => Promise<unknown>> = [
        () => store.markAssetDeleted(userId, assetIds[0], new Date().toISOString()),
        () => store.claimAssetForPurge(userId, assetIds[1], "2199-01-01T00:00:00.000Z"),
        () => store.markAssetPurged(assetIds[2], new Date().toISOString()),
      ];
      for (let index = 0; index < cleanupOperations.length; index += 1) {
        const cleanup = cleanupOperations[index]!();
        await waitForAssetTriggerSleep(pool, applicationName);
        const metadata = store.updateProjectMetadata({
          userId,
          projectId: referencedProjects[index]!.id,
          baseRevision: 1,
          baseMetadataRevision: 1,
          backgroundMode: "solid",
          backgroundColor: `#00000${index + 1}`,
        });
        const outcomes = await Promise.allSettled([cleanup, metadata]);
        assert.equal(outcomes[0]?.status, "fulfilled", outcomes.map(settledFailure).join(", "));
        const metadataOutcome = outcomes[1];
        assert.ok(metadataOutcome?.status === "rejected", outcomes.map(settledFailure).join(", "));
        assert.ok(metadataOutcome.reason instanceof AppError);
        assert.equal(metadataOutcome.reason.statusCode, 409);
        assert.equal(metadataOutcome.reason.code, "PROJECT_METADATA_REVISION_CONFLICT");
        assert.notEqual((metadataOutcome.reason as { code?: string }).code, "40P01");
        assert.equal(
          (await store.getProject(userId, referencedProjects[index]!.id))?.sourceAssetId,
          null,
        );
      }

      const deleteUnreferenced = store.markAssetDeleted(
        userId,
        assetIds[3],
        new Date().toISOString(),
      );
      await waitForAssetTriggerSleep(pool, applicationName);
      const addDeletedReference = store.updateProjectMetadata({
        userId,
        projectId: nullReferenceProject.id,
        baseRevision: 1,
        baseMetadataRevision: 1,
        sourceAssetId: assetIds[3],
      });
      const nullReferenceRace = await Promise.allSettled([deleteUnreferenced, addDeletedReference]);
      assert.equal(nullReferenceRace[0]?.status, "fulfilled");
      assert.equal(nullReferenceRace[1]?.status, "rejected");
      const metadataFailure = nullReferenceRace[1];
      assert.ok(metadataFailure?.status === "rejected");
      assert.ok(metadataFailure.reason instanceof AppError);
      assert.equal(metadataFailure.reason.statusCode, 404);
      assert.equal(metadataFailure.reason.code, "PROJECT_SOURCE_ASSET_NOT_FOUND");
      assert.notEqual((metadataFailure.reason as { code?: string }).code, "40P01");
      assert.equal((await store.getProject(userId, nullReferenceProject.id))?.sourceAssetId, null);

      const createCompletedJob = async (sourceAssetId: string, label: string) => {
        const jobId = randomUUID();
        const candidateId = `lock-order-${suffix}-${label}`;
        const createdAt = new Date().toISOString();
        await store.createGenerationJob({
          userId,
          jobId,
          kind: "normal",
          paletteId,
          sourceAssetId,
          cost: 0,
          seed: `lock-order-${label}`,
          width: 8,
          height: 8,
          now: createdAt,
        });
        await pool.query(
          `UPDATE generation_jobs
           SET status = 'completed', progress = 100,
               completed_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE id = $1`,
          [jobId],
        );
        await pool.query(
          `INSERT INTO generation_candidates(
             id, job_id, ordinal, variant_ordinal, output_slot, subject_slot,
             encoding, width, height, cells, created_at
           ) VALUES (
             $1, $2, 1, 1, 'combined', NULL,
             'palette-code-v1', 8, 8, $3::jsonb, clock_timestamp()
           )`,
          [candidateId, jobId, JSON.stringify(Array.from({ length: 64 }, () => "T01"))],
        );
        return { jobId, candidateId };
      };

      const completionRace = await createCompletedJob(assetIds[4], "late-completion");
      const completionBlocker = await pool.connect();
      let completionBlockerOpen = false;
      try {
        await completionBlocker.query("BEGIN");
        completionBlockerOpen = true;
        await completionBlocker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
        const lateCompletion = store.completeGenerationJob({
          jobId: completionRace.jobId,
          leaseToken: randomUUID(),
          candidates: [],
          now: new Date().toISOString(),
        });
        await waitForLockWaiters(pool, applicationName, 1);
        const acceptCandidate = store.acceptGenerationCandidate({
          userId,
          jobId: completionRace.jobId,
          candidateId: completionRace.candidateId,
          projectName: "迟到完成竞态采用",
        });
        await waitForLockWaiters(pool, applicationName, 2);
        await completionBlocker.query("COMMIT");
        completionBlockerOpen = false;

        const outcomes = await Promise.allSettled([lateCompletion, acceptCandidate]);
        const completionOutcome = outcomes[0];
        assert.ok(completionOutcome?.status === "rejected", outcomes.map(settledFailure).join(", "));
        assert.ok(completionOutcome.reason instanceof AppError);
        assert.equal(completionOutcome.reason.statusCode, 409);
        assert.equal(completionOutcome.reason.code, "GENERATION_LEASE_LOST");
        assert.notEqual((completionOutcome.reason as { code?: string }).code, "40P01");
        const acceptanceOutcome = outcomes[1];
        assert.ok(acceptanceOutcome?.status === "fulfilled", outcomes.map(settledFailure).join(", "));
        assert.equal(acceptanceOutcome.value.job.status, "accepted");
        assert.equal(acceptanceOutcome.value.project.sourceAssetId, assetIds[4]);
      } finally {
        if (completionBlockerOpen) await completionBlocker.query("ROLLBACK").catch(() => undefined);
        completionBlocker.release();
      }

      const cleanupRace = await createCompletedJob(assetIds[5], "asset-cleanup");
      const cleanupBlocker = await pool.connect();
      let cleanupBlockerOpen = false;
      try {
        await cleanupBlocker.query("BEGIN");
        cleanupBlockerOpen = true;
        await cleanupBlocker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
        const cleanup = store.markAssetDeleted(userId, assetIds[5], new Date().toISOString());
        await waitForLockWaiters(pool, applicationName, 1);
        const acceptVariant = store.acceptGenerationVariant({
          userId,
          jobId: cleanupRace.jobId,
          variantOrdinal: 1,
          projects: [{ outputSlot: "combined", projectName: "素材清理竞态采用" }],
        });
        await waitForLockWaiters(pool, applicationName, 2);
        await cleanupBlocker.query("COMMIT");
        cleanupBlockerOpen = false;

        const outcomes = await Promise.allSettled([cleanup, acceptVariant]);
        assert.equal(outcomes[0]?.status, "fulfilled", outcomes.map(settledFailure).join(", "));
        const acceptanceOutcome = outcomes[1];
        assert.ok(acceptanceOutcome?.status === "fulfilled", outcomes.map(settledFailure).join(", "));
        assert.equal(acceptanceOutcome.value.job.status, "accepted");
        assert.equal(acceptanceOutcome.value.outputs[0]?.project.sourceAssetId, null);
        assert.ok((await store.getAsset(userId, assetIds[5]))?.deletedAt);
      } finally {
        if (cleanupBlockerOpen) await cleanupBlocker.query("ROLLBACK").catch(() => undefined);
        cleanupBlocker.release();
      }

      // An old writer that already owns the order must be skipped rather than
      // making repair insert a child job and then wait on the parent FK lock.
      const paymentOrderId = randomUUID();
      const paymentLeaseToken = randomUUID();
      await pool.query(
        `INSERT INTO payment_orders(
           id, user_id, product_id, product_version, product_name,
           credit_amount, amount_cents, currency, out_trade_no, status,
           provider_reference, provider_trade_state, payment_expires_at,
           created_at, updated_at
         ) VALUES (
           $1, $2, 'ai-5', 1, '5 次', 5, 600, 'CNY', $3, 'pending',
           'redacted:lock-order-self-heal', 'NOTPAY', clock_timestamp() + interval '10 minutes',
           '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z'
         )`,
        [paymentOrderId, userId, `PD${randomUUID().replaceAll("-", "").slice(0, 30)}`],
      );
      const paymentCallback = await pool.connect();
      let paymentCallbackOpen = false;
      try {
        await paymentCallback.query("BEGIN");
        paymentCallbackOpen = true;
        await paymentCallback.query("SELECT id FROM payment_orders WHERE id = $1 FOR UPDATE", [paymentOrderId]);
        await paymentCallback.query(
          `UPDATE payment_orders
           SET status = 'succeeded', provider_trade_state = 'SUCCESS',
               provider_transaction_id = $2, paid_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE id = $1`,
          [paymentOrderId, `lock-order-${paymentOrderId}`],
        );

        const claimed = await store.claimNextPaymentReconciliation({
          leaseToken: paymentLeaseToken,
          leaseMilliseconds: 60_000,
        });
        assert.notEqual(claimed?.order.id, paymentOrderId);
        await paymentCallback.query("COMMIT");
        paymentCallbackOpen = false;

        if (claimed) {
          assert.equal(await store.reschedulePaymentReconciliation({
            orderId: claimed.order.id,
            leaseToken: paymentLeaseToken,
            delayMilliseconds: 0,
          }), true);
        }
        assert.equal(await store.getPaymentReconciliationJob(paymentOrderId), null);
      } finally {
        if (paymentCallbackOpen) await paymentCallback.query("ROLLBACK").catch(() => undefined);
        paymentCallback.release();
      }

      // Force the opposite interleaving. Repair first locks the parent order,
      // then pauses in a BEFORE INSERT trigger. An old order -> job writer must
      // wait on that order and finish without 40P01 after repair commits.
      const repairFirstOrderId = randomUUID();
      const repairFirstLeaseToken = randomUUID();
      const paymentTriggerName = `test_payment_repair_order_first_trigger_${suffix}`;
      const paymentFunctionName = `test_payment_repair_order_first_sleep_${suffix}`;
      await pool.query(
        `INSERT INTO payment_orders(
           id, user_id, product_id, product_version, product_name,
           credit_amount, amount_cents, currency, out_trade_no, status,
           provider_reference, provider_trade_state, payment_expires_at,
           created_at, updated_at
         ) VALUES (
           $1, $2, 'ai-5', 1, '5 次', 5, 600, 'CNY', $3, 'pending',
           'redacted:lock-order-repair-first', 'NOTPAY', clock_timestamp() + interval '10 minutes',
           '1999-01-01T00:00:00Z', '1999-01-01T00:00:00Z'
         )`,
        [repairFirstOrderId, userId, `PD${randomUUID().replaceAll("-", "").slice(0, 30)}`],
      );
      await pool.query(`
        CREATE FUNCTION "${paymentFunctionName}"() RETURNS trigger
        LANGUAGE plpgsql AS $body$
        BEGIN
          IF NEW.order_id = '${repairFirstOrderId}'::uuid THEN
            PERFORM pg_sleep(0.75);
          END IF;
          RETURN NEW;
        END
        $body$;
      `);
      await pool.query(`
        CREATE TRIGGER "${paymentTriggerName}"
        BEFORE INSERT ON payment_reconciliation_jobs
        FOR EACH ROW EXECUTE FUNCTION "${paymentFunctionName}"();
      `);
      const oldWriter = await pool.connect();
      let oldWriterOpen = false;
      try {
        const repair = store.claimNextPaymentReconciliation({
          leaseToken: repairFirstLeaseToken,
          leaseMilliseconds: 60_000,
        });
        await waitForAssetTriggerSleep(pool, applicationName);
        const oldWrite = (async () => {
          await oldWriter.query("BEGIN");
          oldWriterOpen = true;
          await oldWriter.query(
            "SELECT id FROM payment_orders WHERE id = $1 FOR UPDATE",
            [repairFirstOrderId],
          );
          await oldWriter.query(
            `INSERT INTO payment_reconciliation_jobs(
               order_id, state, available_at, attempt_count, created_at, updated_at
             ) VALUES ($1, 'scheduled', clock_timestamp(), 0, clock_timestamp(), clock_timestamp())
             ON CONFLICT (order_id) DO NOTHING`,
            [repairFirstOrderId],
          );
          await oldWriter.query("COMMIT");
          oldWriterOpen = false;
        })();
        await waitForLockWaiters(pool, applicationName, 1);
        const outcomes = await Promise.allSettled([repair, oldWrite]);
        assert.equal(outcomes[0]?.status, "fulfilled", outcomes.map(settledFailure).join(", "));
        assert.equal(outcomes[1]?.status, "fulfilled", outcomes.map(settledFailure).join(", "));
        const repairOutcome = outcomes[0];
        assert.ok(repairOutcome?.status === "fulfilled");
        assert.equal(repairOutcome.value?.order.id, repairFirstOrderId);
        assert.equal((await store.getPaymentReconciliationJob(repairFirstOrderId))?.state, "running");

        // Model a pre-0037 writer that later commits SUCCESS without knowing
        // about the job. The next claim must complete the stale running job.
        await pool.query(
          `UPDATE payment_orders
           SET status = 'succeeded', provider_trade_state = 'SUCCESS',
               provider_transaction_id = $2, paid_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE id = $1`,
          [repairFirstOrderId, `late-terminal-${repairFirstOrderId}`],
        );
        const nextClaim = await store.claimNextPaymentReconciliation({
          leaseToken: randomUUID(),
          leaseMilliseconds: 60_000,
        });
        assert.notEqual(nextClaim?.order.id, repairFirstOrderId);
        const converged = await store.getPaymentReconciliationJob(repairFirstOrderId);
        assert.equal(converged?.state, "completed");
        assert.equal(converged?.lastObservedTradeState, "SUCCESS");
        assert.ok(converged?.completedAt);
        if (nextClaim) {
          assert.equal(await store.reschedulePaymentReconciliation({
            orderId: nextClaim.order.id,
            leaseToken: nextClaim.job.leaseToken!,
            delayMilliseconds: 0,
          }), true);
        }
      } finally {
        if (oldWriterOpen) await oldWriter.query("ROLLBACK").catch(() => undefined);
        oldWriter.release();
        await pool.query(`DROP TRIGGER IF EXISTS "${paymentTriggerName}" ON payment_reconciliation_jobs`)
          .catch(() => undefined);
        await pool.query(`DROP FUNCTION IF EXISTS "${paymentFunctionName}"()`)
          .catch(() => undefined);
      }
    } finally {
      try {
        await pool.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON assets`).catch(() => undefined);
        await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => undefined);
        if (userCreated || paletteCreated) {
          await pool.query("BEGIN");
          try {
            if (userCreated) {
              await pool.query("DELETE FROM payment_orders WHERE user_id = $1", [userId]);
              await pool.query("DELETE FROM projects WHERE user_id = $1", [userId]);
              await pool.query("DELETE FROM generation_jobs WHERE user_id = $1", [userId]);
              await pool.query("DELETE FROM assets WHERE user_id = $1", [userId]);
              await pool.query("DELETE FROM users WHERE id = $1", [userId]);
            }
            if (paletteCreated) {
              await pool.query("DELETE FROM palettes WHERE id = $1", [paletteId]);
            }
            await pool.query("COMMIT");
          } catch (error) {
            await pool.query("ROLLBACK").catch(() => undefined);
            throw error;
          }
        }
      } finally {
        await pool.end();
      }
    }
  },
);

it(
  "keeps retired palette history readable while fencing new exports in real PostgreSQL",
  { skip: realPostgres.enabled ? false : realPostgres.skipReason },
  async () => {
    if (!realPostgres.enabled) return;
    await assertRealPostgresTestDatabaseIsIsolated(realPostgres);

    const suffix = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const pool = new Pool({
      connectionString: realPostgres.databaseUrl,
      ssl: realPostgres.poolSsl,
      application_name: `pindou_retired_export_${suffix}`,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      max: 4,
    });
    const store = new PostgresStore(pool);
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const paletteId = `retired-export-${randomUUID()}`;
    const activePaletteId = `active-export-${randomUUID()}`;
    const historicalExportId = randomUUID();
    const activeExportId = randomUUID();
    let projectId: string | null = null;
    let activeProjectId: string | null = null;
    let userCreated = false;
    let palettesCreated = false;

    try {
      await pool.query("SELECT 1");
      await pool.query(
        `INSERT INTO users(id, display_name) VALUES
           ($1, '退役色卡真实 PG 回归'),
           ($2, '退役色卡跨租户回归')`,
        [userId, otherUserId],
      );
      userCreated = true;
      await pool.query(
        `INSERT INTO palettes(id, name, brand, bead_size_mm, verified, version)
         VALUES
           ($1, '退役导出测试色卡', '测试', 5, false, 1),
           ($2, '活动导出测试色卡', '测试', 5, false, 1)`,
        [paletteId, activePaletteId],
      );
      palettesCreated = true;
      await pool.query(
        `INSERT INTO palette_colors(
           palette_id, code, name, hex, unit_price_cents, sort_order, available
         ) VALUES
           ($1, 'T01', '测试白', '#FFFFFF', 1, 0, true),
           ($2, 'T01', '测试白', '#FFFFFF', 1, 0, true)`,
        [paletteId, activePaletteId],
      );

      const project = await store.createProject(userId, {
        name: "退役前历史作品",
        paletteId,
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["T01"] },
      });
      projectId = project.id;
      await store.createExportJob({
        id: historicalExportId,
        userId,
        projectId,
        projectRevision: project.currentRevision,
        format: "png",
        fileName: "historical-export.png",
        options: {
          paper: "A4",
          orientation: "auto",
          showCodes: true,
          showGrid: true,
          transparentBackground: false,
        },
        now: "1900-01-01T00:00:00.000Z",
      });
      const activeProject = await store.createProject(userId, {
        name: "活动色卡导出作品",
        paletteId: activePaletteId,
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["T01"] },
      });
      activeProjectId = activeProject.id;
      await store.createExportJob({
        id: activeExportId,
        userId,
        projectId: activeProjectId,
        projectRevision: activeProject.currentRevision,
        format: "png",
        fileName: "active-export.png",
        options: {
          paper: "A4",
          orientation: "auto",
          showCodes: true,
          showGrid: true,
          transparentBackground: false,
        },
        now: "1900-01-01T00:00:01.000Z",
      });

      const retired = await pool.query(
        "UPDATE palettes SET retired = true WHERE id = $1 AND retired = false RETURNING id",
        [paletteId],
      );
      assert.equal(retired.rowCount, 1);
      assert.ok(await store.getProject(userId, projectId));

      const paletteBeforeNoop = await pool.query<{
        name: string;
        version: number;
        retired: boolean;
      }>(
        "SELECT name, version, retired FROM palettes WHERE id = $1",
        [paletteId],
      );
      const paletteNoop = await pool.query<{
        name: string;
        version: number;
        retired: boolean;
      }>(
        "UPDATE palettes SET name = name WHERE id = $1 RETURNING name, version, retired",
        [paletteId],
      );
      assert.equal(paletteNoop.rowCount, 1);
      assert.deepEqual(paletteNoop.rows[0], paletteBeforeNoop.rows[0]);

      const projectBeforeNoop = await pool.query<{
        name: string;
        palette_id: string;
        current_revision: number;
        updated_at: string;
      }>(
        `SELECT name, palette_id, current_revision, updated_at::text
         FROM projects WHERE id = $1`,
        [projectId],
      );
      const projectNoop = await pool.query<{
        name: string;
        palette_id: string;
        current_revision: number;
        updated_at: string;
      }>(
        `UPDATE projects SET name = name WHERE id = $1
         RETURNING name, palette_id, current_revision, updated_at::text`,
        [projectId],
      );
      assert.equal(projectNoop.rowCount, 1);
      assert.deepEqual(projectNoop.rows[0], projectBeforeNoop.rows[0]);

      await assert.rejects(
        pool.query("UPDATE palettes SET name = '不可变更' WHERE id = $1", [paletteId]),
        (error: unknown) => (error as { code?: string }).code === "23514",
      );
      await assert.rejects(
        pool.query("UPDATE palette_colors SET name = '不可变更' WHERE palette_id = $1", [paletteId]),
        (error: unknown) => (error as { code?: string }).code === "23514",
      );
      await assert.rejects(
        pool.query("UPDATE projects SET name = '不可变更' WHERE id = $1", [projectId]),
        (error: unknown) => (error as { code?: string }).code === "23514",
      );

      await assert.rejects(
        store.createExportJob({
          id: randomUUID(),
          userId,
          projectId,
          projectRevision: project.currentRevision,
          format: "png",
          fileName: "new-retired-export.png",
          options: {
            paper: "A4",
            orientation: "auto",
            showCodes: true,
            showGrid: true,
            transparentBackground: false,
          },
          now: new Date().toISOString(),
        }),
        (error: unknown) => error instanceof AppError
          && error.statusCode === 409
          && error.code === "PALETTE_RETIRED",
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO export_jobs(
             id, user_id, project_id, project_revision, format, file_name, options,
             status, progress, attempt_count, max_attempts, available_at, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, 'png', 'direct-retired-export.png', '{}'::jsonb,
             'queued', 0, 0, 3, clock_timestamp(), clock_timestamp(), clock_timestamp()
           )`,
          [randomUUID(), userId, projectId, project.currentRevision],
        ),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23514"
          && (error as { constraint?: string }).constraint === "retired_palette_write_guard",
      );
      await assert.rejects(
        pool.query(
          `UPDATE export_jobs
           SET project_id = $1, project_revision = $2
           WHERE id = $3`,
          [projectId, project.currentRevision, activeExportId],
        ),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23514"
          && (error as { constraint?: string }).constraint === "retired_palette_write_guard",
      );
      await assert.rejects(
        pool.query(
          "UPDATE export_jobs SET user_id = $1 WHERE id = $2",
          [otherUserId, activeExportId],
        ),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23503"
          && (error as { constraint?: string }).constraint === "export_jobs_project_revision_owner_fkey",
      );
      const unchangedActiveExport = await pool.query<{
        user_id: string;
        project_id: string;
        project_revision: number;
      }>(
        `SELECT user_id, project_id, project_revision
         FROM export_jobs WHERE id = $1`,
        [activeExportId],
      );
      assert.deepEqual(unchangedActiveExport.rows[0], {
        user_id: userId,
        project_id: activeProjectId,
        project_revision: activeProject.currentRevision,
      });
      await assert.rejects(
        pool.query("UPDATE export_jobs SET format = 'pdf' WHERE id = $1", [historicalExportId]),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23514"
          && (error as { constraint?: string }).constraint === "retired_palette_write_guard",
      );
      await assert.rejects(
        pool.query(
          "UPDATE export_jobs SET options = '{\"paper\":\"A4\"}'::jsonb WHERE id = $1",
          [historicalExportId],
        ),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23514"
          && (error as { constraint?: string }).constraint === "retired_palette_write_guard",
      );
      await assert.rejects(
        pool.query("UPDATE export_jobs SET id = $1 WHERE id = $2", [randomUUID(), historicalExportId]),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23514"
          && (error as { constraint?: string }).constraint === "retired_palette_write_guard",
      );

      const historicalOperationalUpdate = await pool.query<{ status: string }>(
        `UPDATE export_jobs
         SET id = id,
             user_id = user_id,
             project_id = project_id,
             project_revision = project_revision,
             format = format,
             file_name = file_name,
             options = options,
             status = 'retry_wait',
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING status`,
        [historicalExportId],
      );
      assert.deepEqual(historicalOperationalUpdate.rows, [{ status: "retry_wait" }]);

      const leaseToken = randomUUID();
      const claimed = await store.claimNextExportJob({
        now: "2199-01-01T00:00:00.000Z",
        leaseToken,
        leaseMilliseconds: 60_000,
      });
      assert.equal(claimed?.id, historicalExportId);
      const finalized = await store.failExportJob({
        jobId: historicalExportId,
        leaseToken,
        code: "HISTORICAL_TEST",
        message: "historical queued work may terminate",
        retryable: false,
        availableAt: "2199-01-01T00:00:01.000Z",
        now: "2199-01-01T00:00:01.000Z",
      });
      assert.equal(finalized.status, "failed");
      assert.equal((await store.getExportJob(userId, historicalExportId))?.status, "failed");
    } finally {
      try {
        if (palettesCreated) {
          await pool.query("BEGIN");
          try {
            await pool.query(
              "ALTER TABLE palette_colors DISABLE TRIGGER palette_colors_retired_immutability_guard",
            );
            await pool.query(
              "ALTER TABLE palettes DISABLE TRIGGER palettes_retired_immutability_guard",
            );
            if (userCreated) {
              await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[userId, otherUserId]]);
            }
            await pool.query("DELETE FROM palettes WHERE id = ANY($1::text[])", [[paletteId, activePaletteId]]);
            await pool.query(
              "ALTER TABLE palette_colors ENABLE TRIGGER palette_colors_retired_immutability_guard",
            );
            await pool.query(
              "ALTER TABLE palettes ENABLE TRIGGER palettes_retired_immutability_guard",
            );
            await pool.query("COMMIT");
          } catch (error) {
            await pool.query("ROLLBACK");
            throw error;
          }
        } else if (userCreated) {
          await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[userId, otherUserId]]);
        }

        const residue = await pool.query<{
          users: number;
          projects: number;
          export_jobs: number;
          palettes: number;
          palette_colors: number;
        }>(
          `SELECT
             (SELECT count(*)::integer FROM users WHERE id = ANY($1::uuid[])) AS users,
             (SELECT count(*)::integer FROM projects WHERE id = ANY($2::uuid[])) AS projects,
             (SELECT count(*)::integer FROM export_jobs WHERE id = ANY($3::uuid[])) AS export_jobs,
             (SELECT count(*)::integer FROM palettes WHERE id = ANY($4::text[])) AS palettes,
             (SELECT count(*)::integer FROM palette_colors WHERE palette_id = ANY($4::text[])) AS palette_colors`,
          [
            [userId, otherUserId],
            [projectId, activeProjectId],
            [historicalExportId, activeExportId],
            [paletteId, activePaletteId],
          ],
        );
        assert.deepEqual(residue.rows[0], {
          users: 0,
          projects: 0,
          export_jobs: 0,
          palettes: 0,
          palette_colors: 0,
        });
      } finally {
        await pool.end();
      }
    }
  },
);
