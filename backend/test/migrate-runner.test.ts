import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { AppError } from "../src/errors.js";
import {
  applyMigrationSet,
  assertNoCompetingMigrationConnections,
  calculateMigrationChecksum,
  loadMigrationFiles,
  requireMigrationMaintenanceAcknowledgement,
  type MigrationClient,
} from "../src/migrate.js";
import { REQUIRED_MIGRATION_VERSIONS } from "../src/migration-manifest.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

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
        assert.equal(migrationLockHeld, false, "migration lock must not be acquired twice");
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
  const query = (text: string, values?: unknown[]) =>
    values === undefined ? database.query(text) : database.query(text, values as never[]);
  const client = {
    query,
    release: () => undefined,
  } as unknown as PoolClient;

  return {
    query,
    connect: async () => client,
    end: () => database.close(),
  } as unknown as Pool;
}

describe("PostgreSQL migration runner", () => {
  it("requires an explicit drained maintenance window for production migrations", async () => {
    assert.throws(
      () => requireMigrationMaintenanceAcknowledgement({}, "production"),
      /PINDOU_MIGRATION_MAINTENANCE_ACKNOWLEDGED must be exactly true/,
    );
    assert.throws(
      () => requireMigrationMaintenanceAcknowledgement({
        PINDOU_MIGRATION_MAINTENANCE_ACKNOWLEDGED: "TRUE",
      }, "production"),
      /must be exactly true/,
    );
    assert.doesNotThrow(() => requireMigrationMaintenanceAcknowledgement({
      PINDOU_MIGRATION_MAINTENANCE_ACKNOWLEDGED: "true",
    }, "production"));
    assert.doesNotThrow(() => requireMigrationMaintenanceAcknowledgement({}, "test"));

    let preflightSql = "";
    const competingClient: MigrationClient = {
      query: async <Row>(sql: string) => {
        preflightSql = sql;
        return {
        rows: [{ connection_count: 1 }] as unknown as Row[],
        rowCount: 1,
        };
      },
    };
    await assert.rejects(
      assertNoCompetingMigrationConnections(competingClient),
      /found 1 other client connection\(s\).*drain every API and worker role/,
    );
    assert.match(preflightSql, /datname\s*=\s*current_database\(\)/);
    assert.doesNotMatch(preflightSql, /usename\s*=\s*current_user/);
    const isolatedClient: MigrationClient = {
      query: async <Row>() => ({
        rows: [{ connection_count: 0 }] as unknown as Row[],
        rowCount: 1,
      }),
    };
    await assert.doesNotReject(assertNoCompetingMigrationConnections(isolatedClient));
  });

  it("keeps the runtime readiness manifest identical to the shipped SQL directory", async () => {
    const migrations = await loadMigrationFiles();
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [...REQUIRED_MIGRATION_VERSIONS],
    );
  });

  it("applies shipped migrations, records checksums, and stays idempotent", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      const applied: string[] = [];
      const client = adaptPGlite(database);

      await applyMigrationSet(client, migrations, (version) => applied.push(version));
      assert.deepEqual(applied, migrations.map((migration) => migration.version));

      const records = await database.query<{ version: string; checksum: string }>(
        "SELECT version, checksum::text AS checksum FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(
        records.rows,
        migrations.map(({ version, checksum }) => ({ version, checksum })),
      );

      const gridDimensionConstraints = await database.query<{
        table_name: string;
        constraint_name: string;
        definition: string;
      }>(`
        SELECT relation.relname AS table_name,
               constraint_row.conname AS constraint_name,
               pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
        WHERE constraint_row.conname = ANY(ARRAY[
          'project_revisions_width_check',
          'project_revisions_height_check',
          'generation_candidates_width_check',
          'generation_candidates_height_check',
          'project_drafts_width_check',
          'project_drafts_height_check',
          'creation_drafts_width_check',
          'creation_drafts_height_check'
        ])
        ORDER BY relation.relname, constraint_row.conname
      `);
      assert.equal(gridDimensionConstraints.rows.length, 8);
      for (const constraint of gridDimensionConstraints.rows) {
        assert.match(constraint.definition, /200/);
        assert.doesNotMatch(constraint.definition, /4096/);
      }

      const boundedAggregateConstraints = await database.query<{
        constraint_name: string;
        definition: string;
      }>(`
        SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = ANY(ARRAY[
          'generation_jobs_size_check',
          'projects_current_bead_count_valid',
          'projects_current_color_count_valid'
        ])
        ORDER BY conname
      `);
      assert.deepEqual(
        boundedAggregateConstraints.rows.map((constraint) => constraint.constraint_name),
        [
          "generation_jobs_size_check",
          "projects_current_bead_count_valid",
          "projects_current_color_count_valid",
        ],
      );
      assert.match(
        boundedAggregateConstraints.rows.find(
          (constraint) => constraint.constraint_name === "generation_jobs_size_check",
        )?.definition ?? "",
        /64/,
      );
      for (const constraint of boundedAggregateConstraints.rows.filter(
        (candidate) => candidate.constraint_name.startsWith("projects_current_"),
      )) {
        assert.match(constraint.definition, /40000/);
      }

      const removedCommunitySchema = await database.query<{
        publication_table: string | null;
        retired_palette_function_count: number;
      }>(`
        SELECT to_regclass('public.community_publications')::text AS publication_table,
               (
                 SELECT count(*)::integer
                 FROM pg_proc AS procedure
                 JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
                 WHERE namespace.nspname = 'public'
                   AND procedure.proname = ANY(ARRAY[
                     'enforce_community_publication_active_palette',
                     'enforce_community_copy_source_active_palette'
                   ])
               ) AS retired_palette_function_count
      `);
      assert.deepEqual(removedCommunitySchema.rows[0], {
        publication_table: null,
        retired_palette_function_count: 0,
      });

      const maxColorsConstraints = await database.query<{ constraint_name: string; definition: string }>(`
        SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = ANY(ARRAY[
          'creation_drafts_options_max_colors_check',
          'generation_jobs_options_max_colors_check'
        ])
        ORDER BY conname
      `);
      assert.deepEqual(
        maxColorsConstraints.rows.map((constraint) => constraint.constraint_name),
        ["creation_drafts_options_max_colors_check", "generation_jobs_options_max_colors_check"],
      );
      for (const constraint of maxColorsConstraints.rows) {
        assert.match(constraint.definition, />=\s*\(?5/);
        assert.match(constraint.definition, /<=\s*\(?32/);
        assert.match(constraint.definition, /jsonb_typeof/);
        assert.doesNotMatch(constraint.definition, /<= 24/);
      }

      const options = {
        crop: {
          ratio: "1:1", freeRatio: 1, rotation: 0, scale: 1,
          offsetX: 0, offsetY: 0, flipX: false, flipY: false,
        },
        removeBackground: true,
        figureStyle: "chibi-full",
        coupleLayout: "together",
        maxColors: 25,
        transparentBackground: false,
        inventoryOnly: false,
        brightness: 0,
        contrast: 0,
        saturation: 0,
        dither: false,
      };
      await database.exec(`
        INSERT INTO users(id, display_name)
        VALUES ('00000000-0000-4000-8000-000000005101', '0051 生成上限测试');
        INSERT INTO palettes(id, name, version, brand, bead_size_mm, verified)
        VALUES ('0051-max-colors-palette', '0051 生成上限色卡', 1, '测试', 2.6, false);
      `);
      await database.query(
        `INSERT INTO generation_jobs(
           id, user_id, kind, status, palette_id, options, cost, seed,
           width, height, progress, available_at, created_at, updated_at, completed_at
         ) VALUES (
           '00000000-0000-4000-8000-000000005102',
           '00000000-0000-4000-8000-000000005101',
           'pixel', 'completed', '0051-max-colors-palette', $1::jsonb, 0, '0051-max-colors',
           8, 8, 100, now(), now(), now(), now()
         )`,
        [JSON.stringify(options)],
      );
      await database.query(
        `UPDATE generation_jobs
         SET options = jsonb_set(options, '{maxColors}', '32'::jsonb)
         WHERE id = '00000000-0000-4000-8000-000000005102'`,
      );
      for (const invalidMaxColors of [4, 33]) {
        await assert.rejects(database.query(
          `UPDATE generation_jobs
           SET options = jsonb_set(options, '{maxColors}', to_jsonb($1::integer))
           WHERE id = '00000000-0000-4000-8000-000000005102'`,
          [invalidMaxColors],
        ));
      }
      for (const expression of [
        "options - 'maxColors'",
        "jsonb_set(options, '{maxColors}', '\"16\"'::jsonb)",
        "jsonb_set(options, '{maxColors}', '16.5'::jsonb)",
      ]) {
        await assert.rejects(database.exec(`
          UPDATE generation_jobs SET options = ${expression}
          WHERE id = '00000000-0000-4000-8000-000000005102'
        `));
      }

      await database.exec(`
        INSERT INTO palette_color_migration_audit(
          entity_type, entity_id, old_palette_id, old_color_code, old_hex,
          new_palette_id, new_color_code, new_hex, delta_e_2000, reliable,
          migration_version
        ) VALUES (
          'project_revision', 'lowercase-hex-regression', 'mard-basic-v1', 'R12', '#e94359',
          'mard-48-v1', 'C5', '#01aceb', 1.2500, true, '0051'
        )
      `);
      const lowercaseAuditHex = await database.query<{ old_hex: string; new_hex: string }>(`
        SELECT old_hex, new_hex
        FROM palette_color_migration_audit
        WHERE entity_id = 'lowercase-hex-regression'
      `);
      assert.deepEqual(lowercaseAuditHex.rows, [{ old_hex: "#e94359", new_hex: "#01aceb" }]);

      const secondPass: string[] = [];
      await applyMigrationSet(client, migrations, (version) => secondPass.push(version));
      assert.deepEqual(secondPass, []);
    } finally {
      await database.close();
    }
  });

  it("creates the ledger and runs migration SQL in public despite a different caller search_path", async () => {
    const database = new PGlite();
    try {
      await database.exec("CREATE SCHEMA tenant; SET search_path TO tenant;");
      const sql = "CREATE TABLE search_path_probe(id integer PRIMARY KEY);";
      await applyMigrationSet(adaptPGlite(database), [{
        version: "9000_search_path_probe.sql",
        sql,
        checksum: calculateMigrationChecksum(sql),
      }]);

      const state = await database.query<{
        current_schema: string;
        ledger: string | null;
        public_table: string | null;
        tenant_table: string | null;
      }>(`
        SELECT current_schema() AS current_schema,
               to_regclass('public.schema_migrations')::text AS ledger,
               to_regclass('public.search_path_probe')::text AS public_table,
               to_regclass('tenant.search_path_probe')::text AS tenant_table
      `);
      assert.deepEqual(state.rows[0], {
        current_schema: "tenant",
        ledger: "public.schema_migrations",
        public_table: "public.search_path_probe",
        tenant_table: null,
      });
    } finally {
      await database.close();
    }
  });

  it("rolls back a migration that changes the transaction search_path", async () => {
    const database = new PGlite();
    try {
      await database.exec("CREATE SCHEMA tenant;");
      const sql = "SET LOCAL search_path TO tenant; CREATE TABLE rejected_search_path_probe(id integer);";
      await assert.rejects(
        applyMigrationSet(adaptPGlite(database), [{
          version: "9000_rejected_search_path_probe.sql",
          sql,
          checksum: calculateMigrationChecksum(sql),
        }]),
        /search_path must resolve only to public/,
      );

      const state = await database.query<{
        relation_name: string | null;
        applied_count: number;
      }>(`
        SELECT to_regclass('tenant.rejected_search_path_probe')::text AS relation_name,
               (SELECT count(*)::integer FROM public.schema_migrations
                WHERE version = '9000_rejected_search_path_probe.sql') AS applied_count
      `);
      assert.deepEqual(state.rows[0], { relation_name: null, applied_count: 0 });
    } finally {
      await database.close();
    }
  });

  it("backfills creation-draft maxColors by palette preset and enforces the current bound", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      const migrationIndex = migrations.findIndex(
        (candidate) => candidate.version === "0052_creation_draft_max_colors.sql",
      );
      const migration = migrations[migrationIndex];
      assert.equal(migration?.version, "0052_creation_draft_max_colors.sql");
      const client = adaptPGlite(database);
      await applyMigrationSet(client, migrations.slice(0, migrationIndex));
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('00000000-0000-4000-8000-000000005201', '0052-48'),
          ('00000000-0000-4000-8000-000000005202', '0052-72'),
          ('00000000-0000-4000-8000-000000005203', '0052-144'),
          ('00000000-0000-4000-8000-000000005204', '0052-221'),
          ('00000000-0000-4000-8000-000000005205', '0052-291'),
          ('00000000-0000-4000-8000-000000005206', '0052-custom');
        INSERT INTO palettes(id, name, brand, bead_size_mm, verified, version) VALUES
          ('mard-48-v1', '48', 'MARD', 2.6, false, 1),
          ('mard-72-v1', '72', 'MARD', 2.6, false, 1),
          ('mard-144-v1', '144', 'MARD', 2.6, false, 1),
          ('mard-221-v1', '221', 'MARD', 2.6, false, 1),
          ('mard-291-v1', '291', 'MARD', 2.6, false, 1),
          ('0052-custom', 'custom', '测试', 5, false, 1);
        INSERT INTO creation_drafts(
          user_id, id, draft_revision, name, kind, setup_step, palette_id,
          source_asset_id, width, height, options, grid_encoding, grid_cells
        ) VALUES
          ('00000000-0000-4000-8000-000000005201', '00000000-0000-4000-8000-000000005211', 1, '48', 'normal', 1, 'mard-48-v1', NULL, 1, 1, '{}'::jsonb, NULL, NULL),
          ('00000000-0000-4000-8000-000000005202', '00000000-0000-4000-8000-000000005212', 1, '72', 'normal', 1, 'mard-72-v1', NULL, 1, 1, '{"maxColors":9.5}'::jsonb, NULL, NULL),
          ('00000000-0000-4000-8000-000000005203', '00000000-0000-4000-8000-000000005213', 1, '144', 'normal', 1, 'mard-144-v1', NULL, 1, 1, '{"maxColors":4}'::jsonb, NULL, NULL),
          ('00000000-0000-4000-8000-000000005204', '00000000-0000-4000-8000-000000005214', 1, '221', 'normal', 1, 'mard-221-v1', NULL, 1, 1, '{}'::jsonb, NULL, NULL),
          ('00000000-0000-4000-8000-000000005205', '00000000-0000-4000-8000-000000005215', 1, '291', 'normal', 1, 'mard-291-v1', NULL, 1, 1, '{"maxColors":"bad"}'::jsonb, NULL, NULL),
          ('00000000-0000-4000-8000-000000005206', '00000000-0000-4000-8000-000000005216', 1, 'custom', 'normal', 1, '0052-custom', NULL, 1, 1, '{"maxColors":33}'::jsonb, NULL, NULL);
      `);
      await applyMigrationSet(client, [migration!], undefined, migrations);

      const repaired = await database.query<{ palette_id: string; max_colors: number }>(`
        SELECT palette_id, (options ->> 'maxColors')::integer AS max_colors
        FROM creation_drafts ORDER BY palette_id
      `);
      assert.deepEqual(repaired.rows, [
        { palette_id: "0052-custom", max_colors: 16 },
        { palette_id: "mard-144-v1", max_colors: 24 },
        { palette_id: "mard-221-v1", max_colors: 24 },
        { palette_id: "mard-291-v1", max_colors: 32 },
        { palette_id: "mard-48-v1", max_colors: 16 },
        { palette_id: "mard-72-v1", max_colors: 16 },
      ]);

      for (const expression of [
        "options - 'maxColors'",
        "jsonb_set(options, '{maxColors}', '4'::jsonb)",
        "jsonb_set(options, '{maxColors}', '33'::jsonb)",
        "jsonb_set(options, '{maxColors}', '\"bad\"'::jsonb)",
      ]) {
        await assert.rejects(database.exec(`
          UPDATE creation_drafts SET options = ${expression}
          WHERE palette_id = '0052-custom'
        `));
      }
      await database.exec(`
        UPDATE creation_drafts
        SET options = jsonb_set(options, '{maxColors}', '5'::jsonb)
        WHERE palette_id = '0052-custom';
        UPDATE creation_drafts
        SET options = jsonb_set(options, '{maxColors}', '32'::jsonb)
        WHERE palette_id = '0052-custom';
      `);
    } finally {
      await database.close();
    }
  });

  it("normalizes legacy generation-job maxColors strings before enforcing JSON numbers", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      const migrationIndex = migrations.findIndex(
        (candidate) => candidate.version === "0053_generation_job_max_colors_type.sql",
      );
      const migration = migrations[migrationIndex];
      assert.equal(migration?.version, "0053_generation_job_max_colors_type.sql");
      const client = adaptPGlite(database);
      await applyMigrationSet(client, migrations.slice(0, migrationIndex));
      const options = {
        crop: {
          ratio: "1:1", freeRatio: 1, rotation: 0, scale: 1,
          offsetX: 0, offsetY: 0, flipX: false, flipY: false,
        },
        removeBackground: true,
        figureStyle: "chibi-full",
        coupleLayout: "together",
        maxColors: "16",
        transparentBackground: false,
        inventoryOnly: false,
        brightness: 0,
        contrast: 0,
        saturation: 0,
        dither: false,
      };
      await database.exec(`
        INSERT INTO users(id, display_name)
        VALUES ('00000000-0000-4000-8000-000000005301', '0053 生成参数测试');
        INSERT INTO palettes(id, name, version, brand, bead_size_mm, verified)
        VALUES ('0053-max-colors-palette', '0053 生成上限色卡', 1, '测试', 2.6, false);
      `);
      const { maxColors: _omittedMaxColors, ...missingMaxColors } = options;
      const legacyRows = [
        { id: "00000000-0000-4000-8000-000000005302", options },
        { id: "00000000-0000-4000-8000-000000005303", options: { ...options, maxColors: null } },
        { id: "00000000-0000-4000-8000-000000005304", options: missingMaxColors },
      ];
      for (const row of legacyRows) {
        await database.query(
          `INSERT INTO generation_jobs(
             id, user_id, kind, status, palette_id, options, cost, seed,
             width, height, progress, available_at, created_at, updated_at, completed_at
           ) VALUES (
             $1::uuid,
             '00000000-0000-4000-8000-000000005301',
             'pixel', 'completed', '0053-max-colors-palette', $2::jsonb, 0, '0053-max-colors',
             8, 8, 100, now(), now(), now(), now()
           )`,
          [row.id, JSON.stringify(row.options)],
        );
      }

      await applyMigrationSet(client, [migration!], undefined, migrations);
      const normalized = await database.query<{ value_type: string; max_colors: number }>(`
        SELECT jsonb_typeof(options -> 'maxColors') AS value_type,
               (options ->> 'maxColors')::integer AS max_colors
        FROM generation_jobs
        WHERE id IN (
          '00000000-0000-4000-8000-000000005302',
          '00000000-0000-4000-8000-000000005303',
          '00000000-0000-4000-8000-000000005304'
        )
        ORDER BY id
      `);
      assert.deepEqual(normalized.rows, [
        { value_type: "number", max_colors: 16 },
        { value_type: "number", max_colors: 16 },
        { value_type: "number", max_colors: 16 },
      ]);

      for (const expression of [
        "options - 'maxColors'",
        "jsonb_set(options, '{maxColors}', '\"16\"'::jsonb)",
        "jsonb_set(options, '{maxColors}', '16.5'::jsonb)",
        "jsonb_set(options, '{maxColors}', '4'::jsonb)",
        "jsonb_set(options, '{maxColors}', '33'::jsonb)",
      ]) {
        await assert.rejects(database.exec(`
          UPDATE generation_jobs SET options = ${expression}
          WHERE id = '00000000-0000-4000-8000-000000005302'
        `));
      }
    } finally {
      await database.close();
    }
  });

  it("rejects an edited migration after it has been applied", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      const client = adaptPGlite(database);
      await applyMigrationSet(client, migrations);

      const first = migrations[0];
      assert.ok(first);
      await assert.rejects(
        applyMigrationSet(client, [
          {
            ...first,
            checksum: "f".repeat(64),
          },
        ], undefined, migrations),
        /Checksum mismatch for applied migration 0001_foundation\.sql/,
      );
    } finally {
      await database.close();
    }
  });

  it("rolls back migration SQL and its marker together on failure", async () => {
    const database = new PGlite();
    try {
      const client = adaptPGlite(database);
      const sql = "CREATE TABLE transaction_probe(id integer); SELECT 1 / 0;";

      await assert.rejects(
        applyMigrationSet(client, [
          {
            version: "9000_transaction_probe.sql",
            sql,
            checksum: calculateMigrationChecksum(sql),
          },
        ]),
        /division by zero/i,
      );

      const state = await database.query<{ relation_name: string | null; marker_count: number }>(`
        SELECT
          to_regclass('public.transaction_probe')::text AS relation_name,
          (SELECT count(*)::integer FROM schema_migrations) AS marker_count
      `);
      assert.deepEqual(state.rows[0], { relation_name: null, marker_count: 0 });
    } finally {
      await database.close();
    }
  });

  it("refuses an unknown database migration before applying a missing local migration", async () => {
    const database = new PGlite();
    try {
      const localSql = "CREATE TABLE must_remain_unapplied(id integer);";
      const localMigration = {
        version: "9000_local_missing.sql",
        sql: localSql,
        checksum: calculateMigrationChecksum(localSql),
      };
      await database.exec(`
        CREATE TABLE schema_migrations (
          version text PRIMARY KEY,
          checksum char(64),
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO schema_migrations(version, checksum)
        VALUES ('9999_future_release.sql', repeat('a', 64));
      `);

      await assert.rejects(
        applyMigrationSet(adaptPGlite(database), [localMigration]),
        /unknown to this release: 9999_future_release\.sql.*refusing to apply an older or divergent migration set/i,
      );

      const state = await database.query<{
        relation_name: string | null;
        local_marker_count: number;
        future_marker_count: number;
      }>(`
        SELECT
          to_regclass('public.must_remain_unapplied')::text AS relation_name,
          (SELECT count(*)::integer FROM schema_migrations
           WHERE version = '9000_local_missing.sql') AS local_marker_count,
          (SELECT count(*)::integer FROM schema_migrations
           WHERE version = '9999_future_release.sql') AS future_marker_count
      `);
      assert.deepEqual(state.rows[0], {
        relation_name: null,
        local_marker_count: 0,
        future_marker_count: 1,
      });
    } finally {
      await database.close();
    }
  });

  it("rejects checksum drift and known-version gaps before backfill or migration writes", async () => {
    const database = new PGlite();
    try {
      const firstSql = "CREATE TABLE first_known_probe(id integer);";
      const missingSql = "CREATE TABLE missing_known_probe(id integer);";
      const laterSql = "CREATE TABLE later_known_probe(id integer);";
      const migrations = [
        {
          version: "9000_first_known.sql",
          sql: firstSql,
          checksum: calculateMigrationChecksum(firstSql),
        },
        {
          version: "9001_missing_known.sql",
          sql: missingSql,
          checksum: calculateMigrationChecksum(missingSql),
        },
        {
          version: "9002_later_known.sql",
          sql: laterSql,
          checksum: calculateMigrationChecksum(laterSql),
        },
      ];
      await database.exec(`
        CREATE TABLE schema_migrations (
          version text PRIMARY KEY,
          checksum char(64),
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO schema_migrations(version, checksum) VALUES
          ('9000_first_known.sql', NULL),
          ('9002_later_known.sql', repeat('f', 64));
      `);

      await assert.rejects(
        applyMigrationSet(adaptPGlite(database), migrations),
        /Checksum mismatch for applied migration 9002_later_known\.sql/,
      );
      let state = await database.query<{
        first_checksum: string | null;
        missing_relation: string | null;
        missing_marker_count: number;
      }>(`
        SELECT
          (SELECT checksum::text FROM schema_migrations
           WHERE version = '9000_first_known.sql') AS first_checksum,
          to_regclass('public.missing_known_probe')::text AS missing_relation,
          (SELECT count(*)::integer FROM schema_migrations
           WHERE version = '9001_missing_known.sql') AS missing_marker_count
      `);
      assert.deepEqual(state.rows[0], {
        first_checksum: null,
        missing_relation: null,
        missing_marker_count: 0,
      });

      await database.query(
        "UPDATE schema_migrations SET checksum = $2 WHERE version = $1",
        [migrations[2]!.version, migrations[2]!.checksum],
      );
      await assert.rejects(
        applyMigrationSet(adaptPGlite(database), migrations),
        /not a continuous prefix.*missing 9001_missing_known\.sql before applied 9002_later_known\.sql/i,
      );
      state = await database.query(`
        SELECT
          (SELECT checksum::text FROM schema_migrations
           WHERE version = '9000_first_known.sql') AS first_checksum,
          to_regclass('public.missing_known_probe')::text AS missing_relation,
          (SELECT count(*)::integer FROM schema_migrations
           WHERE version = '9001_missing_known.sql') AS missing_marker_count
      `);
      assert.deepEqual(state.rows[0], {
        first_checksum: null,
        missing_relation: null,
        missing_marker_count: 0,
      });
    } finally {
      await database.close();
    }
  });

  it("upgrades valid tenant-owned palette data from 0030 through 0032 without data loss", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      const through0030 = migrations.filter((migration) => migration.version <= "0030_auth_rate_limits.sql");
      const after0030 = migrations.filter((migration) => migration.version > "0030_auth_rate_limits.sql");
      const client = adaptPGlite(database);
      const ownerId = "00000000-0000-4000-8000-000000003001";

      await applyMigrationSet(client, through0030);
      await database.exec(`
        INSERT INTO users(id, display_name)
        VALUES ('${ownerId}', '升级保留用户');
        INSERT INTO palettes(id, name, version, brand, bead_size_mm, verified, owner_user_id)
        VALUES ('upgrade-private-palette', '升级保留色卡', 1, '测试', 5, false, '${ownerId}');
        INSERT INTO palette_colors(
          palette_id, code, name, hex, unit_price_cents, sort_order, available
        ) VALUES ('upgrade-private-palette', 'U01', '升级保留色', '#123456', 1, 0, true);
        INSERT INTO inventory_items(
          user_id, palette_id, color_code, quantity, revision
        ) VALUES ('${ownerId}', 'upgrade-private-palette', 'U01', 3, 1);
      `);

      await applyMigrationSet(client, after0030, undefined, migrations);

      const preserved = await database.query<{
        owner_user_id: string;
        quantity: number;
        marker_count: number;
      }>(`
        SELECT palette.owner_user_id::text,
               item.quantity,
               (SELECT count(*)::integer
                FROM schema_migrations
                WHERE version IN (
                  '0031_auth_palette_hardening.sql',
                  '0032_palette_owner_immutability.sql'
                )) AS marker_count
        FROM palettes AS palette
        JOIN inventory_items AS item ON item.palette_id = palette.id
        WHERE palette.id = 'upgrade-private-palette'
      `);
      assert.deepEqual(preserved.rows[0], {
        owner_user_id: ownerId,
        quantity: 3,
        marker_count: 2,
      });
    } finally {
      await database.close();
    }
  });

  it("rolls back 0031 and its marker when legacy data has a cross-tenant palette reference", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      const through0030 = migrations.filter((migration) => migration.version <= "0030_auth_rate_limits.sql");
      const migration0031 = migrations.find(
        (migration) => migration.version === "0031_auth_palette_hardening.sql",
      );
      assert.ok(migration0031);
      const client = adaptPGlite(database);
      const ownerId = "00000000-0000-4000-8000-000000003011";
      const otherId = "00000000-0000-4000-8000-000000003012";

      await applyMigrationSet(client, through0030);
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('${ownerId}', '跨租户色卡拥有者'),
          ('${otherId}', '跨租户引用用户');
        INSERT INTO palettes(id, name, version, brand, bead_size_mm, verified, owner_user_id)
        VALUES ('bad-private-palette', '跨租户坏数据色卡', 1, '测试', 5, false, '${ownerId}');
        INSERT INTO palette_colors(
          palette_id, code, name, hex, unit_price_cents, sort_order, available
        ) VALUES ('bad-private-palette', 'B01', '跨租户坏数据色', '#654321', 1, 0, true);
        INSERT INTO inventory_items(
          user_id, palette_id, color_code, quantity, revision
        ) VALUES ('${otherId}', 'bad-private-palette', 'B01', 1, 1);
      `);

      await assert.rejects(
        applyMigrationSet(client, [migration0031], undefined, migrations),
        /cross-tenant private palette references/i,
      );

      const rollbackState = await database.query<{
        bad_reference_count: number;
        marker_count: number;
        cleanup_index: string | null;
      }>(`
        SELECT
          (SELECT count(*)::integer
           FROM inventory_items
           WHERE user_id = '${otherId}' AND palette_id = 'bad-private-palette') AS bad_reference_count,
          (SELECT count(*)::integer
           FROM schema_migrations
           WHERE version = '0031_auth_palette_hardening.sql') AS marker_count,
          to_regclass('auth_rate_limits_updated_at_idx')::text AS cleanup_index
      `);
      assert.deepEqual(rollbackState.rows[0], {
        bad_reference_count: 1,
        marker_count: 0,
        cleanup_index: null,
      });
    } finally {
      await database.close();
    }
  });

  it("fences retired project revisions and new export jobs without stranding queued exports", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      const migrationIndex = migrations.findIndex(
        (migration) => migration.version === "0054_retired_palette_write_fence.sql",
      );
      assert.notEqual(migrationIndex, -1);
      const migration = migrations[migrationIndex]!;
      const client = adaptPGlite(database);

      await applyMigrationSet(client, migrations.slice(0, migrationIndex));
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('00000000-0000-4000-8000-000000005401', '0054 色卡历史用户'),
          ('00000000-0000-4000-8000-000000005402', '0054 跨租户用户');
        INSERT INTO palettes(id, name, version, brand, bead_size_mm, verified, retired) VALUES
          ('0054-retired-palette', '0054 退役色卡', 1, '测试', 2.6, false, true),
          ('0054-active-palette', '0054 可选色卡', 1, '测试', 2.6, false, false);
        INSERT INTO palette_colors(
          palette_id, code, name, hex, unit_price_cents, sort_order, available
        ) VALUES
          ('0054-retired-palette', 'R01', '历史红', '#FF0000', 1, 0, true),
          ('0054-active-palette', 'A01', '当前蓝', '#0000FF', 1, 0, true);
        INSERT INTO projects(
          id, user_id, name, palette_id, current_revision,
          current_bead_count, current_color_count
        ) VALUES (
          '00000000-0000-4000-8000-000000005403',
          '00000000-0000-4000-8000-000000005401',
          '0054 历史项目', '0054-retired-palette', 1, 1, 1
        );
        INSERT INTO project_revisions(
          project_id, revision, encoding, width, height, cells, palette_id
        ) VALUES (
          '00000000-0000-4000-8000-000000005403', 1,
          'palette-code-v1', 1, 1, '["R01"]'::jsonb, '0054-retired-palette'
        );
        INSERT INTO export_jobs(
          id, user_id, project_id, project_revision, format, file_name, options,
          status, progress, available_at
        ) VALUES (
          '00000000-0000-4000-8000-000000005404',
          '00000000-0000-4000-8000-000000005401',
          '00000000-0000-4000-8000-000000005403', 1,
          'png', 'retired-history.png', '{}'::jsonb, 'queued', 0, now()
        );
      `);

      await applyMigrationSet(client, [migration], undefined, migrations);

      const paletteNoop = await database.query(`
        UPDATE palettes SET name = name WHERE id = '0054-retired-palette'
        RETURNING id
      `);
      assert.equal(paletteNoop.affectedRows, 1);
      await assert.rejects(database.exec(`
        UPDATE palettes SET name = '不可变更' WHERE id = '0054-retired-palette'
      `));
      await assert.rejects(database.exec(`
        DELETE FROM palette_colors
        WHERE palette_id = '0054-retired-palette' AND code = 'R01'
      `));

      await assert.rejects(database.exec(`
        UPDATE projects
        SET palette_id = '0054-active-palette'
        WHERE id = '00000000-0000-4000-8000-000000005403'
      `));

      await database.exec(`
        INSERT INTO project_revisions(
          project_id, revision, encoding, width, height, cells, palette_id
        ) VALUES (
          '00000000-0000-4000-8000-000000005403', 2,
          'palette-code-v1', 1, 1, '["A01"]'::jsonb, '0054-active-palette'
        );
        UPDATE projects
        SET palette_id = '0054-active-palette', current_revision = 2
        WHERE id = '00000000-0000-4000-8000-000000005403';
      `);

      await assert.rejects(database.exec(`
        UPDATE projects
        SET current_revision = 1
        WHERE id = '00000000-0000-4000-8000-000000005403'
      `));
      await database.exec(`
        INSERT INTO project_revisions(
          project_id, revision, encoding, width, height, cells, palette_id
        ) VALUES (
          '00000000-0000-4000-8000-000000005403', 3,
          'palette-code-v1', 1, 1, '["A01"]'::jsonb, '0054-active-palette'
        );
        UPDATE projects
        SET current_revision = 3
        WHERE id = '00000000-0000-4000-8000-000000005403';
      `);

      await assert.rejects(database.exec(`
        INSERT INTO export_jobs(
          id, user_id, project_id, project_revision, format, file_name, options,
          status, progress, available_at
        ) VALUES (
          '00000000-0000-4000-8000-000000005405',
          '00000000-0000-4000-8000-000000005401',
          '00000000-0000-4000-8000-000000005403', 1,
          'png', 'new-retired.png', '{}'::jsonb, 'queued', 0, now()
        )
      `));
      await assert.rejects(database.exec(`
        INSERT INTO export_jobs(
          id, user_id, project_id, project_revision, format, file_name, options,
          status, progress, available_at
        ) VALUES (
          '00000000-0000-4000-8000-000000005406',
          '00000000-0000-4000-8000-000000005402',
          '00000000-0000-4000-8000-000000005403', 3,
          'png', 'cross-tenant.png', '{}'::jsonb, 'queued', 0, now()
        )
      `));

      const store = new PostgresStore(poolFor(database));
      await assert.rejects(
        store.createExportJob({
          id: "00000000-0000-4000-8000-000000005407",
          userId: "00000000-0000-4000-8000-000000005401",
          projectId: "00000000-0000-4000-8000-000000005403",
          projectRevision: 1,
          format: "png",
          fileName: "store-retired.png",
          options: {
            paper: "A4",
            orientation: "auto",
            showCodes: true,
            showGrid: true,
            transparentBackground: false,
          },
          now: "2026-10-05T08:00:00.000Z",
        }),
        (error: unknown) => error instanceof AppError
          && error.statusCode === 409
          && error.code === "PALETTE_RETIRED",
      );
      const activeExport = await store.createExportJob({
        id: "00000000-0000-4000-8000-000000005408",
        userId: "00000000-0000-4000-8000-000000005401",
        projectId: "00000000-0000-4000-8000-000000005403",
        projectRevision: 3,
        format: "png",
        fileName: "store-active.png",
        options: {
          paper: "A4",
          orientation: "auto",
          showCodes: true,
          showGrid: true,
          transparentBackground: false,
        },
        now: "2026-10-05T08:00:01.000Z",
      });
      assert.equal(activeExport.projectRevision, 3);

      await assert.rejects(database.exec(`
        UPDATE export_jobs
        SET project_revision = 1
        WHERE id = '00000000-0000-4000-8000-000000005408'
      `));
      await assert.rejects(database.exec(`
        UPDATE export_jobs
        SET user_id = '00000000-0000-4000-8000-000000005402'
        WHERE id = '00000000-0000-4000-8000-000000005408'
      `));
      const unchangedActiveExport = await database.query<{
        user_id: string;
        project_revision: number;
      }>(`
        SELECT user_id, project_revision
        FROM export_jobs
        WHERE id = '00000000-0000-4000-8000-000000005408'
      `);
      assert.deepEqual(unchangedActiveExport.rows[0], {
        user_id: "00000000-0000-4000-8000-000000005401",
        project_revision: 3,
      });
      await assert.rejects(database.exec(`
        UPDATE export_jobs
        SET format = 'pdf'
        WHERE id = '00000000-0000-4000-8000-000000005404'
      `));
      await assert.rejects(database.exec(`
        UPDATE export_jobs
        SET options = '{"paper":"A4"}'::jsonb
        WHERE id = '00000000-0000-4000-8000-000000005404'
      `));
      await assert.rejects(database.exec(`
        UPDATE export_jobs
        SET id = '00000000-0000-4000-8000-000000005409'
        WHERE id = '00000000-0000-4000-8000-000000005404'
      `));

      const finalizedHistoricalExport = await database.query<{
        status: string;
        project_revision: number;
      }>(`
        UPDATE export_jobs
        SET id = id,
            user_id = user_id,
            project_id = project_id,
            project_revision = project_revision,
            format = format,
            file_name = file_name,
            options = options,
            status = 'failed', error_code = 'HISTORICAL_TEST',
            error_message = 'historical work may terminate', finished_at = now()
        WHERE id = '00000000-0000-4000-8000-000000005404'
        RETURNING status, project_revision
      `);
      assert.equal(finalizedHistoricalExport.affectedRows, 1);
      assert.deepEqual(finalizedHistoricalExport.rows[0], {
        status: "failed",
        project_revision: 1,
      });
    } finally {
      await database.close();
    }
  });

  it("removes retired community and stale published-project caches without touching financial state", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      const migrationIndex = migrations.findIndex(
        (migration) => migration.version === "0055_remove_community_feature.sql",
      );
      assert.notEqual(migrationIndex, -1);
      const migration = migrations[migrationIndex]!;
      const client = adaptPGlite(database);
      const userId = "00000000-0000-4000-8000-000000005501";
      const projectId = "00000000-0000-4000-8000-000000005502";

      await applyMigrationSet(client, migrations.slice(0, migrationIndex));
      await database.exec(`
        INSERT INTO users(id, display_name)
        VALUES ('${userId}', '0055 缓存清理用户');

        INSERT INTO api_idempotency(
          user_id, scope, idempotency_key, request_hash, status_code, response_body
        ) VALUES
          ('${userId}', 'community:publications:00000000-0000-4000-8000-000000005503:like', 'community', repeat('a', 64), 200, '{"publication":"removed"}'::jsonb),
          ('${userId}', 'projects:${projectId}:publish', 'publish', repeat('b', 64), 201, '{"publication":"removed"}'::jsonb),
          ('${userId}', 'projects:not-a-uuid:publish', 'noncanonical', repeat('c', 64), 200, '{}'::jsonb),
          ('${userId}', 'projects:${projectId}:copy', 'copy', repeat('d', 64), 201, '{}'::jsonb),
          ('${userId}', 'payment-orders:create', 'payment', repeat('e', 64), 201,
            '{"order":{"status":"created"},"project":{"lifecycleStatus":"published"}}'::jsonb),
          ('${userId}', 'projects:${projectId}:rename', 'published-snapshot', repeat('f', 64), 200,
            '{"project":{"id":"${projectId}","lifecycleStatus":"published"}}'::jsonb),
          ('${userId}', 'projects:${projectId}:rename', 'editable-snapshot', repeat('0', 64), 200,
            '{"project":{"id":"${projectId}","lifecycleStatus":"editable"}}'::jsonb);

        INSERT INTO user_rate_limits(user_id, action, window_started_at, request_count) VALUES
          ('${userId}', 'community-publish', now(), 1),
          ('${userId}', 'community-engagement', now(), 2),
          ('${userId}', 'community-report', now(), 3),
          ('${userId}', 'project-mutation', now(), 4);

        INSERT INTO auth_rate_limits(key_hash, action, window_started_at, request_count) VALUES
          (repeat('1', 64), 'community-publication-list', now(), 1),
          (repeat('1', 64), 'community-publication-detail', now(), 2),
          (repeat('1', 64), 'web-login-challenge-create', now(), 3);
      `);

      await applyMigrationSet(client, [migration], undefined, migrations);

      const idempotencyScopes = await database.query<{ scope: string; idempotency_key: string }>(`
        SELECT scope, idempotency_key FROM api_idempotency ORDER BY scope, idempotency_key
      `);
      assert.deepEqual(idempotencyScopes.rows, [
        { scope: "payment-orders:create", idempotency_key: "payment" },
        { scope: `projects:${projectId}:copy`, idempotency_key: "copy" },
        { scope: `projects:${projectId}:rename`, idempotency_key: "editable-snapshot" },
        { scope: "projects:not-a-uuid:publish", idempotency_key: "noncanonical" },
      ]);
      const userActions = await database.query<{ action: string }>(`
        SELECT action FROM user_rate_limits ORDER BY action
      `);
      assert.deepEqual(userActions.rows.map((row) => row.action), ["project-mutation"]);
      const anonymousActions = await database.query<{ action: string }>(`
        SELECT action FROM auth_rate_limits ORDER BY action
      `);
      assert.deepEqual(
        anonymousActions.rows.map((row) => row.action),
        ["web-login-challenge-create"],
      );
    } finally {
      await database.close();
    }
  });

  it("backfills checksums for the legacy metadata table before enforcing NOT NULL", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE TABLE schema_migrations (
          version text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO schema_migrations(version) VALUES ('0001_legacy.sql');
      `);
      const sql = "SELECT 1;";
      const checksum = calculateMigrationChecksum(sql);

      await applyMigrationSet(adaptPGlite(database), [
        { version: "0001_legacy.sql", sql, checksum },
      ]);

      const record = await database.query<{ checksum: string }>(
        "SELECT checksum::text AS checksum FROM schema_migrations WHERE version = '0001_legacy.sql'",
      );
      assert.equal(record.rows[0]?.checksum, checksum);

      const column = await database.query<{ is_nullable: string }>(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'schema_migrations'
          AND column_name = 'checksum'
      `);
      assert.equal(column.rows[0]?.is_nullable, "NO");
    } finally {
      await database.close();
    }
  });
});
