import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import {
  calculateMigrationChecksum,
  loadMigrationFiles,
  type MigrationClient,
} from "../src/migrate.js";
import { runSeed } from "../src/seed.js";

function adaptPGlite(database: PGlite): MigrationClient {
  let migrationLockHeld = false;
  return {
    async query<Row = Record<string, unknown>>(sql: string, parameters?: unknown[]) {
      if (sql.includes("pg_advisory_unlock(")) {
        const unlocked = migrationLockHeld;
        migrationLockHeld = false;
        return { rows: [{ unlocked }] as Row[], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_lock(")) {
        assert.equal(migrationLockHeld, false);
        migrationLockHeld = true;
        return { rows: [{}] as Row[], rowCount: 1 };
      }
      if (parameters === undefined) {
        const results = await database.exec(sql);
        const result = results.at(-1);
        return {
          rows: (result?.rows ?? []) as Row[],
          rowCount: result?.affectedRows ?? result?.rows.length ?? 0,
        };
      }
      const result = await database.query(sql, parameters as never[]);
      return {
        rows: result.rows as Row[],
        rowCount: result.affectedRows ?? result.rows.length,
      };
    },
  };
}

function poolFor(database: PGlite): Pool {
  const migrationClient = adaptPGlite(database);
  const client = {
    query: migrationClient.query,
    release: () => undefined,
  } as unknown as PoolClient;
  return { connect: async () => client } as unknown as Pool;
}

function preflightPool(connectionCount: number): {
  pool: Pool;
  queries: string[];
} {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      return {
        rows: sql.includes("pg_stat_activity") ? [{ connection_count: connectionCount }] : [],
        rowCount: 1,
      };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  return {
    pool: { connect: async () => client } as unknown as Pool,
    queries,
  };
}

async function createSeedSchema(database: PGlite, appliedMigrations: boolean): Promise<void> {
  await database.exec(`
    CREATE SCHEMA tenant;
    CREATE TABLE public.schema_migrations (
      version text PRIMARY KEY,
      checksum char(64),
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.palettes (
      id text PRIMARY KEY,
      name text,
      brand text,
      series text,
      material text,
      bead_size_mm numeric,
      verified boolean,
      version text,
      source_name text,
      source_url text,
      source_revision text,
      source_license text,
      retired boolean
    );
    CREATE TABLE public.palette_colors (
      palette_id text,
      code text,
      name text,
      hex text,
      finish text,
      unit_price_cents integer,
      sort_order integer,
      available boolean,
      PRIMARY KEY (palette_id, code)
    );
    SET search_path TO tenant;
  `);
  if (appliedMigrations) {
    for (const migration of await loadMigrationFiles()) {
      await database.query(
        "INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum],
      );
    }
  }
}

describe("production seed safeguards", () => {
  it("requires the exact production maintenance acknowledgement before connecting", async () => {
    let connectCalls = 0;
    const pool = {
      connect: async () => {
        connectCalls += 1;
        throw new Error("unexpected database connection");
      },
    } as unknown as Pool;

    await assert.rejects(
      runSeed(pool, {}, "production"),
      /PINDOU_MIGRATION_MAINTENANCE_ACKNOWLEDGED must be exactly true/,
    );
    assert.equal(connectCalls, 0);
  });

  it("fails closed when another client connection is present", async () => {
    const { pool, queries } = preflightPool(1);
    await assert.rejects(
      runSeed(pool, { PINDOU_MIGRATION_MAINTENANCE_ACKNOWLEDGED: "true" }, "production"),
      /found 1 other client connection\(s\)/,
    );
    assert.equal(queries.some((sql) => sql.includes("pg_advisory_lock(")), false);
    assert.equal(queries.some((sql) => sql.includes("INSERT INTO public.palettes")), false);
  });

  it("refuses to seed unless every migration checksum is applied", async () => {
    const database = new PGlite();
    try {
      await createSeedSchema(database, false);
      await assert.rejects(
        runSeed(poolFor(database), {}, "test"),
        /Cannot seed before every migration is applied/,
      );
      const result = await database.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM public.palettes",
      );
      assert.equal(result.rows[0]?.count, 0);
    } finally {
      await database.close();
    }
  });

  it("serializes seed with migrations, pins SQL to public, and preserves caller search_path", async () => {
    const database = new PGlite();
    try {
      await createSeedSchema(database, true);
      const pool = poolFor(database);
      await runSeed(pool, {}, "test");

      const state = await database.query<{
        current_schema: string;
        palette_count: number;
        color_count: number;
        tenant_palette_table: string | null;
      }>(`
        SELECT current_schema() AS current_schema,
               (SELECT count(*)::integer FROM public.palettes) AS palette_count,
               (SELECT count(*)::integer FROM public.palette_colors) AS color_count,
               to_regclass('tenant.palettes')::text AS tenant_palette_table
      `);
      assert.equal(state.rows[0]?.current_schema, "tenant");
      assert.ok((state.rows[0]?.palette_count ?? 0) > 0);
      assert.ok((state.rows[0]?.color_count ?? 0) > 0);
      assert.equal(state.rows[0]?.tenant_palette_table, null);

      const migrations = await loadMigrationFiles();
      assert.equal(migrations.every((migration) => migration.checksum === calculateMigrationChecksum(migration.sql)), true);
    } finally {
      await database.close();
    }
  });
});
