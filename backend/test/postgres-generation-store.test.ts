import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import type { GenerationCandidate, GenerationOptions, PatternGrid } from "../src/domain/models.js";
import { AppError } from "../src/errors.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const migrationPaths = [
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
  "../migrations/0016_generation_solo_candidates.sql",
  "../migrations/0017_creation_drafts.sql",
  "../migrations/0018_build_progress_metadata.sql",
  "../migrations/0019_project_metadata.sql",
  "../migrations/0020_project_metadata_revision.sql",
  "../migrations/0021_palette_contract.sql",
  "../migrations/0022_generation_variants.sql",
  "../migrations/0035_project_library.sql",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

const userId = "00000000-0000-4000-8000-000000000701";
const completedJobId = "00000000-0000-4000-8000-000000000702";
const completedLeaseToken = "00000000-0000-4000-8000-000000000703";
const wrongLeaseToken = "00000000-0000-4000-8000-000000000704";
const canceledJobId = "00000000-0000-4000-8000-000000000705";
const legacyJobId = "00000000-0000-4000-8000-000000000706";
const optionsJobId = "00000000-0000-4000-8000-000000000707";
const sourceAssetId = "00000000-0000-4000-8000-000000000708";
const sourceJobId = "00000000-0000-4000-8000-000000000709";
const sourceLeaseToken = "00000000-0000-4000-8000-000000000710";
const redrawParentJobId = "00000000-0000-4000-8000-000000000711";
const redrawParentLeaseToken = "00000000-0000-4000-8000-000000000712";
const redrawJobId = "00000000-0000-4000-8000-000000000713";
const missingParentJobId = "00000000-0000-4000-8000-000000000714";
const redrawSourceAssetId = "00000000-0000-4000-8000-000000000715";
const paletteId = "generation-test-palette";

const generationOptions: GenerationOptions = {
  crop: {
    ratio: "free",
    freeRatio: 1.3,
    rotation: 270,
    scale: 1.6,
    offsetX: -42,
    offsetY: 81,
    flipX: true,
    flipY: false,
  },
  removeBackground: false,
  figureStyle: "pixel-avatar",
  coupleLayout: "solo",
  maxColors: 7,
  transparentBackground: true,
  inventoryOnly: true,
  brightness: -30,
  contrast: 20,
  saturation: 55,
  dither: true,
};

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

