import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

import { loadConfig, type AppConfig } from "./config.js";
import { createPool } from "./db.js";
import { BUILTIN_PALETTES } from "./domain/palettes.js";
import {
  adaptPoolClient,
  assertDatabaseMigrationState,
  assertNoCompetingMigrationConnections,
  loadMigrationFiles,
  requireMigrationMaintenanceAcknowledgement,
  runMigrationTransaction,
  withMigrationAdvisoryLock,
} from "./migrate.js";

export async function runSeed(
  pool: Pool,
  environment: NodeJS.ProcessEnv,
  nodeEnv: AppConfig["nodeEnv"],
): Promise<void> {
  requireMigrationMaintenanceAcknowledgement(environment, nodeEnv);
  const migrations = await loadMigrationFiles();
  const poolClient = await pool.connect();

  try {
    const client = adaptPoolClient(poolClient);
    if (nodeEnv === "production") await assertNoCompetingMigrationConnections(client);

    await withMigrationAdvisoryLock(client, async () => {
      await assertDatabaseMigrationState(client, migrations, { requireComplete: true });
      await runMigrationTransaction(client, async () => {
        for (const palette of BUILTIN_PALETTES) {
          await client.query(
            `INSERT INTO public.palettes(
               id, name, brand, series, material, bead_size_mm, verified, version,
               source_name, source_url, source_revision, source_license, retired
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name, brand = EXCLUDED.brand,
               series = EXCLUDED.series, material = EXCLUDED.material,
               bead_size_mm = EXCLUDED.bead_size_mm, verified = EXCLUDED.verified,
               version = EXCLUDED.version, source_name = EXCLUDED.source_name,
               source_url = EXCLUDED.source_url, source_revision = EXCLUDED.source_revision,
               source_license = EXCLUDED.source_license, retired = EXCLUDED.retired`,
            [
              palette.id, palette.name, palette.brand, palette.series, palette.material,
              palette.beadSizeMm, palette.verified, palette.version, palette.source?.name,
              palette.source?.url, palette.source?.revision, palette.source?.license,
              palette.retired ?? false,
            ],
          );
          for (const [sortOrder, color] of palette.colors.entries()) {
            await client.query(
              `INSERT INTO public.palette_colors(palette_id, code, name, hex, finish, unit_price_cents, sort_order, available)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (palette_id, code) DO UPDATE SET
                 name = EXCLUDED.name,
                 hex = EXCLUDED.hex,
                 finish = EXCLUDED.finish,
                 unit_price_cents = EXCLUDED.unit_price_cents,
                 sort_order = EXCLUDED.sort_order,
                 available = EXCLUDED.available`,
              [
                palette.id, color.code, color.name, color.hex, color.finish ?? "solid",
                color.unitPriceCents, sortOrder, color.available,
              ],
            );
          }
        }
      });
    });
    process.stdout.write(`seeded ${BUILTIN_PALETTES.length} palette(s)\n`);
  } finally {
    poolClient.release();
  }
}

async function seedFromEnvironment(): Promise<void> {
  await import("dotenv/config");
  const config = loadConfig(process.env, "seed");
  const pool = createPool(config);
  try {
    await runSeed(pool, process.env, config.nodeEnv);
  } finally {
    await pool.end();
  }
}

const invokedScript = process.argv[1];
if (invokedScript && resolve(invokedScript) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await seedFromEnvironment();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
