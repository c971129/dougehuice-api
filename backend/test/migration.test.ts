import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const migrationPath = fileURLToPath(new URL("../migrations/0001_foundation.sql", import.meta.url));

describe("PostgreSQL foundation migration", () => {
  it("creates the schema and enforces grid and immutable revision constraints", async () => {
    const database = new PGlite();
    try {
      await database.exec(await readFile(migrationPath, "utf8"));

      const tables = await database.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      const tableNames = tables.rows.map((row) => row.tablename);
      for (const expected of [
        "api_idempotency",
        "build_progress",
        "credit_accounts",
        "credit_ledger",
        "generation_candidates",
        "generation_jobs",
        "palette_colors",
        "palettes",
        "project_revisions",
        "projects",
        "sessions",
        "users",
      ]) {
        assert.ok(tableNames.includes(expected), `missing table ${expected}`);
      }

      await database.exec(`
        INSERT INTO users(id, display_name)
        VALUES ('00000000-0000-4000-8000-000000000001', '迁移测试用户');
        INSERT INTO palettes(id, name, version) VALUES ('test-palette', '测试色卡', 1);
        INSERT INTO palette_colors(palette_id, code, name, hex, unit_price_cents, sort_order)
        VALUES ('test-palette', 'T01', '测试白', '#FFFFFF', 1, 0);
        INSERT INTO projects(id, user_id, name, palette_id, current_revision)
        VALUES (
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000001',
          '迁移测试图纸',
          'test-palette',
          1
        );
        INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
        VALUES (
          '00000000-0000-4000-8000-000000000002',
          1,
          'palette-code-v1',
          2,
          2,
          '["T01", null, "T01", null]'::jsonb
        );
      `);

      await assert.rejects(
        database.exec(`
          INSERT INTO project_revisions(project_id, revision, encoding, width, height, cells)
          VALUES (
            '00000000-0000-4000-8000-000000000002',
            2,
            'palette-code-v1',
            2,
            2,
            '["T01"]'::jsonb
          )
        `),
        /project_revisions.*check|violates check constraint/i,
      );

      await assert.rejects(
        database.exec(`
          UPDATE project_revisions
          SET cells = '[null, null, null, null]'::jsonb
          WHERE project_id = '00000000-0000-4000-8000-000000000002' AND revision = 1
        `),
        /project revisions are immutable/i,
      );
    } finally {
      await database.close();
    }
  });
});
