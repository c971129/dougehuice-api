import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { MAX_ACTIVE_SESSIONS_PER_USER } from "../src/domain/resource-limits.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";

function tokenHash(character: string): string {
  return character.repeat(64);
}

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
  for (const migration of await loadMigrationFiles()) {
    await database.exec(migration.sql);
  }
}

describe("WeChat session lifecycle", () => {
  it("removes expired memory sessions and evicts the oldest active session", async () => {
    const store = new MemoryStore();
    const activeHashes = Array.from(
      { length: MAX_ACTIVE_SESSIONS_PER_USER + 1 },
      (_, index) => tokenHash(String(index + 1)),
    );
    let userId = "";
    for (const hash of activeHashes) {
      const session = await store.createWechatSession({
        openId: "openid-memory-session-lifecycle",
        displayName: "内存会话用户",
        tokenHash: hash,
        expiresAt: "2099-10-04T00:00:00.000Z",
      });
      userId = session.user.id;
    }

    assert.equal(await store.resolveSession(activeHashes[0]!), null);
    for (const hash of activeHashes.slice(1)) assert.ok(await store.resolveSession(hash));

    const expiredHash = tokenHash("a");
    await store.createWechatSession({
      openId: "openid-memory-session-lifecycle",
      displayName: "不会覆盖",
      tokenHash: expiredHash,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    await store.createWechatSession({
      openId: "openid-memory-session-lifecycle",
      displayName: "不会覆盖",
      tokenHash: tokenHash("b"),
      expiresAt: "2099-10-04T00:00:00.000Z",
    });

    const storedSessions = (store as unknown as {
      sessions: Map<string, { userId: string }>;
    }).sessions;
    assert.equal(storedSessions.has(expiredHash), false);
    assert.equal(
      [...storedSessions.values()].filter((session) => session.userId === userId).length,
      MAX_ACTIVE_SESSIONS_PER_USER,
    );
    const newest = tokenHash("b");
    assert.equal(await store.revokeSession(newest), true);
    assert.equal(await store.resolveSession(newest), null);
    assert.equal(await store.revokeSession(newest), false);
  });

  it("cleans and bounds sessions in the PostgreSQL transaction", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      const activeHashes = Array.from(
        { length: MAX_ACTIVE_SESSIONS_PER_USER + 1 },
        (_, index) => tokenHash(String(index + 1)),
      );
      let userId = "";
      for (const [index, hash] of activeHashes.slice(0, -1).entries()) {
        const session = await store.createWechatSession({
          openId: "openid-postgres-session-lifecycle",
          displayName: "数据库会话用户",
          tokenHash: hash,
          expiresAt: "2099-10-04T00:00:00.000Z",
        });
        userId = session.user.id;
        await database.query(
          "UPDATE sessions SET created_at = $2 WHERE token_hash = $1",
          [hash, `2026-01-0${index + 1}T00:00:00.000Z`],
        );
      }

      const expiredHash = tokenHash("a");
      await database.query(
        `INSERT INTO sessions(token_hash, user_id, expires_at, created_at)
         VALUES ($1, $2, '2000-01-01T00:00:00.000Z', '1999-01-01T00:00:00.000Z')`,
        [expiredHash, userId],
      );
      await store.createWechatSession({
        openId: "openid-postgres-session-lifecycle",
        displayName: "不会覆盖",
        tokenHash: activeHashes.at(-1)!,
        expiresAt: "2099-10-04T00:00:00.000Z",
      });

      const persisted = await database.query<{ token_hash: string }>(
        "SELECT token_hash FROM sessions WHERE user_id = $1 ORDER BY token_hash",
        [userId],
      );
      assert.deepEqual(
        persisted.rows.map((row) => row.token_hash),
        activeHashes.slice(1),
      );
      assert.equal(await store.resolveSession(activeHashes[0]!), null);
      assert.ok(await store.resolveSession(activeHashes.at(-1)!));
      assert.equal(await store.revokeSession(activeHashes.at(-1)!), true);
      assert.equal(await store.resolveSession(activeHashes.at(-1)!), null);
      assert.equal(await store.revokeSession(activeHashes.at(-1)!), false);
    } finally {
      await store.close();
    }
  });

  it("cleans expired sessions and keeps Web confirmations within the per-user cap", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      await applyMigrations(database);
      const session = await store.createDevSession({
        displayName: "Web 配对并发用户",
        tokenHash: tokenHash("d"),
        expiresAt: "2099-10-04T00:00:00.000Z",
        startingCredits: 0,
      });
      for (let index = 0; index < MAX_ACTIVE_SESSIONS_PER_USER - 1; index += 1) {
        await database.query(
          `INSERT INTO sessions(token_hash, user_id, expires_at, created_at)
           VALUES ($1, $2, '2099-10-04T00:00:00.000Z', $3)`,
          [tokenHash(String(index + 1)), session.user.id, `2026-01-0${index + 1}T00:00:00.000Z`],
        );
      }
      const expired = tokenHash("e");
      await database.query(
        `INSERT INTO sessions(token_hash, user_id, expires_at)
         VALUES ($1, $2, '2000-01-01T00:00:00.000Z')`,
        [expired, session.user.id],
      );
      const challenges = [
        { tokenHash: tokenHash("f"), sessionTokenHash: tokenHash("7"), code: "100001" },
        { tokenHash: tokenHash("9"), sessionTokenHash: tokenHash("8"), code: "100002" },
      ];
      for (const challenge of challenges) {
        await store.createWebLoginChallenge({ ...challenge, expiresAt: "2099-10-04T00:00:00.000Z" });
        assert.equal(await store.confirmWebLoginChallenge({
          code: challenge.code,
          userId: session.user.id,
          sessionExpiresAt: "2099-10-04T00:00:00.000Z",
          createPollTokenSession: false,
        }), true);
      }
      const active = await database.query<{ count: number | string }>(
        "SELECT count(*) AS count FROM sessions WHERE user_id = $1 AND expires_at > clock_timestamp()",
        [session.user.id],
      );
      assert.equal(Number(active.rows[0]?.count), MAX_ACTIVE_SESSIONS_PER_USER);
      assert.equal(await store.resolveSession(expired), null);
      assert.equal(await store.resolveSession(challenges[1]!.tokenHash), null);
      assert.ok(await store.resolveSession(challenges[1]!.sessionTokenHash));
    } finally {
      await store.close();
    }
  });
});
