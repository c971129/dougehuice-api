import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

import pg from "pg";

import { DEFAULT_GENERATION_OPTIONS } from "../src/domain/generation-options.js";
import { AppError } from "../src/errors.js";
import { calculateMigrationChecksum } from "../src/migrate.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";
import {
  assertRealPostgresTestDatabaseIsIsolated,
  loadRealPostgresTestConfig,
} from "./support/real-postgres-config.js";

const { Pool } = pg;
const realPostgres = loadRealPostgresTestConfig();
const expiredJobCount = 2_000;
const liveJobCount = 100_000;
const concurrentClaimCount = 12;
const recoveryBatchSize = 100;
const concurrentRefundUserCount = 3;
const concurrentRefundJobsPerUser = 200;
const concurrentRefundJobCount = concurrentRefundUserCount * concurrentRefundJobsPerUser;
const migrationPaths = new Map([
  [
    "0040_worker_lease_scan_indexes.sql",
    fileURLToPath(new URL("../migrations/0040_worker_lease_scan_indexes.sql", import.meta.url)),
  ],
  [
    "0041_remove_superseded_lease_indexes.sql",
    fileURLToPath(new URL("../migrations/0041_remove_superseded_lease_indexes.sql", import.meta.url)),
  ],
]);

interface RefundSeed {
  id: string;
  userId: string;
  cost: number;
  expiryMinutesAgo: number;
  alreadyReleased?: boolean;
}

