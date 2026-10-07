import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { AppError } from "../src/errors.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

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

describe("PostgreSQL authentication and palette hardening", () => {
  it("enforces tenant visibility, challenge grace, state constraints, and bounded auth limits", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const ownerId = "00000000-0000-4000-8000-000000003201";
    const otherId = "00000000-0000-4000-8000-000000003202";
    try {
      for (const migration of await loadMigrationFiles()) await database.exec(migration.sql);
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('${ownerId}', '私有色卡拥有者'),
          ('${otherId}', '私有色卡其他用户');
      `);
      const privatePalette = await store.createPalette(ownerId, {
        id: "postgres-private-palette",
        name: "私有色卡",
        brand: "测试",
        beadSizeMm: 5,
        verified: false,
        version: 1,
        colors: [
          { code: "P01", name: "私有粉", hex: "#FF88AA", unitPriceCents: 1, available: true },
          { code: "P02", name: "私有蓝", hex: "#88AAFF", unitPriceCents: 1, available: true },
        ],
      });
      assert.equal(privatePalette.ownerUserId, ownerId);
      assert.equal(privatePalette.series, privatePalette.name);
      assert.equal(privatePalette.material, "PE");
      assert.equal(privatePalette.retired, false);
      assert.deepEqual(privatePalette.source, {
        name: "user import",
        url: "",
        revision: "1",
        license: "user supplied",
      });
      assert.equal(privatePalette.colors.every((color) => color.finish === "solid"), true);
      const persistedPrivatePalette = await store.getPalette(privatePalette.id, ownerId);
      assert.equal(persistedPrivatePalette?.series, privatePalette.name);
      assert.equal(persistedPrivatePalette?.material, "PE");
      assert.equal(persistedPrivatePalette?.retired, false);
      assert.deepEqual(persistedPrivatePalette?.source, privatePalette.source);
      assert.equal(persistedPrivatePalette?.colors.every((color) => color.finish === "solid"), true);
      await assert.rejects(
        database.exec(`
          UPDATE palettes
          SET owner_user_id = '${otherId}'
          WHERE id = '${privatePalette.id}'
        `),
        /palettes_owner_immutable|palette ownership is immutable/i,
      );
      await assert.rejects(
        store.setInventoryItem({
          userId: otherId,
          paletteId: privatePalette.id,
          colorCode: "P01",
          quantity: 1,
          location: null,
          baseRevision: 0,
          now: "2026-10-05T00:00:00.000Z",
        }),
        (error: unknown) => error instanceof AppError && error.code === "PALETTE_COLOR_NOT_FOUND",
      );
      await assert.rejects(
        database.exec(`
          INSERT INTO inventory_items(user_id, palette_id, color_code, quantity, revision)
          VALUES ('${otherId}', '${privatePalette.id}', 'P01', 1, 1)
        `),
        /palette tenant visibility|not visible/i,
      );
      const ownerItem = await store.setInventoryItem({
        userId: ownerId,
        paletteId: privatePalette.id,
        colorCode: "P01",
        quantity: 1,
        location: null,
        baseRevision: 0,
        now: "2026-10-05T00:00:00.000Z",
      });
      assert.equal(ownerItem.userId, ownerId);

      const approvedTokenHash = "a".repeat(64);
      await store.createWebLoginChallenge({
        tokenHash: approvedTokenHash,
        sessionTokenHash: "d".repeat(64),
        code: "123456",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      assert.equal(await store.confirmWebLoginChallenge({
        code: "123456",
        userId: ownerId,
        sessionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        createPollTokenSession: false,
      }), true);
      await store.createWebLoginChallenge({
        tokenHash: "b".repeat(64),
        sessionTokenHash: "e".repeat(64),
        code: "654321",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      assert.equal((await store.getWebLoginChallenge(approvedTokenHash))?.status, "approved");

      await assert.rejects(
        database.exec(`
          INSERT INTO web_login_challenges(
            token_hash, session_token_hash, code, status, user_id, expires_at, approved_at
          ) VALUES (
            '${"c".repeat(64)}', '${"f".repeat(64)}', '111111', 'approved', NULL,
            clock_timestamp() + interval '5 minutes', NULL
          )
        `),
        /web_login_challenges_state_contract/i,
      );
      await assert.rejects(
        database.exec(`
          INSERT INTO palette_colors(
            palette_id, code, name, hex, unit_price_cents, sort_order, available
          ) VALUES (
            '${privatePalette.id}', '${"X".repeat(33)}', '过长色号', '#000000', 1, 2, true
          )
        `),
        /palette_colors_code_contract/i,
      );

      await database.exec(`
        INSERT INTO auth_rate_limits(key_hash, action, window_started_at, request_count, updated_at)
        SELECT lpad(to_hex(sequence), 64, '0'), 'stale-probe',
               clock_timestamp() - interval '2 days', 1,
               clock_timestamp() - interval '2 days'
        FROM generate_series(1, 1200) AS sequence
      `);
      const rateResults = await Promise.all(Array.from({ length: 21 }, () => store.consumeAuthRateLimit({
        keyHash: "e".repeat(64),
        action: "concurrency-probe",
        now: new Date().toISOString(),
        limit: 20,
        windowMilliseconds: 600_000,
      })));
      assert.equal(rateResults.filter((result) => result.allowed).length, 20);
      assert.equal(rateResults.filter((result) => !result.allowed).length, 1);
      const stale = await database.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM auth_rate_limits WHERE action = 'stale-probe'",
      );
      assert.equal(stale.rows[0]?.count, 0);
      const index = await database.query<{ exists: boolean }>(
        "SELECT to_regclass('auth_rate_limits_updated_at_idx') IS NOT NULL AS exists",
      );
      assert.equal(index.rows[0]?.exists, true);
    } finally {
      await store.close();
    }
  });

  it("keeps retired palette history readable but rejects a derived project revision", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const userId = "00000000-0000-4000-8000-000000003209";
    try {
      for (const migration of await loadMigrationFiles()) await database.exec(migration.sql);
      await database.exec(`INSERT INTO users(id, display_name) VALUES ('${userId}', '退役色卡 PG 用户')`);
      const palette = await store.createPalette(userId, {
        id: "postgres-retired-palette",
        name: "待退役私有色卡",
        brand: "测试",
        beadSizeMm: 5,
        verified: false,
        version: 1,
        colors: [
          { code: "R01", name: "退役红", hex: "#CC3344", unitPriceCents: 1, available: true },
          { code: "R02", name: "退役白", hex: "#FFFFFF", unitPriceCents: 1, available: true },
        ],
      });
      const grid = {
        encoding: "palette-code-v1" as const,
        width: 2,
        height: 2,
        cells: ["R01", null, "R02", null],
      };
      const project = await store.createProject(userId, {
        name: "退役前历史项目",
        paletteId: palette.id,
        grid,
      });
      await database.query("UPDATE palettes SET retired = true WHERE id = $1", [palette.id]);

      assert.equal((await store.getPalette(palette.id, userId))?.retired, true);
      assert.ok(await store.getProject(userId, project.id));
      assert.ok(await store.getProjectForExport({
        userId,
        projectId: project.id,
        projectRevision: project.currentRevision,
      }));
      await assert.rejects(
        store.updateProjectGrid({
          userId,
          projectId: project.id,
          baseRevision: project.currentRevision,
          grid,
        }),
        (error: unknown) => error instanceof AppError
          && error.statusCode === 409
          && error.code === "PALETTE_RETIRED",
      );
      assert.equal((await store.getProject(userId, project.id))?.currentRevision, 1);
    } finally {
      await store.close();
    }
  });

  it("enforces the per-user 50-palette and 5000-color quota boundaries", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    const paletteQuotaUserId = "00000000-0000-4000-8000-000000003211";
    const colorQuotaUserId = "00000000-0000-4000-8000-000000003212";
    const palette = (id: string, code: string) => ({
      id,
      name: id,
      brand: "测试",
      beadSizeMm: 5,
      verified: false,
      version: 1,
      colors: [
        { code, name: code, hex: "#778899", unitPriceCents: 1, available: true },
      ],
    });
    try {
      for (const migration of await loadMigrationFiles()) await database.exec(migration.sql);
      await database.exec(`
        INSERT INTO users(id, display_name) VALUES
          ('${paletteQuotaUserId}', '色卡数量配额用户'),
          ('${colorQuotaUserId}', '颜色数量配额用户');

        INSERT INTO palettes(id, name, brand, bead_size_mm, verified, version, owner_user_id)
        SELECT 'palette-quota-' || sequence, '配额色卡 ' || sequence,
               '测试', 5, false, 1, '${paletteQuotaUserId}'
        FROM generate_series(1, 49) AS sequence;
      `);

      await store.createPalette(
        paletteQuotaUserId,
        palette("palette-quota-50", "P50"),
      );
      await assert.rejects(
        store.createPalette(
          paletteQuotaUserId,
          palette("palette-quota-51", "P51"),
        ),
        (error: unknown) => error instanceof AppError
          && error.code === "CUSTOM_PALETTE_LIMIT_EXCEEDED",
      );
      const paletteCount = await database.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM palettes
         WHERE owner_user_id = '${paletteQuotaUserId}'`,
      );
      assert.equal(paletteCount.rows[0]?.count, 50);

      await database.exec(`
        INSERT INTO palettes(id, name, brand, bead_size_mm, verified, version, owner_user_id)
        VALUES ('color-quota-base', '颜色配额基础色卡', '测试', 5, false, 1,
                '${colorQuotaUserId}');

        INSERT INTO palette_colors(
          palette_id, code, name, hex, unit_price_cents, sort_order, available
        )
        SELECT 'color-quota-base', 'C' || lpad(sequence::text, 4, '0'),
               '配额色 ' || sequence, '#778899', 1, sequence - 1, true
        FROM generate_series(1, 4999) AS sequence;
      `);
      await store.createPalette(
        colorQuotaUserId,
        palette("color-quota-5000", "C5000"),
      );
      await assert.rejects(
        store.createPalette(
          colorQuotaUserId,
          palette("color-quota-5001", "C5001"),
        ),
        (error: unknown) => error instanceof AppError
          && error.code === "CUSTOM_PALETTE_COLOR_LIMIT_EXCEEDED",
      );
      const colorCount = await database.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM palette_colors AS color
         JOIN palettes AS palette ON palette.id = color.palette_id
         WHERE palette.owner_user_id = '${colorQuotaUserId}'`,
      );
      assert.equal(colorCount.rows[0]?.count, 5000);
    } finally {
      await store.close();
    }
  });
});
