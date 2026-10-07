import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

import { loadConfig } from "./config.js";
import { createPool } from "./db.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const codeRoot = dirname(currentDirectory);
const packageRoot = basename(codeRoot) === "dist" ? dirname(codeRoot) : codeRoot;
export const defaultMigrationsDirectory = join(packageRoot, "migrations");

const migrationLockNamespace = ["pindou", "schema-migrations"] as const;
const transactionControlStatement = /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;\s*(?:--.*)?$/im;

export interface MigrationFile {
  version: string;
  checksum: string;
  sql: string;
}

export interface MigrationQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface MigrationClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<MigrationQueryResult<Row>>;
}

export function requireMigrationMaintenanceAcknowledgement(
  environment: NodeJS.ProcessEnv,
  nodeEnv: string,
): void {
  if (nodeEnv === "production"
    && environment.PINDOU_MIGRATION_MAINTENANCE_ACKNOWLEDGED !== "true") {
    throw new Error(
      "PINDOU_MIGRATION_MAINTENANCE_ACKNOWLEDGED must be exactly true in production after all API and worker writers are drained",
    );
  }
}

export async function assertNoCompetingMigrationConnections(client: MigrationClient): Promise<void> {
  const result = await client.query<{ connection_count: number | string }>(
    `SELECT count(*)::integer AS connection_count
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND backend_type = 'client backend'
       AND pid <> pg_backend_pid()`,
  );
  const connectionCount = Number(result.rows[0]?.connection_count ?? 0);
  if (!Number.isSafeInteger(connectionCount) || connectionCount !== 0) {
    throw new Error(
      `Migration maintenance preflight found ${String(connectionCount)} other client connection(s) to the current database; block new connections and drain every API and worker role before migrating`,
    );
  }
}

interface AppliedMigrationRow {
  version: string;
  checksum: string | null;
}

export function calculateMigrationChecksum(sql: string): string {
  // Git may check out the same file with CRLF on Windows and LF in production.
  // Normalize only line endings so semantic edits still invalidate the checksum.
  return createHash("sha256").update(sql.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
}

export async function loadMigrationFiles(
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<MigrationFile[]> {
  const fileNames = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right, "en"));

  const migrations: MigrationFile[] = [];
  for (const version of fileNames) {
    if (!/^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/.test(version)) {
      throw new Error(`Invalid migration filename: ${version}`);
    }

    const sql = await readFile(join(migrationsDirectory, version), "utf8");
    if (transactionControlStatement.test(sql)) {
      throw new Error(
        `Migration ${version} contains a top-level transaction statement; the migration runner owns the transaction`,
      );
    }

    migrations.push({
      version,
      sql,
      checksum: calculateMigrationChecksum(sql),
    });
  }

  return migrations;
}

export async function assertPublicSearchPath(client: MigrationClient): Promise<void> {
  const result = await client.query<{ current_schema: string | null; schemas: string[] }>(
    "SELECT current_schema() AS current_schema, current_schemas(false) AS schemas",
  );
  const row = result.rows[0];
  if (row?.current_schema !== "public"
    || !Array.isArray(row.schemas)
    || row.schemas.length !== 1
    || row.schemas[0] !== "public") {
    throw new Error("Migration session search_path must resolve only to public");
  }
}

export async function runMigrationTransaction<T>(
  client: MigrationClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL search_path TO public");
    await assertPublicSearchPath(client);
    const result = await operation();
    await assertPublicSearchPath(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original migration failure; a broken connection will be discarded by the pool.
    }
    throw error;
  }
}

async function prepareMetadataTable(client: MigrationClient): Promise<void> {
  await runMigrationTransaction(client, async () => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version text PRIMARY KEY,
        checksum char(64),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      ALTER TABLE public.schema_migrations
      ADD COLUMN IF NOT EXISTS checksum char(64)
    `);
  });
}

export async function assertDatabaseMigrationState(
  client: MigrationClient,
  migrations: readonly MigrationFile[],
  options: { requireComplete?: boolean } = {},
): Promise<void> {
  const knownByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const applied = await client.query<AppliedMigrationRow>(
    `SELECT version, checksum::text AS checksum
     FROM public.schema_migrations
     ORDER BY version`,
  );
  const unknownVersions = applied.rows
    .map((row) => row.version)
    .filter((version) => !knownByVersion.has(version));

  if (unknownVersions.length > 0) {
    throw new Error(
      `Database contains migration version(s) unknown to this release: ${unknownVersions.join(", ")}; refusing to apply an older or divergent migration set`,
    );
  }

  for (const row of applied.rows) {
    const known = knownByVersion.get(row.version)!;
    if (options.requireComplete && row.checksum === null) {
      throw new Error(`Cannot seed before migration ${row.version} has a verified checksum`);
    }
    if (row.checksum !== null && row.checksum !== known.checksum) {
      throw new Error(
        `Checksum mismatch for applied migration ${row.version}: `
          + `database=${row.checksum} file=${known.checksum}`,
      );
    }
  }

  const appliedVersions = new Set(applied.rows.map((row) => row.version));
  let firstMissingVersion: string | null = null;
  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      firstMissingVersion ??= migration.version;
      continue;
    }
    if (firstMissingVersion !== null) {
      throw new Error(
        `Applied migrations are not a continuous prefix of this release: missing ${firstMissingVersion} before applied ${migration.version}`,
      );
    }
  }

  if (options.requireComplete && applied.rows.length !== migrations.length) {
    const missingVersions = migrations
      .filter((migration) => !appliedVersions.has(migration.version))
      .map((migration) => migration.version);
    throw new Error(
      `Cannot seed before every migration is applied; missing: ${missingVersions.join(", ")}`,
    );
  }
}

async function recordLegacyChecksum(
  client: MigrationClient,
  migration: MigrationFile,
): Promise<void> {
  await runMigrationTransaction(client, async () => {
    const updated = await client.query(
      `UPDATE public.schema_migrations
       SET checksum = $2
       WHERE version = $1 AND checksum IS NULL`,
      [migration.version, migration.checksum],
    );
    if (updated.rowCount !== 1) {
      throw new Error(`Could not record checksum for legacy migration ${migration.version}`);
    }
  });
}

async function applyMigration(client: MigrationClient, migration: MigrationFile): Promise<void> {
  await runMigrationTransaction(client, async () => {
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO public.schema_migrations(version, checksum)
       VALUES ($1, $2)`,
      [migration.version, migration.checksum],
    );
  });
}

