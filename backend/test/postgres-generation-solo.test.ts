import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { copyDefaultGenerationOptions } from "../src/domain/generation-options.js";
import type { GenerationCandidate, PatternGrid } from "../src/domain/models.js";
import { AppError } from "../src/errors.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const baseMigrationPaths = [
  "../migrations/0001_foundation.sql",
  "../migrations/0002_private_assets.sql",
  "../migrations/0003_exports.sql",
  "../migrations/0004_payments.sql",
  "../migrations/0005_inventory.sql",
  "../migrations/0006_project_lifecycle.sql",
  "../migrations/0007_generation_worker.sql",
  "../migrations/0008_export_artifact_cleanup.sql",
  "../migrations/0009_generation_options.sql",
  "../migrations/0010_generation_redraw.sql",
  "../migrations/0011_asset_readiness.sql",
  "../migrations/0012_payment_effect_claims.sql",
  "../migrations/0013_resource_controls.sql",
  "../migrations/0014_wechat_identity_and_payment_notifications.sql",
  "../migrations/0015_project_drafts.sql",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

const soloMigrationPath = fileURLToPath(new URL(
  "../migrations/0016_generation_solo_candidates.sql",
  import.meta.url,
));

const postSoloMigrationPaths = [
  "../migrations/0017_creation_drafts.sql",
  "../migrations/0018_build_progress_metadata.sql",
  "../migrations/0019_project_metadata.sql",
  "../migrations/0020_project_metadata_revision.sql",
  "../migrations/0021_palette_contract.sql",
  "../migrations/0022_generation_variants.sql",
  "../migrations/0035_project_library.sql",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

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

async function applyBaseMigrations(database: PGlite): Promise<void> {
  for (const migrationPath of baseMigrationPaths) {
    await database.exec(await readFile(migrationPath, "utf8"));
  }
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

describe("PostgresStore couple/solo candidates", () => {
  it("backfills subject slots, persists them, and links two separate adopted projects", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const userId = "00000000-0000-4000-8000-000000000461";
    const legacyJobId = "00000000-0000-4000-8000-000000000462";
    const jobId = "00000000-0000-4000-8000-000000000463";
    const leaseToken = "00000000-0000-4000-8000-000000000464";
    const paletteId = "solo-postgres-palette";
    const options = copyDefaultGenerationOptions();
    options.coupleLayout = "solo";
    const grid: PatternGrid = {
      encoding: "palette-code-v1",
      width: 8,
      height: 8,
      cells: Array.from({ length: 64 }, (_, index) => index % 2 === 0 ? "S01" : null),
    };
    const secondGrid: PatternGrid = {
      ...grid,
      cells: Array.from({ length: 64 }, (_, index) => index % 3 === 0 ? "S02" : "S01"),
    };

    try {
      await applyBaseMigrations(database);
      await database.query("INSERT INTO users(id, display_name) VALUES ($1, '独立人物 SQL 用户')", [userId]);
      await database.query(
        "INSERT INTO palettes(id, name, version) VALUES ($1, '独立人物 SQL 色卡', 1)",
        [paletteId],
      );
      await database.query(
        `INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
         VALUES ($1, 'S01', '一号色', '#FFFFFF', 1, 0), ($1, 'S02', '二号色', '#000000', 1, 1)`,
        [paletteId],
      );
      await database.query(
        "INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES ($1, 10, $2)",
        [userId, "2026-10-04T10:00:00.000Z"],
      );

      await store.createGenerationJob({
        jobId: legacyJobId,
        userId,
        kind: "couple",
        paletteId,
        sourceAssetId: null,
        options,
        cost: 0,
        seed: "legacy-solo",
        width: 8,
        height: 8,
        now: "2026-10-04T10:00:00.000Z",
      });
      for (const ordinal of [1, 2]) {
        await database.query(
          `INSERT INTO generation_candidates(id, job_id, ordinal, encoding, width, height, cells, created_at)
           VALUES ($1, $2, $3, 'palette-code-v1', 8, 8, $4::jsonb, $5)`,
          [
            `legacy-solo-candidate-${ordinal}`,
            legacyJobId,
            ordinal,
            JSON.stringify(ordinal === 1 ? grid.cells : secondGrid.cells),
            "2026-10-04T10:00:01.000Z",
          ],
        );
      }
      await database.query(
        `UPDATE generation_jobs
         SET status = 'accepted', progress = 100, accepted_candidate_id = $3,
             completed_at = $2, updated_at = $2
         WHERE id = $1`,
        [legacyJobId, "2026-10-04T10:00:01.000Z", "legacy-solo-candidate-1"],
      );

      await database.exec(await readFile(soloMigrationPath, "utf8"));
      for (const migrationPath of postSoloMigrationPaths) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      const legacy = await store.getGenerationJob(userId, legacyJobId);
      assert.deepEqual(legacy?.candidates.map((candidate) => candidate.subject), [1, 2]);
      assert.deepEqual(legacy?.candidates.map((candidate) => [
        candidate.variantOrdinal,
        candidate.outputSlot,
      ]), [
        [1, "subject-1"],
        [1, "subject-2"],
      ]);
      assert.deepEqual(legacy?.candidates.map((candidate) => Boolean(candidate.acceptedAt)), [true, false]);

      await assert.rejects(
        database.query(
          "UPDATE generation_candidates SET subject_slot = 3 WHERE id = $1",
          ["legacy-solo-candidate-1"],
        ),
        /generation_candidates_(subject_slot_valid|output_subject_valid)/,
      );

      await store.createGenerationJob({
        jobId,
        userId,
        kind: "couple",
        paletteId,
        sourceAssetId: null,
        options,
        cost: 2,
        seed: "new-solo",
        width: 8,
        height: 8,
        now: "2026-10-04T10:01:00.000Z",
      });
      const claimed = await store.claimNextGenerationJob({
        now: "2026-10-04T10:01:01.000Z",
        leaseToken,
        leaseMilliseconds: 5 * 60_000,
      });
      assert.equal(claimed?.id, jobId);
      const candidates: GenerationCandidate[] = [
        {
          id: "solo-postgres-subject-1",
          jobId,
          ordinal: 1,
          variantOrdinal: 1,
          outputSlot: "subject-1",
          subject: 1,
          grid,
          createdAt: "2026-10-04T10:01:02.000Z",
        },
        {
          id: "solo-postgres-subject-2",
          jobId,
          ordinal: 2,
          variantOrdinal: 1,
          outputSlot: "subject-2",
          subject: 2,
          grid: secondGrid,
          createdAt: "2026-10-04T10:01:02.000Z",
        },
        {
          id: "solo-postgres-subject-1-variant-2",
          jobId,
          ordinal: 3,
          variantOrdinal: 2,
          outputSlot: "subject-1",
          subject: 1,
          grid: secondGrid,
          createdAt: "2026-10-04T10:01:02.000Z",
        },
        {
          id: "solo-postgres-subject-2-variant-2",
          jobId,
          ordinal: 4,
          variantOrdinal: 2,
          outputSlot: "subject-2",
          subject: 2,
          grid,
          createdAt: "2026-10-04T10:01:02.000Z",
        },
      ];
      const completed = await store.completeGenerationJob({
        jobId,
        leaseToken,
        candidates,
        now: "2026-10-04T10:01:03.000Z",
      });
      assert.deepEqual(completed.candidates, candidates);

      await assert.rejects(store.acceptGenerationCandidate({
        userId,
        jobId,
        candidateId: candidates[0]!.id,
        projectName: "SQL 人物一",
      }), rejectsWithCode("GENERATION_CANDIDATE_REQUIRES_VARIANT_ACCEPT"));

      const accepted = await store.acceptGenerationVariant({
        userId,
        jobId,
        variantOrdinal: 1,
        projects: [
          { outputSlot: "subject-1", projectName: "SQL 人物一" },
          { outputSlot: "subject-2", projectName: "SQL 人物二" },
        ],
      });
      assert.equal(accepted.job.status, "accepted");
      assert.equal(accepted.job.acceptedCandidateId, candidates[0]!.id);
      assert.deepEqual(accepted.outputs.map((output) => output.outputSlot), ["subject-1", "subject-2"]);
      const firstProject = accepted.outputs[0]!.project;
      const secondProject = accepted.outputs[1]!.project;
      assert.deepEqual(
        accepted.job.candidates.map((candidate) => candidate.acceptedProjectId),
        [firstProject.id, secondProject.id, undefined, undefined],
      );
      await assert.rejects(store.acceptGenerationVariant({
        userId,
        jobId,
        variantOrdinal: 2,
        projects: [
          { outputSlot: "subject-1", projectName: "SQL 第二方案人物一" },
          { outputSlot: "subject-2", projectName: "SQL 第二方案人物二" },
        ],
      }), rejectsWithCode("GENERATION_VARIANT_ALREADY_ACCEPTED"));
      const persisted = await database.query<{
        id: string;
        subject_slot: number;
        accepted_project_id: string;
        accepted: boolean;
      }>(
        `SELECT id, subject_slot, accepted_project_id, accepted_at IS NOT NULL AS accepted
         FROM generation_candidates WHERE job_id = $1 ORDER BY ordinal`,
        [jobId],
      );
      assert.deepEqual(persisted.rows, [
        { id: candidates[0]!.id, subject_slot: 1, accepted_project_id: firstProject.id, accepted: true },
        { id: candidates[1]!.id, subject_slot: 2, accepted_project_id: secondProject.id, accepted: true },
        { id: candidates[2]!.id, subject_slot: 1, accepted_project_id: null, accepted: false },
        { id: candidates[3]!.id, subject_slot: 2, accepted_project_id: null, accepted: false },
      ]);

      await database.query("DELETE FROM projects WHERE id = $1", [firstProject.id]);
      const afterProjectPurge = await store.getGenerationJob(userId, jobId);
      assert.equal(afterProjectPurge?.candidates[0]?.acceptedProjectId, undefined);
      assert.ok(afterProjectPurge?.candidates[0]?.acceptedAt);
      await assert.rejects(store.acceptGenerationCandidate({
        userId,
        jobId,
        candidateId: candidates[0]!.id,
        projectName: "SQL 人物一回收后重复",
      }), rejectsWithCode("GENERATION_CANDIDATE_REQUIRES_VARIANT_ACCEPT"));
      assert.equal((await store.getCreditAccount(userId)).balance, 8);
    } finally {
      await store.close();
    }
  });
});
