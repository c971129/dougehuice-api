import type { PoolClient } from "pg";

import { createPool } from "../db.js";
import { loadConfig } from "../config.js";
import {
  defaultMigrationsDirectory,
  loadMigrationFiles,
  requireMigrationMaintenanceAcknowledgement,
  runMigrations,
} from "../migrate.js";
import { REQUIRED_MIGRATION_VERSIONS } from "../migration-manifest.js";
import { runSeed } from "../seed.js";

const TARGET_LABEL = "dghc";

type MigrationEvent = {
  confirmation?: unknown;
  target?: unknown;
  targetVerified?: unknown;
  writersDrained?: unknown;
};

type RolePreflight = {
  tls: boolean;
  actual_role: string;
  is_superuser: boolean;
  can_create_role: boolean;
  can_create_database: boolean;
  can_replicate: boolean;
  can_bypass_rls: boolean;
  can_create_public: boolean;
  can_use_public: boolean;
};

class MigrationGateError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "MigrationGateError";
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function requireOperatorAcknowledgements(event: unknown): void {
  const request = asRecord(event) as MigrationEvent | null;
  const expectedConfirmation = process.env.PINDOU_MIGRATION_CONFIRMATION;
  if (!request || !expectedConfirmation || expectedConfirmation.length < 32
    || request.confirmation !== expectedConfirmation
    || request.target !== TARGET_LABEL
    || request.targetVerified !== true
    || request.writersDrained !== true) {
    throw new MigrationGateError("MIGRATION_CONFIRMATION_REQUIRED");
  }

  if (process.env.NODE_ENV !== "production"
    || process.env.PINDOU_MIGRATION_ARMED !== "true"
    || process.env.PINDOU_MIGRATION_TARGET_ACKNOWLEDGED !== TARGET_LABEL
    || !expectedConfirmation
    || process.env.PINDOU_MIGRATION_WRITERS_DRAINED !== "true"
    || process.env.PINDOU_MIGRATION_MAINTENANCE_ACKNOWLEDGED !== "true"
    || process.env.DATABASE_SSL !== "true"
    || process.env.DATABASE_POOL_MAX !== "1"
    || !process.env.DATABASE_URL?.trim()
    || !process.env.PINDOU_MIGRATION_EXPECTED_HOST?.trim()
    || !process.env.PINDOU_MIGRATION_EXPECTED_DATABASE?.trim()
    || !process.env.PINDOU_MIGRATION_EXPECTED_ROLE?.trim()) {
    throw new MigrationGateError("MIGRATION_ENVIRONMENT_NOT_ARMED");
  }
}

function requireExpectedDatabase(config: ReturnType<typeof loadConfig>): void {
  if (!config.databaseSsl) throw new MigrationGateError("DATABASE_TLS_REQUIRED");

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(config.databaseUrl);
  } catch {
    throw new MigrationGateError("DATABASE_TARGET_INVALID");
  }

  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (databaseUrl.hostname !== process.env.PINDOU_MIGRATION_EXPECTED_HOST
    || databaseName !== process.env.PINDOU_MIGRATION_EXPECTED_DATABASE) {
    throw new MigrationGateError("DATABASE_TARGET_MISMATCH");
  }
}

async function assertMigrationRole(): Promise<void> {
  const config = loadConfig(process.env, "migration");
  requireExpectedDatabase(config);

  const pool = createPool(config, () => {
    console.error(JSON.stringify({
      event: "pindou_one_shot_migration",
      ok: false,
      code: "DATABASE_IDLE_CONNECTION_ERROR",
    }));
  });
  let client: PoolClient | undefined;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    transactionStarted = true;
    const result = await client.query<RolePreflight>(
      `SELECT stats.ssl AS tls,
              current_user AS actual_role,
              role.rolsuper AS is_superuser,
              role.rolcreaterole AS can_create_role,
              role.rolcreatedb AS can_create_database,
              role.rolreplication AS can_replicate,
              role.rolbypassrls AS can_bypass_rls,
              pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public,
              pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_public
       FROM pg_catalog.pg_stat_ssl AS stats
       JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user
       WHERE stats.pid = pg_catalog.pg_backend_pid()`,
    );
    const row = result.rows[0];
    if (!row?.tls) throw new MigrationGateError("DATABASE_TLS_NOT_ACTIVE");
    if (row.actual_role !== process.env.PINDOU_MIGRATION_EXPECTED_ROLE) {
      throw new MigrationGateError("DATABASE_ROLE_MISMATCH");
    }
    if (row.is_superuser || row.can_create_role || row.can_create_database
      || row.can_replicate || row.can_bypass_rls) {
      throw new MigrationGateError("DATABASE_ROLE_TOO_PRIVILEGED");
    }
    if (!row.can_create_public || !row.can_use_public) {
      throw new MigrationGateError("DATABASE_ROLE_DDL_PERMISSION_MISSING");
    }
  } finally {
    if (transactionStarted) {
      try {
        await client?.query("ROLLBACK");
      } catch {
        // Do not log driver errors; the connection is closed below.
      }
    }
    client?.release();
    await pool.end();
  }
}

function safeErrorCode(error: unknown): string {
  const candidate = error instanceof MigrationGateError
    ? error.code
    : typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof candidate === "string" && /^[A-Z0-9_]{1,64}$/.test(candidate)
    ? candidate
    : "MIGRATION_EXECUTION_FAILED";
}

export async function main(
  event: unknown,
): Promise<{ ok: true; migrationCount: number; seed: "completed" }> {
  try {
    requireOperatorAcknowledgements(event);
    if (REQUIRED_MIGRATION_VERSIONS.length !== 58) {
      throw new MigrationGateError("MIGRATION_MANIFEST_NOT_58_FILES");
    }

    const migrations = await loadMigrationFiles(defaultMigrationsDirectory);
    if (migrations.length !== REQUIRED_MIGRATION_VERSIONS.length
      || migrations.some((migration, index) => migration.version !== REQUIRED_MIGRATION_VERSIONS[index])) {
      throw new MigrationGateError("MIGRATION_MANIFEST_MISMATCH");
    }

    await assertMigrationRole();
    const config = loadConfig(process.env, "migration");
    requireMigrationMaintenanceAcknowledgement(process.env, config.nodeEnv);
    const pool = createPool(config, () => {
      console.error(JSON.stringify({
        event: "pindou_one_shot_migration",
        ok: false,
        code: "DATABASE_IDLE_CONNECTION_ERROR",
      }));
    });
    try {
      await runMigrations(
        pool,
        defaultMigrationsDirectory,
        (version) => console.log(JSON.stringify({
          event: "pindou_one_shot_migration",
          status: "applied",
          version,
        })),
        { requireExclusiveDatabase: true },
      );
      await runSeed(pool, process.env, config.nodeEnv);
    } finally {
      await pool.end();
    }

    console.log(JSON.stringify({
      event: "pindou_one_shot_migration",
      ok: true,
      migrationCount: migrations.length,
      seed: "completed",
    }));
    return { ok: true, migrationCount: migrations.length, seed: "completed" };
  } catch (error) {
    const code = safeErrorCode(error);
    console.error(JSON.stringify({ event: "pindou_one_shot_migration", ok: false, code }));
    throw new Error(`PINDOU_MIGRATION_FAILED:${code}`);
  }
}
