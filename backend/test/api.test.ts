import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";
import sharp from "sharp";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { hashToken } from "../src/auth.js";
import type { Palette } from "../src/domain/models.js";
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
  assetStorageRoot: join(tmpdir(), "pindou-api-test-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

function multipartImage(bytes: Buffer): { payload: Buffer; contentType: string } {
  const boundary = `pindou-generation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nai-source\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="consentVersion"\r\n\r\nprivacy-v1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.png"\r\nContent-Type: image/png\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe("pindou backend API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function login(displayName = "测试用户"): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName },
    });
    assert.equal(response.statusCode, 201);
    return response.json().token as string;
  }

  it("exposes health, readiness and a generated OpenAPI document", async () => {
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().status, "ok");

    const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });
    assert.equal(ready.statusCode, 200);

    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(openapi.statusCode, 200);
    assert.equal(openapi.json().info.title, "拼豆小程序 API");
  });

  it("exposes only active built-in palettes anonymously and never treats a raw token as its hash", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/palettes" });
    assert.equal(anonymous.statusCode, 200, anonymous.body);
    assert.deepEqual(
      anonymous.json().palettes.map((palette: { id: string }) => palette.id),
      ["mard-48-v1", "mard-72-v1", "mard-144-v1", "mard-221-v1", "mard-291-v1"],
    );
    assert.equal(anonymous.json().palettes.every((palette: { ownerUserId?: string | null }) => !palette.ownerUserId), true);

    const malformedCredential = await app.inject({
      method: "GET",
      url: "/api/v1/palettes",
      headers: { authorization: "Bearer invalid" },
    });
    assert.equal(malformedCredential.statusCode, 401);
    assert.equal(malformedCredential.json().error.code, "INVALID_TOKEN");

    const token = await login();
    assert.notEqual(hashToken(token), token);
    assert.equal(hashToken(token).length, 64);
    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/palettes",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.json().palettes[0].id, "mard-48-v1");

    const profile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(profile.statusCode, 200, profile.body);
    assert.equal(profile.json().user.displayName, "测试用户");
    assert.equal(profile.json().account.balance, 20);
    assert.deepEqual(profile.json().stats, {
      projects: { total: 0, draft: 0, inProgress: 0, completed: 0 },
      inventory: { colorCount: 0, beadCount: 0 },
      activeGenerationJobs: 0,
      exports: { total: 0, succeeded: 0 },
    });
  });

  it("pairs a Web browser session with the account that confirms the six-digit code", async () => {
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/web-login-challenges",
      payload: {},
    });
    assert.equal(challengeResponse.statusCode, 201, challengeResponse.body);
    const challenge = challengeResponse.json() as { token: string; sessionToken: string; code: string; expiresAt: string };
    assert.match(challenge.code, /^[0-9]{6}$/);
    assert.notEqual(challenge.sessionToken, challenge.token);

    const pending = await app.inject({
      method: "GET",
      url: "/api/v1/auth/web-login-challenges/current",
      headers: { "x-web-login-token": challenge.token },
    });
    assert.equal(pending.statusCode, 200, pending.body);
    assert.equal(pending.json().status, "pending");

    const miniProgramToken = await login("配对用户");
    const confirmed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/web-login-challenges/confirm",
      headers: { authorization: `Bearer ${miniProgramToken}` },
      payload: { code: challenge.code },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);

    const approved = await app.inject({
      method: "GET",
      url: "/api/v1/auth/web-login-challenges/current",
      headers: { "x-web-login-token": challenge.token },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().status, "approved");

    const webProfile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${challenge.token}` },
    });
    assert.equal(webProfile.statusCode, 200, webProfile.body);
    assert.equal(webProfile.json().user.displayName, "配对用户");

    const webProfileWithSessionToken = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${challenge.sessionToken}` },
    });
    assert.equal(webProfileWithSessionToken.statusCode, 200, webProfileWithSessionToken.body);
    assert.equal(webProfileWithSessionToken.json().user.displayName, "配对用户");

    const secondConfirmation = await app.inject({
      method: "POST",
      url: "/api/v1/auth/web-login-challenges/confirm",
      headers: { authorization: `Bearer ${miniProgramToken}` },
      payload: { code: challenge.code },
    });
    assert.equal(secondConfirmation.statusCode, 404, secondConfirmation.body);
  });

  it("rate-limits Web pairing creation and brute-force confirmation attempts", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/web-login-challenges", payload: {} });
      assert.equal(response.statusCode, 201, response.body);
    }
    const saturatedCreate = await app.inject({ method: "POST", url: "/api/v1/auth/web-login-challenges", payload: {} });
    assert.equal(saturatedCreate.statusCode, 429, saturatedCreate.body);
    assert.match(String(saturatedCreate.headers["retry-after"]), /^\d+$/);

    const token = await login("配对限流用户");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/web-login-challenges/confirm",
        headers: { authorization: `Bearer ${token}` },
        payload: { code: "999999" },
      });
      assert.equal(response.statusCode, 404, response.body);
    }
    const saturatedConfirm = await app.inject({
      method: "POST",
      url: "/api/v1/auth/web-login-challenges/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: { code: "999999" },
    });
    assert.equal(saturatedConfirm.statusCode, 429, saturatedConfirm.body);
    assert.match(String(saturatedConfirm.headers["retry-after"]), /^\d+$/);
  });

  it("paginates the authoritative credit ledger", async () => {
    const token = await login("账本分页用户");
    const first = await app.inject({ method: "GET", url: "/api/v1/credits/ledger?limit=1&offset=0", headers: { authorization: `Bearer ${token}` } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().entries.length, 1);
    assert.deepEqual(first.json().pagination, { limit: 1, offset: 0, hasMore: false, nextOffset: null });
    const empty = await app.inject({ method: "GET", url: "/api/v1/credits/ledger?limit=1&offset=1", headers: { authorization: `Bearer ${token}` } });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.equal(empty.json().entries.length, 0);
  });

  it("imports an idempotent private palette and keeps it isolated from other accounts", async () => {
    const ownerToken = await login("色卡所有者");
    const otherToken = await login("其他用户");
    const payload = {
      name: "工作室 5mm 色卡",
      brand: "自定义",
      beadSizeMm: 5,
      colors: [
        { code: "X01", name: "墨黑", hex: "#111111" },
        { code: "X02", name: "雪白", hex: "#FAFAFA", unitPriceCents: 4 },
      ],
    };

    const missingKey = await app.inject({
      method: "POST",
      url: "/api/v1/palettes",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload,
    });
    assert.equal(missingKey.statusCode, 400, missingKey.body);
    assert.equal(missingKey.json().error.code, "IDEMPOTENCY_KEY_REQUIRED");

    const headers = { authorization: `Bearer ${ownerToken}`, "idempotency-key": "custom-palette-import-1" };
    const created = await app.inject({ method: "POST", url: "/api/v1/palettes", headers, payload });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().palette.ownerUserId !== null, true);
    assert.equal(created.json().palette.series, payload.name);
    assert.equal(created.json().palette.material, "PE");
    assert.equal(created.json().palette.retired, false);
    assert.equal(created.json().palette.source.name, "user import");
    assert.equal(created.json().palette.colors[0].finish, "solid");
    assert.equal(created.json().palette.colors[1].code, "X02");

    const replayed = await app.inject({ method: "POST", url: "/api/v1/palettes", headers, payload });
    assert.equal(replayed.statusCode, 201, replayed.body);
    assert.equal(replayed.headers["idempotency-replayed"], "true");
    assert.equal(replayed.json().palette.id, created.json().palette.id);

    const ownerPalettes = await app.inject({
      method: "GET",
      url: "/api/v1/palettes",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerPalettes.json().palettes.some((palette: { id: string }) => palette.id === created.json().palette.id), true);

    const otherPalettes = await app.inject({
      method: "GET",
      url: "/api/v1/palettes",
      headers: { authorization: `Bearer ${otherToken}` },
    });
    assert.equal(otherPalettes.json().palettes.some((palette: { id: string }) => palette.id === created.json().palette.id), false);
  });

  it("exposes only the five pinned MARD reference palettes and round-trips valid MARD 48 colors", async () => {
    const token = await login();
    const authorization = { authorization: `Bearer ${token}` };
    const expectedColors = [
      { code: "H7", name: "MARD H7", hex: "#000000" },
      { code: "F5", name: "MARD F5", hex: "#D80127" },
      { code: "F13", name: "MARD F13", hex: "#DD422F" },
      { code: "E3", name: "MARD E3", hex: "#FF97C3" },
      { code: "A11", name: "MARD A11", hex: "#FFDD99" },
      { code: "C5", name: "MARD C5", hex: "#01ACEB" },
      { code: "B3", name: "MARD B3", hex: "#7CEE9D" },
      { code: "D18", name: "MARD D18", hex: "#A45EC7" },
      { code: "H2", name: "MARD H2", hex: "#FFFFFF" },
    ];

    const paletteResponse = await app.inject({
      method: "GET",
      url: "/api/v1/palettes",
      headers: authorization,
    });
    assert.equal(paletteResponse.statusCode, 200, paletteResponse.body);
    assert.deepEqual(
      paletteResponse.json().palettes.slice(0, 5).map((candidate: { id: string }) => candidate.id),
      ["mard-48-v1", "mard-72-v1", "mard-144-v1", "mard-221-v1", "mard-291-v1"],
    );
    const palette = paletteResponse.json().palettes.find(
      (candidate: { id: string }) => candidate.id === "mard-48-v1",
    );
    assert.ok(palette);
    assert.equal(palette.version, 1);
    assert.equal(palette.name, "MARD 48 色");
    assert.equal(palette.brand, "MARD");
    assert.equal(palette.series, "MARD 2.6mm");
    assert.equal(palette.beadSizeMm, 2.6);
    assert.equal(palette.verified, false);
    assert.equal(palette.retired, false);
    assert.equal(palette.source.name, "Pindou MARD 48-color project subset v1 (non-official)");
    assert.equal(palette.colors.length, 48);
    assert.equal(palette.colors.every((color: { available: boolean }) => color.available), true);
    const colorsByCode = new Map(
      palette.colors.map((color: { code: string; name: string; hex: string }) => [color.code, color]),
    );
    for (const expected of expectedColors) {
      const actual = colorsByCode.get(expected.code) as { code: string; name: string; hex: string } | undefined;
      assert.ok(actual, `missing MARD 48 color ${expected.code}`);
      assert.deepEqual(
        { code: actual.code, name: actual.name, hex: actual.hex },
        expected,
      );
    }
    const cells = expectedColors.map((color) => color.code);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...authorization, "idempotency-key": "mard-palette-round-trip" },
      payload: {
        name: "MARD 色号往返",
        paletteId: "mard-48-v1",
        grid: { encoding: "palette-code-v1", width: 3, height: 3, cells },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().project.grid.cells, cells);

    const fetched = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${created.json().project.id}`,
      headers: authorization,
    });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.deepEqual(fetched.json().project.grid.cells, cells);

    const materials = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${created.json().project.id}/materials`,
      headers: authorization,
    });
    assert.equal(materials.statusCode, 200, materials.body);
    const materialByCode = new Map(
      materials.json().materials.lines.map(
        (line: { colorCode: string; colorName: string; hex: string }) => [line.colorCode, line],
      ),
    );
    for (const expected of expectedColors) {
      const actual = materialByCode.get(expected.code) as {
        colorCode: string;
        colorName: string;
        hex: string;
      } | undefined;
      assert.ok(actual, `missing material line ${expected.code}`);
      assert.deepEqual(
        { colorCode: actual.colorCode, colorName: actual.colorName, hex: actual.hex },
        { colorCode: expected.code, colorName: expected.name, hex: expected.hex },
      );
    }
  });

  it("creates immutable project revisions, computes materials and enforces both optimistic locks", async () => {
    const token = await login();
    const headers = {
      authorization: `Bearer ${token}`,
      "idempotency-key": "create-project-0001",
    };
    const grid = {
      encoding: "palette-code-v1",
      width: 2,
      height: 2,
      cells: ["H2", "H2", "A11", null],
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { name: "第一张图纸", paletteId: "mard-48-v1", grid },
    });
    assert.equal(created.statusCode, 201);
    const projectId = created.json().project.id as string;

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { name: "第一张图纸", paletteId: "mard-48-v1", grid },
    });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.equal(replay.json().project.id, projectId);

    const idempotencyConflict = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { name: "错误复用同一幂等键", paletteId: "mard-48-v1", grid },
    });
    assert.equal(idempotencyConflict.statusCode, 409);
    assert.equal(idempotencyConflict.json().error.code, "IDEMPOTENCY_CONFLICT");

    const materials = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/materials`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(materials.statusCode, 200);
    assert.equal(materials.json().materials.beadCount, 3);
    assert.equal(materials.json().materials.estimatedTotalCents, 0);
    assert.deepEqual(
      {
        width: materials.json().materials.width,
        height: materials.json().materials.height,
        colorCount: materials.json().materials.colorCount,
        occupiedBounds: materials.json().materials.occupiedBounds,
        physicalSize: materials.json().materials.physicalSize,
      },
      {
        width: 2,
        height: 2,
        colorCount: 2,
        occupiedBounds: { left: 0, top: 0, right: 1, bottom: 1, width: 2, height: 2 },
        physicalSize: {
          unit: "mm",
          beadSizeMm: 2.6,
          canvas: { widthMm: 5.2, heightMm: 5.2 },
          occupied: { widthMm: 5.2, heightMm: 5.2 },
        },
      },
    );

    const nextGrid = { ...grid, cells: ["E2", "H2", "A11", "E2"] };
    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/grid`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "update-project-0001" },
      payload: { baseRevision: 1, grid: nextGrid },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().project.currentRevision, 2);

    const stale = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/grid`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "update-project-stale" },
      payload: { baseRevision: 1, grid },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "PROJECT_REVISION_CONFLICT");

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}?revision=1`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(history.json().project.grid.cells, grid.cells);

    const savedProgress = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/build-progress`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "progress-save-0001" },
      payload: { projectRevision: 2, baseProgressRevision: 0, completedIndices: [3, 1, 1] },
    });
    assert.equal(savedProgress.statusCode, 200);
    assert.deepEqual(savedProgress.json().progress.completedIndices, [1, 3]);

    const listedInProgress = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(listedInProgress.statusCode, 200, listedInProgress.body);
    assert.deepEqual(
      {
        id: listedInProgress.json().projects[0].id,
        width: listedInProgress.json().projects[0].width,
        height: listedInProgress.json().projects[0].height,
        colorCount: listedInProgress.json().projects[0].colorCount,
        beadCount: listedInProgress.json().projects[0].beadCount,
        completedBeadCount: listedInProgress.json().projects[0].completedBeadCount,
        status: listedInProgress.json().projects[0].status,
      },
      {
        id: projectId,
        width: 2,
        height: 2,
        colorCount: 3,
        beadCount: 4,
        completedBeadCount: 2,
        status: "in_progress",
      },
    );
    const profileInProgress = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(profileInProgress.statusCode, 200, profileInProgress.body);
    assert.deepEqual(profileInProgress.json().stats.projects, {
      total: 1,
      draft: 0,
      inProgress: 1,
      completed: 0,
    });

    const staleProgress = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/build-progress`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "progress-save-stale" },
      payload: { projectRevision: 2, baseProgressRevision: 0, completedIndices: [0] },
    });
    assert.equal(staleProgress.statusCode, 409);
    assert.equal(staleProgress.json().error.code, "BUILD_PROGRESS_REVISION_CONFLICT");

    const thirdRevision = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/grid`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "update-project-0002" },
      payload: { baseRevision: 2, grid },
    });
    assert.equal(thirdRevision.statusCode, 200);
    assert.equal(thirdRevision.json().project.currentRevision, 3);

    const listedAfterRevision = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(listedAfterRevision.statusCode, 200, listedAfterRevision.body);
    assert.equal(listedAfterRevision.json().projects[0].status, "draft");
    assert.equal(listedAfterRevision.json().projects[0].beadCount, 3);
    assert.equal(listedAfterRevision.json().projects[0].completedBeadCount, 0);

    const invalidatedProgress = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/build-progress`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(invalidatedProgress.statusCode, 409);
    assert.equal(invalidatedProgress.json().error.code, "BUILD_PROGRESS_REVISION_MISMATCH");

    const blankCellProgress = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/build-progress`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "progress-save-blank-cell" },
      payload: { projectRevision: 3, baseProgressRevision: 0, completedIndices: [3] },
    });
    assert.equal(blankCellProgress.statusCode, 400, blankCellProgress.body);
    assert.equal(blankCellProgress.json().error.code, "INVALID_COMPLETED_INDICES");
  });

  it("marks an explicitly started empty build as in progress and refreshes project activity", async () => {
    const token = await login();
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth, "idempotency-key": "empty-build-project" },
      payload: {
        name: "刚进入制作",
        paletteId: "mard-48-v1",
        grid: { encoding: "palette-code-v1", width: 2, height: 1, cells: ["H2", "A11"] },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const project = created.json().project;

    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${project.id}/build-progress`,
      headers: { ...auth, "idempotency-key": "empty-build-start" },
      payload: { projectRevision: 1, baseProgressRevision: 0, completedIndices: [] },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().progress.progressRevision, 1);
    assert.equal(saved.json().progress.mode, "color");
    assert.deepEqual(saved.json().progress.completedIndices, []);
    assert.equal(saved.json().progress.elapsedTime, 0);
    assert.ok(Date.parse(saved.json().progress.startedAt) >= Date.parse(project.updatedAt));
    assert.equal(saved.json().progress.completedAt, null);
    assert.ok(Date.parse(saved.json().progress.updatedAt) >= Date.parse(project.updatedAt));

    const listed = await app.inject({ method: "GET", url: "/api/v1/projects", headers: auth });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().projects[0].status, "in_progress");
    assert.equal(listed.json().projects[0].completedBeadCount, 0);
    assert.equal(listed.json().projects[0].updatedAt, saved.json().progress.updatedAt);

    const profile = await app.inject({ method: "GET", url: "/api/v1/me", headers: auth });
    assert.deepEqual(profile.json().stats.projects, {
      total: 1,
      draft: 0,
      inProgress: 1,
      completed: 0,
    });
  });

  it("persists build mode, elapsed seconds and server-managed lifecycle timestamps", async () => {
    const token = await login();
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth, "idempotency-key": "build-metadata-project" },
      payload: {
        name: "制作元数据",
        paletteId: "mard-48-v1",
        grid: { encoding: "palette-code-v1", width: 2, height: 1, cells: ["H2", "A11"] },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const projectId = created.json().project.id as string;

    const untouched = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/build-progress`,
      headers: auth,
    });
    assert.equal(untouched.statusCode, 200, untouched.body);
    assert.deepEqual(
      {
        progressRevision: untouched.json().progress.progressRevision,
        mode: untouched.json().progress.mode,
        navigationCursor: untouched.json().progress.navigationCursor,
        completedIndices: untouched.json().progress.completedIndices,
        elapsedTime: untouched.json().progress.elapsedTime,
        startedAt: untouched.json().progress.startedAt,
        completedAt: untouched.json().progress.completedAt,
      },
      {
        progressRevision: 0,
        mode: "color",
        navigationCursor: null,
        completedIndices: [],
        elapsedTime: 0,
        startedAt: null,
        completedAt: null,
      },
    );

    const completed = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/build-progress`,
      headers: { ...auth, "idempotency-key": "build-metadata-complete" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 0,
        mode: "region",
        completedIndices: [1, 0],
        elapsedTime: 75,
      },
    });
    assert.equal(completed.statusCode, 200, completed.body);
    const completedProgress = completed.json().progress;
    assert.equal(completedProgress.mode, "region");
    assert.equal(completedProgress.elapsedTime, 75);
    assert.deepEqual(completedProgress.completedIndices, [0, 1]);
    assert.ok(Number.isFinite(Date.parse(completedProgress.startedAt)));
    assert.ok(Number.isFinite(Date.parse(completedProgress.completedAt)));
    assert.ok(Date.parse(completedProgress.completedAt) >= Date.parse(completedProgress.startedAt));

    const reopened = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/build-progress`,
      headers: { ...auth, "idempotency-key": "build-metadata-reopen" },
      payload: { projectRevision: 1, baseProgressRevision: 1, completedIndices: [0] },
    });
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal(reopened.json().progress.mode, "region");
    assert.equal(reopened.json().progress.elapsedTime, 75);
    assert.equal(reopened.json().progress.startedAt, completedProgress.startedAt);
    assert.equal(reopened.json().progress.completedAt, null);

    const regressed = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/build-progress`,
      headers: { ...auth, "idempotency-key": "build-metadata-regression" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 2,
        mode: "row-column",
        completedIndices: [0],
        elapsedTime: 74,
      },
    });
    assert.equal(regressed.statusCode, 409, regressed.body);
    assert.equal(regressed.json().error.code, "BUILD_PROGRESS_ELAPSED_TIME_REGRESSION");
  });

  it("persists and validates resumable build navigation cursors with legacy omission semantics", async () => {
    const token = await login();
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth, "idempotency-key": "cursor-project" },
      payload: {
        name: "制作导航游标",
        paletteId: "mard-48-v1",
        grid: {
          encoding: "palette-code-v1",
          width: 3,
          height: 2,
          cells: ["H2", "A11", "H2", "E2", null, "A11"],
        },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const projectId = created.json().project.id as string;
    const url = `/api/v1/projects/${projectId}/build-progress`;

    const colorPayload = {
      projectRevision: 1,
      baseProgressRevision: 0,
      mode: "color",
      navigationCursor: { kind: "color", colorCode: "H2" },
      completedIndices: [0],
      elapsedTime: 10,
    };
    const color = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-color" },
      payload: colorPayload,
    });
    assert.equal(color.statusCode, 200, color.body);
    assert.equal(color.json().progress.progressRevision, 1);
    assert.deepEqual(color.json().progress.navigationCursor, { kind: "color", colorCode: "H2" });

    const replay = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-color" },
      payload: colorPayload,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json().progress, color.json().progress);

    const colorRoundTrip = await app.inject({ method: "GET", url, headers: auth });
    assert.equal(colorRoundTrip.statusCode, 200, colorRoundTrip.body);
    assert.deepEqual(colorRoundTrip.json().progress.navigationCursor, { kind: "color", colorCode: "H2" });

    const legacyOmission = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-legacy-omit" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 1,
        completedIndices: [0, 2],
        elapsedTime: 20,
      },
    });
    assert.equal(legacyOmission.statusCode, 200, legacyOmission.body);
    assert.deepEqual(legacyOmission.json().progress.navigationCursor, { kind: "color", colorCode: "H2" });

    const switchedWithoutCursor = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-mode-switch" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 2,
        mode: "region",
        completedIndices: [0, 2],
        elapsedTime: 30,
      },
    });
    assert.equal(switchedWithoutCursor.statusCode, 200, switchedWithoutCursor.body);
    assert.equal(switchedWithoutCursor.json().progress.mode, "region");
    assert.equal(switchedWithoutCursor.json().progress.navigationCursor, null);

    const region = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-region" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 3,
        mode: "region",
        navigationCursor: { kind: "region", regionIndex: 3 },
        completedIndices: [0, 2],
        elapsedTime: 40,
      },
    });
    assert.equal(region.statusCode, 200, region.body);
    assert.deepEqual(region.json().progress.navigationCursor, { kind: "region", regionIndex: 3 });
    const regionRoundTrip = await app.inject({ method: "GET", url, headers: auth });
    assert.deepEqual(regionRoundTrip.json().progress.navigationCursor, { kind: "region", regionIndex: 3 });

    const cleared = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-explicit-null" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 4,
        navigationCursor: null,
        completedIndices: [0, 2],
        elapsedTime: 50,
      },
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json().progress.navigationCursor, null);

    const rowColumn = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-row-column" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 5,
        mode: "row-column",
        navigationCursor: { kind: "row-column", axis: "row", index: 0 },
        completedIndices: [0, 2],
        elapsedTime: 60,
      },
    });
    assert.equal(rowColumn.statusCode, 200, rowColumn.body);
    assert.deepEqual(rowColumn.json().progress.navigationCursor, { kind: "row-column", axis: "row", index: 0 });
    const rowColumnRoundTrip = await app.inject({ method: "GET", url, headers: auth });
    assert.deepEqual(
      rowColumnRoundTrip.json().progress.navigationCursor,
      { kind: "row-column", axis: "row", index: 0 },
    );

    const missingColor = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-missing-color" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 6,
        mode: "color",
        navigationCursor: { kind: "color", colorCode: "M99" },
        completedIndices: [0, 2],
      },
    });
    assert.equal(missingColor.statusCode, 400, missingColor.body);
    assert.equal(missingColor.json().error.code, "BUILD_NAVIGATION_COLOR_NOT_FOUND");

    const invalidRegion = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-region-oob" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 6,
        mode: "region",
        navigationCursor: { kind: "region", regionIndex: 4 },
        completedIndices: [0, 2],
      },
    });
    assert.equal(invalidRegion.statusCode, 400, invalidRegion.body);

    const invalidRow = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-row-oob" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 6,
        mode: "row-column",
        navigationCursor: { kind: "row-column", axis: "row", index: 2 },
        completedIndices: [0, 2],
      },
    });
    assert.equal(invalidRow.statusCode, 400, invalidRow.body);
    assert.equal(invalidRow.json().error.code, "BUILD_NAVIGATION_CURSOR_OUT_OF_RANGE");

    const mismatched = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-mode-mismatch" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 6,
        mode: "color",
        navigationCursor: { kind: "region", regionIndex: 0 },
        completedIndices: [0, 2],
      },
    });
    assert.equal(mismatched.statusCode, 400, mismatched.body);
    assert.equal(mismatched.json().error.code, "BUILD_NAVIGATION_CURSOR_MODE_MISMATCH");

    const stale = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-stale" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 5,
        completedIndices: [0, 2],
      },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, "BUILD_PROGRESS_REVISION_CONFLICT");

    const completedTargetAndAdvanced = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "idempotency-key": "cursor-complete-and-advance" },
      payload: {
        projectRevision: 1,
        baseProgressRevision: 6,
        mode: "row-column",
        navigationCursor: { kind: "row-column", axis: "row", index: 1 },
        completedIndices: [0, 1, 2],
        elapsedTime: 70,
      },
    });
    assert.equal(completedTargetAndAdvanced.statusCode, 200, completedTargetAndAdvanced.body);
    assert.deepEqual(completedTargetAndAdvanced.json().progress.completedIndices, [0, 1, 2]);
    assert.deepEqual(
      completedTargetAndAdvanced.json().progress.navigationCursor,
      { kind: "row-column", axis: "row", index: 1 },
    );
    assert.equal(completedTargetAndAdvanced.json().progress.progressRevision, 7);
  });

  it("coalesces editor autosaves in one draft and commits exactly one immutable revision", async () => {
    const token = await login();
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth, "idempotency-key": "draft-project-create" },
      payload: {
        name: "草稿原稿",
        paletteId: "mard-48-v1",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const projectId = created.json().project.id as string;

    const first = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      headers: auth,
      payload: {
        baseProjectRevision: 1,
        baseDraftRevision: 0,
        name: "草稿新名称",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["A11"] },
      },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().draft.draftRevision, 1);

    const second = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      headers: auth,
      payload: {
        baseProjectRevision: 1,
        baseDraftRevision: 1,
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["E2"] },
      },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().draft.draftRevision, 2);
    assert.equal(second.json().draft.name, "草稿新名称");

    const stale = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      headers: auth,
      payload: {
        baseProjectRevision: 1,
        baseDraftRevision: 1,
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["F13"] },
      },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, "PROJECT_DRAFT_REVISION_CONFLICT");

    const beforeCommit = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: auth });
    assert.equal(beforeCommit.json().project.currentRevision, 1);
    assert.deepEqual(beforeCommit.json().project.grid.cells, ["H2"]);
    const listWithDraft = await app.inject({ method: "GET", url: "/api/v1/projects", headers: auth });
    assert.equal(listWithDraft.json().projects[0].hasDraft, true);

    const commitHeaders = { ...auth, "idempotency-key": "draft-project-commit" };
    const committed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/draft/commit`,
      headers: commitHeaders,
      payload: { baseProjectRevision: 1, draftRevision: 2 },
    });
    assert.equal(committed.statusCode, 200, committed.body);
    assert.equal(committed.json().project.currentRevision, 2);
    assert.equal(committed.json().project.name, "草稿新名称");
    assert.deepEqual(committed.json().project.grid.cells, ["E2"]);
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/draft/commit`,
      headers: commitHeaders,
      payload: { baseProjectRevision: 1, draftRevision: 2 },
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.headers["idempotency-replayed"], "true");

    const oldRevision = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}?revision=1`,
      headers: auth,
    });
    assert.deepEqual(oldRevision.json().project.grid.cells, ["H2"]);
    const noDraft = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/draft`, headers: auth });
    assert.equal(noDraft.statusCode, 200, noDraft.body);
    assert.equal(noDraft.json().draft, null);
    assert.equal(noDraft.json().baseProjectRevision, 2);
    const listCommitted = await app.inject({ method: "GET", url: "/api/v1/projects", headers: auth });
    assert.equal(listCommitted.json().projects[0].hasDraft, false);
  });

  it("paginates project summaries with a bounded validated window", async () => {
    const token = await login();
    const auth = { authorization: `Bearer ${token}` };
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { ...auth, "idempotency-key": `project-page-${index}` },
        payload: {
          name: `分页项目 ${index}`,
          paletteId: "mard-48-v1",
          grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      ids.push(created.json().project.id);
    }

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=2&offset=0",
      headers: auth,
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().projects.length, 2);
    assert.deepEqual(first.json().pagination, { limit: 2, offset: 0, hasMore: true, nextOffset: 2 });

    const second = await app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=2&offset=2",
      headers: auth,
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().projects.length, 1);
    assert.deepEqual(second.json().pagination, { limit: 2, offset: 2, hasMore: false, nextOffset: null });
    assert.deepEqual(
      new Set([...first.json().projects, ...second.json().projects].map((project: { id: string }) => project.id)),
      new Set(ids),
    );

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=101",
      headers: auth,
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
  });

  it("atomically replays concurrent generation requests, settles cost once, and accepts a candidate", async () => {
    const token = await login();
    const auth = { authorization: `Bearer ${token}` };
    const image = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 220, g: 80, b: 130, alpha: 1 } },
    }).png().toBuffer();
    const uploadBody = multipartImage(image);
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: {
        ...auth,
        "content-type": uploadBody.contentType,
        "idempotency-key": "portrait-source-upload-0001",
      },
      payload: uploadBody.payload,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const sourceAssetId = uploaded.json().asset.id as string;
    const createHeaders = { ...auth, "idempotency-key": "portrait-job-0001" };
    const payload = {
      kind: "portrait",
      paletteId: "mard-48-v1",
      sourceAssetId,
      width: 8,
      height: 8,
      seed: "fixed-seed",
    };

    const [generated, concurrentReplay] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/generation-jobs", headers: createHeaders, payload }),
      app.inject({ method: "POST", url: "/api/v1/generation-jobs", headers: createHeaders, payload }),
    ]);
    assert.equal(generated.statusCode, 202);
    assert.equal(concurrentReplay.statusCode, 202);
    const job = generated.json().job;
    assert.equal(job.status, "queued");
    assert.equal(job.progress, 0);
    assert.equal(job.candidates.length, 0);
    assert.equal("userId" in job, false);
    assert.equal("leaseToken" in job, false);
    assert.equal("seed" in job, false);
    assert.equal(concurrentReplay.json().job.id, job.id);
    assert.equal(
      [generated, concurrentReplay].filter((response) => response.headers["idempotency-replayed"] === "true").length,
      1,
    );

    const activeProfile = await app.inject({ method: "GET", url: "/api/v1/me", headers: auth });
    assert.equal(activeProfile.statusCode, 200, activeProfile.body);
    assert.equal(activeProfile.json().stats.activeGenerationJobs, 1);

    const credits = await app.inject({ method: "GET", url: "/api/v1/credits", headers: auth });
    assert.equal(credits.json().account.balance, 19);
    const reservedLedger = await app.inject({ method: "GET", url: "/api/v1/credits/ledger", headers: auth });
    assert.equal(reservedLedger.json().entries.filter((entry: { reason: string }) => entry.reason === "generation_reserved").length, 1);
    assert.equal(reservedLedger.json().entries.filter((entry: { reason: string }) => entry.reason === "generation_settled").length, 0);

    const prematureAccept = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${job.id}/accept`,
      headers: { ...auth, "idempotency-key": "accept-before-complete" },
      payload: { candidateId: `${job.id}-candidate-1`, projectName: "过早采用" },
    });
    assert.equal(prematureAccept.statusCode, 409);
    assert.equal(prematureAccept.json().error.code, "GENERATION_NOT_READY");

    const deniedWorker = await app.inject({
      method: "POST",
      url: "/api/v1/internal/generation-jobs/process-next",
      headers: { "x-internal-worker-key": "wrong-worker-key" },
    });
    assert.equal(deniedWorker.statusCode, 401);
    const processed = await app.inject({
      method: "POST",
      url: "/api/v1/internal/generation-jobs/process-next",
      headers: { "x-internal-worker-key": config.internalWorkerKey },
    });
    assert.equal(processed.statusCode, 200, processed.body);
    assert.equal(processed.json().job.status, "completed");
    assert.equal(processed.json().job.progress, 100);
    assert.equal(processed.json().job.candidates.length, 2);

    const completedProfile = await app.inject({ method: "GET", url: "/api/v1/me", headers: auth });
    assert.equal(completedProfile.statusCode, 200, completedProfile.body);
    assert.equal(completedProfile.json().stats.activeGenerationJobs, 0);

    const fetched = await app.inject({
      method: "GET",
      url: `/api/v1/generation-jobs/${job.id}`,
      headers: auth,
    });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().job.status, "completed");
    const completedJob = fetched.json().job;

    const settledLedger = await app.inject({ method: "GET", url: "/api/v1/credits/ledger", headers: auth });
    assert.equal(settledLedger.json().entries.filter((entry: { reason: string }) => entry.reason === "generation_reserved").length, 1);
    assert.equal(settledLedger.json().entries.filter((entry: { reason: string }) => entry.reason === "generation_settled").length, 1);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${job.id}/accept`,
      headers: { ...auth, "idempotency-key": "accept-candidate-0001" },
      payload: { candidateId: completedJob.candidates[0].id, projectName: "AI 肖像" },
    });
    assert.equal(accepted.statusCode, 201);
    assert.equal(accepted.json().job.status, "accepted");
    assert.deepEqual(accepted.json().project.grid, completedJob.candidates[0].grid);

    const duplicateAccept = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${job.id}/accept`,
      headers: { ...auth, "idempotency-key": "accept-candidate-0002" },
      payload: { candidateId: completedJob.candidates[0].id, projectName: "重复项目" },
    });
    assert.equal(duplicateAccept.statusCode, 409);
    assert.equal(duplicateAccept.json().error.code, "GENERATION_ALREADY_ACCEPTED");
  });

  it("rejects palette codes outside the selected palette", async () => {
    const token = await login();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "bad-grid-project" },
      payload: {
        name: "非法图纸",
        paletteId: "mard-48-v1",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["UNKNOWN"] },
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "UNKNOWN_PALETTE_COLOR");
  });

  it("atomically remaps a tenant-owned revision with stable palette and material contracts", async () => {
    const token = await login("换卡用户");
    const authorization = { authorization: `Bearer ${token}` };
    const originalGrid = {
      encoding: "palette-code-v1",
      width: 4,
      height: 3,
      cells: [
        null, "F13", "F13", null,
        null, "F13", "B3", null,
        null, null, null, null,
      ],
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...authorization, "idempotency-key": "remap-create" },
      payload: { name: "待换卡", paletteId: "mard-48-v1", grid: originalGrid },
    });
    assert.equal(created.statusCode, 201, created.body);
    const projectId = created.json().project.id as string;

    const materials = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/materials`,
      headers: authorization,
    });
    assert.equal(materials.statusCode, 200, materials.body);
    assert.deepEqual(materials.json().materials.occupiedBounds, {
      left: 1, top: 0, right: 2, bottom: 1, width: 2, height: 2,
    });
    assert.deepEqual(materials.json().materials.physicalSize, {
      unit: "mm",
      beadSizeMm: 2.6,
      canvas: { widthMm: 10.4, heightMm: 7.8 },
      occupied: { widthMm: 5.2, heightMm: 5.2 },
    });
    assert.equal(materials.json().materials.colorCount, 2);
    assert.equal(materials.json().materials.beadCount, 4);

    for (const maxColors of [4, 33]) {
      const invalidBound = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/remap-palette`,
        headers: { ...authorization, "idempotency-key": `remap-invalid-${maxColors}` },
        payload: { baseRevision: 1, paletteId: "mard-48-v1", maxColors },
      });
      assert.equal(invalidBound.statusCode, 400, invalidBound.body);
    }

    const noInventory = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/remap-palette`,
      headers: { ...authorization, "idempotency-key": "remap-no-inventory" },
      payload: { baseRevision: 1, paletteId: "mard-48-v1", maxColors: 5, inventoryOnly: true },
    });
    assert.equal(noInventory.statusCode, 409, noInventory.body);
    assert.equal(noInventory.json().error.code, "PALETTE_REMAP_NO_COLORS");

    const remapped = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/remap-palette`,
      headers: { ...authorization, "idempotency-key": "remap-success" },
      payload: { baseRevision: 1, paletteId: "mard-48-v1", maxColors: 5 },
    });
    assert.equal(remapped.statusCode, 200, remapped.body);
    assert.equal(remapped.json().project.currentRevision, 2);
    assert.equal(remapped.json().project.paletteId, "mard-48-v1");
    assert.equal(remapped.json().project.lifecycleStatus, "editable");
    assert.equal(remapped.json().project.previewAssetId, null);
    assert.equal(remapped.json().materials.beadCount, 4);
    assert.equal(remapped.json().materials.colorCount, 2);
    assert.deepEqual(
      remapped.json().project.grid.cells.map((cell: string | null) => cell === null),
      originalGrid.cells.map((cell) => cell === null),
    );
    assert.equal(new Set(remapped.json().project.grid.cells.filter(Boolean)).size, 2);

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/remap-palette`,
      headers: { ...authorization, "idempotency-key": "remap-success" },
      payload: { baseRevision: 1, paletteId: "mard-48-v1", maxColors: 5 },
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.equal(replay.json().project.currentRevision, 2);

    const historical = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}?revision=1`,
      headers: authorization,
    });
    assert.equal(historical.statusCode, 200, historical.body);
    assert.deepEqual(historical.json().project.grid.cells, originalGrid.cells);
    assert.equal(historical.json().project.paletteId, "mard-48-v1");

    const stale = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/remap-palette`,
      headers: { ...authorization, "idempotency-key": "remap-stale" },
      payload: { baseRevision: 1, paletteId: "mard-48-v1", maxColors: 5 },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, "PROJECT_REVISION_CONFLICT");

    const otherToken = await login("其他换卡用户");
    const hidden = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/remap-palette`,
      headers: { authorization: `Bearer ${otherToken}`, "idempotency-key": "remap-other-tenant" },
      payload: { baseRevision: 2, paletteId: "mard-48-v1", maxColors: 5 },
    });
    assert.equal(hidden.statusCode, 404, hidden.body);
    assert.equal(hidden.json().error.code, "PROJECT_NOT_FOUND");

    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...authorization, "idempotency-key": "empty-material-create" },
      payload: {
        name: "空图纸",
        paletteId: "mard-48-v1",
        grid: { encoding: "palette-code-v1", width: 2, height: 3, cells: Array(6).fill(null) },
      },
    });
    assert.equal(empty.statusCode, 201, empty.body);
    const emptyMaterials = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${empty.json().project.id}/materials`,
      headers: authorization,
    });
    assert.equal(emptyMaterials.statusCode, 200, emptyMaterials.body);
    assert.equal(emptyMaterials.json().materials.beadCount, 0);
    assert.equal(emptyMaterials.json().materials.colorCount, 0);
    assert.equal(emptyMaterials.json().materials.occupiedBounds, null);
    assert.equal(emptyMaterials.json().materials.physicalSize.occupied, null);
  });

  it("requires confirmation and atomically audits the fixed legacy palette migration", async () => {
    await app.close();
    const store = new MemoryStore();
    const legacyPalette: Palette = {
      id: "mard-basic-v1",
      name: "退役演示色卡",
      brand: "非官方演示数据",
      series: "legacy-prototype",
      material: "PE",
      beadSizeMm: 5,
      verified: false,
      retired: false,
      version: 2,
      source: {
        name: "Pindou legacy prototype palette",
        url: "",
        revision: "2",
        license: "Internal prototype data; not an official MARD dataset",
      },
      colors: [
        { code: "M05", name: "旧紫", hex: "#A868A0", unitPriceCents: 1, available: true },
        { code: "G11", name: "旧绿", hex: "#62C6A3", unitPriceCents: 1, available: true },
      ],
    };
    (Reflect.get(store, "palettes") as Map<string, Palette>).set(legacyPalette.id, legacyPalette);
    app = await buildApp({ config, store, logger: false });
    await app.ready();
    const token = await login("旧色卡迁移用户");
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth, "idempotency-key": "legacy-remap-create" },
      payload: {
        name: "待审计迁移",
        paletteId: legacyPalette.id,
        grid: {
          encoding: "palette-code-v1",
          width: 2,
          height: 1,
          cells: ["M05", "G11"],
        },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    legacyPalette.retired = true;
    const projectId = created.json().project.id as string;

    const confirmationRequired = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/remap-palette`,
      headers: { ...auth, "idempotency-key": "legacy-remap-needs-confirmation" },
      payload: { baseRevision: 1, paletteId: "mard-291-v1", maxColors: 5 },
    });
    assert.equal(confirmationRequired.statusCode, 409, confirmationRequired.body);
    assert.equal(confirmationRequired.json().error.code, "LEGACY_PALETTE_CONFIRMATION_REQUIRED");
    assert.deepEqual(
      confirmationRequired.json().error.details.mappings.map((mapping: { oldCode: string }) => mapping.oldCode),
      ["M05"],
    );

    const migrated = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/remap-palette`,
      headers: { ...auth, "idempotency-key": "legacy-remap-confirmed" },
      payload: {
        baseRevision: 1,
        paletteId: "mard-291-v1",
        maxColors: 5,
        confirmUnreliableLegacyMappings: true,
      },
    });
    assert.equal(migrated.statusCode, 200, migrated.body);
    assert.equal(migrated.json().project.currentRevision, 2);
    assert.equal(migrated.json().project.paletteId, "mard-291-v1");
    assert.deepEqual(migrated.json().project.grid.cells, ["M11", "P6"]);
    assert.deepEqual(migrated.json().migration, {
      version: "legacy-demo-to-mard-291-v1@1",
      targetPaletteId: "mard-291-v1",
      confirmedUnreliableCodes: ["M05"],
    });
    const audits = Reflect.get(store, "paletteColorMigrationAudits") as Array<{
      entityId: string;
      oldColorCode: string;
      newColorCode: string;
      reliable: boolean;
    }>;
    assert.deepEqual(audits.map((audit) => ({
      entityId: audit.entityId,
      oldColorCode: audit.oldColorCode,
      newColorCode: audit.newColorCode,
      reliable: audit.reliable,
    })), [
      { entityId: `${projectId}:2`, oldColorCode: "M05", newColorCode: "M11", reliable: false },
      { entityId: `${projectId}:2`, oldColorCode: "G11", newColorCode: "P6", reliable: true },
    ]);
  });
});
