import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OPERATIONAL_HISTORY_RETENTION_MILLISECONDS } from "../src/domain/resource-limits.js";
import { AppError } from "../src/errors.js";
import { MemoryStore } from "../src/repositories/memory-store.js";

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

describe("MemoryStore inventory audit preservation", () => {
  it("keeps operations, markers, ledger lines, and references after physical project purge", async (context) => {
    context.mock.timers.enable({
      apis: ["Date"],
      now: new Date("2026-10-05T02:00:00.000Z"),
    });
    try {
      const store = new MemoryStore();
      const session = await store.createDevSession({
        displayName: "内存库存审计用户",
        tokenHash: "a".repeat(64),
        expiresAt: "2028-10-05T02:00:00.000Z",
        startingCredits: 0,
      });
      const userId = session.user.id;
      await store.applyInventoryBatch({
        userId,
        mode: "calibrate",
        entries: [{
          paletteId: "mard-48-v1",
          colorCode: "H2",
          quantity: 2,
          location: "审计盒",
          baseRevision: 0,
        }],
        idempotencyReference: "memory:audit:seed",
        now: new Date().toISOString(),
      });
      const project = await store.createProject(userId, {
        name: "应被物理清除的私密项目",
        paletteId: "mard-48-v1",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["H2"] },
      });
      await store.saveBuildProgress({
        userId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 0,
        completedIndices: [0],
      });
      const consumedAt = new Date().toISOString();
      const consumed = await store.consumeProjectInventory({
        userId,
        projectId: project.id,
        projectRevision: 1,
        idempotencyReference: "memory:audit:consume-once",
        now: consumedAt,
      });
      assert.equal(await store.deleteProject(userId, project.id), true);

      context.mock.timers.tick(OPERATIONAL_HISTORY_RETENTION_MILLISECONDS + 1);
      await store.createProject(userId, {
        name: "触发历史回收",
        paletteId: "mard-48-v1",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: [null] },
      });

      const internalProjects = (store as unknown as {
        projects: Map<string, unknown>;
      }).projects;
      assert.equal(internalProjects.has(project.id), false, "the soft-deleted project must be physically purged");

      const operations = await store.listInventoryOperations({
        userId,
        projectId: project.id,
        idempotencyReference: "memory:audit:consume-once",
        limit: 100,
      });
      assert.equal(operations.length, 1);
      assert.deepEqual(operations[0], {
        id: consumed.operationId,
        userId,
        type: "project_consumption",
        projectId: project.id,
        projectRevision: 1,
        idempotencyReference: "memory:audit:consume-once",
        consumedAt,
        createdAt: consumedAt,
      });
      assert.equal((await store.listInventoryTransactions({
        userId,
        projectId: project.id,
        limit: 100,
      })).length, 1);
      await assert.rejects(
        store.applyInventoryBatch({
          userId,
          mode: "delta",
          entries: [{
            paletteId: "mard-48-v1",
            colorCode: "H2",
            delta: 1,
            baseRevision: 2,
          }],
          idempotencyReference: "memory:audit:consume-once",
          now: new Date().toISOString(),
        }),
        rejectsWithCode("INVENTORY_REFERENCE_CONFLICT"),
      );
    } finally {
      context.mock.timers.reset();
    }
  });
});
