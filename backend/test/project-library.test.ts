import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused",
  databaseSsl: false,
  devAuthEnabled: true,
  corsOrigins: ["http://localhost:5173"],
  sessionTtlDays: 30,
  devStartingCredits: 20,
  assetStorageRoot: join(tmpdir(), "pindou-project-library-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

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

describe("project library API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
    await app.ready();
  });

  afterEach(async () => app.close());

  async function login(displayName: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().token as string;
  }

  it("normalizes tags, combines filters, pages revision metadata, and restores by appending", async () => {
    const token = await login("作品库用户");
    const stranger = await login("其他作品库用户");
    const auth = { authorization: `Bearer ${token}` };
    const originalGrid = {
      encoding: "palette-code-v1",
      width: 2,
      height: 1,
      cells: ["H2", "A11"],
    } as const;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth, "idempotency-key": "library-create-cat" },
      payload: {
        name: "萌猫拼豆",
        paletteId: "mard-48-v1",
        grid: originalGrid,
        mode: "portrait",
        tags: ["  猫咪  ", "猫咪", "ＡＩ"],
        deviceSource: "web",
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const projectId = created.json().project.id as string;
    assert.deepEqual(created.json().project.tags, ["猫咪", "AI"]);
    assert.equal(created.json().project.deviceSource, "web");
    assert.equal(created.json().project.revisionDeviceSource, "web");

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth, "idempotency-key": "library-create-pixel" },
      payload: {
        name: "像素风景",
        paletteId: "mard-48-v1",
        grid: originalGrid,
        mode: "pixel",
        tags: ["风景"],
        deviceSource: "mini-program",
      },
    });
    assert.equal(second.statusCode, 201, second.body);
    const secondId = second.json().project.id as string;
    const secondMetadata = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${secondId}/metadata`,
      headers: { ...auth, "idempotency-key": "library-second-metadata" },
      payload: {
        baseRevision: 1,
        baseMetadataRevision: 1,
        lifecycleStatus: "generating",
        tags: ["  待 制作  ", "待 制作"],
        deviceSource: "api",
      },
    });
    assert.equal(secondMetadata.statusCode, 200, secondMetadata.body);
    assert.deepEqual(secondMetadata.json().project.tags, ["待 制作"]);

    const bySearch = await app.inject({
      method: "GET",
      url: "/api/v1/projects?q=%E8%90%8C%E7%8C%AB&mode=portrait&tag=ai&limit=1&offset=0",
      headers: auth,
    });
    assert.equal(bySearch.statusCode, 200, bySearch.body);
    assert.deepEqual(bySearch.json().projects.map((project: { id: string }) => project.id), [projectId]);
    assert.equal(bySearch.json().pagination.hasMore, false);

    const byLifecycle = await app.inject({
      method: "GET",
      url: "/api/v1/projects?status=draft&mode=pixel&lifecycleStatus=generating&tag=%E5%BE%85%20%E5%88%B6%E4%BD%9C",
      headers: auth,
    });
    assert.equal(byLifecycle.statusCode, 200, byLifecycle.body);
    assert.deepEqual(byLifecycle.json().projects.map((project: { id: string }) => project.id), [secondId]);

    const editedGrid = {
      encoding: "palette-code-v1",
      width: 1,
      height: 1,
      cells: ["E2"],
    } as const;
    const edited = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/grid`,
      headers: { ...auth, "idempotency-key": "library-edit-cat" },
      payload: { baseRevision: 1, grid: editedGrid, deviceSource: "mini-program" },
    });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().project.currentRevision, 2);
    assert.equal(edited.json().project.revisionDeviceSource, "mini-program");

    const concurrentRestores = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/revisions/1/restore`,
        headers: { ...auth, "idempotency-key": "library-restore-cat" },
        payload: { baseRevision: 2, deviceSource: "web" },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/revisions/1/restore`,
        headers: { ...auth, "idempotency-key": "library-concurrent-restore" },
        payload: { baseRevision: 2, deviceSource: "web" },
      }),
    ]);
    assert.deepEqual(concurrentRestores.map((response) => response.statusCode).sort(), [200, 409]);
    const restored = concurrentRestores.find((response) => response.statusCode === 200)!;
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().project.currentRevision, 3);
    assert.deepEqual(restored.json().project.grid, originalGrid);
    assert.equal(restored.json().project.revisionDeviceSource, "web");

    const staleRestore = concurrentRestores.find((response) => response.statusCode === 409)!;
    assert.equal(staleRestore.json().error.code, "PROJECT_REVISION_CONFLICT");

    const firstPage = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/revisions?limit=2&offset=0`,
      headers: auth,
    });
    assert.equal(firstPage.statusCode, 200, firstPage.body);
    assert.deepEqual(firstPage.json().revisions.map((revision: { revision: number }) => revision.revision), [3, 2]);
    assert.equal(firstPage.json().pagination.hasMore, true);
    assert.equal("grid" in firstPage.json().revisions[0], false);
    assert.equal(firstPage.json().revisions[0].deviceSource, "web");
    const secondPage = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/revisions?limit=2&offset=2`,
      headers: auth,
    });
    assert.deepEqual(secondPage.json().revisions.map((revision: { revision: number }) => revision.revision), [1]);

    const copied = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/copy`,
      headers: { ...auth, "idempotency-key": "library-copy-cat" },
      payload: { revision: 1, deviceSource: "api" },
    });
    assert.equal(copied.statusCode, 201, copied.body);
    assert.deepEqual(copied.json().project.tags, ["猫咪", "AI"]);
    assert.equal(copied.json().project.deviceSource, "api");

    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/revisions`,
      headers: { authorization: `Bearer ${stranger}` },
    });
    assert.equal(hidden.statusCode, 404, hidden.body);
  });
});

