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
  assetStorageRoot: join(tmpdir(), "pindou-inventory-transactions-api-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

describe("inventory batch, ledger, and explicit consumption API", () => {
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
    assert.equal(response.statusCode, 201, response.body);
    return response.json().token as string;
  }

  it("atomically calibrates or adjusts a bounded batch and paginates a tenant ledger", async () => {
    const token = await login("批量库存用户");
    const otherToken = await login("其他库存用户");
    const auth = { authorization: `Bearer ${token}` };
    const calibration = {
      mode: "calibrate",
      items: [
        { paletteId: "mard-48-v1", colorCode: "H2", quantity: 5, location: "  A  ", baseRevision: 0 },
        { paletteId: "mard-48-v1", colorCode: "A11", quantity: 2, location: "B", baseRevision: 0 },
      ],
    };
    const calibrationHeaders = { ...auth, "idempotency-key": "inventory-batch-calibrate" };
    const [created, replayed] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/inventory/batch", headers: calibrationHeaders, payload: calibration }),
      app.inject({ method: "POST", url: "/api/v1/inventory/batch", headers: calibrationHeaders, payload: calibration }),
    ]);
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.equal(
      [created, replayed].filter((response) => response.headers["idempotency-replayed"] === "true").length,
      1,
    );
    assert.deepEqual(
      created.json().items.map((item: { colorCode: string; quantity: number; location: string; revision: number }) => ({
        colorCode: item.colorCode,
        quantity: item.quantity,
        location: item.location,
        revision: item.revision,
      })),
      [
        { colorCode: "H2", quantity: 5, location: "A", revision: 1 },
        { colorCode: "A11", quantity: 2, location: "B", revision: 1 },
      ],
    );
    assert.deepEqual(
      created.json().transactions.map((entry: { quantityBefore: number; delta: number; quantityAfter: number }) => ({
        before: entry.quantityBefore,
        delta: entry.delta,
        after: entry.quantityAfter,
      })),
      [
        { before: 0, delta: 5, after: 5 },
        { before: 0, delta: 2, after: 2 },
      ],
    );

    const conflictingReplay = await app.inject({
      method: "POST",
      url: "/api/v1/inventory/batch",
      headers: calibrationHeaders,
      payload: {
        ...calibration,
        items: [{ ...calibration.items[0], quantity: 6 }, calibration.items[1]],
      },
    });
    assert.equal(conflictingReplay.statusCode, 409, conflictingReplay.body);
    assert.equal(conflictingReplay.json().error.code, "IDEMPOTENCY_CONFLICT");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/inventory/batch",
      headers: { ...auth, "idempotency-key": "inventory-batch-duplicate" },
      payload: {
        mode: "calibrate",
        items: [calibration.items[0], calibration.items[0]],
      },
    });
    assert.equal(duplicate.statusCode, 400, duplicate.body);
    assert.equal(duplicate.json().error.code, "INVENTORY_BATCH_DUPLICATE_COLOR");

    const blankLocation = await app.inject({
      method: "POST",
      url: "/api/v1/inventory/batch",
      headers: { ...auth, "idempotency-key": "inventory-batch-blank-location" },
      payload: {
        mode: "calibrate",
        items: [{
          paletteId: "mard-48-v1",
          colorCode: "E2",
          quantity: 1,
          location: "   ",
          baseRevision: 0,
        }],
      },
    });
    assert.equal(blankLocation.statusCode, 400, blankLocation.body);
    assert.equal(blankLocation.json().error.code, "INVENTORY_LOCATION_REQUIRED");

    const oversizedLocation = await app.inject({
      method: "POST",
      url: "/api/v1/inventory/batch",
      headers: { ...auth, "idempotency-key": "inventory-batch-long-location" },
      payload: {
        mode: "calibrate",
        items: [{
          paletteId: "mard-48-v1",
          colorCode: "E2",
          quantity: 1,
          location: "L".repeat(101),
          baseRevision: 0,
        }],
      },
    });
    assert.equal(oversizedLocation.statusCode, 400, oversizedLocation.body);
    assert.equal(oversizedLocation.json().error.code, "VALIDATION_ERROR");

    const failedDelta = await app.inject({
      method: "POST",
      url: "/api/v1/inventory/batch",
      headers: { ...auth, "idempotency-key": "inventory-batch-rollback" },
      payload: {
        mode: "delta",
        items: [
          { paletteId: "mard-48-v1", colorCode: "H2", delta: -1, baseRevision: 1 },
          { paletteId: "mard-48-v1", colorCode: "A11", delta: -99, baseRevision: 1 },
        ],
      },
    });
    assert.equal(failedDelta.statusCode, 409, failedDelta.body);
    assert.equal(failedDelta.json().error.code, "INVENTORY_QUANTITY_OUT_OF_RANGE");
    const afterFailure = await app.inject({ method: "GET", url: "/api/v1/inventory", headers: auth });
    assert.deepEqual(
      afterFailure.json().items.map((item: { quantity: number; revision: number }) => [item.quantity, item.revision]),
      [[2, 1], [5, 1]],
    );

    const adjusted = await app.inject({
      method: "POST",
      url: "/api/v1/inventory/batch",
      headers: { ...auth, "idempotency-key": "inventory-batch-adjust" },
      payload: {
        mode: "delta",
        items: [
          { paletteId: "mard-48-v1", colorCode: "H2", delta: -2, baseRevision: 1 },
          { paletteId: "mard-48-v1", colorCode: "A11", delta: 3, location: null, baseRevision: 1 },
        ],
      },
    });
    assert.equal(adjusted.statusCode, 200, adjusted.body);
    assert.deepEqual(
      adjusted.json().items.map((item: { quantity: number; location: string | null; revision: number }) => ({
        quantity: item.quantity,
        location: item.location,
        revision: item.revision,
      })),
      [
        { quantity: 3, location: "A", revision: 2 },
        { quantity: 5, location: null, revision: 2 },
      ],
    );

    const single = await app.inject({
      method: "PUT",
      url: "/api/v1/inventory/mard-48-v1/E2",
      headers: { ...auth, "idempotency-key": "inventory-single-ledger" },
      payload: { quantity: 4, location: "L".repeat(100), baseRevision: 0 },
    });
    assert.equal(single.statusCode, 201, single.body);
    assert.equal(single.json().item.location.length, 100);

    const firstPage = await app.inject({
      method: "GET",
      url: "/api/v1/inventory/transactions?limit=2&offset=0",
      headers: auth,
    });
    assert.equal(firstPage.statusCode, 200, firstPage.body);
    assert.equal(firstPage.json().transactions.length, 2);
    assert.deepEqual(firstPage.json().pagination, {
      limit: 2,
      offset: 0,
      hasMore: true,
      nextOffset: 2,
    });
    const allLedger = await app.inject({
      method: "GET",
      url: "/api/v1/inventory/transactions?limit=20",
      headers: auth,
    });
    assert.equal(allLedger.json().transactions.length, 5);
    assert.equal(
      allLedger.json().transactions.some((entry: { idempotencyReference: string }) =>
        entry.idempotencyReference === "inventory:mard-48-v1:E2:inventory-single-ledger"),
      true,
    );
    const hiddenLedger = await app.inject({
      method: "GET",
      url: "/api/v1/inventory/transactions",
      headers: { authorization: `Bearer ${otherToken}` },
    });
    assert.deepEqual(hiddenLedger.json().transactions, []);
  });

  it("deducts completed current project materials once and never partially deducts a shortage", async () => {
    const token = await login("项目库存用户");
    const otherToken = await login("项目库存越权用户");
    const auth = { authorization: `Bearer ${token}` };
    const seeded = await app.inject({
      method: "POST",
      url: "/api/v1/inventory/batch",
      headers: { ...auth, "idempotency-key": "inventory-consumption-seed" },
      payload: {
        mode: "calibrate",
        items: [
          { paletteId: "mard-48-v1", colorCode: "H2", quantity: 3, location: "A", baseRevision: 0 },
          { paletteId: "mard-48-v1", colorCode: "A11", quantity: 2, location: "B", baseRevision: 0 },
        ],
      },
    });
    assert.equal(seeded.statusCode, 200, seeded.body);

    let projectOrdinal = 0;
    async function createProject(name: string): Promise<string> {
      projectOrdinal += 1;
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { ...auth, "idempotency-key": `inventory-consumption-project-${projectOrdinal}` },
        payload: {
          name,
          paletteId: "mard-48-v1",
          grid: {
            encoding: "palette-code-v1",
            width: 3,
            height: 1,
            cells: ["H2", "H2", "A11"],
          },
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      return created.json().project.id as string;
    }

    async function completeProject(projectId: string, key: string): Promise<void> {
      const completed = await app.inject({
        method: "PUT",
        url: `/api/v1/projects/${projectId}/build-progress`,
        headers: { ...auth, "idempotency-key": key },
        payload: {
          projectRevision: 1,
          baseProgressRevision: 0,
          completedIndices: [0, 1, 2],
        },
      });
      assert.equal(completed.statusCode, 200, completed.body);
      assert.ok(completed.json().progress.completedAt);
    }

    const projectId = await createProject("库存消费一");
    const tooEarly = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/inventory-consumption`,
      headers: { ...auth, "idempotency-key": "inventory-consume-too-early" },
      payload: { projectRevision: 1 },
    });
    assert.equal(tooEarly.statusCode, 409, tooEarly.body);
    assert.equal(tooEarly.json().error.code, "PROJECT_BUILD_NOT_COMPLETED");
    await completeProject(projectId, "inventory-progress-complete-one");

    const staleRevision = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/inventory-consumption`,
      headers: { ...auth, "idempotency-key": "inventory-consume-stale-revision" },
      payload: { projectRevision: 2 },
    });
    assert.equal(staleRevision.statusCode, 409, staleRevision.body);
    assert.equal(staleRevision.json().error.code, "INVENTORY_CONSUMPTION_REVISION_MISMATCH");

    const consumeHeaders = { ...auth, "idempotency-key": "inventory-consume-once" };
    const [consumed, consumedReplay] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/inventory-consumption`,
        headers: consumeHeaders,
        payload: { projectRevision: 1 },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/inventory-consumption`,
        headers: consumeHeaders,
        payload: { projectRevision: 1 },
      }),
    ]);
    assert.equal(consumed.statusCode, 200, consumed.body);
    assert.equal(consumedReplay.statusCode, 200, consumedReplay.body);
    assert.equal(
      [consumed, consumedReplay].filter((response) => response.headers["idempotency-replayed"] === "true").length,
      1,
    );
    assert.deepEqual(
      consumed.json().consumption.transactions.map((entry: { colorCode: string; delta: number }) => ({
        colorCode: entry.colorCode,
        delta: entry.delta,
      })),
      [
        { colorCode: "A11", delta: -1 },
        { colorCode: "H2", delta: -2 },
      ],
    );
    const afterConsumption = await app.inject({ method: "GET", url: "/api/v1/inventory", headers: auth });
    assert.deepEqual(
      afterConsumption.json().items.map((item: { colorCode: string; quantity: number }) => [item.colorCode, item.quantity]),
      [["A11", 1], ["H2", 1]],
    );

    const consumedAgain = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/inventory-consumption`,
      headers: { ...auth, "idempotency-key": "inventory-consume-second-key" },
      payload: { projectRevision: 1 },
    });
    assert.equal(consumedAgain.statusCode, 409, consumedAgain.body);
    assert.equal(consumedAgain.json().error.code, "PROJECT_INVENTORY_ALREADY_CONSUMED");

    const hidden = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/inventory-consumption`,
      headers: { authorization: `Bearer ${otherToken}`, "idempotency-key": "inventory-consume-other-user" },
      payload: { projectRevision: 1 },
    });
    assert.equal(hidden.statusCode, 404, hidden.body);
    assert.equal(hidden.json().error.code, "PROJECT_NOT_FOUND");

    const secondProjectId = await createProject("库存消费二");
    await completeProject(secondProjectId, "inventory-progress-complete-two");
    const insufficient = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${secondProjectId}/inventory-consumption`,
      headers: { ...auth, "idempotency-key": "inventory-consume-insufficient" },
      payload: { projectRevision: 1 },
    });
    assert.equal(insufficient.statusCode, 409, insufficient.body);
    assert.equal(insufficient.json().error.code, "INVENTORY_INSUFFICIENT");
    const afterShortage = await app.inject({ method: "GET", url: "/api/v1/inventory", headers: auth });
    assert.deepEqual(
      afterShortage.json().items.map((item: { colorCode: string; quantity: number; revision: number }) => [
        item.colorCode,
        item.quantity,
        item.revision,
      ]),
      [["A11", 1, 2], ["H2", 1, 2]],
    );

    const projectLedger = await app.inject({
      method: "GET",
      url: `/api/v1/inventory/transactions?projectId=${projectId}`,
      headers: auth,
    });
    assert.equal(projectLedger.statusCode, 200, projectLedger.body);
    assert.equal(projectLedger.json().transactions.length, 2);
    assert.equal(
      projectLedger.json().transactions.every((entry: { type: string }) => entry.type === "project_consumption"),
      true,
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...auth, "idempotency-key": "inventory-audit-delete-project" },
    });
    assert.equal(deleted.statusCode, 204, deleted.body);
    const idempotencyReference = `projects:${projectId}:inventory-consumption:inventory-consume-once`;
    const retainedOperations = await app.inject({
      method: "GET",
      url: `/api/v1/inventory/operations?projectId=${projectId}&idempotencyReference=${encodeURIComponent(idempotencyReference)}`,
      headers: auth,
    });
    assert.equal(retainedOperations.statusCode, 200, retainedOperations.body);
    assert.equal(retainedOperations.json().operations.length, 1);
    const retainedOperation = retainedOperations.json().operations[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(retainedOperation).sort(), [
      "consumedAt",
      "createdAt",
      "id",
      "idempotencyReference",
      "projectId",
      "projectRevision",
      "type",
      "userId",
    ]);
    assert.deepEqual({
      type: retainedOperation.type,
      projectId: retainedOperation.projectId,
      projectRevision: retainedOperation.projectRevision,
      idempotencyReference: retainedOperation.idempotencyReference,
      hasConsumedAt: typeof retainedOperation.consumedAt === "string",
    }, {
      type: "project_consumption",
      projectId,
      projectRevision: 1,
      idempotencyReference,
      hasConsumedAt: true,
    });
    const retainedLedger = await app.inject({
      method: "GET",
      url: `/api/v1/inventory/transactions?projectId=${projectId}`,
      headers: auth,
    });
    assert.equal(retainedLedger.statusCode, 200, retainedLedger.body);
    assert.equal(retainedLedger.json().transactions.length, 2);
    const hiddenOperations = await app.inject({
      method: "GET",
      url: `/api/v1/inventory/operations?projectId=${projectId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    assert.equal(hiddenOperations.statusCode, 200, hiddenOperations.body);
    assert.deepEqual(hiddenOperations.json().operations, []);

    const emptyProject = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth, "idempotency-key": "inventory-empty-project-create" },
      payload: {
        name: "空图纸不能消费库存",
        paletteId: "mard-48-v1",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: [null] },
      },
    });
    assert.equal(emptyProject.statusCode, 201, emptyProject.body);
    const emptyProjectId = emptyProject.json().project.id as string;
    const emptyProgress = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${emptyProjectId}/build-progress`,
      headers: { ...auth, "idempotency-key": "inventory-empty-project-progress" },
      payload: { projectRevision: 1, baseProgressRevision: 0, completedIndices: [] },
    });
    assert.equal(emptyProgress.statusCode, 200, emptyProgress.body);
    assert.equal(emptyProgress.json().progress.completedAt, null);
    const emptyConsumption = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${emptyProjectId}/inventory-consumption`,
      headers: { ...auth, "idempotency-key": "inventory-empty-project-consume" },
      payload: { projectRevision: 1 },
    });
    assert.equal(emptyConsumption.statusCode, 409, emptyConsumption.body);
    assert.equal(emptyConsumption.json().error.code, "PROJECT_BUILD_NOT_COMPLETED");
  });
});
