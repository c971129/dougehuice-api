import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";

import pg from "pg";

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

it(
  "bounds expired export lease recovery while concurrent workers still claim fresh jobs",
  {
    skip: realPostgres.enabled ? false : realPostgres.skipReason,
    timeout: 30_000,
  },
  async () => {
    if (!realPostgres.enabled) return;
    await assertRealPostgresTestDatabaseIsIsolated(realPostgres);

    const suffix = randomUUID().replaceAll("-", "");
    const userId = randomUUID();
    const paletteId = `export-lease-${suffix}`;
    const projectId = randomUUID();
    const expiredPrefix = `${suffix}:expired:`;
    const livePrefix = `${suffix}:live:`;
    const queuedPrefix = `${suffix}:queued:`;
    const applicationName = `pindou_export_lease_${suffix.slice(0, 12)}`;
    const pool = new Pool({
      connectionString: realPostgres.databaseUrl,
      ssl: realPostgres.poolSsl,
      application_name: applicationName,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      max: concurrentClaimCount + 2,
    });
    const store = new PostgresStore(pool);

    try {
      await pool.query("SELECT 1");
      await pool.query(
        "INSERT INTO users(id, display_name) VALUES ($1, '导出过期租约并发回归')",
        [userId],
      );
      await pool.query(
        `INSERT INTO palettes(id, name, brand, bead_size_mm, verified, version)
         VALUES ($1, '导出过期租约测试色卡', '测试', 5, true, 1)`,
        [paletteId],
      );
      await pool.query(
        `INSERT INTO palette_colors(
           palette_id, code, name, hex, unit_price_cents, sort_order, available
         ) VALUES ($1, 'T01', '测试白', '#FFFFFF', 1, 0, true)`,
        [paletteId],
      );
      await pool.query(
        `INSERT INTO projects(id, user_id, name, palette_id, current_revision)
         VALUES ($1, $2, '导出过期租约并发图纸', $3, 1)`,
        [projectId, userId, paletteId],
      );
      await pool.query(
        `INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
         VALUES ($1, 1, 'palette-code-v1', 1, 1, '["T01"]'::jsonb)`,
        [projectId],
      );
      await pool.query(
        `INSERT INTO export_jobs(
           id, user_id, project_id, project_revision, format, file_name, options,
           status, progress, attempt_count, max_attempts, available_at,
           lease_token, lease_expires_at, created_at, updated_at
         )
         SELECT md5($1 || sequence::text)::uuid, $2, $3, 1, 'png',
                'expired-' || sequence || '.png', '{}'::jsonb,
                'running', 5, 3, 3, clock_timestamp() - interval '2 minutes',
                $4, clock_timestamp() - interval '1 minute',
                clock_timestamp() - interval '3 minutes',
                clock_timestamp() - interval '2 minutes'
         FROM generate_series(1, $5::integer) AS sequence`,
        [expiredPrefix, userId, projectId, randomUUID(), expiredJobCount],
      );
      await pool.query(
        `INSERT INTO export_jobs(
           id, user_id, project_id, project_revision, format, file_name, options,
           status, progress, attempt_count, max_attempts, available_at,
           lease_token, lease_expires_at, created_at, updated_at
         )
         SELECT md5($1 || sequence::text)::uuid, $2, $3, 1, 'png',
                'live-' || sequence || '.png', '{}'::jsonb,
                'running', 5, 1, 3, clock_timestamp(),
                $4, clock_timestamp() + interval '1 day',
                clock_timestamp(), clock_timestamp()
         FROM generate_series(1, $5::integer) AS sequence`,
        [livePrefix, userId, projectId, randomUUID(), liveJobCount],
      );
      await pool.query(
        `INSERT INTO export_jobs(
           id, user_id, project_id, project_revision, format, file_name, options,
           status, progress, attempt_count, max_attempts, available_at, created_at, updated_at
         )
         SELECT md5($1 || sequence::text)::uuid, $2, $3, 1, 'png',
                'fresh-' || sequence || '.png', '{}'::jsonb,
                'queued', 0, 0, 3, clock_timestamp() - interval '1 second',
                clock_timestamp(), clock_timestamp()
         FROM generate_series(1, $4::integer) AS sequence`,
        [queuedPrefix, userId, projectId, concurrentClaimCount],
      );
      await pool.query("ANALYZE export_jobs");

      const startedAt = performance.now();
      const claims = await Promise.all(
        Array.from({ length: concurrentClaimCount }, () => store.claimNextExportJob({
          now: new Date().toISOString(),
          leaseToken: randomUUID(),
          leaseMilliseconds: 60_000,
        })),
      );
      const elapsedMilliseconds = performance.now() - startedAt;

      assert.equal(claims.every((claim) => claim?.status === "running"), true);
      assert.equal(new Set(claims.map((claim) => claim?.id)).size, concurrentClaimCount);
      assert.ok(
        elapsedMilliseconds < 8_000,
        `concurrent export claims exceeded the latency gate: ${elapsedMilliseconds.toFixed(1)}ms`,
      );

      const counts = await pool.query<{
        failed: number;
        expired_running: number;
        fresh_claimed: number;
      }>(
        `SELECT
           count(*) FILTER (
             WHERE status = 'failed' AND error_code = 'EXPORT_LEASE_EXPIRED'
           )::integer AS failed,
           count(*) FILTER (
             WHERE status = 'running' AND lease_expires_at <= clock_timestamp()
           )::integer AS expired_running,
           count(*) FILTER (
             WHERE status = 'running' AND file_name LIKE 'fresh-%'
           )::integer AS fresh_claimed
         FROM export_jobs
         WHERE user_id = $1`,
        [userId],
      );
      assert.equal(counts.rows[0]?.failed, concurrentClaimCount * recoveryBatchSize);
      assert.equal(
        counts.rows[0]?.expired_running,
        expiredJobCount - concurrentClaimCount * recoveryBatchSize,
      );
      assert.equal(counts.rows[0]?.fresh_claimed, concurrentClaimCount);

      const planResult = await pool.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE, FORMAT JSON)
         SELECT id FROM export_jobs
         WHERE status = 'running' AND lease_expires_at <= statement_timestamp()
         ORDER BY lease_expires_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 100`,
      );
      const serializedPlan = JSON.stringify(planResult.rows[0]?.["QUERY PLAN"]);
      assert.match(serializedPlan, /export_jobs_expired_lease_order_idx/);
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => undefined);
      await pool.query("DELETE FROM palettes WHERE id = $1", [paletteId]).catch(() => undefined);
      await pool.end();
    }
  },
);