describe("PostgresStore project library", () => {
  it("matches filtering/restoration semantics, isolates tenants, and rolls back a failed restore", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const ownerId = "00000000-0000-4000-8000-000000003501";
    const otherId = "00000000-0000-4000-8000-000000003502";
    try {
      for (const migration of await loadMigrationFiles()) await database.exec(migration.sql);
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('${ownerId}', '作品库 PG 用户'),
          ('${otherId}', '其他 PG 用户');
        INSERT INTO palettes(id, name, version, brand, bead_size_mm, verified)
        VALUES ('library-palette', '作品库色卡', 1, '测试', 5, false);
        INSERT INTO palette_colors(
          palette_id, code, name, hex, unit_price_cents, sort_order, available
        ) VALUES
          ('library-palette', 'H2', '色一', '#FF0000', 1, 0, true),
          ('library-palette', 'A11', '色二', '#00FF00', 1, 1, true),
          ('library-palette', 'E2', '色三', '#0000FF', 1, 2, true);
      `);
      const created = await store.createProject(ownerId, {
        name: "Postgres 萌猫",
        paletteId: "library-palette",
        mode: "portrait",
        tags: [" 猫咪 ", "ＡＩ", "ai"],
        deviceSource: "web",
        grid: { encoding: "palette-code-v1", width: 2, height: 1, cells: ["H2", "A11"] },
      });
      assert.deepEqual(created.tags, ["猫咪", "AI"]);
      assert.equal(created.deviceSource, "web");

      assert.deepEqual(
        (await store.listProjects({
          userId: ownerId,
          limit: 10,
          offset: 0,
          q: "萌猫",
          status: "draft",
          mode: "portrait",
          lifecycleStatus: "editable",
          tag: "ai",
        })).map((project) => project.id),
        [created.id],
      );

      const longNameProject = await store.createProject(ownerId, {
        name: "长".repeat(100),
        paletteId: "library-palette",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
      });
      const defaultNamedCopy = await store.copyProject({
        userId: ownerId,
        projectId: longNameProject.id,
      });
      assert.ok(defaultNamedCopy);
      assert.equal(Array.from(defaultNamedCopy.name).length, 100);
      assert.equal(defaultNamedCopy.name, `${"长".repeat(97)} 副本`);
      assert.deepEqual(await store.listProjects({
        userId: otherId,
        limit: 10,
        offset: 0,
        tag: "AI",
      }), []);

      const edited = await store.updateProjectGrid({
        userId: ownerId,
        projectId: created.id,
        baseRevision: 1,
        deviceSource: "mini-program",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["E2"] },
      });
      assert.equal(edited.currentRevision, 2);
      const restored = await store.restoreProjectRevision({
        userId: ownerId,
        projectId: created.id,
        revision: 1,
        baseRevision: 2,
        deviceSource: "api",
      });
      assert.equal(restored.currentRevision, 3);
      assert.deepEqual(restored.grid.cells, ["H2", "A11"]);
      assert.deepEqual(
        (await store.listProjectRevisions({ userId: ownerId, projectId: created.id, limit: 10, offset: 0 }))
          .map((revision) => [revision.revision, revision.deviceSource]),
        [[3, "api"], [2, "mini-program"], [1, "web"]],
      );
      assert.deepEqual(
        await store.listProjectRevisions({ userId: otherId, projectId: created.id, limit: 10, offset: 0 }),
        [],
      );
      await assert.rejects(
        store.restoreProjectRevision({
          userId: otherId,
          projectId: created.id,
          revision: 1,
          baseRevision: 3,
        }),
        (error: unknown) => error instanceof AppError && error.code === "PROJECT_NOT_FOUND",
      );

      await database.exec(`
        CREATE FUNCTION reject_test_restore() RETURNS trigger AS $$
        BEGIN
          IF NEW.current_revision = 4 THEN
            RAISE EXCEPTION 'test restore rollback';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_test_restore
          BEFORE UPDATE ON projects
          FOR EACH ROW EXECUTE FUNCTION reject_test_restore();
      `);
      await assert.rejects(store.restoreProjectRevision({
        userId: ownerId,
        projectId: created.id,
        revision: 1,
        baseRevision: 3,
        deviceSource: "web",
      }), /test restore rollback/i);
      const afterRollback = await database.query<{ current_revision: number; revision_count: number | string }>(
        `SELECT project.current_revision,
                (SELECT count(*) FROM project_revisions AS revision
                 WHERE revision.project_id = project.id) AS revision_count
         FROM projects AS project WHERE project.id = $1`,
        [created.id],
      );
      assert.deepEqual({
        currentRevision: afterRollback.rows[0]?.current_revision,
        revisionCount: Number(afterRollback.rows[0]?.revision_count),
      }, { currentRevision: 3, revisionCount: 3 });

      await assert.rejects(
        database.query("UPDATE project_revisions SET device_source = 'web' WHERE project_id = $1 AND revision = 1", [created.id]),
        /project revisions are immutable/i,
      );
      await assert.rejects(
        database.query("UPDATE projects SET tags = ARRAY['AI', 'ai'] WHERE id = $1", [created.id]),
        /projects_tags_valid|check constraint/i,
      );
    } finally {
      await store.close();
    }
  });
});
