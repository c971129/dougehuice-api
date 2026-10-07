import pg from "pg";

import type { AppConfig } from "./config.js";

const { Pool } = pg;

export type PoolIdleClientErrorReporter = (error: Error) => void;

function reportIdleClientError(error: Error): void {
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  console.error(JSON.stringify({
    level: "error",
    event: "postgres_pool_idle_client_error",
    ...(code ? { code } : {}),
    name: error.name,
    message: error.message,
  }));
}

export function createPool(
  config: Pick<
    AppConfig,
    | "databaseUrl"
    | "databaseSsl"
    | "databasePoolMax"
    | "databaseIdleTimeoutMilliseconds"
    | "databaseConnectionTimeoutMilliseconds"
    | "databaseStatementTimeoutMilliseconds"
    | "databaseLockTimeoutMilliseconds"
    | "databaseIdleTransactionTimeoutMilliseconds"
  >,
  onIdleClientError: PoolIdleClientErrorReporter = reportIdleClientError,
): pg.Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
    max: config.databasePoolMax ?? 10,
    idleTimeoutMillis: config.databaseIdleTimeoutMilliseconds ?? 30_000,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMilliseconds ?? 5_000,
    statement_timeout: config.databaseStatementTimeoutMilliseconds ?? 30_000,
    lock_timeout: config.databaseLockTimeoutMilliseconds ?? 5_000,
    idle_in_transaction_session_timeout: config.databaseIdleTransactionTimeoutMilliseconds ?? 15_000,
  });
  pool.on("error", onIdleClientError);
  return pool;
}
