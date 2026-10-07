import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { copyDefaultGenerationOptions } from "../src/domain/generation-options.js";
import { AppError } from "../src/errors.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const ownerId = "00000000-0000-4000-8000-000000000701";
const otherId = "00000000-0000-4000-8000-000000000702";

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

async function prepare(database: PGlite): Promise<void> {
  for (const migration of await loadMigrationFiles()) await database.exec(migration.sql);
  await database.exec(`
    INSERT INTO users(id, display_name) VALUES
      ('${ownerId}', '创建草稿用户'),
      ('${otherId}', '其他用户');
    INSERT INTO palettes(id, name, version) VALUES ('test-palette', '测试色卡', 1);
    INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
    VALUES
      ('test-palette', 'T01', '测试白', '#FFFFFF', 1, 0),
      ('test-palette', 'T02', '测试黑', '#000000', 1, 1);
  `);
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

describe("PostgresStore creation drafts", () => {
  it("keeps one versioned tenant-owned row and atomically promotes its ready grid", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await prepare(database);
      const options = copyDefaultGenerationOptions();
      options.crop.ratio = "3:4";
      options.maxColors = 8;
      options.brightness = -15;
      options.contrast = 25;
      options.saturation = 45;
      options.dither = true;

      const first = await store.saveCreationDraft({
        userId: ownerId,
        draftId: null,
        baseDraftRevision: 0,
        name: "云端创建流程",
        kind: "portrait",
        setupStep: 2,
        paletteId: "test-palette",
        sourceAssetId: null,
        width: 2,
        height: 2,
        options,
        grid: null,
      });
      assert.equal(first.draftRevision, 1);
      assert.equal(first.grid, null);
      assert.equal(first.options.crop.ratio, "3:4");
      assert.deepEqual(first.options, options);
      assert.equal(await store.getCreationDraft(otherId), null);

      await assert.rejects(
        store.saveCreationDraft({
          userId: ownerId,
          draftId: first.id,
          baseDraftRevision: 0,
          name: first.name,
          kind: first.kind,
          setupStep: first.setupStep,
          paletteId: first.paletteId,
          sourceAssetId: null,
          width: first.width,
          height: first.height,
          options: first.options,
          grid: null,
        }),
        rejectsWithCode("CREATION_DRAFT_REVISION_CONFLICT"),
      );
      await assert.rejects(
        store.commitCreationDraft({ userId: ownerId, draftId: first.id, draftRevision: 1 }),
        rejectsWithCode("CREATION_DRAFT_NOT_READY"),
      );
      assert.equal((await store.getCreationDraft(ownerId))?.draftRevision, 1);

      const ready = await store.saveCreationDraft({
        userId: ownerId,
        draftId: first.id,
        baseDraftRevision: 1,
        name: first.name,
        kind: first.kind,
        setupStep: 3,
        paletteId: first.paletteId,
        sourceAssetId: null,
        width: first.width,
        height: first.height,
        options: first.options,
        grid: {
          encoding: "palette-code-v1",
          width: 2,
          height: 2,
          cells: ["T01", null, "T02", "T01"],
        },
      });
      assert.equal(ready.id, first.id);
      assert.equal(ready.draftRevision, 2);

      const rowCount = await database.query<{ count: number | string }>(
        "SELECT count(*) AS count FROM creation_drafts WHERE user_id = $1",
        [ownerId],
      );
      assert.equal(Number(rowCount.rows[0]?.count), 1);

      const committed = await store.commitCreationDraft({
        userId: ownerId,
        draftId: ready.id,
        draftRevision: ready.draftRevision,
      });
      assert.equal(committed.currentRevision, 1);
      assert.equal(committed.name, "云端创建流程");
      assert.deepEqual(committed.grid.cells, ["T01", null, "T02", "T01"]);
      assert.equal(await store.getCreationDraft(ownerId), null);

      const persisted = await database.query<{
        projects: number | string;
        revisions: number | string;
        drafts: number | string;
      }>(`
        SELECT
          (SELECT count(*) FROM projects WHERE user_id = $1) AS projects,
          (SELECT count(*) FROM project_revisions WHERE project_id = $2) AS revisions,
          (SELECT count(*) FROM creation_drafts WHERE user_id = $1) AS drafts
      `, [ownerId, committed.id]);
      assert.deepEqual(
        {
          projects: Number(persisted.rows[0]?.projects),
          revisions: Number(persisted.rows[0]?.revisions),
          drafts: Number(persisted.rows[0]?.drafts),
        },
        { projects: 1, revisions: 1, drafts: 0 },
      );
    } finally {
      await store.close();
    }
  });

  it("version-protects discard and creates a new identity after a flow is removed", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await prepare(database);
      const input = {
        userId: ownerId,
        draftId: null,
        baseDraftRevision: 0,
        name: "待丢弃",
        kind: "normal" as const,
        setupStep: 1 as const,
        paletteId: "test-palette",
        sourceAssetId: null,
        width: 1,
        height: 1,
        options: copyDefaultGenerationOptions(),
        grid: null,
      };
      const first = await store.saveCreationDraft(input);
      await assert.rejects(
        store.discardCreationDraft({ userId: ownerId, draftId: first.id, draftRevision: 2 }),
        rejectsWithCode("CREATION_DRAFT_REVISION_CONFLICT"),
      );
      assert.equal(await store.discardCreationDraft({
        userId: ownerId,
        draftId: first.id,
        draftRevision: 1,
      }), true);
      assert.equal(await store.discardCreationDraft({
        userId: ownerId,
        draftId: first.id,
        draftRevision: 1,
      }), false);

      const second = await store.saveCreationDraft(input);
      assert.notEqual(second.id, first.id);
      assert.equal(second.draftRevision, 1);
    } finally {
      await store.close();
    }
  });

  it("enforces source-asset ownership and releases the reference when an asset row is purged", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await prepare(database);
      const ownerAssetId = "00000000-0000-4000-8000-000000000711";
      const otherAssetId = "00000000-0000-4000-8000-000000000712";
      await database.query(
        `INSERT INTO assets(
           id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
           width, height, storage_key, expires_at, ready_at, created_at
         ) VALUES
           ($1, $3, 'ai-source', 'privacy-v1', $5, 'image/png', 10,
            10, 10, 'creation-owner-asset-key', now() + interval '1 day', now(), now()),
           ($2, $4, 'ai-source', 'privacy-v1', $6, 'image/png', 10,
            10, 10, 'creation-other-asset-key', now() + interval '1 day', now(), now())`,
        [ownerAssetId, otherAssetId, ownerId, otherId, "a".repeat(64), "b".repeat(64)],
      );
      const base = {
        userId: ownerId,
        draftId: null,
        baseDraftRevision: 0,
        name: "带素材草稿",
        kind: "portrait" as const,
        setupStep: 2 as const,
        paletteId: "test-palette",
        width: 1,
        height: 1,
        options: copyDefaultGenerationOptions(),
        grid: null,
      };
      await assert.rejects(
        store.saveCreationDraft({ ...base, sourceAssetId: otherAssetId }),
        rejectsWithCode("CREATION_DRAFT_SOURCE_ASSET_NOT_FOUND"),
      );
      const saved = await store.saveCreationDraft({ ...base, sourceAssetId: ownerAssetId });
      assert.equal(saved.sourceAssetId, ownerAssetId);

      await database.query("DELETE FROM assets WHERE id = $1", [ownerAssetId]);
      assert.equal((await store.getCreationDraft(ownerId))?.sourceAssetId, null);
    } finally {
      await store.close();
    }
  });
});
