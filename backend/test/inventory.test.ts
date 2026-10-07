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
  assetStorageRoot: join(tmpdir(), "pindou-inventory-test-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

describe("inventory API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function login(displayName: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName },
    });
    assert.equal(response.statusCode, 201);
    return response.json().token as string;
  }

  it("requires ownership and atomically replays inventory calibration", async () => {
    const token = await login("库存用户");
    const otherToken = await login("其他用户");
    const auth = { authorization: `Bearer ${token}` };

    const denied = await app.inject({ method: "GET", url: "/api/v1/inventory" });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.json().error.code, "AUTH_REQUIRED");

    const initial = await app.inject({ method: "GET", url: "/api/v1/inventory", headers: auth });
    assert.equal(initial.statusCode, 200);
    assert.deepEqual(initial.json().items, []);

    const payload = { quantity: 12, location: "  收纳盒 A1  ", baseRevision: 0 };
    const headers = { ...auth, "idempotency-key": "inventory-m01-create" };
    const [created, replayed] = await Promise.all([
      app.inject({ method: "PUT", url: "/api/v1/inventory/mard-48-v1/H2", headers, payload }),
      app.inject({ method: "PUT", url: "/api/v1/inventory/mard-48-v1/H2", headers, payload }),
    ]);
    assert.equal(created.statusCode, 201);
    assert.equal(replayed.statusCode, 201);
    assert.equal(
      [created, replayed].filter((response) => response.headers["idempotency-replayed"] === "true").length,
      1,
    );
    assert.deepEqual(
      {
        quantity: created.json().item.quantity,
        location: created.json().item.location,
        revision: created.json().item.revision,
      },
      { quantity: 12, location: "收纳盒 A1", revision: 1 },
    );

    const conflict = await app.inject({
      method: "PUT",
      url: "/api/v1/inventory/mard-48-v1/H2",
      headers,
      payload: { ...payload, quantity: 13 },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");

    const stale = await app.inject({
      method: "PUT",
      url: "/api/v1/inventory/mard-48-v1/H2",
      headers: { ...auth, "idempotency-key": "inventory-m01-stale" },
      payload: { quantity: 8, location: null, baseRevision: 0 },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "INVENTORY_REVISION_CONFLICT");
    assert.equal(stale.json().error.details.currentRevision, 1);

    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/inventory/mard-48-v1/H2",
      headers: { ...auth, "idempotency-key": "inventory-m01-update" },
      payload: { quantity: 8, location: null, baseRevision: 1 },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().item.revision, 2);
    assert.equal(updated.json().item.quantity, 8);

    const ownerItems = await app.inject({
      method: "GET",
      url: "/api/v1/inventory?paletteId=mard-48-v1",
      headers: auth,
    });
    assert.equal(ownerItems.statusCode, 200);
    assert.equal(ownerItems.json().items.length, 1);
    assert.equal(ownerItems.json().items[0].quantity, 8);

    const otherItems = await app.inject({
      method: "GET",
      url: "/api/v1/inventory?paletteId=mard-48-v1",
      headers: { authorization: `Bearer ${otherToken}` },
    });
    assert.equal(otherItems.statusCode, 200);
    assert.deepEqual(otherItems.json().items, []);
  });

  it("validates inventory input and unknown palette colors", async () => {
    const token = await login("校验用户");
    const auth = { authorization: `Bearer ${token}` };

    const noKey = await app.inject({
      method: "PUT",
      url: "/api/v1/inventory/mard-48-v1/H2",
      headers: auth,
      payload: { quantity: 1, location: null, baseRevision: 0 },
    });
    assert.equal(noKey.statusCode, 400);
    assert.equal(noKey.json().error.code, "IDEMPOTENCY_KEY_REQUIRED");

    const whitespaceLocation = await app.inject({
      method: "PUT",
      url: "/api/v1/inventory/mard-48-v1/H2",
      headers: { ...auth, "idempotency-key": "inventory-blank-location" },
      payload: { quantity: 1, location: "   ", baseRevision: 0 },
    });
    assert.equal(whitespaceLocation.statusCode, 400);
    assert.equal(whitespaceLocation.json().error.code, "INVENTORY_LOCATION_REQUIRED");

    const extraProperty = await app.inject({
      method: "PUT",
      url: "/api/v1/inventory/mard-48-v1/H2",
      headers: { ...auth, "idempotency-key": "inventory-extra-field" },
      payload: { quantity: 1, location: null, baseRevision: 0, delta: 99 },
    });
    assert.equal(extraProperty.statusCode, 400);
    assert.equal(extraProperty.json().error.code, "VALIDATION_ERROR");

    const unknownColor = await app.inject({
      method: "PUT",
      url: "/api/v1/inventory/mard-48-v1/UNKNOWN",
      headers: { ...auth, "idempotency-key": "inventory-unknown-color" },
      payload: { quantity: 1, location: null, baseRevision: 0 },
    });
    assert.equal(unknownColor.statusCode, 404);
    assert.equal(unknownColor.json().error.code, "PALETTE_COLOR_NOT_FOUND");

    const unknownPalette = await app.inject({
      method: "GET",
      url: "/api/v1/inventory?paletteId=unknown-palette",
      headers: auth,
    });
    assert.equal(unknownPalette.statusCode, 404);
    assert.equal(unknownPalette.json().error.code, "PALETTE_NOT_FOUND");
  });

  it("compares an immutable project revision without consuming inventory", async () => {
    const token = await login("缺货计算用户");
    const otherToken = await login("越权用户");
    const auth = { authorization: `Bearer ${token}` };

    for (const item of [
      { colorCode: "H2", quantity: 2, location: "白色盒" },
      { colorCode: "A11", quantity: 5, location: "黄色盒" },
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/inventory/mard-48-v1/${item.colorCode}`,
        headers: { ...auth, "idempotency-key": `inventory-${item.colorCode.toLowerCase()}-seed` },
        payload: { quantity: item.quantity, location: item.location, baseRevision: 0 },
      });
      assert.equal(response.statusCode, 201);
    }

    const grid = {
      encoding: "palette-code-v1",
      width: 3,
      height: 2,
      cells: ["H2", "H2", "H2", "A11", "A11", "E2"],
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth, "idempotency-key": "inventory-project-create" },
      payload: { name: "缺货测试图纸", paletteId: "mard-48-v1", grid },
    });
    assert.equal(created.statusCode, 201);
    const projectId = created.json().project.id as string;

    const shortages = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/shortages?revision=1`,
      headers: auth,
    });
    assert.equal(shortages.statusCode, 200);
    const summary = shortages.json().shortages;
    assert.deepEqual(
      {
        projectRevision: summary.projectRevision,
        paletteId: summary.paletteId,
        requiredBeadCount: summary.requiredBeadCount,
        coveredBeadCount: summary.coveredBeadCount,
        shortageBeadCount: summary.shortageBeadCount,
        hasShortage: summary.hasShortage,
      },
      {
        projectRevision: 1,
        paletteId: "mard-48-v1",
        requiredBeadCount: 6,
        coveredBeadCount: 4,
        shortageBeadCount: 2,
        hasShortage: true,
      },
    );
    assert.deepEqual(
      summary.purchaseList.map((line: { colorCode: string; shortageQuantity: number }) => ({
        colorCode: line.colorCode,
        shortageQuantity: line.shortageQuantity,
      })),
      [
        { colorCode: "H2", shortageQuantity: 1 },
        { colorCode: "E2", shortageQuantity: 1 },
      ],
    );
    const yellow = summary.lines.find((line: { colorCode: string }) => line.colorCode === "A11");
    assert.equal(yellow.availableQuantity, 5);
    assert.equal(yellow.coveredQuantity, 2);
    assert.equal(yellow.shortageQuantity, 0);
    assert.equal(yellow.storageLocation, "黄色盒");
    assert.equal(yellow.suggestedSubstitute, null);
    const white = summary.lines.find((line: { colorCode: string }) => line.colorCode === "H2");
    assert.equal(white.suggestedSubstitute.colorCode, "A11");
    assert.equal(white.suggestedSubstitute.surplusQuantity, 3);
    assert.equal(white.suggestedSubstitute.storageLocation, "黄色盒");
    assert.ok(white.suggestedSubstitute.rgbDistance > 0);
    const black = summary.lines.find((line: { colorCode: string }) => line.colorCode === "E2");
    assert.equal(black.suggestedSubstitute.colorCode, "A11");
    assert.equal(black.suggestedSubstitute.surplusQuantity, 2);
    assert.equal(black.suggestedSubstitute.storageLocation, "黄色盒");
    assert.ok(black.suggestedSubstitute.rgbDistance > 0);

    const afterComparison = await app.inject({
      method: "GET",
      url: "/api/v1/inventory?paletteId=mard-48-v1",
      headers: auth,
    });
    assert.equal(afterComparison.statusCode, 200);
    assert.deepEqual(
      afterComparison.json().items.map((item: { colorCode: string; quantity: number }) => ({
        colorCode: item.colorCode,
        quantity: item.quantity,
      })),
      [
        { colorCode: "A11", quantity: 5 },
        { colorCode: "H2", quantity: 2 },
      ],
    );

    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/shortages`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    assert.equal(hidden.statusCode, 404);
    assert.equal(hidden.json().error.code, "PROJECT_NOT_FOUND");
  });
});
