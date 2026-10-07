import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { MemoryStore } from "../src/repositories/memory-store.js";

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
  assetStorageRoot: join(tmpdir(), "pindou-project-lifecycle-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

describe("project lifecycle API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function login(name: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: name },
    });
    assert.equal(response.statusCode, 201);
    return response.json().token as string;
  }

  it("renames by revision, copies a snapshot, and hides soft-deleted projects", async () => {
    const token = await login("作品用户");
    const stranger = await login("其他用户");
    const auth = { authorization: `Bearer ${token}` };
    const grid = {
      encoding: "palette-code-v1",
      width: 2,
      height: 2,
      cells: ["H2", "A11", null, "E2"],
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth, "idempotency-key": "lifecycle-create-project" },
      payload: { name: "原始作品", paletteId: "mard-48-v1", grid },
    });
    assert.equal(created.statusCode, 201);
    const projectId = created.json().project.id as string;

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...auth, "idempotency-key": "lifecycle-rename-project" },
      payload: { baseRevision: 1, name: "  新作品名  ", deviceSource: "web" },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().project.name, "新作品名");
    assert.equal(renamed.json().project.currentRevision, 2);
    assert.equal(renamed.json().project.metadataRevision, 2);
    assert.equal(renamed.json().project.deviceSource, "web");
    assert.deepEqual(renamed.json().project.grid, grid);

    const renameProvenanceConflict = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...auth, "idempotency-key": "lifecycle-rename-project" },
      payload: { baseRevision: 1, name: "新作品名", deviceSource: "mini-program" },
    });
    assert.equal(renameProvenanceConflict.statusCode, 409, renameProvenanceConflict.body);
    assert.equal(renameProvenanceConflict.json().error.code, "IDEMPOTENCY_CONFLICT");

    const staleRename = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...auth, "idempotency-key": "lifecycle-stale-rename" },
      payload: { baseRevision: 1, name: "过期改名" },
    });
    assert.equal(staleRename.statusCode, 409);
    assert.equal(staleRename.json().error.code, "PROJECT_REVISION_CONFLICT");

    const metadata = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/metadata`,
      headers: { ...auth, "idempotency-key": "lifecycle-project-metadata" },
      payload: {
        baseRevision: 2,
        baseMetadataRevision: 2,
        mode: "pixel",
        lifecycleStatus: "exported",
        backgroundMode: "solid",
        backgroundColor: "#a1b2c3",
      },
    });
    assert.equal(metadata.statusCode, 200, metadata.body);
    assert.equal(metadata.json().project.currentRevision, 2);
    assert.equal(metadata.json().project.mode, "pixel");
    assert.equal(metadata.json().project.lifecycleStatus, "exported");
    assert.equal(metadata.json().project.metadataRevision, 3);
    assert.equal(metadata.json().project.backgroundMode, "solid");
    assert.equal(metadata.json().project.backgroundColor, "#A1B2C3");

    const copyHeaders = { ...auth, "idempotency-key": "lifecycle-copy-project" };
    const [copied, copiedReplay] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/copy`,
        headers: copyHeaders,
        payload: { revision: 1, name: "历史版本副本", deviceSource: "web" },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/copy`,
        headers: copyHeaders,
        payload: { revision: 1, name: "历史版本副本", deviceSource: "web" },
      }),
    ]);
    assert.equal(copied.statusCode, 201);
    assert.equal(copiedReplay.statusCode, 201);
    assert.equal(copied.json().project.id, copiedReplay.json().project.id);
    assert.equal(
      [copied, copiedReplay].filter((response) => response.headers["idempotency-replayed"] === "true").length,
      1,
    );
    assert.notEqual(copied.json().project.id, projectId);
    assert.equal(copied.json().project.name, "历史版本副本");
    assert.equal(copied.json().project.mode, "pixel");
    assert.equal(copied.json().project.lifecycleStatus, "editable");
    assert.equal(copied.json().project.metadataRevision, 1);
    assert.equal(copied.json().project.backgroundMode, "solid");
    assert.equal(copied.json().project.backgroundColor, "#A1B2C3");
    assert.equal(copied.json().project.deviceSource, "web");
    assert.equal(copied.json().project.sourceAssetId, null);
    assert.equal(copied.json().project.previewAssetId, null);
    assert.deepEqual(copied.json().project.grid, grid);

    const copyProvenanceConflict = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/copy`,
      headers: copyHeaders,
      payload: { revision: 1, name: "历史版本副本", deviceSource: "api" },
    });
    assert.equal(copyProvenanceConflict.statusCode, 409, copyProvenanceConflict.body);
    assert.equal(copyProvenanceConflict.json().error.code, "IDEMPOTENCY_CONFLICT");

    const hiddenFromStranger = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/copy`,
      headers: {
        authorization: `Bearer ${stranger}`,
        "idempotency-key": "lifecycle-cross-user-copy",
      },
      payload: {},
    });
    assert.equal(hiddenFromStranger.statusCode, 404);
    assert.equal(hiddenFromStranger.json().error.code, "PROJECT_NOT_FOUND");

    const deleteHeaders = { ...auth, "idempotency-key": "lifecycle-delete-project" };
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: deleteHeaders,
    });
    assert.equal(removed.statusCode, 204);
    const deleteReplay = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: deleteHeaders,
    });
    assert.equal(deleteReplay.statusCode, 204);
    assert.equal(deleteReplay.headers["idempotency-replayed"], "true");

    for (const suffix of ["", "/materials", "/build-progress", "/shortages"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}${suffix}`,
        headers: auth,
      });
      assert.equal(response.statusCode, 404, `${suffix || "project"} should be hidden`);
    }
    const listed = await app.inject({ method: "GET", url: "/api/v1/projects", headers: auth });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(
      listed.json().projects.map((project: { id: string }) => project.id),
      [copied.json().project.id],
    );

    const secondDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...auth, "idempotency-key": "lifecycle-delete-again" },
    });
    assert.equal(secondDelete.statusCode, 404);
    assert.equal(secondDelete.json().error.code, "PROJECT_NOT_FOUND");
  });
});
