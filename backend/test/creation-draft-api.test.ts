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
  assetStorageRoot: join(tmpdir(), "pindou-creation-draft-api-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

const emptyDraft = {
  draftId: null,
  baseDraftRevision: 0,
  name: "周末合照",
  kind: "couple",
  setupStep: 2,
  paletteId: "mard-48-v1",
  sourceAssetId: null,
  width: 2,
  height: 2,
  options: {
    crop: { ratio: "4:3", rotation: 90 },
    coupleLayout: "split",
    maxColors: 8,
    transparentBackground: true,
    brightness: -20,
    contrast: 35,
    saturation: 60,
    dither: true,
  },
  grid: null,
} as const;

describe("creation draft API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function login(displayName: string): Promise<Record<string, string>> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName },
    });
    assert.equal(response.statusCode, 201, response.body);
    return { authorization: `Bearer ${response.json().token as string}` };
  }

  it("derives omitted maxColors from built-in and custom palettes without overriding explicit input", async () => {
    const { options: _omittedOptions, ...draftWithoutOptions } = emptyDraft;
    for (const [paletteId, expectedMaxColors] of [
      ["mard-48-v1", 16],
      ["mard-72-v1", 16],
      ["mard-144-v1", 24],
      ["mard-221-v1", 24],
      ["mard-291-v1", 32],
    ] as const) {
      const auth = await login(`草稿默认值 ${paletteId}`);
      const saved = await app.inject({
        method: "PUT",
        url: "/api/v1/creation-draft",
        headers: auth,
        payload: { ...draftWithoutOptions, paletteId },
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().draft.options.maxColors, expectedMaxColors, paletteId);
    }

    const customAuth = await login("草稿自定义色卡默认值");
    const customPalette = await app.inject({
      method: "POST",
      url: "/api/v1/palettes",
      headers: { ...customAuth, "idempotency-key": "draft-default-custom-palette" },
      payload: {
        name: "草稿默认值自定义色卡",
        brand: "测试",
        beadSizeMm: 5,
        colors: [
          { code: "X1", name: "黑", hex: "#000000" },
          { code: "X2", name: "白", hex: "#FFFFFF" },
        ],
      },
    });
    assert.equal(customPalette.statusCode, 201, customPalette.body);
    const customSaved = await app.inject({
      method: "PUT",
      url: "/api/v1/creation-draft",
      headers: customAuth,
      payload: { ...draftWithoutOptions, paletteId: customPalette.json().palette.id },
    });
    assert.equal(customSaved.statusCode, 200, customSaved.body);
    assert.equal(customSaved.json().draft.options.maxColors, 16);

    const explicitAuth = await login("草稿显式色数");
    const explicit = await app.inject({
      method: "PUT",
      url: "/api/v1/creation-draft",
      headers: explicitAuth,
      payload: { ...draftWithoutOptions, paletteId: "mard-291-v1", options: { maxColors: 9 } },
    });
    assert.equal(explicit.statusCode, 200, explicit.body);
    assert.equal(explicit.json().draft.options.maxColors, 9);
  });

  it("autosaves one isolated pre-project flow and atomically promotes its ready grid", async () => {
    const owner = await login("草稿所有者");
    const other = await login("其他用户");

    const initiallyEmpty = await app.inject({ method: "GET", url: "/api/v1/creation-draft", headers: owner });
    assert.equal(initiallyEmpty.statusCode, 200);
    assert.equal(initiallyEmpty.json().draft, null);

    const firstSave = await app.inject({
      method: "PUT",
      url: "/api/v1/creation-draft",
      headers: owner,
      payload: emptyDraft,
    });
    assert.equal(firstSave.statusCode, 200, firstSave.body);
    const first = firstSave.json().draft;
    assert.match(first.id, /^[0-9a-f-]{36}$/);
    assert.equal(first.draftRevision, 1);
    assert.equal(first.grid, null);
    assert.equal(first.options.crop.ratio, "4:3");
    assert.equal(first.options.crop.rotation, 90);
    assert.equal(first.options.crop.scale, 1);
    assert.equal(first.options.coupleLayout, "split");
    assert.equal(first.options.brightness, -20);
    assert.equal(first.options.contrast, 35);
    assert.equal(first.options.saturation, 60);
    assert.equal(first.options.dither, true);

    const isolated = await app.inject({ method: "GET", url: "/api/v1/creation-draft", headers: other });
    assert.equal(isolated.statusCode, 200);
    assert.equal(isolated.json().draft, null);

    const staleSave = await app.inject({
      method: "PUT",
      url: "/api/v1/creation-draft",
      headers: owner,
      payload: emptyDraft,
    });
    assert.equal(staleSave.statusCode, 409, staleSave.body);
    assert.equal(staleSave.json().error.code, "CREATION_DRAFT_ID_CONFLICT");

    const notReady = await app.inject({
      method: "POST",
      url: "/api/v1/creation-draft/commit",
      headers: { ...owner, "idempotency-key": "creation-not-ready" },
      payload: { draftId: first.id, draftRevision: 1 },
    });
    assert.equal(notReady.statusCode, 409, notReady.body);
    assert.equal(notReady.json().error.code, "CREATION_DRAFT_NOT_READY");

    const readySave = await app.inject({
      method: "PUT",
      url: "/api/v1/creation-draft",
      headers: owner,
      payload: {
        ...emptyDraft,
        draftId: first.id,
        baseDraftRevision: 1,
        setupStep: 3,
        grid: {
          encoding: "palette-code-v1",
          width: 2,
          height: 2,
          cells: ["F5", null, "C5", "A11"],
        },
      },
    });
    assert.equal(readySave.statusCode, 200, readySave.body);
    const ready = readySave.json().draft;
    assert.equal(ready.id, first.id);
    assert.equal(ready.draftRevision, 2);

    const commitHeaders = { ...owner, "idempotency-key": "creation-ready-commit" };
    const committed = await app.inject({
      method: "POST",
      url: "/api/v1/creation-draft/commit",
      headers: commitHeaders,
      payload: { draftId: ready.id, draftRevision: ready.draftRevision },
    });
    assert.equal(committed.statusCode, 201, committed.body);
    assert.equal(committed.json().project.name, "周末合照");
    assert.equal(committed.json().project.currentRevision, 1);
    assert.equal(committed.json().project.mode, "couple");
    assert.equal(committed.json().project.lifecycleStatus, "editable");
    assert.equal(committed.json().project.sourceAssetId, null);
    assert.equal(committed.json().project.previewAssetId, null);
    assert.equal(committed.json().project.backgroundMode, "transparent");
    assert.equal(committed.json().project.backgroundColor, null);
    assert.deepEqual(committed.json().project.grid.cells, ["F5", null, "C5", "A11"]);

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/creation-draft/commit",
      headers: commitHeaders,
      payload: { draftId: ready.id, draftRevision: ready.draftRevision },
    });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.equal(replay.json().project.id, committed.json().project.id);

    const afterCommit = await app.inject({ method: "GET", url: "/api/v1/creation-draft", headers: owner });
    assert.equal(afterCommit.json().draft, null);
    const projects = await app.inject({ method: "GET", url: "/api/v1/projects", headers: owner });
    assert.equal(projects.json().projects.length, 1);
  });

  it("rejects a grid that disagrees with setup dimensions and version-protects discard", async () => {
    const auth = await login("尺寸校验用户");
    const invalidGrid = await app.inject({
      method: "PUT",
      url: "/api/v1/creation-draft",
      headers: auth,
      payload: {
        ...emptyDraft,
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["F5"] },
      },
    });
    assert.equal(invalidGrid.statusCode, 400, invalidGrid.body);
    assert.equal(invalidGrid.json().error.code, "CREATION_DRAFT_GRID_SIZE_MISMATCH");

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/creation-draft",
      headers: auth,
      payload: emptyDraft,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const draft = saved.json().draft;

    const staleDiscard = await app.inject({
      method: "DELETE",
      url: "/api/v1/creation-draft",
      headers: { ...auth, "idempotency-key": "stale-discard" },
      payload: { draftId: draft.id, draftRevision: draft.draftRevision + 1 },
    });
    assert.equal(staleDiscard.statusCode, 409, staleDiscard.body);
    assert.equal(staleDiscard.json().error.code, "CREATION_DRAFT_REVISION_CONFLICT");

    const discarded = await app.inject({
      method: "DELETE",
      url: "/api/v1/creation-draft",
      headers: { ...auth, "idempotency-key": "current-discard" },
      payload: { draftId: draft.id, draftRevision: draft.draftRevision },
    });
    assert.equal(discarded.statusCode, 204, discarded.body);
    const after = await app.inject({ method: "GET", url: "/api/v1/creation-draft", headers: auth });
    assert.equal(after.json().draft, null);
  });
});
