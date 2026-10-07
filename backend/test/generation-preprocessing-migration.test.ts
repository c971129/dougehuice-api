import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { copyDefaultGenerationOptions } from "../src/domain/generation-options.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const USER_ID = "00000000-0000-4000-8000-000000002501";
const JOB_ID = "00000000-0000-4000-8000-000000002502";
const DRAFT_ID = "00000000-0000-4000-8000-000000002503";

function poolFor(database: PGlite): Pool {
  const query = (text: string, values?: unknown[]) =>
    values === undefined ? database.query(text) : database.query(text, values as never[]);
  const client = { query, release: () => undefined } as unknown as PoolClient;
  return {
    query,
    connect: async () => client,
    end: () => database.close(),
  } as unknown as Pool;
}

describe("0025 generation preprocessing options migration", () => {
  it("backfills jobs, drafts, and generation replays while enforcing present values", async () => {
    const database = new PGlite();
    const migrations = await loadMigrationFiles();
    const migration0025 = migrations.find((migration) =>
      migration.version === "0025_generation_preprocessing_options.sql");
    assert.ok(migration0025);
    try {
      for (const migration of migrations) {
        if (migration.version === migration0025.version) break;
        await database.exec(migration.sql);
      }

      const legacy = copyDefaultGenerationOptions() as unknown as Record<string, unknown>;
      delete legacy.brightness;
      delete legacy.contrast;
      delete legacy.saturation;
      delete legacy.dither;
      await database.query(
        "INSERT INTO users(id, display_name) VALUES ($1, 'FR-028 migration user')",
        [USER_ID],
      );
      await database.query(
        "INSERT INTO palettes(id, name, version) VALUES ('fr028-palette', 'FR-028 palette', 1)",
      );
      await database.query(
        `INSERT INTO generation_jobs(
           id, user_id, kind, status, palette_id, options, cost, seed,
           width, height, progress, available_at, created_at, updated_at
         ) VALUES ($1, $2, 'normal', 'completed', 'fr028-palette', $3::jsonb, 0, 'legacy',
           8, 8, 100, now(), now(), now())`,
        [JOB_ID, USER_ID, JSON.stringify(legacy)],
      );
      await database.query(
        `INSERT INTO creation_drafts(
           user_id, id, draft_revision, name, kind, setup_step, palette_id,
           source_asset_id, width, height, options, grid_encoding, grid_cells
         ) VALUES ($1, $2, 1, 'legacy draft', 'normal', 2, 'fr028-palette',
           NULL, 8, 8, $3::jsonb, NULL, NULL)`,
        [USER_ID, DRAFT_ID, JSON.stringify(legacy)],
      );
      await database.query(
        `INSERT INTO api_idempotency(
           user_id, scope, idempotency_key, request_hash, status_code, response_body
         ) VALUES ($1, 'generation-jobs:create', 'legacy-fr028-replay', $2, 202, $3::jsonb)`,
        [
          USER_ID,
          "a".repeat(64),
          JSON.stringify({ job: { id: JOB_ID, options: legacy } }),
        ],
      );

      await database.exec(migration0025.sql);
      const defaults = copyDefaultGenerationOptions();
      const rows = await database.query<{ job_options: unknown; draft_options: unknown; response_body: any }>(`
        SELECT
          (SELECT options FROM generation_jobs WHERE id = '${JOB_ID}') AS job_options,
          (SELECT options FROM creation_drafts WHERE id = '${DRAFT_ID}') AS draft_options,
          (SELECT response_body FROM api_idempotency
             WHERE user_id = '${USER_ID}' AND scope = 'generation-jobs:create') AS response_body
      `);
      assert.deepEqual(rows.rows[0]?.job_options, defaults);
      assert.deepEqual(rows.rows[0]?.draft_options, defaults);
      assert.deepEqual(rows.rows[0]?.response_body.job.options, defaults);

      // Rolling compatibility: missing fields remain legal and runtime parsing
      // restores the canonical defaults.
      await database.query(
        `UPDATE generation_jobs
         SET options = options - 'brightness' - 'contrast' - 'saturation' - 'dither'
         WHERE id = $1`,
        [JOB_ID],
      );
      await database.query(
        `UPDATE creation_drafts
         SET options = options - 'brightness' - 'contrast' - 'saturation' - 'dither'
         WHERE id = $1`,
        [DRAFT_ID],
      );
      const store = new PostgresStore(poolFor(database));
      assert.deepEqual((await store.getGenerationJob(USER_ID, JOB_ID))?.options, defaults);
      assert.deepEqual((await store.getCreationDraft(USER_ID))?.options, defaults);

      for (const [field, literal] of [
        ["brightness", "-101"],
        ["contrast", "101"],
        ["saturation", "1.5"],
        ["dither", "\"yes\""],
      ] as const) {
        await assert.rejects(database.query(
          `UPDATE generation_jobs
           SET options = jsonb_set(options, ARRAY[$2::text], $3::jsonb)
           WHERE id = $1`,
          [JOB_ID, field, literal],
        ));
      }
      await assert.rejects(database.query(
        `UPDATE creation_drafts
         SET options = jsonb_set(options, '{brightness}', '1.25'::jsonb)
         WHERE id = $1`,
        [DRAFT_ID],
      ));
    } finally {
      await database.close();
    }
  });
});
