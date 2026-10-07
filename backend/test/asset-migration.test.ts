import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const foundationPath = fileURLToPath(new URL("../migrations/0001_foundation.sql", import.meta.url));
const assetsPath = fileURLToPath(new URL("../migrations/0002_private_assets.sql", import.meta.url));
const readinessPath = fileURLToPath(new URL("../migrations/0011_asset_readiness.sql", import.meta.url));

describe("private assets migration", () => {
  it("creates constrained private metadata without exposing paths through public columns", async () => {
    const database = new PGlite();
    try {
      await database.exec(await readFile(foundationPath, "utf8"));
      await database.exec(await readFile(assetsPath, "utf8"));
      await database.exec(`
        INSERT INTO users(id, display_name)
        VALUES ('00000000-0000-4000-8000-000000000001', '素材迁移测试');
        INSERT INTO assets(
          id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
          width, height, storage_key, expires_at, created_at
        ) VALUES (
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000001',
          'ai-source', 'privacy-v1', repeat('a', 64), 'image/png', 128,
          10, 10, 'opaque-storage-key-0001', now() + interval '24 hours', now()
        )
      `);
      await database.exec(await readFile(readinessPath, "utf8"));
      const columns = await database.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'assets'
         ORDER BY ordinal_position`,
      );
      const names = columns.rows.map((row) => row.column_name);
      for (const required of [
        "user_id",
        "consent_version",
        "sha256",
        "mime_type",
        "size_bytes",
        "width",
        "height",
        "expires_at",
        "ready_at",
        "deleted_at",
      ]) assert.ok(names.includes(required), `missing assets.${required}`);

      const legacyReady = await database.query<{ ready: boolean }>(
        `SELECT ready_at IS NOT NULL AS ready FROM assets
         WHERE id = '00000000-0000-4000-8000-000000000002'`,
      );
      assert.equal(legacyReady.rows[0]?.ready, true);

      await database.exec(`
        INSERT INTO assets(
          id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
          width, height, storage_key, expires_at, created_at
        ) VALUES (
          '00000000-0000-4000-8000-000000000004',
          '00000000-0000-4000-8000-000000000001',
          'ai-source', 'privacy-v1', repeat('c', 64), 'image/png', 128,
          10, 10, 'opaque-storage-key-0003', now() + interval '24 hours', now()
        )
      `);
      const pending = await database.query<{ ready: boolean }>(
        `SELECT ready_at IS NULL AS ready FROM assets
         WHERE id = '00000000-0000-4000-8000-000000000004'`,
      );
      assert.equal(pending.rows[0]?.ready, true);

      await assert.rejects(
        database.exec(`
          INSERT INTO assets(
            id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
            width, height, storage_key, expires_at, created_at
          ) VALUES (
            '00000000-0000-4000-8000-000000000003',
            '00000000-0000-4000-8000-000000000001',
            'ai-source', 'privacy-v1', repeat('b', 64), 'image/gif', 128,
            10, 10, 'opaque-storage-key-0002', now() + interval '24 hours', now()
          )
        `),
        /assets.*check|violates check constraint/i,
      );
    } finally {
      await database.close();
    }
  });
});