async function enforceChecksumInvariant(client: MigrationClient): Promise<void> {
  const missingChecksums = await client.query<{ version: string }>(
    `SELECT version
     FROM public.schema_migrations
     WHERE checksum IS NULL
     ORDER BY version`,
  );
  if (missingChecksums.rows.length > 0) {
    throw new Error(
      `Cannot validate legacy migrations missing from this release: ${missingChecksums.rows
        .map((row) => row.version)
        .join(", ")}`,
    );
  }

  await runMigrationTransaction(client, async () => {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.schema_migrations'::regclass
            AND conname = 'schema_migrations_checksum_format'
        ) THEN
          ALTER TABLE public.schema_migrations
          ADD CONSTRAINT schema_migrations_checksum_format
          CHECK (checksum ~ '^[0-9a-f]{64}$');
        END IF;
      END
      $$
    `);
    await client.query(`
      ALTER TABLE public.schema_migrations
      ALTER COLUMN checksum SET NOT NULL
    `);
  });
}

export async function applyMigrationSet(
  client: MigrationClient,
  migrations: readonly MigrationFile[],
  onApplied: (version: string) => void = () => undefined,
  knownMigrations: readonly MigrationFile[] = migrations,
): Promise<void> {
  await withMigrationAdvisoryLock(client, async () => {
    await prepareMetadataTable(client);
    await assertDatabaseMigrationState(client, knownMigrations);

    for (const migration of migrations) {
      const applied = await client.query<AppliedMigrationRow>(
        `SELECT version, checksum::text AS checksum
         FROM public.schema_migrations
         WHERE version = $1`,
        [migration.version],
      );
      const existing = applied.rows[0];

      if (existing) {
        if (existing.checksum === null) {
          await recordLegacyChecksum(client, migration);
          continue;
        }
        if (existing.checksum !== migration.checksum) {
          throw new Error(
            `Checksum mismatch for applied migration ${migration.version}: ` +
              `database=${existing.checksum} file=${migration.checksum}`,
          );
        }
        continue;
      }

      await applyMigration(client, migration);
      onApplied(migration.version);
    }

    await enforceChecksumInvariant(client);
  });
}

export async function withMigrationAdvisoryLock<T>(
  client: MigrationClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query(
    "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
    [...migrationLockNamespace],
  );

  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      const unlockResult = await client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS unlocked",
        [...migrationLockNamespace],
      );
      if (unlockResult.rows[0]?.unlocked !== true && operationError === undefined) {
        throw new Error("PostgreSQL migration advisory lock was not held by this session");
      }
    } catch (unlockError) {
      if (operationError === undefined) throw unlockError;
    }
  }
}

export function adaptPoolClient(client: PoolClient): MigrationClient {
  return {
    async query<Row = Record<string, unknown>>(sql: string, parameters?: unknown[]) {
      const result = await client.query(sql, parameters);
      return {
        rows: result.rows as Row[],
        rowCount: result.rowCount,
      };
    },
  };
}

export async function runMigrations(
  pool: Pool,
  migrationsDirectory = defaultMigrationsDirectory,
  onApplied: (version: string) => void = (version) => process.stdout.write(`applied ${version}\n`),
  options: { requireExclusiveDatabase?: boolean } = {},
): Promise<void> {
  const migrations = await loadMigrationFiles(migrationsDirectory);
  const poolClient = await pool.connect();
  try {
    const client = adaptPoolClient(poolClient);
    if (options.requireExclusiveDatabase) await assertNoCompetingMigrationConnections(client);
    await applyMigrationSet(client, migrations, onApplied);
  } finally {
    poolClient.release();
  }
}

export async function migrateFromEnvironment(): Promise<void> {
  await import("dotenv/config");
  const config = loadConfig(process.env, "migration");
  requireMigrationMaintenanceAcknowledgement(process.env, config.nodeEnv);
  const pool = createPool(config);
  try {
    await runMigrations(pool, defaultMigrationsDirectory, undefined, {
      requireExclusiveDatabase: config.nodeEnv === "production",
    });
  } finally {
    await pool.end();
  }
}

const invokedScript = process.argv[1];
if (invokedScript && resolve(invokedScript) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await migrateFromEnvironment();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