async function applyMigrations(database: PGlite): Promise<void> {
  for (const migrationPath of migrationPaths) {
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

describe("PostgresStore generation SQL", () => {
  it("reserves, settles, accepts, and idempotently releases generation credits", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      await database.query(
        `INSERT INTO users(id, display_name) VALUES ($1, '生成 SQL 测试用户')`,
        [userId],
      );
      await database.query(
        `INSERT INTO palettes(id, name, version) VALUES ($1, '生成测试色卡', 1)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
         VALUES
           ($1, 'T01', '测试白', '#FFFFFF', 1, 0),
           ($1, 'T02', '测试黑', '#000000', 1, 1)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES ($1, 5, $2)`,
        [userId, "2026-10-04T10:00:00.000Z"],
      );

      const createdAt = "2026-10-04T10:00:01.000Z";
      const created = await store.createGenerationJob({
        jobId: completedJobId,
        userId,
        kind: "portrait",
        paletteId,
        sourceAssetId: null,
        options: generationOptions,
        cost: 2,
        seed: "postgres-success-seed",
        width: 8,
        height: 8,
        now: createdAt,
      });
      assert.deepEqual(
        {
          id: created.id,
          status: created.status,
          progress: created.progress,
          attemptCount: created.attemptCount,
          availableAt: created.availableAt,
          leaseToken: created.leaseToken,
          options: created.options,
          candidates: created.candidates,
        },
        {
          id: completedJobId,
          status: "queued",
          progress: 0,
          attemptCount: 0,
          availableAt: createdAt,
          leaseToken: null,
          options: generationOptions,
          candidates: [],
        },
      );
      const queuedJobs = await store.listGenerationJobs({
        userId,
        statuses: ["queued"],
        limit: 10,
      });
      assert.equal(queuedJobs.length, 1);
      assert.equal(queuedJobs[0]?.id, completedJobId);
      assert.deepEqual(queuedJobs[0]?.options, generationOptions);
      assert.deepEqual(await store.listGenerationJobs({
        userId,
        statuses: ["queued"],
        limit: 10,
        offset: 1,
      }), []);
      assert.deepEqual(await store.listGenerationJobs({ userId, statuses: ["completed"], limit: 10 }), []);
      assert.equal(await store.countActiveGenerationJobs(userId), 1);

      const reserved = await database.query<{
        balance: number;
        ledger_count: number;
        ledger_delta: number;
        balance_after: number;
        options: GenerationOptions;
      }>(
        `SELECT
           (SELECT balance FROM credit_accounts WHERE user_id = $1) AS balance,
           (SELECT options FROM generation_jobs WHERE id = ($2::text)::uuid) AS options,
           count(*)::integer AS ledger_count,
           coalesce(sum(delta), 0)::integer AS ledger_delta,
           max(balance_after)::integer AS balance_after
         FROM credit_ledger
         WHERE user_id = $1 AND reason = 'generation_reserved' AND reference_id = $2::text`,
        [userId, completedJobId],
      );
      assert.deepEqual(reserved.rows[0], {
        balance: 3,
        ledger_count: 1,
        ledger_delta: -2,
        balance_after: 3,
        options: generationOptions,
      });

      const claimedAt = "2026-10-04T10:00:10.000Z";
      const claimed = await store.claimNextGenerationJob({
        now: claimedAt,
        leaseToken: completedLeaseToken,
        leaseMilliseconds: 5 * 60_000,
      });
      assert.ok(claimed);
      assert.equal(claimed.id, completedJobId);
      assert.equal(claimed.status, "preprocessing");
      assert.equal(claimed.progress, 5);
      assert.equal(claimed.attemptCount, 1);
      assert.equal(claimed.leaseToken, completedLeaseToken);

      await assert.rejects(
        store.advanceGenerationJob({
          jobId: completedJobId,
          leaseToken: wrongLeaseToken,
          status: "generating",
          progress: 40,
          now: "2026-10-04T10:00:20.000Z",
        }),
        rejectsWithCode("GENERATION_LEASE_LOST"),
      );
      const advanced = await store.advanceGenerationJob({
        jobId: completedJobId,
        leaseToken: completedLeaseToken,
        status: "generating",
        progress: 40,
        now: "2026-10-04T10:00:20.000Z",
      });
      assert.equal(advanced.status, "generating");
      assert.equal(advanced.progress, 40);
      assert.equal(advanced.attemptCount, 1);

      const acceptedGrid: PatternGrid = {
        encoding: "palette-code-v1",
        width: 8,
        height: 8,
        cells: Array.from({ length: 64 }, (_, index) => index % 3 === 0 ? "T02" : "T01"),
      };
      const alternateGrid: PatternGrid = {
        encoding: "palette-code-v1",
        width: 8,
        height: 8,
        cells: Array.from({ length: 64 }, (_, index) => index % 2 === 0 ? "T01" : null),
      };
      const candidates: GenerationCandidate[] = [
        {
          id: "postgres-candidate-701-a",
          jobId: completedJobId,
          ordinal: 1,
          variantOrdinal: 1,
          outputSlot: "combined",
          grid: acceptedGrid,
          createdAt: "2026-10-04T10:00:30.000Z",
        },
        {
          id: "postgres-candidate-701-b",
          jobId: completedJobId,
          ordinal: 2,
          variantOrdinal: 2,
          outputSlot: "combined",
          grid: alternateGrid,
          createdAt: "2026-10-04T10:00:30.000Z",
        },
      ];
      const completed = await store.completeGenerationJob({
        jobId: completedJobId,
        leaseToken: completedLeaseToken,
        candidates,
        now: "2026-10-04T10:00:31.000Z",
      });
      assert.equal(completed.status, "completed");
      assert.equal(completed.progress, 100);
      assert.equal(completed.leaseToken, null);
      assert.deepEqual(completed.candidates, candidates);
      assert.equal(await store.countActiveGenerationJobs(userId), 0);

      const settled = await database.query<{
        balance: number;
        reserved_count: number;
        settled_count: number;
        released_count: number;
        settled_delta: number;
        candidate_count: number;
      }>(
        `SELECT
           (SELECT balance FROM credit_accounts WHERE user_id = $1) AS balance,
           count(*) FILTER (WHERE reason = 'generation_reserved')::integer AS reserved_count,
           count(*) FILTER (WHERE reason = 'generation_settled')::integer AS settled_count,
           count(*) FILTER (WHERE reason = 'generation_released')::integer AS released_count,
           coalesce(sum(delta) FILTER (WHERE reason = 'generation_settled'), 0)::integer AS settled_delta,
           (SELECT count(*)::integer FROM generation_candidates WHERE job_id = $2::uuid) AS candidate_count
         FROM credit_ledger
         WHERE user_id = $1 AND reference_id = $2::text`,
        [userId, completedJobId],
      );
      assert.deepEqual(settled.rows[0], {
        balance: 3,
        reserved_count: 1,
        settled_count: 1,
        released_count: 0,
        settled_delta: 0,
        candidate_count: 2,
      });

      const accepted = await store.acceptGenerationCandidate({
        userId,
        jobId: completedJobId,
        candidateId: candidates[0]!.id,
        projectName: "采用的生成图纸",
      });
      assert.equal(accepted.job.status, "accepted");
      assert.equal(accepted.job.acceptedCandidateId, candidates[0]!.id);
      assert.equal(accepted.project.name, "采用的生成图纸");
      assert.equal(accepted.project.currentRevision, 1);
      assert.deepEqual(accepted.project.grid, acceptedGrid);

      const persistedAcceptance = await database.query<{
        status: string;
        accepted_candidate_id: string;
        project_count: number;
        revision_count: number;
      }>(
        `SELECT
           status,
           accepted_candidate_id,
           (SELECT count(*)::integer FROM projects WHERE id = $3 AND user_id = $1) AS project_count,
           (SELECT count(*)::integer FROM project_revisions WHERE project_id = $3 AND revision = 1) AS revision_count
         FROM generation_jobs
         WHERE id = $2 AND user_id = $1`,
        [userId, completedJobId, accepted.project.id],
      );
      assert.deepEqual(persistedAcceptance.rows[0], {
        status: "accepted",
        accepted_candidate_id: candidates[0]!.id,
        project_count: 1,
        revision_count: 1,
      });

      const secondCreatedAt = "2026-10-04T10:01:00.000Z";
      const second = await store.createGenerationJob({
        jobId: canceledJobId,
        userId,
        kind: "pixel",
        paletteId,
        sourceAssetId: null,
        cost: 1,
        seed: "postgres-cancel-seed",
        width: 8,
        height: 8,
        now: secondCreatedAt,
      });
      assert.equal(second.status, "queued");
      assert.equal((await store.getCreditAccount(userId)).balance, 2);
      assert.equal(await store.countActiveGenerationJobs(userId), 1);

      const canceledAt = "2026-10-04T10:01:10.000Z";
      const canceled = await store.cancelGenerationJob(userId, canceledJobId, canceledAt);
      assert.equal(canceled.status, "canceled");
      assert.equal(canceled.canceledAt, canceledAt);
      assert.equal((await store.getCreditAccount(userId)).balance, 3);
      assert.equal(await store.countActiveGenerationJobs(userId), 0);

      const replay = await store.cancelGenerationJob(
        userId,
        canceledJobId,
        "2026-10-04T10:01:20.000Z",
      );
      assert.equal(replay.status, "canceled");
      assert.equal(replay.canceledAt, canceledAt);

      const released = await database.query<{
        balance: number;
        reserved_count: number;
        reserved_delta: number;
        released_count: number;
        released_delta: number;
        settled_count: number;
      }>(
        `SELECT
           (SELECT balance FROM credit_accounts WHERE user_id = $1) AS balance,
           count(*) FILTER (WHERE reason = 'generation_reserved')::integer AS reserved_count,
           coalesce(sum(delta) FILTER (WHERE reason = 'generation_reserved'), 0)::integer AS reserved_delta,
           count(*) FILTER (WHERE reason = 'generation_released')::integer AS released_count,
           coalesce(sum(delta) FILTER (WHERE reason = 'generation_released'), 0)::integer AS released_delta,
           count(*) FILTER (WHERE reason = 'generation_settled')::integer AS settled_count
         FROM credit_ledger
         WHERE user_id = $1 AND reference_id = $2`,
        [userId, canceledJobId],
      );
      assert.deepEqual(released.rows[0], {
        balance: 3,
        reserved_count: 1,
        reserved_delta: -1,
        released_count: 1,
        released_delta: 1,
        settled_count: 0,
      });
    } finally {
      await store.close();
    }
  });

  it("atomically accepts every split output and rolls all projects back when the second output fails", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      const successUserId = "00000000-0000-4000-8000-000000000721";
      const rollbackUserId = "00000000-0000-4000-8000-000000000722";
      await database.query(
        `INSERT INTO users(id, display_name) VALUES
           ($1, '方案原子采用用户'),
           ($2, '方案回滚用户')`,
        [successUserId, rollbackUserId],
      );
      await database.query(
        `INSERT INTO palettes(id, name, version) VALUES ($1, '方案测试色卡', 1)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
         VALUES
           ($1, 'T01', '测试白', '#FFFFFF', 1, 0),
           ($1, 'T02', '测试黑', '#000000', 2, 1)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES
           ($1, 10, $3),
           ($2, 10, $3)`,
        [successUserId, rollbackUserId, "2026-10-04T11:00:00.000Z"],
      );

      const splitOptions: GenerationOptions = { ...generationOptions, coupleLayout: "split" };
      const leftGrid: PatternGrid = {
        encoding: "palette-code-v1",
        width: 8,
        height: 8,
        cells: Array.from({ length: 64 }, (_, index) => index % 4 === 0 ? null : "T01"),
      };
      const rightGrid: PatternGrid = {
        encoding: "palette-code-v1",
        width: 8,
        height: 8,
        cells: Array.from({ length: 64 }, (_, index) => index % 3 === 0 ? "T02" : null),
      };
      const completeSplitJob = async (input: {
        userId: string;
        jobId: string;
        leaseToken: string;
        minute: string;
        candidatePrefix: string;
      }) => {
        await store.createGenerationJob({
          jobId: input.jobId,
          userId: input.userId,
          kind: "couple",
          paletteId,
          sourceAssetId: null,
          options: splitOptions,
          cost: 2,
          seed: `${input.candidatePrefix}-seed`,
          width: 8,
          height: 8,
          now: `2026-10-04T11:${input.minute}:00.000Z`,
        });
        const claimed = await store.claimNextGenerationJob({
          now: `2026-10-04T11:${input.minute}:01.000Z`,
          leaseToken: input.leaseToken,
          leaseMilliseconds: 58_000,
        });
        assert.equal(claimed?.id, input.jobId);
        const candidates: GenerationCandidate[] = [
          {
            id: `${input.candidatePrefix}-v1-left`,
            jobId: input.jobId,
            ordinal: 1,
            variantOrdinal: 1,
            outputSlot: "left",
            grid: leftGrid,
            createdAt: `2026-10-04T11:${input.minute}:02.000Z`,
          },
          {
            id: `${input.candidatePrefix}-v1-right`,
            jobId: input.jobId,
            ordinal: 2,
            variantOrdinal: 1,
            outputSlot: "right",
            grid: rightGrid,
            createdAt: `2026-10-04T11:${input.minute}:02.000Z`,
          },
          {
            id: `${input.candidatePrefix}-v2-left`,
            jobId: input.jobId,
            ordinal: 3,
            variantOrdinal: 2,
            outputSlot: "left",
            grid: rightGrid,
            createdAt: `2026-10-04T11:${input.minute}:02.000Z`,
          },
          {
            id: `${input.candidatePrefix}-v2-right`,
            jobId: input.jobId,
            ordinal: 4,
            variantOrdinal: 2,
            outputSlot: "right",
            grid: leftGrid,
            createdAt: `2026-10-04T11:${input.minute}:02.000Z`,
          },
        ];
        await store.completeGenerationJob({
          jobId: input.jobId,
          leaseToken: input.leaseToken,
          candidates,
          now: `2026-10-04T11:${input.minute}:03.000Z`,
        });
        return candidates;
      };

      const successJobId = "00000000-0000-4000-8000-000000000723";
      const successCandidates = await completeSplitJob({
        userId: successUserId,
        jobId: successJobId,
        leaseToken: "00000000-0000-4000-8000-000000000724",
        minute: "01",
        candidatePrefix: "atomic-success",
      });
      await assert.rejects(store.acceptGenerationVariant({
        userId: rollbackUserId,
        jobId: successJobId,
        variantOrdinal: 1,
        projects: [
          { outputSlot: "left", projectName: "越权左侧" },
          { outputSlot: "right", projectName: "越权右侧" },
        ],
      }), rejectsWithCode("GENERATION_JOB_NOT_FOUND"));
      const accepted = await store.acceptGenerationVariant({
        userId: successUserId,
        jobId: successJobId,
        variantOrdinal: 1,
        projects: [
          { outputSlot: "left", projectName: "SQL 左侧" },
          { outputSlot: "right", projectName: "SQL 右侧" },
        ],
      });
      assert.deepEqual(accepted.outputs.map((output) => output.outputSlot), ["left", "right"]);
      assert.deepEqual(accepted.outputs.map((output) => output.project.grid), [leftGrid, rightGrid]);
      assert.deepEqual(
        accepted.job.candidates.map((candidate) => Boolean(candidate.acceptedProjectId)),
        [true, true, false, false],
      );
      const persistedSuccess = await database.query<{
        project_count: number;
        revision_count: number;
        accepted_count: number;
        status: string;
        accepted_candidate_id: string;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM projects WHERE user_id = $1) AS project_count,
           (SELECT count(*)::integer FROM project_revisions AS revision
              JOIN projects AS project ON project.id = revision.project_id
             WHERE project.user_id = $1) AS revision_count,
           (SELECT count(*)::integer FROM generation_candidates
             WHERE job_id = $2 AND accepted_at IS NOT NULL) AS accepted_count,
           status,
           accepted_candidate_id
         FROM generation_jobs WHERE id = $2`,
        [successUserId, successJobId],
      );
      assert.deepEqual(persistedSuccess.rows[0], {
        project_count: 2,
        revision_count: 2,
        accepted_count: 2,
        status: "accepted",
        accepted_candidate_id: successCandidates[0]!.id,
      });
      await assert.rejects(store.acceptGenerationVariant({
        userId: successUserId,
        jobId: successJobId,
        variantOrdinal: 2,
        projects: [
          { outputSlot: "left", projectName: "重复左侧" },
          { outputSlot: "right", projectName: "重复右侧" },
        ],
      }), rejectsWithCode("GENERATION_VARIANT_ALREADY_ACCEPTED"));

      const rollbackJobId = "00000000-0000-4000-8000-000000000725";
      await completeSplitJob({
        userId: rollbackUserId,
        jobId: rollbackJobId,
        leaseToken: "00000000-0000-4000-8000-000000000726",
        minute: "02",
        candidatePrefix: "atomic-rollback",
      });
      await database.query(
        `INSERT INTO projects(id, user_id, name, palette_id, current_revision)
         SELECT
           ('10000000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid,
           $1,
           '配额占位-' || number::text,
           $2,
           1
         FROM generate_series(1, 99) AS number`,
        [rollbackUserId, paletteId],
      );
      await assert.rejects(store.acceptGenerationVariant({
        userId: rollbackUserId,
        jobId: rollbackJobId,
        variantOrdinal: 1,
        projects: [
          { outputSlot: "left", projectName: "应回滚左侧" },
          { outputSlot: "right", projectName: "应回滚右侧" },
        ],
      }), rejectsWithCode("PROJECT_LIMIT_EXCEEDED"));
      const persistedRollback = await database.query<{
        project_count: number;
        revision_count: number;
        accepted_count: number;
        status: string;
        accepted_candidate_id: string | null;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM projects WHERE user_id = $1) AS project_count,
           (SELECT count(*)::integer FROM project_revisions AS revision
              JOIN projects AS project ON project.id = revision.project_id
             WHERE project.user_id = $1) AS revision_count,
           (SELECT count(*)::integer FROM generation_candidates
             WHERE job_id = $2 AND accepted_at IS NOT NULL) AS accepted_count,
           status,
           accepted_candidate_id
         FROM generation_jobs WHERE id = $2`,
        [rollbackUserId, rollbackJobId],
      );
      assert.deepEqual(persistedRollback.rows[0], {
        project_count: 99,
        revision_count: 0,
        accepted_count: 0,
        status: "completed",
        accepted_candidate_id: null,
      });
    } finally {
      await store.close();
    }
  });

  it("atomically cancels active jobs and refunds once when their source asset is deleted", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      const createdAt = "2026-10-04T12:00:00.000Z";
      await database.query(
        `INSERT INTO users(id, display_name) VALUES ($1, '素材删除级联用户')`,
        [userId],
      );
      await database.query(
        `INSERT INTO palettes(id, name, version) VALUES ($1, '素材删除级联色卡', 1)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
         VALUES ($1, 'T01', '测试白', '#FFFFFF', 1, 0)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES ($1, 4, $2)`,
        [userId, createdAt],
      );
      await database.query(
        `INSERT INTO assets(
           id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
           width, height, storage_key, expires_at, ready_at, created_at
         ) VALUES ($1, $2, 'ai-source', 'privacy-v1', $3, 'image/png', 16,
           2, 2, 'source-asset-storage-key', $4, $5, $5)`,
        [sourceAssetId, userId, "a".repeat(64), "2026-10-05T12:00:00.000Z", createdAt],
      );
      assert.deepEqual(
        (await store.listAssets({
          userId,
          purpose: "ai-source",
          includeDeleted: false,
          now: createdAt,
          limit: 10,
        })).map((asset) => asset.id),
        [sourceAssetId],
      );

      await store.createGenerationJob({
        jobId: sourceJobId,
        userId,
        kind: "portrait",
        paletteId,
        sourceAssetId,
        cost: 2,
        seed: "source-delete-seed",
        width: 8,
        height: 8,
        now: "2026-10-04T12:00:01.000Z",
      });
      assert.equal((await store.getCreditAccount(userId)).balance, 2);
      const claimed = await store.claimNextGenerationJob({
        now: "2026-10-04T12:00:02.000Z",
        leaseToken: sourceLeaseToken,
        leaseMilliseconds: 5 * 60_000,
      });
      assert.equal(claimed?.id, sourceJobId);

      const deletedAt = "2026-10-04T12:00:03.000Z";
      const deleted = await store.markAssetDeleted(userId, sourceAssetId, deletedAt);
      assert.equal(deleted?.deletedAt, deletedAt);
      const canceled = await store.getGenerationJob(userId, sourceJobId);
      assert.equal(canceled?.status, "canceled");
      assert.equal(canceled?.canceledAt, deletedAt);
      assert.equal(canceled?.leaseToken, null);
      assert.equal((await store.getCreditAccount(userId)).balance, 4);
      assert.deepEqual(await store.listAssets({
        userId,
        includeDeleted: false,
        now: deletedAt,
        limit: 10,
      }), []);
      const deletedAssets = await store.listAssets({
        userId,
        includeDeleted: true,
        now: deletedAt,
        limit: 10,
      });
      assert.equal(deletedAssets.length, 1);
      assert.equal(deletedAssets[0]?.id, sourceAssetId);
      assert.equal(deletedAssets[0]?.deletedAt, deletedAt);
      assert.equal(await store.renewGenerationJobLease({
        jobId: sourceJobId,
        leaseToken: sourceLeaseToken,
        now: "2026-10-04T12:00:04.000Z",
        leaseMilliseconds: 6 * 60_000,
      }), false);

      await store.markAssetDeleted(userId, sourceAssetId, "2026-10-04T12:00:05.000Z");
      const ledger = await database.query<{
        reserved_count: number;
        released_count: number;
        released_delta: number;
      }>(
        `SELECT
           count(*) FILTER (WHERE reason = 'generation_reserved')::integer AS reserved_count,
           count(*) FILTER (WHERE reason = 'generation_released')::integer AS released_count,
           coalesce(sum(delta) FILTER (WHERE reason = 'generation_released'), 0)::integer AS released_delta
         FROM credit_ledger
         WHERE user_id = $1 AND reference_id = $2`,
        [userId, sourceJobId],
      );
      assert.deepEqual(ledger.rows[0], {
        reserved_count: 1,
        released_count: 1,
        released_delta: 2,
      });
      assert.equal((await store.getCreditAccount(userId)).balance, 4);
    } finally {
      await store.close();
    }
  });

  it("enforces redraw parent constraints and persists copied job data through the public store API", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      const createdAt = "2026-10-04T13:00:00.000Z";
      await database.query(
        `INSERT INTO users(id, display_name) VALUES ($1, '换一批 SQL 测试用户')`,
        [userId],
      );
      await database.query(
        `INSERT INTO palettes(id, name, version) VALUES ($1, '换一批测试色卡', 1)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
         VALUES
           ($1, 'T01', '测试白', '#FFFFFF', 1, 0),
           ($1, 'T02', '测试黑', '#000000', 1, 1)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES ($1, 5, $2)`,
        [userId, createdAt],
      );
      await database.query(
        `INSERT INTO assets(
           id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
           width, height, storage_key, expires_at, ready_at, created_at
         ) VALUES ($1, $2, 'ai-source', 'privacy-v1', $3, 'image/png', 16,
           2, 2, 'redraw-source-asset-storage-key', $4, $5, $5)`,
        [redrawSourceAssetId, userId, "b".repeat(64), "2026-10-05T13:00:00.000Z", createdAt],
      );

      const parent = await store.createGenerationJob({
        jobId: redrawParentJobId,
        userId,
        kind: "couple",
        paletteId,
        sourceAssetId: redrawSourceAssetId,
        options: generationOptions,
        cost: 2,
        seed: "postgres-redraw-parent-seed",
        width: 9,
        height: 11,
        now: "2026-10-04T13:00:01.000Z",
      });
      assert.equal(parent.parentJobId, null);

      const claimed = await store.claimNextGenerationJob({
        now: "2026-10-04T13:00:02.000Z",
        leaseToken: redrawParentLeaseToken,
        leaseMilliseconds: 5 * 60_000,
      });
      assert.equal(claimed?.id, redrawParentJobId);
      const parentCandidate: GenerationCandidate = {
        id: "postgres-redraw-parent-candidate",
        jobId: redrawParentJobId,
        ordinal: 1,
        variantOrdinal: 1,
        outputSlot: "subject-1",
        subject: 1,
        grid: {
          encoding: "palette-code-v1",
          width: 9,
          height: 11,
          cells: Array.from({ length: 99 }, (_, index) => index % 3 === 0 ? null : index % 2 === 0 ? "T02" : "T01"),
        },
        createdAt: "2026-10-04T13:00:03.000Z",
      };
      await store.completeGenerationJob({
        jobId: redrawParentJobId,
        leaseToken: redrawParentLeaseToken,
        candidates: [
          parentCandidate,
          {
            ...parentCandidate,
            id: "postgres-redraw-parent-candidate-2",
            ordinal: 2,
            variantOrdinal: 1,
            outputSlot: "subject-2",
            subject: 2,
          },
          {
            ...parentCandidate,
            id: "postgres-redraw-parent-candidate-3",
            ordinal: 3,
            variantOrdinal: 2,
          },
          {
            ...parentCandidate,
            id: "postgres-redraw-parent-candidate-4",
            ordinal: 4,
            variantOrdinal: 2,
            outputSlot: "subject-2",
            subject: 2,
          },
        ],
        now: "2026-10-04T13:00:04.000Z",
      });
      assert.deepEqual(
        (await store.getGenerationJob(userId, redrawParentJobId))?.candidates[0]?.grid,
        parentCandidate.grid,
      );

      const redraw = await store.createGenerationJob({
        jobId: redrawJobId,
        userId,
        parentJobId: redrawParentJobId,
        kind: parent.kind,
        paletteId: parent.paletteId,
        sourceAssetId: parent.sourceAssetId,
        options: parent.options,
        cost: 1,
        seed: "postgres-redraw-child-seed",
        width: parent.width,
        height: parent.height,
        now: "2026-10-04T13:00:05.000Z",
      });
      const expectedRedrawData = {
        parentJobId: redrawParentJobId,
        kind: "couple",
        paletteId,
        sourceAssetId: redrawSourceAssetId,
        options: generationOptions,
        width: 9,
        height: 11,
      };
      assert.deepEqual({
        parentJobId: redraw.parentJobId,
        kind: redraw.kind,
        paletteId: redraw.paletteId,
        sourceAssetId: redraw.sourceAssetId,
        options: redraw.options,
        width: redraw.width,
        height: redraw.height,
      }, expectedRedrawData);

      const fetched = await store.getGenerationJob(userId, redrawJobId);
      assert.deepEqual(fetched && {
        parentJobId: fetched.parentJobId,
        kind: fetched.kind,
        paletteId: fetched.paletteId,
        sourceAssetId: fetched.sourceAssetId,
        options: fetched.options,
        width: fetched.width,
        height: fetched.height,
      }, expectedRedrawData);
      const listed = (await store.listGenerationJobs({ userId, limit: 10 }))
        .find((job) => job.id === redrawJobId);
      assert.deepEqual(listed && {
        parentJobId: listed.parentJobId,
        kind: listed.kind,
        paletteId: listed.paletteId,
        sourceAssetId: listed.sourceAssetId,
        options: listed.options,
        width: listed.width,
        height: listed.height,
      }, expectedRedrawData);

      await assert.rejects(
        database.query(
          `UPDATE generation_jobs SET parent_job_id = $2 WHERE id = $1`,
          [redrawJobId, missingParentJobId],
        ),
        /generation_jobs_parent_job_fk/,
      );
      await assert.rejects(
        database.query(
          `UPDATE generation_jobs SET parent_job_id = id WHERE id = $1`,
          [redrawJobId],
        ),
        /generation_jobs_parent_not_self_check/,
      );
      await assert.rejects(
        database.query(`DELETE FROM generation_jobs WHERE id = $1`, [redrawParentJobId]),
        /generation_jobs_parent_job_fk/,
      );
      assert.equal((await store.getGenerationJob(userId, redrawJobId))?.parentJobId, redrawParentJobId);
    } finally {
      await store.close();
    }
  });

  it("batch-recovers expired generation leases and refunds terminal jobs exactly once", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      const firstUserId = "00000000-0000-4000-8000-000000000731";
      const secondUserId = "00000000-0000-4000-8000-000000000732";
      const retryUserId = "00000000-0000-4000-8000-000000000733";
      const jobs = [
        { id: "00000000-0000-4000-8000-000000000741", userId: firstUserId, cost: 2, attempt: 3, max: 3, lease: "2020-01-01T00:00:01.000Z" },
        { id: "00000000-0000-4000-8000-000000000742", userId: firstUserId, cost: 3, attempt: 3, max: 3, lease: "2020-01-01T00:00:02.000Z" },
        { id: "00000000-0000-4000-8000-000000000743", userId: secondUserId, cost: 4, attempt: 3, max: 3, lease: "2020-01-01T00:00:03.000Z" },
        { id: "00000000-0000-4000-8000-000000000744", userId: secondUserId, cost: 1, attempt: 3, max: 3, lease: "2020-01-01T00:00:04.000Z" },
        { id: "00000000-0000-4000-8000-000000000745", userId: retryUserId, cost: 0, attempt: 3, max: 3, lease: "2020-01-01T00:00:05.000Z" },
        { id: "00000000-0000-4000-8000-000000000746", userId: retryUserId, cost: 2, attempt: 1, max: 3, lease: "2020-01-01T00:00:06.000Z" },
      ] as const;
      await database.query(
        `INSERT INTO users(id, display_name) VALUES
           ($1, '批量恢复用户一'), ($2, '批量恢复用户二'), ($3, '批量重试用户')`,
        [firstUserId, secondUserId, retryUserId],
      );
      await database.query(
        `INSERT INTO palettes(id, name, version) VALUES ($1, '批量恢复色卡', 1)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
         VALUES ($1, 'T01', '测试白', '#FFFFFF', 1, 0)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES
           ($1, 20, $4), ($2, 20, $4), ($3, 20, $4)`,
        [firstUserId, secondUserId, retryUserId, "2020-01-01T00:00:00.000Z"],
      );

      for (const [index, job] of jobs.entries()) {
        await store.createGenerationJob({
          jobId: job.id,
          userId: job.userId,
          kind: "pixel",
          paletteId,
          sourceAssetId: null,
          cost: job.cost,
          seed: `batch-expiry-${index}`,
          width: 8,
          height: 8,
          now: `2020-01-01T00:00:${String(10 + index).padStart(2, "0")}.000Z`,
        });
        await database.query(
          `UPDATE generation_jobs
           SET status = 'generating', progress = 50, attempt_count = $2, max_attempts = $3,
               lease_token = $4, lease_expires_at = $5
           WHERE id = $1`,
          [
            job.id,
            job.attempt,
            job.max,
            `00000000-0000-4000-8000-${String(760 + index).padStart(12, "0")}`,
            job.lease,
          ],
        );
      }

      const preReleasedJob = jobs[3]!;
      const preReleasedBalance = await database.query<{ balance: number }>(
        `UPDATE credit_accounts
         SET balance = balance + $2, updated_at = $3
         WHERE user_id = $1
         RETURNING balance`,
        [preReleasedJob.userId, preReleasedJob.cost, "2020-01-01T00:00:20.000Z"],
      );
      await database.query(
        `INSERT INTO credit_ledger(id, user_id, delta, balance_after, reason, reference_id, created_at)
         VALUES ($1, $2, $3, $4, 'generation_released', $5, $6)`,
        [
          "00000000-0000-4000-8000-000000000770",
          preReleasedJob.userId,
          preReleasedJob.cost,
          preReleasedBalance.rows[0]!.balance,
          preReleasedJob.id,
          "2020-01-01T00:00:20.000Z",
        ],
      );

      const retryLeaseToken = "00000000-0000-4000-8000-000000000799";
      const claimed = await store.claimNextGenerationJob({
        now: "1999-01-01T00:00:00.000Z",
        leaseToken: retryLeaseToken,
        leaseMilliseconds: 60_000,
      });
      assert.equal(claimed?.id, jobs[5]!.id);
      assert.equal(claimed?.status, "preprocessing");
      assert.equal(claimed?.attemptCount, 2);
      assert.equal(claimed?.leaseToken, retryLeaseToken);

      const persisted = await database.query<{
        id: string;
        status: string;
        lease_token: string | null;
        error_code: string | null;
      }>(
        `SELECT id, status, lease_token, error_code
         FROM generation_jobs
         ORDER BY id`,
      );
      assert.deepEqual(persisted.rows.slice(0, 5), jobs.slice(0, 5).map((job) => ({
        id: job.id,
        status: "failed",
        lease_token: null,
        error_code: "GENERATION_LEASE_EXPIRED",
      })));

      const accounts = await database.query<{ user_id: string; balance: number }>(
        `SELECT user_id, balance FROM credit_accounts ORDER BY user_id`,
      );
      assert.deepEqual(accounts.rows, [
        { user_id: firstUserId, balance: 20 },
        { user_id: secondUserId, balance: 20 },
        { user_id: retryUserId, balance: 18 },
      ]);
      const releases = await database.query<{
        reference_id: string;
        delta: number;
        balance_after: number;
      }>(
        `SELECT reference_id, delta, balance_after
         FROM credit_ledger
         WHERE reason = 'generation_released'
         ORDER BY reference_id`,
      );
      assert.deepEqual(releases.rows, [
        { reference_id: jobs[0]!.id, delta: 2, balance_after: 17 },
        { reference_id: jobs[1]!.id, delta: 3, balance_after: 20 },
        { reference_id: jobs[2]!.id, delta: 4, balance_after: 20 },
        { reference_id: jobs[3]!.id, delta: 1, balance_after: 16 },
      ]);

      assert.equal(await store.claimNextGenerationJob({
        now: "2100-01-01T00:00:00.000Z",
        leaseToken: "00000000-0000-4000-8000-000000000798",
        leaseMilliseconds: 60_000,
      }), null);
      const replay = await database.query<{ release_count: number; released_delta: number }>(
        `SELECT count(*)::integer AS release_count, coalesce(sum(delta), 0)::integer AS released_delta
         FROM credit_ledger WHERE reason = 'generation_released'`,
      );
      assert.deepEqual(replay.rows[0], { release_count: 4, released_delta: 10 });
      assert.deepEqual((await database.query<{ user_id: string; balance: number }>(
        `SELECT user_id, balance FROM credit_accounts ORDER BY user_id`,
      )).rows, accounts.rows);
    } finally {
      await store.close();
    }
  });

  it("rolls the whole generation lease recovery transaction back when a refund account is missing", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      const rollbackUserId = "00000000-0000-4000-8000-000000000771";
      const rollbackJobId = "00000000-0000-4000-8000-000000000772";
      const originalLeaseToken = "00000000-0000-4000-8000-000000000773";
      await database.query(
        `INSERT INTO users(id, display_name) VALUES ($1, '恢复回滚用户')`,
        [rollbackUserId],
      );
      await database.query(
        `INSERT INTO palettes(id, name, version) VALUES ($1, '恢复回滚色卡', 1)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
         VALUES ($1, 'T01', '测试白', '#FFFFFF', 1, 0)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES ($1, 5, $2)`,
        [rollbackUserId, "2020-01-01T00:00:00.000Z"],
      );
      await store.createGenerationJob({
        jobId: rollbackJobId,
        userId: rollbackUserId,
        kind: "pixel",
        paletteId,
        sourceAssetId: null,
        cost: 2,
        seed: "missing-refund-account",
        width: 8,
        height: 8,
        now: "2020-01-01T00:00:01.000Z",
      });
      await database.query(
        `UPDATE generation_jobs
         SET status = 'generating', progress = 50, attempt_count = 3, max_attempts = 3,
             lease_token = $2, lease_expires_at = $3
         WHERE id = $1`,
        [rollbackJobId, originalLeaseToken, "2020-01-01T00:00:02.000Z"],
      );
      await database.query(`DELETE FROM credit_accounts WHERE user_id = $1`, [rollbackUserId]);

      await assert.rejects(store.claimNextGenerationJob({
        now: "2100-01-01T00:00:00.000Z",
        leaseToken: "00000000-0000-4000-8000-000000000774",
        leaseMilliseconds: 60_000,
      }), rejectsWithCode("CREDIT_ACCOUNT_NOT_FOUND"));
      const job = await database.query<{
        status: string;
        lease_token: string;
        error_code: string | null;
      }>(
        `SELECT status, lease_token, error_code FROM generation_jobs WHERE id = $1`,
        [rollbackJobId],
      );
      assert.deepEqual(job.rows[0], {
        status: "generating",
        lease_token: originalLeaseToken,
        error_code: null,
      });
      const release = await database.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM credit_ledger
         WHERE reason = 'generation_released' AND reference_id = $1`,
        [rollbackJobId],
      );
      assert.equal(release.rows[0]?.count, 0);
    } finally {
      await store.close();
    }
  });

  it("bounds each generation lease recovery pass to one hundred rows", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      const boundedUserId = "00000000-0000-4000-8000-000000000781";
      await database.query(
        `INSERT INTO users(id, display_name) VALUES ($1, '有界恢复用户')`,
        [boundedUserId],
      );
      await database.query(
        `INSERT INTO palettes(id, name, version) VALUES ($1, '有界恢复色卡', 1)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO generation_jobs(
           id, user_id, kind, status, palette_id, options, cost, seed,
           width, height, progress, attempt_count, max_attempts, available_at,
           lease_token, lease_expires_at, created_at, updated_at
         )
         SELECT
           ('20000000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid,
           $1, 'pixel', 'generating', $2, $3::jsonb, 0, 'bounded-' || number::text,
           8, 8, 50, 3, 3, $4,
           ('30000000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid,
           $4::timestamptz + (number * interval '1 millisecond'), $4, $4
         FROM generate_series(1, 101) AS number`,
        [boundedUserId, paletteId, JSON.stringify(generationOptions), "2020-01-01T00:00:00.000Z"],
      );

      assert.equal(await store.claimNextGenerationJob({
        now: "2100-01-01T00:00:00.000Z",
        leaseToken: "00000000-0000-4000-8000-000000000782",
        leaseMilliseconds: 60_000,
      }), null);
      const firstPass = await database.query<{ failed: number; active: number }>(
        `SELECT
           count(*) FILTER (WHERE status = 'failed')::integer AS failed,
           count(*) FILTER (WHERE status = 'generating')::integer AS active
         FROM generation_jobs`,
      );
      assert.deepEqual(firstPass.rows[0], { failed: 100, active: 1 });

      assert.equal(await store.claimNextGenerationJob({
        now: "2100-01-01T00:00:00.000Z",
        leaseToken: "00000000-0000-4000-8000-000000000783",
        leaseMilliseconds: 60_000,
      }), null);
      const secondPass = await database.query<{ failed: number; active: number }>(
        `SELECT
           count(*) FILTER (WHERE status = 'failed')::integer AS failed,
           count(*) FILTER (WHERE status = 'generating')::integer AS active
         FROM generation_jobs`,
      );
      assert.deepEqual(secondPass.rows[0], { failed: 101, active: 0 });
    } finally {
      await store.close();
    }
  });

  it("backfills, constrains, and persists generation options through migration 0009", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migrationPath of migrationPaths.filter((path) =>
        !path.endsWith("0009_generation_options.sql")
        && !path.endsWith("0010_generation_redraw.sql")
        && !path.endsWith("0016_generation_solo_candidates.sql")
        && !path.endsWith("0022_generation_variants.sql"))) {
        await database.exec(await readFile(migrationPath, "utf8"));
      }
      await database.query(
        `INSERT INTO users(id, display_name) VALUES ($1, '生成参数迁移用户')`,
        [userId],
      );
      await database.query(
        `INSERT INTO palettes(id, name, version) VALUES ($1, '生成参数迁移色卡', 1)`,
        [paletteId],
      );
      await database.query(
        `INSERT INTO generation_jobs(
           id, user_id, kind, status, palette_id, cost, seed, width, height,
           progress, available_at, created_at, updated_at
         ) VALUES ($1, $2, 'pixel', 'completed', $3, 0, 'legacy-options-seed', 8, 8,
           100, $4, $4, $4)`,
        [legacyJobId, userId, paletteId, "2026-10-04T09:00:00.000Z"],
      );

      const generationOptionsMigrationPath = migrationPaths.find((path) =>
        path.endsWith("0009_generation_options.sql"))!;
      assert.ok(generationOptionsMigrationPath.endsWith("0009_generation_options.sql"));
      await database.exec(await readFile(generationOptionsMigrationPath, "utf8"));

      const legacy = await database.query<{ options: GenerationOptions }>(
        `SELECT options FROM generation_jobs WHERE id = $1`,
        [legacyJobId],
      );
      assert.deepEqual(legacy.rows[0]?.options, {
        crop: {
          ratio: "1:1",
          freeRatio: 1,
          rotation: 0,
          scale: 1,
          offsetX: 0,
          offsetY: 0,
          flipX: false,
          flipY: false,
        },
        removeBackground: true,
        figureStyle: "chibi-full",
        coupleLayout: "together",
        maxColors: 12,
        transparentBackground: false,
        inventoryOnly: false,
      });

      await assert.rejects(database.query(
        `UPDATE generation_jobs SET options = NULL WHERE id = $1`,
        [legacyJobId],
      ));
      await assert.rejects(database.query(
        `UPDATE generation_jobs SET options = '[]'::jsonb WHERE id = $1`,
        [legacyJobId],
      ));
      for (const maxColors of [4, 25]) {
        await assert.rejects(database.query(
          `UPDATE generation_jobs
           SET options = jsonb_set(options, '{maxColors}', to_jsonb($2::integer))
           WHERE id = $1`,
          [legacyJobId, maxColors],
        ));
      }

      const redrawMigrationPath = migrationPaths.find((path) => path.endsWith("0010_generation_redraw.sql"))!;
      await database.exec(await readFile(redrawMigrationPath, "utf8"));
      const soloMigrationPath = migrationPaths.find((path) => path.endsWith("0016_generation_solo_candidates.sql"))!;
      await database.exec(await readFile(soloMigrationPath, "utf8"));
      await database.query(
        `INSERT INTO generation_candidates(
           id, job_id, ordinal, encoding, width, height, cells, created_at
         ) VALUES
           ('legacy-pixel-output-1', $1, 1, 'palette-code-v1', 8, 8, $2::jsonb, $3),
           ('legacy-pixel-output-2', $1, 2, 'palette-code-v1', 8, 8, $2::jsonb, $3)`,
        [legacyJobId, JSON.stringify(Array.from({ length: 64 }, () => null)), "2026-10-04T09:00:01.000Z"],
      );
      const variantMigrationPath = migrationPaths.find((path) => path.endsWith("0022_generation_variants.sql"))!;
      await database.exec(await readFile(variantMigrationPath, "utf8"));
      const legacyVariants = await database.query<{
        ordinal: number;
        variant_ordinal: number;
        output_slot: string;
      }>(
        `SELECT ordinal, variant_ordinal, output_slot
         FROM generation_candidates WHERE job_id = $1 ORDER BY ordinal`,
        [legacyJobId],
      );
      assert.deepEqual(legacyVariants.rows, [
        { ordinal: 1, variant_ordinal: 1, output_slot: "combined" },
        { ordinal: 2, variant_ordinal: 2, output_slot: "combined" },
      ]);

      await database.query(
        `INSERT INTO credit_accounts(user_id, balance, updated_at) VALUES ($1, 5, $2)`,
        [userId, "2026-10-04T10:00:00.000Z"],
      );
      const created = await store.createGenerationJob({
        jobId: optionsJobId,
        userId,
        kind: "couple",
        paletteId,
        sourceAssetId: null,
        options: generationOptions,
        cost: 1,
        seed: "postgres-options-seed",
        width: 16,
        height: 16,
        now: "2026-10-04T10:00:01.000Z",
      });
      assert.deepEqual(created.options, generationOptions);
      assert.deepEqual((await store.getGenerationJob(userId, optionsJobId))?.options, generationOptions);

      const persisted = await database.query<{ options: GenerationOptions }>(
        `SELECT options FROM generation_jobs WHERE id = $1`,
        [optionsJobId],
      );
      assert.deepEqual(persisted.rows[0]?.options, generationOptions);
    } finally {
      await store.close();
    }
  });
});