it(
  "bounds and atomically recovers generation leases under backlog, refund contention, and worker crashes",
  {
    skip: realPostgres.enabled ? false : realPostgres.skipReason,
    timeout: 120_000,
  },
  async () => {
    if (!realPostgres.enabled) return;
    await assertRealPostgresTestDatabaseIsIsolated(realPostgres);

    const suffix = randomUUID().replaceAll("-", "");
    const backlogUserId = randomUUID();
    const refundUserAId = randomUUID();
    const refundUserBId = randomUUID();
    const takeoverUserId = randomUUID();
    const concurrentRefundUserIds = [randomUUID(), randomUUID(), randomUUID()];
    const lockOrderUserId = randomUUID();
    const conflictUserId = randomUUID();
    const userIds = [
      backlogUserId,
      refundUserAId,
      refundUserBId,
      takeoverUserId,
      ...concurrentRefundUserIds,
      lockOrderUserId,
      conflictUserId,
    ];
    const paletteId = `generation-lease-${suffix}`;
    const expiredPrefix = `${suffix}:expired:`;
    const livePrefix = `${suffix}:live:`;
    const queuedPrefix = `${suffix}:queued:`;
    const concurrentRefundPrefix = `${suffix}:concurrent-refund:`;
    const applicationName = `pindou_generation_lease_${suffix.slice(0, 12)}`;
    const injectionFunctionName = `pindou_inject_generation_release_${suffix.slice(0, 12)}`;
    const injectionTriggerName = `pindou_inject_generation_release_${suffix.slice(0, 12)}`;
    const lockPauseFunctionName = `pindou_pause_generation_expiry_${suffix.slice(0, 12)}`;
    const lockPauseTriggerName = `pindou_pause_generation_expiry_${suffix.slice(0, 12)}`;
    const optionsJson = JSON.stringify(DEFAULT_GENERATION_OPTIONS);
    let injectionFunctionCreated = false;
    let injectionTriggerCreated = false;
    let lockPauseFunctionCreated = false;
    let lockPauseTriggerCreated = false;
    const pool = new Pool({
      connectionString: realPostgres.databaseUrl,
      ssl: realPostgres.poolSsl,
      application_name: applicationName,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 15_000,
      max: concurrentClaimCount + 2,
    });
    const store = new PostgresStore(pool);

    try {
      await pool.query("SELECT 1");
      const appliedMigrations = await pool.query<{ version: string; checksum: string }>(
        `SELECT version, checksum::text AS checksum
         FROM schema_migrations
         WHERE version = ANY($1::text[])
         ORDER BY version`,
        [[...migrationPaths.keys()]],
      );
      assert.equal(appliedMigrations.rows.length, migrationPaths.size);
      for (const [version, path] of migrationPaths) {
        const applied = appliedMigrations.rows.find((row) => row.version === version);
        assert.equal(
          applied?.checksum,
          calculateMigrationChecksum(await readFile(path, "utf8")),
          `${version} checksum differs from the release artifact`,
        );
      }
      const leaseIndexes = await pool.query<{
        ordered_index_exists: boolean;
        superseded_index_exists: boolean;
      }>(
        `SELECT
           to_regclass('generation_jobs_expired_lease_order_idx') IS NOT NULL
             AS ordered_index_exists,
           to_regclass('generation_jobs_expired_lease_idx') IS NOT NULL
             AS superseded_index_exists`,
      );
      assert.deepEqual(leaseIndexes.rows[0], {
        ordered_index_exists: true,
        superseded_index_exists: false,
      });
      await pool.query(
        `INSERT INTO users(id, display_name) VALUES
           ($1, '生成租约积压回归'),
           ($2, '生成退款回归甲'),
           ($3, '生成退款回归乙'),
           ($4, '生成崩溃接管回归'),
           ($5, '并发退款回归甲'),
           ($6, '并发退款回归乙'),
           ($7, '并发退款回归丙'),
           ($8, '生成锁序交错回归'),
           ($9, '退款原子回滚回归')`,
        userIds,
      );
      await pool.query(
        `INSERT INTO palettes(id, name, brand, bead_size_mm, verified, version)
         VALUES ($1, '生成租约测试色卡', '测试', 5, true, 1)`,
        [paletteId],
      );
      await pool.query(
        `INSERT INTO palette_colors(
           palette_id, code, name, hex, unit_price_cents, sort_order, available
         ) VALUES ($1, 'T01', '测试白', '#FFFFFF', 1, 0, true)`,
        [paletteId],
      );

      // A large live population makes this a real index/selectivity gate, while
      // twelve workers must each recover at most 100 expired rows and still
      // claim the twelve deliberately older fresh jobs.
      await pool.query(
        `INSERT INTO generation_jobs(
           id, user_id, kind, status, palette_id, options, cost, seed,
           width, height, progress, attempt_count, max_attempts, available_at,
           lease_token, lease_expires_at, created_at, updated_at
         )
         SELECT md5($1 || sequence::text)::uuid, $2, 'portrait', 'generating', $3,
                $4::jsonb, 0, $1 || sequence::text,
                8, 8, 40, 3, 3, clock_timestamp() - interval '2 minutes',
                $5, clock_timestamp() - interval '1 minute',
                clock_timestamp() - interval '3 minutes',
                clock_timestamp() - interval '2 minutes'
         FROM generate_series(1, $6::integer) AS sequence`,
        [expiredPrefix, backlogUserId, paletteId, optionsJson, randomUUID(), expiredJobCount],
      );
      await pool.query(
        `INSERT INTO generation_jobs(
           id, user_id, kind, status, palette_id, options, cost, seed,
           width, height, progress, attempt_count, max_attempts, available_at,
           lease_token, lease_expires_at, created_at, updated_at
         )
         SELECT md5($1 || sequence::text)::uuid, $2, 'portrait', 'generating', $3,
                $4::jsonb, 0, $1 || sequence::text,
                8, 8, 40, 1, 3, clock_timestamp(),
                $5, clock_timestamp() + interval '1 day',
                clock_timestamp(), clock_timestamp()
         FROM generate_series(1, $6::integer) AS sequence`,
        [livePrefix, backlogUserId, paletteId, optionsJson, randomUUID(), liveJobCount],
      );
      await pool.query(
        `INSERT INTO generation_jobs(
           id, user_id, kind, status, palette_id, options, cost, seed,
           width, height, progress, attempt_count, max_attempts, available_at,
           created_at, updated_at
         )
         SELECT md5($1 || sequence::text)::uuid, $2, 'portrait', 'queued', $3,
                $4::jsonb, 0, $1 || sequence::text,
                8, 8, 0, 0, 3, clock_timestamp() - interval '5 minutes',
                clock_timestamp() - interval '5 minutes',
                clock_timestamp() - interval '5 minutes'
         FROM generate_series(1, $5::integer) AS sequence`,
        [queuedPrefix, backlogUserId, paletteId, optionsJson, concurrentClaimCount],
      );
      await pool.query("ANALYZE generation_jobs");

      const startedAt = performance.now();
      const claims = await Promise.all(
        Array.from({ length: concurrentClaimCount }, () => store.claimNextGenerationJob({
          now: new Date().toISOString(),
          leaseToken: randomUUID(),
          leaseMilliseconds: 60_000,
        })),
      );
      const elapsedMilliseconds = performance.now() - startedAt;

      assert.equal(claims.every((claim) => claim?.status === "preprocessing"), true);
      assert.equal(claims.every((claim) => claim?.seed.startsWith(queuedPrefix)), true);
      assert.equal(new Set(claims.map((claim) => claim?.id)).size, concurrentClaimCount);
      assert.ok(
        elapsedMilliseconds < 8_000,
        `concurrent generation claims exceeded the latency gate: ${elapsedMilliseconds.toFixed(1)}ms`,
      );

      const backlogCounts = await pool.query<{
        failed: number;
        expired_active: number;
        live_active: number;
        fresh_claimed: number;
      }>(
        `SELECT
           count(*) FILTER (
             WHERE status = 'failed' AND error_code = 'GENERATION_LEASE_EXPIRED'
           )::integer AS failed,
           count(*) FILTER (
             WHERE status IN ('preprocessing', 'generating', 'mapping_colors', 'finalizing')
               AND lease_expires_at <= clock_timestamp()
           )::integer AS expired_active,
           count(*) FILTER (
             WHERE status = 'generating' AND seed LIKE $2
           )::integer AS live_active,
           count(*) FILTER (
             WHERE status = 'preprocessing' AND seed LIKE $3
           )::integer AS fresh_claimed
         FROM generation_jobs
         WHERE user_id = $1`,
        [backlogUserId, `${livePrefix}%`, `${queuedPrefix}%`],
      );
      assert.deepEqual(backlogCounts.rows[0], {
        failed: concurrentClaimCount * recoveryBatchSize,
        expired_active: expiredJobCount - concurrentClaimCount * recoveryBatchSize,
        live_active: liveJobCount,
        fresh_claimed: concurrentClaimCount,
      });

      const planResult = await pool.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE, FORMAT JSON)
         SELECT id FROM generation_jobs
         WHERE status IN ('preprocessing', 'generating', 'mapping_colors', 'finalizing')
           AND lease_expires_at <= statement_timestamp()
         ORDER BY lease_expires_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 100`,
      );
      const serializedPlan = JSON.stringify(planResult.rows[0]?.["QUERY PLAN"]);
      assert.match(serializedPlan, /generation_jobs_expired_lease_order_idx/);

      const drainClaims = await Promise.all(
        Array.from({ length: 8 }, () => store.claimNextGenerationJob({
          now: new Date().toISOString(),
          leaseToken: randomUUID(),
          leaseMilliseconds: 60_000,
        })),
      );
      assert.deepEqual(drainClaims, Array.from({ length: 8 }, () => null));
      const drainedBacklog = await pool.query<{
        failed: number;
        expired_active: number;
      }>(
        `SELECT
           count(*) FILTER (
             WHERE status = 'failed' AND error_code = 'GENERATION_LEASE_EXPIRED'
           )::integer AS failed,
           count(*) FILTER (
             WHERE status IN ('preprocessing', 'generating', 'mapping_colors', 'finalizing')
               AND lease_expires_at <= clock_timestamp()
           )::integer AS expired_active
         FROM generation_jobs
         WHERE user_id = $1 AND seed LIKE $2`,
        [backlogUserId, `${expiredPrefix}%`],
      );
      assert.deepEqual(drainedBacklog.rows[0], {
        failed: expiredJobCount,
        expired_active: 0,
      });

      // Remove this exact 102,012-row fixture before exercising accounting so
      // it cannot influence the refund or takeover scenarios below.
      await pool.query("DELETE FROM users WHERE id = $1", [backlogUserId]);

      // Six 100-row batches all contain jobs for the same three accounts. The
      // twelve simultaneous claimers therefore exercise both SKIP LOCKED job
      // partitioning and deterministic shared-account lock ordering.
      await pool.query(
        `INSERT INTO credit_accounts(user_id, balance)
         SELECT user_id, 0
         FROM unnest($1::uuid[]) AS account(user_id)`,
        [concurrentRefundUserIds],
      );
      await pool.query(
        `WITH fixture AS (
           SELECT sequence,
                  ($2::uuid[])[(((sequence - 1) % $6::integer) + 1)] AS user_id,
                  (((sequence - 1) / $6::integer) + 1) AS user_ordinal
           FROM generate_series(1, $5::integer) AS sequence
         )
         INSERT INTO generation_jobs(
           id, user_id, kind, status, palette_id, options, cost, seed,
           width, height, progress, attempt_count, max_attempts, available_at,
           lease_token, lease_expires_at, created_at, updated_at
         )
         SELECT md5($1 || fixture.sequence::text)::uuid,
                fixture.user_id, 'portrait', 'generating', $3, $4::jsonb, 1,
                $1 || fixture.sequence::text,
                8, 8, 70, 3, 3,
                clock_timestamp() - interval '10 minutes',
                md5($1 || ':lease:' || fixture.sequence::text)::uuid,
                clock_timestamp() - interval '10 minutes'
                  + fixture.sequence * interval '1 millisecond',
                clock_timestamp() - interval '20 minutes'
                  + fixture.sequence * interval '1 millisecond',
                clock_timestamp() - interval '10 minutes'
         FROM fixture`,
        [
          concurrentRefundPrefix,
          concurrentRefundUserIds,
          paletteId,
          optionsJson,
          concurrentRefundJobCount,
          concurrentRefundUserCount,
        ],
      );
      await pool.query(
        `WITH fixture AS (
           SELECT sequence,
                  ($2::uuid[])[(((sequence - 1) % $4::integer) + 1)] AS user_id,
                  (((sequence - 1) / $4::integer) + 1) AS user_ordinal
           FROM generate_series(1, $3::integer) AS sequence
         )
         INSERT INTO credit_ledger(
           id, user_id, delta, balance_after, reason, reference_id, created_at
         )
         SELECT md5($1 || ':reserved:' || fixture.sequence::text)::uuid,
                fixture.user_id,
                -1,
                $5::integer - fixture.user_ordinal,
                'generation_reserved',
                (md5($1 || fixture.sequence::text)::uuid)::text,
                clock_timestamp() - interval '20 minutes'
                  + fixture.user_ordinal * interval '1 millisecond'
         FROM fixture`,
        [
          concurrentRefundPrefix,
          concurrentRefundUserIds,
          concurrentRefundJobCount,
          concurrentRefundUserCount,
          concurrentRefundJobsPerUser,
        ],
      );

      const reservationState = await pool.query<{
        user_id: string;
        balance: number;
        reservation_count: number;
        reserved_delta: number;
        minimum_balance_after: number;
        maximum_balance_after: number;
      }>(
        `SELECT account.user_id,
                account.balance,
                count(ledger.id)::integer AS reservation_count,
                sum(ledger.delta)::integer AS reserved_delta,
                min(ledger.balance_after)::integer AS minimum_balance_after,
                max(ledger.balance_after)::integer AS maximum_balance_after
         FROM credit_accounts AS account
         JOIN credit_ledger AS ledger
           ON ledger.user_id = account.user_id
          AND ledger.reason = 'generation_reserved'
         WHERE account.user_id = ANY($1::uuid[])
         GROUP BY account.user_id, account.balance
         ORDER BY account.user_id`,
        [concurrentRefundUserIds],
      );
      assert.equal(reservationState.rows.length, concurrentRefundUserCount);
      for (const row of reservationState.rows) {
        assert.deepEqual(row, {
          user_id: row.user_id,
          balance: 0,
          reservation_count: concurrentRefundJobsPerUser,
          reserved_delta: -concurrentRefundJobsPerUser,
          minimum_balance_after: 0,
          maximum_balance_after: concurrentRefundJobsPerUser - 1,
        });
      }

      const concurrentRefundClaims = await Promise.all(
        Array.from({ length: concurrentClaimCount }, () => store.claimNextGenerationJob({
          now: new Date().toISOString(),
          leaseToken: randomUUID(),
          leaseMilliseconds: 60_000,
        })),
      );
      assert.deepEqual(
        concurrentRefundClaims,
        Array.from({ length: concurrentClaimCount }, () => null),
      );
      const concurrentRefundJobs = await pool.query<{
        failed: number;
        expired_active: number;
      }>(
        `SELECT
           count(*) FILTER (
             WHERE status = 'failed' AND error_code = 'GENERATION_LEASE_EXPIRED'
           )::integer AS failed,
           count(*) FILTER (
             WHERE status IN ('preprocessing', 'generating', 'mapping_colors', 'finalizing')
               AND lease_expires_at <= clock_timestamp()
           )::integer AS expired_active
         FROM generation_jobs
         WHERE seed LIKE $1`,
        [`${concurrentRefundPrefix}%`],
      );
      assert.deepEqual(concurrentRefundJobs.rows[0], {
        failed: concurrentRefundJobCount,
        expired_active: 0,
      });

      const concurrentRefundAccounting = await pool.query<{
        user_id: string;
        balance: number;
        release_count: number;
        distinct_reference_count: number;
        released_delta: number;
        balance_afters: number[];
      }>(
        `SELECT job.user_id,
                max(account.balance)::integer AS balance,
                count(ledger.id)::integer AS release_count,
                count(DISTINCT ledger.reference_id)::integer AS distinct_reference_count,
                sum(ledger.delta)::integer AS released_delta,
                array_agg(ledger.balance_after ORDER BY ledger.balance_after) AS balance_afters
         FROM generation_jobs AS job
         JOIN credit_accounts AS account ON account.user_id = job.user_id
         JOIN credit_ledger AS ledger
           ON ledger.reason = 'generation_released'
          AND ledger.reference_id = job.id::text
         WHERE job.seed LIKE $1
         GROUP BY job.user_id
         ORDER BY job.user_id`,
        [`${concurrentRefundPrefix}%`],
      );
      const expectedBalanceAfters = Array.from(
        { length: concurrentRefundJobsPerUser },
        (_, index) => index + 1,
      );
      assert.equal(concurrentRefundAccounting.rows.length, concurrentRefundUserCount);
      for (const row of concurrentRefundAccounting.rows) {
        assert.deepEqual(row, {
          user_id: row.user_id,
          balance: concurrentRefundJobsPerUser,
          release_count: concurrentRefundJobsPerUser,
          distinct_reference_count: concurrentRefundJobsPerUser,
          released_delta: concurrentRefundJobsPerUser,
          balance_afters: expectedBalanceAfters,
        });
      }

      const concurrentReplayClaims = await Promise.all(
        Array.from({ length: concurrentClaimCount }, () => store.claimNextGenerationJob({
          now: new Date().toISOString(),
          leaseToken: randomUUID(),
          leaseMilliseconds: 60_000,
        })),
      );
      assert.deepEqual(
        concurrentReplayClaims,
        Array.from({ length: concurrentClaimCount }, () => null),
      );
      const concurrentReplayAccounting = await pool.query<{
        user_id: string;
        balance: number;
        release_count: number;
      }>(
        `SELECT account.user_id,
                account.balance,
                count(ledger.id)::integer AS release_count
         FROM credit_accounts AS account
         LEFT JOIN credit_ledger AS ledger
           ON ledger.user_id = account.user_id
          AND ledger.reason = 'generation_released'
         WHERE account.user_id = ANY($1::uuid[])
         GROUP BY account.user_id, account.balance
         ORDER BY account.user_id`,
        [concurrentRefundUserIds],
      );
      assert.equal(concurrentReplayAccounting.rows.length, concurrentRefundUserCount);
      for (const row of concurrentReplayAccounting.rows) {
        assert.deepEqual(row, {
          user_id: row.user_id,
          balance: concurrentRefundJobsPerUser,
          release_count: concurrentRefundJobsPerUser,
        });
      }
      await pool.query(
        "DELETE FROM users WHERE id = ANY($1::uuid[])",
        [concurrentRefundUserIds],
      );

      await pool.query(
        `INSERT INTO credit_accounts(user_id, balance) VALUES
           ($1, 30),
           ($2, 20)`,
        [refundUserAId, refundUserBId],
      );
      const refundSeeds: RefundSeed[] = [
        { id: randomUUID(), userId: refundUserAId, cost: 1, expiryMinutesAgo: 6 },
        { id: randomUUID(), userId: refundUserAId, cost: 3, expiryMinutesAgo: 5 },
        {
          id: randomUUID(),
          userId: refundUserAId,
          cost: 7,
          expiryMinutesAgo: 4,
          alreadyReleased: true,
        },
        { id: randomUUID(), userId: refundUserBId, cost: 2, expiryMinutesAgo: 3 },
        { id: randomUUID(), userId: refundUserBId, cost: 4, expiryMinutesAgo: 2 },
        { id: randomUUID(), userId: refundUserBId, cost: 0, expiryMinutesAgo: 1 },
      ];
      for (const seed of refundSeeds) {
        await store.createGenerationJob({
          jobId: seed.id,
          userId: seed.userId,
          kind: "portrait",
          paletteId,
          sourceAssetId: null,
          options: DEFAULT_GENERATION_OPTIONS,
          cost: seed.cost,
          seed: `${suffix}:refund:${seed.id}`,
          width: 8,
          height: 8,
          now: new Date().toISOString(),
        });
        await pool.query(
          `UPDATE generation_jobs
           SET status = 'generating', progress = 70,
               attempt_count = max_attempts,
               available_at = clock_timestamp() - interval '10 minutes',
               lease_token = $2,
               lease_expires_at = clock_timestamp() - ($3::integer * interval '1 minute'),
               updated_at = clock_timestamp() - interval '10 minutes'
           WHERE id = $1`,
          [seed.id, randomUUID(), seed.expiryMinutesAgo],
        );
        if (seed.alreadyReleased) {
          const manuallyRefunded = await pool.query<{ balance: number }>(
            `UPDATE credit_accounts
             SET balance = balance + $2, updated_at = clock_timestamp()
             WHERE user_id = $1
             RETURNING balance`,
            [seed.userId, seed.cost],
          );
          assert.equal(manuallyRefunded.rows[0]?.balance, 26);
          await pool.query(
            `INSERT INTO credit_ledger(
               id, user_id, delta, balance_after, reason, reference_id
             ) VALUES ($1, $2, $3, $4, 'generation_released', $5)`,
            [randomUUID(), seed.userId, seed.cost, manuallyRefunded.rows[0]!.balance, seed.id],
          );
        }
      }

      const recoveryClaim = await store.claimNextGenerationJob({
        now: new Date().toISOString(),
        leaseToken: randomUUID(),
        leaseMilliseconds: 60_000,
      });
      assert.equal(recoveryClaim, null);
      const replayClaim = await store.claimNextGenerationJob({
        now: new Date().toISOString(),
        leaseToken: randomUUID(),
        leaseMilliseconds: 60_000,
      });
      assert.equal(replayClaim, null);

      const refundJobIds = refundSeeds.map((seed) => seed.id);
      const terminalState = await pool.query<{
        failed: number;
        fenced: number;
        expiry_error: number;
      }>(
        `SELECT
           count(*) FILTER (WHERE status = 'failed')::integer AS failed,
           count(*) FILTER (WHERE lease_token IS NULL AND lease_expires_at IS NULL)::integer AS fenced,
           count(*) FILTER (WHERE error_code = 'GENERATION_LEASE_EXPIRED')::integer AS expiry_error
         FROM generation_jobs
         WHERE id = ANY($1::uuid[])`,
        [refundJobIds],
      );
      assert.deepEqual(terminalState.rows[0], {
        failed: refundSeeds.length,
        fenced: refundSeeds.length,
        expiry_error: refundSeeds.length,
      });

      const accounts = await pool.query<{ user_id: string; balance: number }>(
        `SELECT user_id, balance FROM credit_accounts
         WHERE user_id = ANY($1::uuid[])
         ORDER BY user_id`,
        [[refundUserAId, refundUserBId]],
      );
      assert.deepEqual(
        new Map(accounts.rows.map((row) => [row.user_id, row.balance])),
        new Map([
          [refundUserAId, 30],
          [refundUserBId, 20],
        ]),
      );

      const releases = await pool.query<{
        reference_id: string;
        delta: number;
        balance_after: number;
      }>(
        `SELECT reference_id, delta, balance_after
         FROM credit_ledger
         WHERE reason = 'generation_released'
           AND reference_id = ANY($1::text[])`,
        [refundJobIds],
      );
      const releaseByJob = new Map(releases.rows.map((row) => [row.reference_id, row]));
      assert.equal(releaseByJob.size, 5);
      assert.deepEqual(releaseByJob.get(refundSeeds[0]!.id), {
        reference_id: refundSeeds[0]!.id,
        delta: 1,
        balance_after: 27,
      });
      assert.deepEqual(releaseByJob.get(refundSeeds[1]!.id), {
        reference_id: refundSeeds[1]!.id,
        delta: 3,
        balance_after: 30,
      });
      assert.deepEqual(releaseByJob.get(refundSeeds[2]!.id), {
        reference_id: refundSeeds[2]!.id,
        delta: 7,
        balance_after: 26,
      });
      assert.deepEqual(releaseByJob.get(refundSeeds[3]!.id), {
        reference_id: refundSeeds[3]!.id,
        delta: 2,
        balance_after: 16,
      });
      assert.deepEqual(releaseByJob.get(refundSeeds[4]!.id), {
        reference_id: refundSeeds[4]!.id,
        delta: 4,
        balance_after: 20,
      });
      assert.equal(releaseByJob.has(refundSeeds[5]!.id), false);

      // A worker claims and then disappears. Before expiry no contender can
      // steal the job; after PostgreSQL's own clock crosses the lease boundary,
      // a new token takes over and every operation from the old token is fenced.
      await pool.query(
        "INSERT INTO credit_accounts(user_id, balance) VALUES ($1, 10)",
        [takeoverUserId],
      );
      const takeoverJobId = randomUUID();
      await store.createGenerationJob({
        jobId: takeoverJobId,
        userId: takeoverUserId,
        kind: "portrait",
        paletteId,
        sourceAssetId: null,
        options: DEFAULT_GENERATION_OPTIONS,
        cost: 2,
        seed: `${suffix}:takeover`,
        width: 8,
        height: 8,
        now: new Date().toISOString(),
      });
      const abandonedLeaseToken = randomUUID();
      const crashedPool = new Pool({
        connectionString: realPostgres.databaseUrl,
        ssl: realPostgres.poolSsl,
        application_name: `${applicationName}_crashed`,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 15_000,
        lock_timeout: 5_000,
        idle_in_transaction_session_timeout: 15_000,
        max: 1,
      });
      const crashedStore = new PostgresStore(crashedPool);
      let firstOwner;
      try {
        firstOwner = await crashedStore.claimNextGenerationJob({
          now: new Date().toISOString(),
          leaseToken: abandonedLeaseToken,
          leaseMilliseconds: 2_000,
        });
      } finally {
        await crashedStore.close();
      }
      assert.equal(firstOwner?.id, takeoverJobId);
      assert.equal(firstOwner?.attemptCount, 1);

      const prematureContender = await store.claimNextGenerationJob({
        now: new Date().toISOString(),
        leaseToken: randomUUID(),
        leaseMilliseconds: 60_000,
      });
      assert.equal(prematureContender, null);
      await pool.query(
        `SELECT pg_sleep(
           GREATEST(
             EXTRACT(EPOCH FROM (lease_expires_at - clock_timestamp())),
             0
           ) + 0.1
         )
         FROM generation_jobs
         WHERE id = $1`,
        [takeoverJobId],
      );

      const replacementLeaseToken = randomUUID();
      const replacementOwner = await store.claimNextGenerationJob({
        now: new Date().toISOString(),
        leaseToken: replacementLeaseToken,
        leaseMilliseconds: 60_000,
      });
      assert.equal(replacementOwner?.id, takeoverJobId);
      assert.equal(replacementOwner?.leaseToken, replacementLeaseToken);
      assert.equal(replacementOwner?.attemptCount, 2);
      assert.equal(await store.renewGenerationJobLease({
        jobId: takeoverJobId,
        leaseToken: abandonedLeaseToken,
        leaseMilliseconds: 60_000,
      }), false);
      await assert.rejects(
        store.advanceGenerationJob({
          jobId: takeoverJobId,
          leaseToken: abandonedLeaseToken,
          status: "generating",
          progress: 40,
          now: new Date().toISOString(),
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "GENERATION_LEASE_LOST");
          return true;
        },
      );
      const advanced = await store.advanceGenerationJob({
        jobId: takeoverJobId,
        leaseToken: replacementLeaseToken,
        status: "generating",
        progress: 40,
        now: new Date().toISOString(),
      });
      assert.equal(advanced.leaseToken, replacementLeaseToken);

      const takeoverAccounting = await pool.query<{
        balance: number;
        reserved_count: number;
        released_count: number;
        settled_count: number;
      }>(
        `SELECT
           (SELECT balance FROM credit_accounts WHERE user_id = $1)::integer AS balance,
           count(*) FILTER (WHERE reason = 'generation_reserved')::integer AS reserved_count,
           count(*) FILTER (WHERE reason = 'generation_released')::integer AS released_count,
           count(*) FILTER (WHERE reason = 'generation_settled')::integer AS settled_count
         FROM credit_ledger
         WHERE user_id = $1 AND reference_id = $2`,
        [takeoverUserId, takeoverJobId],
      );
      assert.deepEqual(takeoverAccounting.rows[0], {
        balance: 8,
        reserved_count: 1,
        released_count: 0,
        settled_count: 0,
      });

      // Force the historical account -> job / job -> account deadlock shape.
      // The expiry trigger pauses claim after it owns the active child row.
      // Opportunistic history cleanup must skip that non-terminal child, letting
      // a concurrent create finish before recovery continues. A later create can
      // clean the parent after the child has become terminal.
      await pool.query(
        "INSERT INTO credit_accounts(user_id, balance) VALUES ($1, 8)",
        [lockOrderUserId],
      );
      const lockOrderParentId = randomUUID();
      const lockOrderChildId = randomUUID();
      const lockOrderChildLease = randomUUID();
      const lockOrderCreatedJobId = randomUUID();
      const deferredCleanupJobId = randomUUID();
      await pool.query(
        `INSERT INTO generation_jobs(
           id, user_id, parent_job_id, kind, status, palette_id, options, cost, seed,
           width, height, progress, attempt_count, max_attempts, available_at,
           lease_token, lease_expires_at, created_at, updated_at
         ) VALUES
           ($1, $3, NULL, 'portrait', 'completed', $4, $5::jsonb, 0, $6,
            8, 8, 100, 1, 3, clock_timestamp() - interval '100 days',
            NULL, NULL, clock_timestamp() - interval '100 days',
            clock_timestamp() - interval '100 days'),
           ($2, $3, $1, 'portrait', 'generating', $4, $5::jsonb, 2, $7,
            8, 8, 70, 3, 3, clock_timestamp() - interval '2 minutes',
            $8, clock_timestamp() - interval '1 minute',
            clock_timestamp() - interval '2 minutes',
            clock_timestamp() - interval '2 minutes')`,
        [
          lockOrderParentId,
          lockOrderChildId,
          lockOrderUserId,
          paletteId,
          optionsJson,
          `${suffix}:lock-order-parent`,
          `${suffix}:lock-order-child`,
          lockOrderChildLease,
        ],
      );
      await pool.query(
        `INSERT INTO credit_ledger(
           id, user_id, delta, balance_after, reason, reference_id, created_at
         ) VALUES ($1, $2, -2, 8, 'generation_reserved', $3, clock_timestamp() - interval '2 minutes')`,
        [randomUUID(), lockOrderUserId, lockOrderChildId],
      );

      const lockPauseKey = `${suffix}:generation-lock-order`;
      await pool.query(
        `CREATE FUNCTION public.${lockPauseFunctionName}() RETURNS trigger AS $body$
         BEGIN
           IF NEW.id::text = TG_ARGV[1]
              AND NEW.error_code = 'GENERATION_LEASE_EXPIRED' THEN
             PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0]));
           END IF;
           RETURN NEW;
         END;
         $body$ LANGUAGE plpgsql`,
      );
      lockPauseFunctionCreated = true;
      await pool.query(
        `CREATE TRIGGER ${lockPauseTriggerName}
         BEFORE UPDATE ON public.generation_jobs
         FOR EACH ROW EXECUTE FUNCTION public.${lockPauseFunctionName}(
           '${lockPauseKey}', '${lockOrderChildId}'
         )`,
      );
      lockPauseTriggerCreated = true;

      const waitForBlockedQuery = async (queryFragment: string, label: string): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const waiting = await pool.query<{ waiting: number }>(
            `SELECT count(*)::integer AS waiting
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND application_name = $1
               AND pid <> pg_backend_pid()
               AND wait_event_type = 'Lock'
               AND position($2 in query) > 0`,
            [applicationName, queryFragment],
          );
          if ((waiting.rows[0]?.waiting ?? 0) > 0) return;
          await delay(25);
        }
        throw new Error(`timed out waiting for ${label}`);
      };

      const advisoryClient = await pool.connect();
      let advisoryTransactionOpen = false;
      const pendingLockOrderOperations: Promise<unknown>[] = [];
      try {
        await advisoryClient.query("BEGIN");
        advisoryTransactionOpen = true;
        await advisoryClient.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [lockPauseKey],
        );

        const claimPromise = store.claimNextGenerationJob({
          now: new Date().toISOString(),
          leaseToken: randomUUID(),
          leaseMilliseconds: 60_000,
        });
        pendingLockOrderOperations.push(claimPromise);
        await waitForBlockedQuery("GENERATION_LEASE_EXPIRED", "generation expiry advisory lock");

        const createPromise = store.createGenerationJob({
          jobId: lockOrderCreatedJobId,
          userId: lockOrderUserId,
          kind: "portrait",
          paletteId,
          sourceAssetId: null,
          options: DEFAULT_GENERATION_OPTIONS,
          cost: 3,
          seed: `${suffix}:lock-order-created`,
          width: 8,
          height: 8,
          now: new Date().toISOString(),
        });
        pendingLockOrderOperations.push(createPromise);
        let createTimeout: ReturnType<typeof setTimeout> | undefined;
        let created;
        try {
          created = await Promise.race([
            createPromise,
            new Promise<never>((_resolve, reject) => {
              createTimeout = setTimeout(
                () => reject(new Error("generation create blocked on an active history child")),
                5_000,
              );
            }),
          ]);
        } finally {
          if (createTimeout) clearTimeout(createTimeout);
        }
        assert.equal(created.id, lockOrderCreatedJobId);
        assert.equal(created.status, "queued");

        await advisoryClient.query("COMMIT");
        advisoryTransactionOpen = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const claim = await Promise.race([
            claimPromise,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error("generation create/recovery lock-order interleave timed out")),
                10_000,
              );
            }),
          ]);
          assert.equal(claim?.id, lockOrderCreatedJobId);
          assert.equal(claim?.status, "preprocessing");
        } finally {
          if (timeout) clearTimeout(timeout);
        }

        const lockOrderState = await pool.query<{
          child_status: string;
          child_error_code: string | null;
          child_parent_id: string | null;
          child_lease_token: string | null;
          parent_exists: boolean;
          created_status: string;
          balance: number;
          child_release_count: number;
          child_release_delta: number;
          child_release_balance: number | null;
          created_reserve_count: number;
          created_reserve_delta: number;
          created_reserve_balance: number | null;
        }>(
          `SELECT
             child.status AS child_status,
             child.error_code AS child_error_code,
             child.parent_job_id::text AS child_parent_id,
             child.lease_token::text AS child_lease_token,
             EXISTS (SELECT 1 FROM generation_jobs WHERE id = $2::uuid) AS parent_exists,
             created.status AS created_status,
             account.balance::integer AS balance,
             (SELECT count(*)::integer FROM credit_ledger
              WHERE reason = 'generation_released' AND reference_id = $1::text) AS child_release_count,
             (SELECT COALESCE(sum(delta), 0)::integer FROM credit_ledger
              WHERE reason = 'generation_released' AND reference_id = $1::text) AS child_release_delta,
             (SELECT max(balance_after)::integer FROM credit_ledger
              WHERE reason = 'generation_released' AND reference_id = $1::text) AS child_release_balance,
             (SELECT count(*)::integer FROM credit_ledger
              WHERE reason = 'generation_reserved' AND reference_id = $3::text) AS created_reserve_count,
             (SELECT COALESCE(sum(delta), 0)::integer FROM credit_ledger
              WHERE reason = 'generation_reserved' AND reference_id = $3::text) AS created_reserve_delta,
             (SELECT max(balance_after)::integer FROM credit_ledger
              WHERE reason = 'generation_reserved' AND reference_id = $3::text) AS created_reserve_balance
           FROM generation_jobs AS child
           JOIN generation_jobs AS created ON created.id = $3::uuid
           JOIN credit_accounts AS account ON account.user_id = child.user_id
           WHERE child.id = $1::uuid`,
          [lockOrderChildId, lockOrderParentId, lockOrderCreatedJobId],
        );
        assert.deepEqual(lockOrderState.rows[0], {
          child_status: "failed",
          child_error_code: "GENERATION_LEASE_EXPIRED",
          child_parent_id: lockOrderParentId,
          child_lease_token: null,
          parent_exists: true,
          created_status: "preprocessing",
          balance: 7,
          child_release_count: 1,
          child_release_delta: 2,
          child_release_balance: 7,
          created_reserve_count: 1,
          created_reserve_delta: -3,
          created_reserve_balance: 5,
        });

        const deferredCleanup = await store.createGenerationJob({
          jobId: deferredCleanupJobId,
          userId: lockOrderUserId,
          kind: "normal",
          paletteId,
          sourceAssetId: null,
          options: DEFAULT_GENERATION_OPTIONS,
          cost: 0,
          seed: `${suffix}:deferred-history-cleanup`,
          width: 8,
          height: 8,
          now: new Date().toISOString(),
        });
        assert.equal(deferredCleanup.id, deferredCleanupJobId);
        const deferredCleanupState = await pool.query<{
          child_parent_id: string | null;
          parent_exists: boolean;
          balance: number;
        }>(
          `SELECT child.parent_job_id::text AS child_parent_id,
                  EXISTS (SELECT 1 FROM generation_jobs WHERE id = $2) AS parent_exists,
                  account.balance::integer AS balance
           FROM generation_jobs AS child
           JOIN credit_accounts AS account ON account.user_id = child.user_id
           WHERE child.id = $1`,
          [lockOrderChildId, lockOrderParentId],
        );
        assert.deepEqual(deferredCleanupState.rows[0], {
          child_parent_id: null,
          parent_exists: false,
          balance: 7,
        });
      } finally {
        if (advisoryTransactionOpen) {
          await advisoryClient.query("ROLLBACK").catch(() => undefined);
        }
        advisoryClient.release();
        await Promise.allSettled(pendingLockOrderOperations);
        if (lockPauseTriggerCreated) {
          await pool.query(
            `DROP TRIGGER ${lockPauseTriggerName} ON public.generation_jobs`,
          );
          lockPauseTriggerCreated = false;
        }
        if (lockPauseFunctionCreated) {
          await pool.query(`DROP FUNCTION public.${lockPauseFunctionName}()`);
          lockPauseFunctionCreated = false;
        }
      }

      // Suppress exactly one release-ledger row with a narrowly targeted
      // trigger. The store must detect the short INSERT RETURNING result and
      // roll the job transition, account mutation, and every ledger write back.
      await pool.query(
        "INSERT INTO credit_accounts(user_id, balance) VALUES ($1, 10)",
        [conflictUserId],
      );
      const conflictJobId = randomUUID();
      const conflictLeaseToken = randomUUID();
      await store.createGenerationJob({
        jobId: conflictJobId,
        userId: conflictUserId,
        kind: "portrait",
        paletteId,
        sourceAssetId: null,
        options: DEFAULT_GENERATION_OPTIONS,
        cost: 2,
        seed: `${suffix}:release-count-conflict`,
        width: 8,
        height: 8,
        now: new Date().toISOString(),
      });
      await pool.query(
        `UPDATE generation_jobs
         SET status = 'generating', progress = 70,
             attempt_count = max_attempts,
             available_at = clock_timestamp() - interval '2 minutes',
             lease_token = $2,
             lease_expires_at = clock_timestamp() - interval '1 minute',
             updated_at = clock_timestamp() - interval '2 minutes'
         WHERE id = $1`,
        [conflictJobId, conflictLeaseToken],
      );
      const readConflictState = () => pool.query<{
        status: string;
        progress: number;
        attempt_count: number;
        lease_token: string | null;
        lease_expires_at: string | null;
        error_code: string | null;
        updated_at: string;
        balance: number;
        reserved_count: number;
        released_count: number;
        ledger_count: number;
      }>(
        `SELECT job.status,
                job.progress,
                job.attempt_count,
                job.lease_token::text AS lease_token,
                job.lease_expires_at::text AS lease_expires_at,
                job.error_code,
                job.updated_at::text AS updated_at,
                (SELECT balance FROM credit_accounts WHERE user_id = job.user_id)::integer
                  AS balance,
                (SELECT count(*)::integer FROM credit_ledger
                 WHERE user_id = job.user_id AND reference_id = job.id::text
                   AND reason = 'generation_reserved') AS reserved_count,
                (SELECT count(*)::integer FROM credit_ledger
                 WHERE user_id = job.user_id AND reference_id = job.id::text
                   AND reason = 'generation_released') AS released_count,
                (SELECT count(*)::integer FROM credit_ledger
                 WHERE user_id = job.user_id AND reference_id = job.id::text) AS ledger_count
         FROM generation_jobs AS job
         WHERE job.id = $1`,
        [conflictJobId],
      );
      const conflictStateBefore = (await readConflictState()).rows[0];
      assert.ok(conflictStateBefore);
      assert.deepEqual({
        status: conflictStateBefore.status,
        progress: conflictStateBefore.progress,
        attempt_count: conflictStateBefore.attempt_count,
        lease_token: conflictStateBefore.lease_token,
        error_code: conflictStateBefore.error_code,
        balance: conflictStateBefore.balance,
        reserved_count: conflictStateBefore.reserved_count,
        released_count: conflictStateBefore.released_count,
        ledger_count: conflictStateBefore.ledger_count,
      }, {
        status: "generating",
        progress: 70,
        attempt_count: 3,
        lease_token: conflictLeaseToken,
        error_code: null,
        balance: 8,
        reserved_count: 1,
        released_count: 0,
        ledger_count: 1,
      });

      await pool.query(
        `CREATE FUNCTION public.${injectionFunctionName}() RETURNS trigger AS $body$
         BEGIN
           IF NEW.reason = 'generation_released'
              AND NEW.reference_id = '${conflictJobId}' THEN
             RETURN NULL;
           END IF;
           RETURN NEW;
         END;
         $body$ LANGUAGE plpgsql`,
      );
      injectionFunctionCreated = true;
      try {
        await pool.query(
          `CREATE TRIGGER ${injectionTriggerName}
           BEFORE INSERT ON public.credit_ledger
           FOR EACH ROW EXECUTE FUNCTION public.${injectionFunctionName}()`,
        );
        injectionTriggerCreated = true;

        await assert.rejects(
          store.claimNextGenerationJob({
            now: new Date().toISOString(),
            leaseToken: randomUUID(),
            leaseMilliseconds: 60_000,
          }),
          (error: unknown) => {
            assert.ok(error instanceof AppError);
            assert.equal(error.code, "GENERATION_CREDIT_RELEASE_FAILED");
            return true;
          },
        );
        const conflictStateAfter = (await readConflictState()).rows[0];
        assert.deepEqual(conflictStateAfter, conflictStateBefore);
      } finally {
        if (injectionTriggerCreated) {
          await pool.query(
            `DROP TRIGGER ${injectionTriggerName} ON public.credit_ledger`,
          );
          injectionTriggerCreated = false;
        }
        if (injectionFunctionCreated) {
          await pool.query(`DROP FUNCTION public.${injectionFunctionName}()`);
          injectionFunctionCreated = false;
        }
      }
      const injectionObjects = await pool.query<{
        trigger_exists: boolean;
        function_exists: boolean;
        lock_trigger_exists: boolean;
        lock_function_exists: boolean;
      }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM pg_trigger
             WHERE tgname = $1 AND tgrelid = 'public.credit_ledger'::regclass
           ) AS trigger_exists,
           EXISTS (
             SELECT 1
             FROM pg_proc AS procedure
             JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
             WHERE namespace.nspname = 'public' AND procedure.proname = $2
           ) AS function_exists,
           EXISTS (
             SELECT 1 FROM pg_trigger
             WHERE tgname = $3 AND tgrelid = 'public.generation_jobs'::regclass
           ) AS lock_trigger_exists,
           EXISTS (
             SELECT 1
             FROM pg_proc AS procedure
             JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
             WHERE namespace.nspname = 'public' AND procedure.proname = $4
           ) AS lock_function_exists`,
        [
          injectionTriggerName,
          injectionFunctionName,
          lockPauseTriggerName,
          lockPauseFunctionName,
        ],
      );
      assert.deepEqual(injectionObjects.rows[0], {
        trigger_exists: false,
        function_exists: false,
        lock_trigger_exists: false,
        lock_function_exists: false,
      });
    } finally {
      const cleanupErrors: unknown[] = [];
      if (lockPauseTriggerCreated) {
        try {
          await pool.query(
            `DROP TRIGGER IF EXISTS ${lockPauseTriggerName} ON public.generation_jobs`,
          );
          lockPauseTriggerCreated = false;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (lockPauseFunctionCreated) {
        try {
          await pool.query(`DROP FUNCTION IF EXISTS public.${lockPauseFunctionName}()`);
          lockPauseFunctionCreated = false;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (injectionTriggerCreated) {
        try {
          await pool.query(
            `DROP TRIGGER IF EXISTS ${injectionTriggerName} ON public.credit_ledger`,
          );
          injectionTriggerCreated = false;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (injectionFunctionCreated) {
        try {
          await pool.query(`DROP FUNCTION IF EXISTS public.${injectionFunctionName}()`);
          injectionFunctionCreated = false;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await pool.query("DELETE FROM palettes WHERE id = $1", [paletteId]);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await pool.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "generation lease recovery fixture cleanup failed");
      }
    }
  },
);
