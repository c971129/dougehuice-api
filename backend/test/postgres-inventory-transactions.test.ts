import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { AppError } from "../src/errors.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const ownerId = "00000000-0000-4000-8000-000000002301";
const otherId = "00000000-0000-4000-8000-000000002302";

function poolFor(database: PGlite): Pool {
  const query = (text: string, values?: unknown[]) =>
    values === undefined ? database.query(text) : database.query(text, values as never[]);
  let connectionTail = Promise.resolve();
  return {
    query,
    connect: async () => {
      const previous = connectionTail;
      let releaseConnection = (): void => undefined;
      const gate = new Promise<void>((resolve) => { releaseConnection = resolve; });
      connectionTail = previous.then(() => gate);
      await previous;
      return { query, release: releaseConnection } as unknown as PoolClient;
    },
    end: () => database.close(),
  } as unknown as Pool;
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

describe("Postgres inventory transaction and consumption parity", () => {
  it("rolls back whole batches, isolates ledger rows, and consumes a completed revision exactly once", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      const migrations = await loadMigrationFiles();
      for (const migration of migrations) {
        await database.exec(migration.sql);
        if (migration.version === "0028_custom_palettes.sql") break;
      }
      const projectLibraryMigration = migrations.find(
        (migration) => migration.version === "0035_project_library.sql",
      );
      const inventoryAuditMigration = migrations.find(
        (migration) => migration.version === "0036_inventory_audit_preservation.sql",
      );
      assert.ok(projectLibraryMigration);
      assert.ok(inventoryAuditMigration);
      await database.exec(projectLibraryMigration.sql);
      await database.exec(inventoryAuditMigration.sql);
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('${ownerId}', '库存流水拥有者'),
          ('${otherId}', '库存流水其他用户');
        INSERT INTO palettes(id, name, version, brand, bead_size_mm, verified)
        VALUES ('inventory-ledger-palette', '库存流水色卡', 1, '测试', 5, true);
        INSERT INTO palette_colors(
          palette_id, code, name, hex, unit_price_cents, sort_order, available
        ) VALUES
          ('inventory-ledger-palette', 'T01', '测试一', '#FFFFFF', 1, 0, true),
          ('inventory-ledger-palette', 'T02', '测试二', '#000000', 1, 1, true),
          ('inventory-ledger-palette', 'T03', '停用色', '#FF0000', 1, 2, false);
      `);

      const calibrated = await store.applyInventoryBatch({
        userId: ownerId,
        mode: "calibrate",
        entries: [
          { paletteId: "inventory-ledger-palette", colorCode: "T01", quantity: 5, location: "A", baseRevision: 0 },
          { paletteId: "inventory-ledger-palette", colorCode: "T02", quantity: 3, location: "B", baseRevision: 0 },
        ],
        idempotencyReference: "postgres:batch:calibrate",
        now: "2026-10-05T01:00:00.000Z",
      });
      assert.deepEqual(calibrated.items.map((item) => item.quantity), [5, 3]);
      assert.deepEqual(calibrated.transactions.map((entry) => entry.delta), [5, 3]);

      await assert.rejects(
        store.applyInventoryBatch({
          userId: ownerId,
          mode: "delta",
          entries: [
            { paletteId: "inventory-ledger-palette", colorCode: "T01", delta: -1, baseRevision: 1 },
            { paletteId: "inventory-ledger-palette", colorCode: "T02", delta: -99, baseRevision: 1 },
          ],
          idempotencyReference: "postgres:batch:rollback",
          now: "2026-10-05T01:01:00.000Z",
        }),
        rejectsWithCode("INVENTORY_QUANTITY_OUT_OF_RANGE"),
      );
      assert.deepEqual(
        (await store.listInventory(ownerId, "inventory-ledger-palette"))
          .map((item) => [item.colorCode, item.quantity, item.revision]),
        [["T01", 5, 1], ["T02", 3, 1]],
      );
      assert.equal(
        (await store.listInventoryTransactions({ userId: ownerId, limit: 100 })).length,
        2,
      );

      await assert.rejects(
        store.applyInventoryBatch({
          userId: ownerId,
          mode: "calibrate",
          entries: [{
            paletteId: "inventory-ledger-palette",
            colorCode: "T03",
            quantity: 1,
            location: null,
            baseRevision: 0,
          }],
          idempotencyReference: "postgres:batch:unavailable",
          now: "2026-10-05T01:02:00.000Z",
        }),
        rejectsWithCode("PALETTE_COLOR_UNAVAILABLE"),
      );
      assert.deepEqual(await store.listInventoryTransactions({ userId: otherId, limit: 100 }), []);

      await store.setInventoryItem({
        userId: otherId,
        paletteId: "inventory-ledger-palette",
        colorCode: "T01",
        quantity: 9,
        location: "其他仓库",
        baseRevision: 0,
        idempotencyReference: "postgres:single:other",
        now: "2026-10-05T01:03:00.000Z",
      });
      const otherLedger = await store.listInventoryTransactions({ userId: otherId, limit: 100 });
      assert.equal(otherLedger.length, 1);
      assert.equal(otherLedger[0]?.quantityAfter, 9);
      assert.equal((await store.listInventoryTransactions({ userId: ownerId, limit: 100 })).length, 2);

      const project = await store.createProject(ownerId, {
        name: "Postgres 库存消费",
        paletteId: "inventory-ledger-palette",
        grid: {
          encoding: "palette-code-v1",
          width: 3,
          height: 1,
          cells: ["T01", "T01", "T02"],
        },
      });
      await store.saveBuildProgress({
        userId: ownerId,
        projectId: project.id,
        projectRevision: 1,
        baseProgressRevision: 0,
        completedIndices: [0, 1, 2],
      });
      const consumed = await store.consumeProjectInventory({
        userId: ownerId,
        projectId: project.id,
        projectRevision: 1,
        idempotencyReference: "postgres:consume:one",
        now: "2026-10-05T01:04:00.000Z",
      });
      assert.deepEqual(
        consumed.transactions.map((entry) => [entry.colorCode, entry.quantityBefore, entry.delta, entry.quantityAfter]),
        [["T01", 5, -2, 3], ["T02", 3, -1, 2]],
      );
      await assert.rejects(
        store.consumeProjectInventory({
          userId: ownerId,
          projectId: project.id,
          projectRevision: 1,
          idempotencyReference: "postgres:consume:second",
          now: "2026-10-05T01:05:00.000Z",
        }),
        rejectsWithCode("PROJECT_INVENTORY_ALREADY_CONSUMED"),
      );
      await assert.rejects(
        store.consumeProjectInventory({
          userId: otherId,
          projectId: project.id,
          projectRevision: 1,
          idempotencyReference: "postgres:consume:cross-tenant",
          now: "2026-10-05T01:06:00.000Z",
        }),
        rejectsWithCode("PROJECT_NOT_FOUND"),
      );
      const projectLedger = await store.listInventoryTransactions({
        userId: ownerId,
        projectId: project.id,
        limit: 100,
      });
      assert.equal(projectLedger.length, 2);
      assert.equal(projectLedger.every((entry) => entry.type === "project_consumption"), true);

      await database.query("DELETE FROM projects WHERE id = $1", [project.id]);
      const retainedOperations = await store.listInventoryOperations({
        userId: ownerId,
        projectId: project.id,
        idempotencyReference: "postgres:consume:one",
        limit: 100,
      });
      assert.equal(retainedOperations.length, 1);
      assert.deepEqual({
        type: retainedOperations[0]?.type,
        projectId: retainedOperations[0]?.projectId,
        projectRevision: retainedOperations[0]?.projectRevision,
        idempotencyReference: retainedOperations[0]?.idempotencyReference,
        consumedAt: retainedOperations[0]?.consumedAt,
      }, {
        type: "project_consumption",
        projectId: project.id,
        projectRevision: 1,
        idempotencyReference: "postgres:consume:one",
        consumedAt: "2026-10-05T01:04:00.000Z",
      });
      assert.equal((await store.listInventoryTransactions({
        userId: ownerId,
        projectId: project.id,
        limit: 100,
      })).length, 2);
      const retainedMarker = await database.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM inventory_project_consumptions WHERE operation_id = $1",
        [consumed.operationId],
      );
      assert.equal(retainedMarker.rows[0]?.count, 1);
      await assert.rejects(
        store.applyInventoryBatch({
          userId: ownerId,
          mode: "delta",
          entries: [{
            paletteId: "inventory-ledger-palette",
            colorCode: "T01",
            delta: 1,
            baseRevision: 2,
          }],
          idempotencyReference: "postgres:consume:one",
          now: "2026-10-05T01:06:30.000Z",
        }),
        rejectsWithCode("INVENTORY_REFERENCE_CONFLICT"),
      );

      const concurrentProject = await store.createProject(ownerId, {
        name: "Postgres 并发库存消费",
        paletteId: "inventory-ledger-palette",
        grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["T01"] },
      });
      await store.saveBuildProgress({
        userId: ownerId,
        projectId: concurrentProject.id,
        projectRevision: 1,
        baseProgressRevision: 0,
        completedIndices: [0],
      });
      const quantityBeforeRace = (await store.listInventory(ownerId, "inventory-ledger-palette"))
        .find((item) => item.colorCode === "T01")?.quantity;
      const raced = await Promise.allSettled([
        store.consumeProjectInventory({
          userId: ownerId,
          projectId: concurrentProject.id,
          projectRevision: 1,
          idempotencyReference: "postgres:consume:race-a",
          now: "2026-10-05T01:07:00.000Z",
        }),
        store.consumeProjectInventory({
          userId: ownerId,
          projectId: concurrentProject.id,
          projectRevision: 1,
          idempotencyReference: "postgres:consume:race-b",
          now: "2026-10-05T01:07:00.000Z",
        }),
      ]);
      assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = raced.find((result) => result.status === "rejected");
      assert.ok(rejected && rejected.status === "rejected");
      assert.ok(rejected.reason instanceof AppError);
      assert.equal(rejected.reason.code, "PROJECT_INVENTORY_ALREADY_CONSUMED");
      const quantityAfterRace = (await store.listInventory(ownerId, "inventory-ledger-palette"))
        .find((item) => item.colorCode === "T01")?.quantity;
      assert.equal(quantityAfterRace, quantityBeforeRace! - 1);
      assert.equal((await store.listInventoryTransactions({
        userId: ownerId,
        projectId: concurrentProject.id,
        limit: 100,
      })).length, 1);

      await assert.rejects(
        database.query(
          `INSERT INTO inventory_operations(
             id, user_id, transaction_type, project_id, project_revision,
             idempotency_reference, created_at
           ) VALUES (
             '00000000-0000-4000-8000-000000002399', $1,
             'project_consumption', $2, 1, 'forged-cross-tenant', now()
           )`,
          [otherId, project.id],
        ),
      );
    } finally {
      await store.close();
    }
  });
});
