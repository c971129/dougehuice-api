import assert from "node:assert/strict";
import { test } from "node:test";

import { createPool } from "../src/db.js";

test("creates a bounded PostgreSQL pool and handles idle-client errors through a reporter", async () => {
  const observed: Error[] = [];
  const pool = createPool({
    databaseUrl: "postgresql://pindou:pindou_local_only@127.0.0.1:54329/pindou",
    databaseSsl: false,
    databasePoolMax: 7,
    databaseIdleTimeoutMilliseconds: 41_000,
    databaseConnectionTimeoutMilliseconds: 4_100,
    databaseStatementTimeoutMilliseconds: 31_000,
    databaseLockTimeoutMilliseconds: 4_200,
    databaseIdleTransactionTimeoutMilliseconds: 16_000,
  }, (error) => observed.push(error));

  try {
    assert.equal(pool.options.max, 7);
    assert.equal(pool.options.idleTimeoutMillis, 41_000);
    assert.equal(pool.options.connectionTimeoutMillis, 4_100);
    assert.equal(pool.options.statement_timeout, 31_000);
    assert.equal(pool.options.lock_timeout, 4_200);
    assert.equal(pool.options.idle_in_transaction_session_timeout, 16_000);

    const failure = new Error("simulated idle connection failure");
    assert.doesNotThrow(() => pool.emit("error", failure));
    assert.deepEqual(observed, [failure]);
  } finally {
    await pool.end();
  }
});
