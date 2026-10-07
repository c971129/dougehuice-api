"use strict";

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function getExpectedRole(env) {
  const expectedRole = typeof env.DATABASE_EXPECTED_ROLE === "string"
    ? env.DATABASE_EXPECTED_ROLE
    : "";
  if (!expectedRole || expectedRole.trim() !== expectedRole) {
    throw new ProbeFailure("DATABASE_ROLE_CONFIG_INVALID");
  }
  return expectedRole;
}

function getPoolOptions(env) {
  const rawUrl = typeof env.DATABASE_URL === "string" ? env.DATABASE_URL.trim() : "";
  if (!rawUrl || env.DATABASE_SSL !== "true" || env.DATABASE_POOL_MAX !== "2") {
    throw new ProbeFailure("DATABASE_CONFIG_INVALID");
  }

  let databaseUrl;
  try {
    databaseUrl = new URL(rawUrl);
  } catch {
    throw new ProbeFailure("DATABASE_CONFIG_INVALID");
  }
  const hostname = databaseUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)
    || !databaseUrl.hostname
    || !databaseUrl.username
    || databaseUrl.pathname.length < 2
    || databaseUrl.search
    || databaseUrl.hash
    || ["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new ProbeFailure("DATABASE_CONFIG_INVALID");
  }

  return {
    connectionString: rawUrl,
    ssl: { rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 5_000,
    application_name: "pindou-cloudbase-readonly-tls-probe",
  };
}

function createHandler({ Pool, env = process.env, log = console.log } = {}) {
  return async function main(event = {}) {
    if (event.probeRuntime === true) {
      try {
        const PoolConstructor = Pool ?? require("pg").Pool;
        if (typeof PoolConstructor !== "function") throw new Error("driver unavailable");
        return { ok: true, runtimeOnly: true, driverLoaded: true };
      } catch {
        const code = "PG_DRIVER_LOAD_FAILED";
        log(JSON.stringify({ event: "cloudbase_pg_tls_probe", ok: false, code }));
        return { ok: false, code };
      }
    }

    let pool;
    let client;
    let transactionStarted = false;
    try {
      const expectedRole = getExpectedRole(env);
      const options = getPoolOptions(env);
      const PoolConstructor = Pool ?? require("pg").Pool;
      pool = new PoolConstructor(options);
      client = await pool.connect();
      await client.query("BEGIN READ ONLY");
      transactionStarted = true;
      const result = await client.query(
        "SELECT stats.ssl, pg_catalog.current_setting('transaction_read_only') AS read_only, "
          + "current_user AS actual_role, role.rolsuper AS is_superuser, "
          + "role.rolcreaterole AS can_create_role, role.rolcreatedb AS can_create_database, "
          + "role.rolreplication AS can_replicate, role.rolbypassrls AS can_bypass_rls, "
          + "pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public "
          + "FROM pg_catalog.pg_stat_ssl AS stats "
          + "JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user "
          + "WHERE stats.pid = pg_catalog.pg_backend_pid()",
      );
      const row = result.rows?.[0];
      if (row?.ssl !== true) throw new ProbeFailure("TLS_NOT_ACTIVE");
      if (row.read_only !== "on") throw new ProbeFailure("READ_ONLY_NOT_ACTIVE");
      if (row.actual_role !== expectedRole) throw new ProbeFailure("DATABASE_ROLE_MISMATCH");
      if ([
        row.is_superuser,
        row.can_create_role,
        row.can_create_database,
        row.can_replicate,
        row.can_bypass_rls,
      ].some((value) => value !== false) || row.can_create_public !== false) {
        throw new ProbeFailure("DATABASE_ROLE_PRIVILEGED");
      }
      return { ok: true, tls: true, readOnly: true, roleVerified: true, poolMax: 2 };
    } catch (error) {
      const code = error instanceof ProbeFailure ? error.code : "DATABASE_CONNECT_FAILED";
      log(JSON.stringify({ event: "cloudbase_pg_tls_probe", ok: false, code }));
      return { ok: false, code };
    } finally {
      if (transactionStarted && client) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The probe never commits and the one-shot pool is always closed.
        }
      }
      try {
        client?.release();
      } catch {
        // Do not expose driver errors, which may contain connection metadata.
      }
      if (pool) {
        try {
          await pool.end();
        } catch {
          // Do not expose driver errors, which may contain connection metadata.
        }
      }
    }
  };
}

exports.main = createHandler();
exports.createHandler = createHandler;
exports.getPoolOptions = getPoolOptions;
