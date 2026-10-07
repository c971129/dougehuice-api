import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { AppError } from "../src/errors.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

const migrationPaths = [
  "../migrations/0001_foundation.sql",
  "../migrations/0005_inventory.sql",
  "../migrations/0021_palette_contract.sql",
  "../migrations/0023_inventory_transactions.sql",
  "../migrations/0028_custom_palettes.sql",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

const ownerId = "00000000-0000-4000-8000-000000000201";
const otherUserId = "00000000-0000-4000-8000-000000000202";

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

async function applyMigrations(database: PGlite): Promise<void> {
  for (const migrationPath of migrationPaths) {
    await database.exec(await readFile(migrationPath, "utf8"));
  }
}

function rejectsWithCode(code: string, currentRevision?: number): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    if (currentRevision !== undefined) {
      assert.deepEqual(error.details, { currentRevision });
    }
    return true;
  };
}

describe("PostgresStore inventory SQL", () => {
  it("isolates users and enforces revision-checked inventory calibration", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('${ownerId}', '库存拥有者'),
          ('${otherUserId}', '其他用户');
        INSERT INTO palettes(id, name, version)
        VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order) VALUES
          ('test-palette', 'T01', '测试白', '#FFFFFF', 1, 0),
          ('test-palette', 'T02', '测试黑', '#000000', 1, 1);
      `);

      const created = await store.setInventoryItem({
        userId: ownerId,
        paletteId: "test-palette",
        colorCode: "T01",
        quantity: 7,
        location: "抽屉 1",
        baseRevision: 0,
        now: "2026-10-04T10:00:00.000Z",
      });
      assert.deepEqual(
        {
          userId: created.userId,
          paletteId: created.paletteId,
          colorCode: created.colorCode,
          quantity: created.quantity,
          location: created.location,
          revision: created.revision,
          updatedAt: created.updatedAt,
        },
        {
          userId: ownerId,
          paletteId: "test-palette",
          colorCode: "T01",
          quantity: 7,
          location: "抽屉 1",
          revision: 1,
          updatedAt: "2026-10-04T10:00:00.000Z",
        },
      );
      assert.deepEqual(await store.listInventory(ownerId, "test-palette"), [created]);
      assert.deepEqual(await store.listInventory(otherUserId, "test-palette"), []);

      const updated = await store.setInventoryItem({
        userId: ownerId,
        paletteId: "test-palette",
        colorCode: "T01",
        quantity: 3,
        location: null,
        baseRevision: 1,
        now: "2026-10-04T11:00:00.000Z",
      });
      assert.equal(updated.revision, 2);
      assert.equal(updated.quantity, 3);
      assert.equal(updated.location, null);

      await assert.rejects(
        store.setInventoryItem({
          userId: ownerId,
          paletteId: "test-palette",
          colorCode: "T01",
          quantity: 99,
          location: "不应保存",
          baseRevision: 1,
          now: "2026-10-04T12:00:00.000Z",
        }),
        rejectsWithCode("INVENTORY_REVISION_CONFLICT", 2),
      );
      const afterStaleWrite = await store.listInventory(ownerId, "test-palette");
      assert.equal(afterStaleWrite[0]?.quantity, 3);
      assert.equal(afterStaleWrite[0]?.revision, 2);

      await assert.rejects(
        store.setInventoryItem({
          userId: ownerId,
          paletteId: "test-palette",
          colorCode: "UNKNOWN",
          quantity: 1,
          location: null,
          baseRevision: 0,
          now: "2026-10-04T12:00:00.000Z",
        }),
        rejectsWithCode("PALETTE_COLOR_NOT_FOUND"),
      );

      const otherUserItem = await store.setInventoryItem({
        userId: otherUserId,
        paletteId: "test-palette",
        colorCode: "T01",
        quantity: 20,
        location: "另一个仓库",
        baseRevision: 0,
        now: "2026-10-04T13:00:00.000Z",
      });
      assert.equal(otherUserItem.revision, 1);
      assert.equal((await store.listInventory(otherUserId))[0]?.quantity, 20);
      assert.equal((await store.listInventory(ownerId))[0]?.quantity, 3);
      assert.deepEqual(await store.getInventoryStats(ownerId), { colorCount: 1, beadCount: 3 });
      assert.deepEqual(await store.getInventoryStats(otherUserId), { colorCount: 1, beadCount: 20 });

      await database.exec(`
        INSERT INTO palettes(id, name, version, owner_user_id)
        VALUES ('owner-private-palette', '私有色卡', 1, '${ownerId}');
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('owner-private-palette', 'P01', '私有色', '#123456', 1, 0);
      `);
      await assert.rejects(
        store.setInventoryItem({
          userId: otherUserId,
          paletteId: "owner-private-palette",
          colorCode: "P01",
          quantity: 1,
          location: null,
          baseRevision: 0,
          now: "2026-10-04T13:30:00.000Z",
        }),
        rejectsWithCode("PALETTE_COLOR_NOT_FOUND"),
      );
      await store.setInventoryItem({
        userId: ownerId,
        paletteId: "test-palette",
        colorCode: "T01",
        quantity: 2_147_483_647,
        location: null,
        baseRevision: 2,
        now: "2026-10-04T14:00:00.000Z",
      });
      await store.setInventoryItem({
        userId: ownerId,
        paletteId: "test-palette",
        colorCode: "T02",
        quantity: 2_147_483_647,
        location: null,
        baseRevision: 0,
        now: "2026-10-04T14:00:00.000Z",
      });
      assert.deepEqual(await store.getInventoryStats(ownerId), {
        colorCount: 2,
        beadCount: 4_294_967_294,
      });
      const privateItem = await store.setInventoryItem({
        userId: ownerId,
        paletteId: "owner-private-palette",
        colorCode: "P01",
        quantity: 1,
        location: null,
        baseRevision: 0,
        now: "2026-10-04T14:30:00.000Z",
      });
      assert.equal(privateItem.userId, ownerId);
    } finally {
      await store.close();
    }
  });
});
