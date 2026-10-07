import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { AssetPurpose } from "../src/domain/models.js";
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
  assetStorageRoot: join(tmpdir(), "pindou-project-metadata-api-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

const sourceAssetId = "00000000-0000-4000-8000-000000000821";
const previewAssetId = "00000000-0000-4000-8000-000000000822";
const pendingPreviewAssetId = "00000000-0000-4000-8000-000000000823";
const otherSourceAssetId = "00000000-0000-4000-8000-000000000824";

describe("project metadata API", () => {
  let app: FastifyInstance;
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    app = await buildApp({ config, store, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function login(displayName: string): Promise<{ token: string; userId: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName },
    });
    assert.equal(response.statusCode, 201, response.body);
    return { token: response.json().token, userId: response.json().user.id };
  }

  async function seedAsset(input: {
    id: string;
    userId: string;
    purpose: AssetPurpose;
    ready: boolean;
    digestCharacter: string;
  }): Promise<void> {
    const createdAt = "2026-10-04T10:00:00.000Z";
    await store.createAsset({
      id: input.id,
      userId: input.userId,
      purpose: input.purpose,
      consentVersion: "privacy-v1",
      sha256: input.digestCharacter.repeat(64),
      mimeType: "image/png",
      sizeBytes: 128,
      width: 16,
      height: 16,
      storageKey: `project-metadata-${input.id}`,
      expiresAt: "2030-10-04T10:00:00.000Z",
      createdAt,
    });
    if (input.ready) await store.markAssetReady(input.userId, input.id, createdAt);
  }

  it("keeps lifecycle separate from build status and validates tenant-owned ready asset references", async () => {
    const owner = await login("元数据所有者");
    const other = await login("元数据其他用户");
    await seedAsset({ id: sourceAssetId, userId: owner.userId, purpose: "ai-source", ready: true, digestCharacter: "a" });
    await seedAsset({ id: previewAssetId, userId: owner.userId, purpose: "ai-intermediate", ready: true, digestCharacter: "b" });
    await seedAsset({ id: pendingPreviewAssetId, userId: owner.userId, purpose: "ai-intermediate", ready: false, digestCharacter: "c" });
    await seedAsset({ id: otherSourceAssetId, userId: other.userId, purpose: "ai-source", ready: true, digestCharacter: "d" });
    const auth = { authorization: `Bearer ${owner.token}` };
    const grid = {
      encoding: "palette-code-v1",
      width: 2,
      height: 1,
      cells: ["H2", null],
    };

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth, "idempotency-key": "metadata-create" },
      payload: {
        name: "带完整元数据的作品",
        paletteId: "mard-48-v1",
        grid,
        mode: "portrait",
        sourceAssetId,
        previewAssetId,
        backgroundMode: "solid",
        backgroundColor: "#e1a2f3",
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const project = created.json().project;
    assert.equal(project.mode, "portrait");
    assert.equal(project.lifecycleStatus, "editable");
    assert.equal(project.metadataRevision, 1);
    assert.equal(project.sourceAssetId, sourceAssetId);
    assert.equal(project.previewAssetId, previewAssetId);
    assert.equal(project.backgroundMode, "solid");
    assert.equal(project.backgroundColor, "#E1A2F3");

    const listed = await app.inject({ method: "GET", url: "/api/v1/projects", headers: auth });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().projects[0].status, "draft");
    assert.equal(listed.json().projects[0].lifecycleStatus, "editable");

    const invalidLifecycle = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/metadata`,
      headers: { ...auth, "idempotency-key": "metadata-invalid-lifecycle" },
      payload: {
        baseRevision: 1,
        baseMetadataRevision: 1,
        lifecycleStatus: "removed-status",
      },
    });
    assert.equal(invalidLifecycle.statusCode, 400, invalidLifecycle.body);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/metadata`,
      headers: { ...auth, "idempotency-key": "metadata-update" },
      payload: {
        baseRevision: 1,
        baseMetadataRevision: 1,
        lifecycleStatus: "exported",
        previewAssetId: null,
        backgroundMode: "transparent",
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().project.currentRevision, 1);
    assert.equal(updated.json().project.lifecycleStatus, "exported");
    assert.equal(updated.json().project.metadataRevision, 2);
    assert.equal(updated.json().project.previewAssetId, null);
    assert.equal(updated.json().project.backgroundMode, "transparent");
    assert.equal(updated.json().project.backgroundColor, null);

    const staleMetadataUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/metadata`,
      headers: { ...auth, "idempotency-key": "metadata-stale-update" },
      payload: {
        baseRevision: 1,
        baseMetadataRevision: 1,
        mode: "couple",
      },
    });
    assert.equal(staleMetadataUpdate.statusCode, 409, staleMetadataUpdate.body);
    assert.equal(staleMetadataUpdate.json().error.code, "PROJECT_METADATA_REVISION_CONFLICT");
    assert.equal(staleMetadataUpdate.json().error.details.currentMetadataRevision, 2);

    await store.markAssetDeleted(owner.userId, sourceAssetId, "2026-10-04T11:00:00.000Z");
    const afterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}`,
      headers: auth,
    });
    assert.equal(afterDelete.json().project.sourceAssetId, null);
    assert.equal(afterDelete.json().project.metadataRevision, 3);

    for (const [key, assetId, expectedCode] of [
      ["cross-tenant", otherSourceAssetId, "PROJECT_SOURCE_ASSET_NOT_FOUND"],
      ["wrong-purpose", previewAssetId, "PROJECT_SOURCE_ASSET_NOT_FOUND"],
    ] as const) {
      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { ...auth, "idempotency-key": `metadata-${key}` },
        payload: {
          name: key,
          paletteId: "mard-48-v1",
          grid,
          sourceAssetId: assetId,
        },
      });
      assert.equal(rejected.statusCode, 404, rejected.body);
      assert.equal(rejected.json().error.code, expectedCode);
    }

    const pending = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/metadata`,
      headers: { ...auth, "idempotency-key": "metadata-pending-preview" },
      payload: { baseRevision: 1, baseMetadataRevision: 3, previewAssetId: pendingPreviewAssetId },
    });
    assert.equal(pending.statusCode, 404, pending.body);
    assert.equal(pending.json().error.code, "PROJECT_PREVIEW_ASSET_NOT_FOUND");

    const invalidBackground = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/metadata`,
      headers: { ...auth, "idempotency-key": "metadata-invalid-background" },
      payload: {
        baseRevision: 1,
        baseMetadataRevision: 3,
        backgroundMode: "white",
        backgroundColor: "#112233",
      },
    });
    assert.equal(invalidBackground.statusCode, 400, invalidBackground.body);
    assert.equal(invalidBackground.json().error.code, "PROJECT_BACKGROUND_COLOR_NOT_ALLOWED");
  });
});
