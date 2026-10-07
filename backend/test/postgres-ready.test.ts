import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";

import { BUILTIN_PALETTES } from "../src/domain/palettes.js";
import { AppError } from "../src/errors.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { REQUIRED_MIGRATION_VERSIONS } from "../src/migration-manifest.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

function poolFor(database: PGlite): Pool {
  return {
    query: (text: string, values?: unknown[]) => database.query(text, values),
    end: () => database.close(),
  } as unknown as Pool;
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

describe("PostgreSQL readiness", () => {
  it("requires all expected migrations and the complete built-in palette seed", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await database.exec(`
        CREATE TABLE schema_migrations(
          version text PRIMARY KEY,
          checksum char(64)
        );
        CREATE TABLE palettes(
          id text PRIMARY KEY,
          name text NOT NULL,
          brand text NOT NULL,
          series text NOT NULL,
          material text NOT NULL,
          bead_size_mm numeric(6, 3) NOT NULL,
          verified boolean NOT NULL,
          version integer NOT NULL,
          source_name text NOT NULL,
          source_url text NOT NULL,
          source_revision text NOT NULL,
          source_license text NOT NULL,
          retired boolean NOT NULL,
          owner_user_id uuid
        );
        CREATE TABLE palette_colors(
          palette_id text NOT NULL REFERENCES palettes(id) ON DELETE CASCADE,
          code text NOT NULL,
          name text NOT NULL,
          hex text NOT NULL,
          finish text NOT NULL,
          unit_price_cents integer NOT NULL,
          sort_order integer NOT NULL,
          available boolean NOT NULL,
          PRIMARY KEY (palette_id, code)
        );
      `);
      const migrationManifest = await loadMigrationFiles();
      assert.deepEqual(
        migrationManifest.map((migration) => migration.version),
        [...REQUIRED_MIGRATION_VERSIONS],
      );
      for (const migration of migrationManifest) {
        await database.query(
          "INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
      }
      for (const palette of BUILTIN_PALETTES) {
        await database.query(
          `INSERT INTO palettes(
             id, name, brand, series, material, bead_size_mm, verified, version,
             source_name, source_url, source_revision, source_license, retired
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            palette.id, palette.name, palette.brand, palette.series, palette.material,
            palette.beadSizeMm, palette.verified, palette.version, palette.source?.name,
            palette.source?.url, palette.source?.revision, palette.source?.license,
            palette.retired ?? false,
          ],
        );
        for (const [sortOrder, color] of palette.colors.entries()) {
          await database.query(
            `INSERT INTO palette_colors(
               palette_id, code, name, hex, finish, unit_price_cents, sort_order, available
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              palette.id, color.code, color.name, color.hex, color.finish ?? "solid",
              color.unitPriceCents, sortOrder, color.available,
            ],
          );
        }
      }
      await database.query(
        `INSERT INTO palettes(
           id, name, brand, series, material, bead_size_mm, verified, version,
           source_name, source_url, source_revision, source_license, retired
         ) VALUES (
           'mard-basic-v1', '退役演示色卡', '非官方演示数据', 'legacy-prototype', 'PE', 5,
           false, 2, 'legacy migration audit only', '', '2', 'internal', true
         )`,
      );

      await store.ready();

      await database.query(
        "INSERT INTO schema_migrations(version) VALUES ($1)",
        ["9999_unexpected_future_migration.sql"],
      );
      await assert.rejects(store.ready(), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "DATABASE_MIGRATIONS_PENDING");
        assert.deepEqual(error.details, {
          missingMigrations: [],
          unexpectedMigrations: ["9999_unexpected_future_migration.sql"],
          checksumMismatches: [],
        });
        return true;
      });
      await database.query(
        "DELETE FROM schema_migrations WHERE version = $1",
        ["9999_unexpected_future_migration.sql"],
      );
      await store.ready();

      const checksumProbe = migrationManifest[1];
      assert.ok(checksumProbe);
      await database.query(
        "UPDATE schema_migrations SET checksum = $2 WHERE version = $1",
        [checksumProbe.version, "f".repeat(64)],
      );
      await assert.rejects(store.ready(), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "DATABASE_MIGRATIONS_PENDING");
        assert.deepEqual(error.details, {
          missingMigrations: [],
          unexpectedMigrations: [],
          checksumMismatches: [{
            version: checksumProbe.version,
            expectedChecksum: checksumProbe.checksum,
            actualChecksum: "f".repeat(64),
          }],
        });
        return true;
      });
      await database.query(
        "UPDATE schema_migrations SET checksum = NULL WHERE version = $1",
        [checksumProbe.version],
      );
      await assert.rejects(store.ready(), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "DATABASE_MIGRATIONS_PENDING");
        assert.deepEqual(error.details, {
          missingMigrations: [],
          unexpectedMigrations: [],
          checksumMismatches: [{
            version: checksumProbe.version,
            expectedChecksum: checksumProbe.checksum,
            actualChecksum: null,
          }],
        });
        return true;
      });
      await database.query(
        "UPDATE schema_migrations SET checksum = $2 WHERE version = $1",
        [checksumProbe.version, checksumProbe.checksum],
      );
      await store.ready();

      const listed = await store.listPalettes("00000000-0000-4000-8000-000000000099");
      assert.deepEqual(
        listed.map((palette) => palette.id),
        BUILTIN_PALETTES.map((palette) => palette.id),
      );
      assert.equal(listed.some((palette) => palette.id === "mard-basic-v1"), false);
      assert.equal(listed.every((palette) => palette.verified === false), true);
      for (const palette of listed.slice(0, 4)) {
        assert.match(palette.source?.name ?? "", /project subset v1 \(non-official\)$/);
        assert.match(palette.source?.revision ?? "", new RegExp(`^pindou-mard-${palette.colors.length}-subset-v1@`));
      }
      await database.query("UPDATE palettes SET retired = false WHERE id = 'mard-basic-v1'");
      await assert.rejects(store.ready(), rejectsWithCode("DATABASE_PALETTE_SEED_INCOMPLETE"));
      await database.query("UPDATE palettes SET retired = true WHERE id = 'mard-basic-v1'");
      await store.ready();
      const fullMard = listed.find((candidate) => candidate.id === "mard-291-v1");
      assert.equal(fullMard?.series, "MARD 2.6mm");
      assert.match(fullMard?.source?.name ?? "", /non-official reference/);
      assert.equal(fullMard?.source?.revision, BUILTIN_PALETTES.at(-1)?.source?.revision);
      assert.deepEqual(
        fullMard?.colors.map((color) => color.finish),
        BUILTIN_PALETTES.at(-1)?.colors.map((color) => color.finish),
      );

      const metadataPalette = BUILTIN_PALETTES.at(-1);
      assert.ok(metadataPalette);
      await database.query(
        "UPDATE palettes SET source_revision = 'drifted' WHERE id = $1",
        [metadataPalette.id],
      );
      await assert.rejects(store.ready(), rejectsWithCode("DATABASE_PALETTE_SEED_INCOMPLETE"));
      await database.query(
        "UPDATE palettes SET source_revision = $2 WHERE id = $1",
        [metadataPalette.id, metadataPalette.source?.revision],
      );

      await database.query("DELETE FROM schema_migrations WHERE version = $1", ["0002_private_assets.sql"]);
      await assert.rejects(store.ready(), rejectsWithCode("DATABASE_MIGRATIONS_PENDING"));

      await database.query(
        "INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)",
        [checksumProbe.version, checksumProbe.checksum],
      );
      const palette = BUILTIN_PALETTES[0];
      assert.ok(palette);
      const color = palette.colors.find((candidate) => candidate.code === "A4");
      assert.ok(color);
      await database.query(
        "DELETE FROM palette_colors WHERE palette_id = $1 AND code = $2",
        [palette.id, color.code],
      );
      await assert.rejects(store.ready(), rejectsWithCode("DATABASE_PALETTE_SEED_INCOMPLETE"));

      await database.query(
        `INSERT INTO palette_colors(
           palette_id, code, name, hex, finish, unit_price_cents, sort_order, available
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          palette.id,
          color.code,
          color.name,
          color.hex,
          color.finish ?? "solid",
          color.unitPriceCents,
          palette.colors.indexOf(color),
          color.available,
        ],
      );
      await database.query("UPDATE palettes SET version = $2 WHERE id = $1", [palette.id, palette.version + 1]);
      await assert.rejects(store.ready(), rejectsWithCode("DATABASE_PALETTE_SEED_INCOMPLETE"));

      await database.query("UPDATE palettes SET version = $2 WHERE id = $1", [palette.id, palette.version]);
      await database.query(
        "UPDATE palette_colors SET finish = 'special' WHERE palette_id = $1 AND code = $2",
        [palette.id, color.code],
      );
      await assert.rejects(store.ready(), rejectsWithCode("DATABASE_PALETTE_SEED_INCOMPLETE"));
      await database.query(
        "UPDATE palette_colors SET finish = $3 WHERE palette_id = $1 AND code = $2",
        [palette.id, color.code, color.finish ?? "solid"],
      );
      await database.query(
        "UPDATE palette_colors SET hex = '#000000' WHERE palette_id = $1 AND code = $2",
        [palette.id, color.code],
      );
      await assert.rejects(store.ready(), rejectsWithCode("DATABASE_PALETTE_SEED_INCOMPLETE"));
    } finally {
      await store.close();
    }
  });
});
