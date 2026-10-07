import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";

import type { PoolClient } from "pg";

import { createPool } from "../src/db.js";
import {
  assertRealPostgresTestDatabaseIsIsolated,
  loadRealPostgresTestConfig,
} from "./support/real-postgres-config.js";

const realPostgres = loadRealPostgresTestConfig();

it(
  "bounds PostgreSQL lock waits, returns the connection, and keeps a queued readiness query live",
  {
    skip: realPostgres.enabled ? false : realPostgres.skipReason,
    timeout: 10_000,
  },
  async () => {
    if (!realPostgres.enabled) return;
    await assertRealPostgresTestDatabaseIsIsolated(realPostgres);

    const userId = randomUUID();
    const idleErrors: Error[] = [];
    const pool = createPool({
      databaseUrl: realPostgres.databaseUrl,
      databaseSsl: realPostgres.databaseSsl,
      databasePoolMax: 2,
      databaseIdleTimeoutMilliseconds: 30_000,
      databaseConnectionTimeoutMilliseconds: 2_000,
      databaseStatementTimeoutMilliseconds: 2_000,
      databaseLockTimeoutMilliseconds: 200,
      databaseIdleTransactionTimeoutMilliseconds: 5_000,
    }, (error) => idleErrors.push(error));
    let blocker: PoolClient | undefined;
    let blockerInTransaction = false;

    try {
      await pool.query("INSERT INTO users(id, display_name) VALUES ($1, '连接池锁超时回归')", [userId]);
      blocker = await pool.connect();
      await blocker.query("BEGIN");
      blockerInTransaction = true;
      await blocker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);

      const startedAt = performance.now();
      const [blockedWrite, readiness] = await Promise.allSettled([
        pool.query("UPDATE users SET display_name = '不应提交' WHERE id = $1", [userId]),
        pool.query<{ ready: number }>("SELECT 1::integer AS ready"),
      ]);
      const elapsedMilliseconds = performance.now() - startedAt;

      assert.equal(blockedWrite.status, "rejected");
      if (blockedWrite.status === "rejected") {
        assert.equal((blockedWrite.reason as { code?: string }).code, "55P03");
      }
      assert.equal(readiness.status, "fulfilled");
      if (readiness.status === "fulfilled") assert.equal(readiness.value.rows[0]?.ready, 1);
      assert.ok(elapsedMilliseconds >= 150, `lock timeout fired too early: ${elapsedMilliseconds.toFixed(1)}ms`);
      assert.ok(elapsedMilliseconds < 1_500, `lock timeout exceeded its budget: ${elapsedMilliseconds.toFixed(1)}ms`);
      assert.deepEqual(idleErrors, []);

      await blocker.query("ROLLBACK");
      blockerInTransaction = false;
      blocker.release();
      blocker = undefined;
      assert.equal((await pool.query<{ ready: number }>("SELECT 1::integer AS ready")).rows[0]?.ready, 1);
    } finally {
      if (blocker) {
        if (blockerInTransaction) await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }
      await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => undefined);
      await pool.end();
    }
  },
);
