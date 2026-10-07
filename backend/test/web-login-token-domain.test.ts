import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

import { buildApp } from "../src/app.js";
import { hashToken } from "../src/auth.js";
import { isLocalDevelopmentAuthAllowed, type AppConfig } from "../src/config.js";
import { MAX_ACTIVE_SESSIONS_PER_USER } from "../src/domain/resource-limits.js";
import { AppError } from "../src/errors.js";
import { loadMigrationFiles } from "../src/migrate.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { PostgresStore } from "../src/repositories/postgres-store.js";
import { VolatileMemoryStorage } from "../src/storage/volatile-memory-storage.js";

function tokenHash(character: string): string {
  return character.repeat(64);
}

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

const httpConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused",
  databaseSsl: false,
  devAuthEnabled: false,
  corsOrigins: ["http://localhost:5173"],
  sessionTtlDays: 30,
  devStartingCredits: 0,
  assetStorageRoot: join(tmpdir(), "pindou-web-login-token-domain"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

describe("Web login credential domains", () => {
  it("keeps the polling token out of ordinary HTTP sessions while the returned session token authenticates", async () => {
    const store = new MemoryStore();
    const confirmerToken = "web-login-confirming-session-secret";
    await store.createDevSession({
      displayName: "配对确认用户",
      tokenHash: hashToken(confirmerToken),
      expiresAt: "2099-10-05T00:00:00.000Z",
      startingCredits: 0,
    });
    const app = await buildApp({
      config: httpConfig,
      store,
      storage: new VolatileMemoryStorage(),
      logger: false,
    });
    try {
      await app.ready();
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/auth/web-login-challenges",
        payload: {},
      });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.headers["cache-control"], "private, no-store");
      const challenge = created.json() as {
        token: string;
        sessionToken: string;
        code: string;
        expiresAt: string;
      };
      assert.notEqual(challenge.token, challenge.sessionToken);
      assert.equal(challenge.token.length >= 40, true);
      assert.equal(challenge.sessionToken.length >= 40, true);

      const prematureSession = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${challenge.sessionToken}` },
      });
      assert.equal(prematureSession.statusCode, 401, prematureSession.body);

      const sessionTokenAsPollToken = await app.inject({
        method: "GET",
        url: "/api/v1/auth/web-login-challenges/current",
        headers: { "x-web-login-token": challenge.sessionToken },
      });
      assert.equal(sessionTokenAsPollToken.statusCode, 404, sessionTokenAsPollToken.body);

      const confirmed = await app.inject({
        method: "POST",
        url: "/api/v1/auth/web-login-challenges/confirm",
        headers: { authorization: `Bearer ${confirmerToken}` },
        payload: { code: challenge.code },
      });
      assert.equal(confirmed.statusCode, 200, confirmed.body);

      const polling = await app.inject({
        method: "GET",
        url: "/api/v1/auth/web-login-challenges/current",
        headers: { "x-web-login-token": challenge.token },
      });
      assert.equal(polling.statusCode, 200, polling.body);
      assert.equal(polling.headers["cache-control"], "private, no-store");
      assert.equal(polling.json().status, "approved");
      assert.equal(Object.hasOwn(polling.json(), "sessionToken"), false);

      const realSession = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${challenge.sessionToken}` },
      });
      assert.equal(realSession.statusCode, 200, realSession.body);
      assert.equal(realSession.json().user.displayName, "配对确认用户");

      const pollTokenAsBearer = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${challenge.token}` },
      });
      assert.equal(pollTokenAsBearer.statusCode, 401, pollTokenAsBearer.body);

      const repeated = await app.inject({
        method: "POST",
        url: "/api/v1/auth/web-login-challenges/confirm",
        headers: { authorization: `Bearer ${confirmerToken}` },
        payload: { code: challenge.code },
      });
      assert.equal(repeated.statusCode, 404, repeated.body);
      assert.ok(await store.resolveSession(hashToken(challenge.sessionToken)));
      assert.equal(await store.resolveSession(hashToken(challenge.token)), null);
    } finally {
      await app.close();
    }
  });

  it("requires the complete local development gate before enabling poll-token compatibility", () => {
    assert.equal(isLocalDevelopmentAuthAllowed({
      nodeEnv: "development",
      host: "127.0.0.1",
      devAuthEnabled: true,
    }), true);
    for (const config of [
      { nodeEnv: "production", host: "127.0.0.1", devAuthEnabled: true },
      { nodeEnv: "test", host: "0.0.0.0", devAuthEnabled: true },
      { nodeEnv: "test", host: "127.0.0.1", devAuthEnabled: false },
    ] as const) {
      assert.equal(isLocalDevelopmentAuthAllowed(config), false);
    }
  });

  it("atomically confirms once and enforces unique session-token hashes in memory", async () => {
    const store = new MemoryStore();
    const owner = await store.createDevSession({
      displayName: "Memory 配对用户",
      tokenHash: tokenHash("1"),
      expiresAt: "2099-10-05T00:00:00.000Z",
      startingCredits: 0,
    });
    await store.createWebLoginChallenge({
      tokenHash: tokenHash("2"),
      sessionTokenHash: tokenHash("3"),
      code: "200001",
      expiresAt: "2099-10-05T00:00:00.000Z",
    });
    assert.equal(await store.confirmWebLoginChallenge({
      code: "200001",
      userId: "00000000-0000-4000-8000-000000000000",
      sessionExpiresAt: "2099-10-05T00:00:00.000Z",
      createPollTokenSession: false,
    }), false);

    const results = await Promise.all([
      store.confirmWebLoginChallenge({
        code: "200001",
        userId: owner.user.id,
        sessionExpiresAt: "2099-10-05T00:00:00.000Z",
        createPollTokenSession: false,
      }),
      store.confirmWebLoginChallenge({
        code: "200001",
        userId: owner.user.id,
        sessionExpiresAt: "2099-10-05T00:00:00.000Z",
        createPollTokenSession: false,
      }),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.ok(await store.resolveSession(tokenHash("3")));
    assert.equal(await store.resolveSession(tokenHash("2")), null);

    await assert.rejects(
      store.createWebLoginChallenge({
        tokenHash: tokenHash("4"),
        sessionTokenHash: tokenHash("3"),
        code: "200002",
        expiresAt: "2099-10-05T00:00:00.000Z",
      }),
      (error: unknown) => error instanceof AppError && error.code === "WEB_LOGIN_CODE_COLLISION",
    );

    await store.createWebLoginChallenge({
      tokenHash: tokenHash("5"),
      sessionTokenHash: tokenHash("6"),
      code: "200003",
      expiresAt: "2099-10-05T00:00:00.000Z",
    });
    assert.equal(await store.confirmWebLoginChallenge({
      code: "200003",
      userId: owner.user.id,
      sessionExpiresAt: "2099-10-05T00:00:00.000Z",
      createPollTokenSession: true,
    }), true);
    assert.ok(await store.resolveSession(tokenHash("5")));
    assert.ok(await store.resolveSession(tokenHash("6")));

    let newestSessionTokenHash = "";
    for (let index = 0; index < MAX_ACTIVE_SESSIONS_PER_USER + 2; index += 1) {
      const pollTokenHash = hashToken(`memory-cap-poll-${index}`);
      newestSessionTokenHash = hashToken(`memory-cap-session-${index}`);
      const code = String(210_000 + index);
      await store.createWebLoginChallenge({
        tokenHash: pollTokenHash,
        sessionTokenHash: newestSessionTokenHash,
        code,
        expiresAt: "2099-10-05T00:00:00.000Z",
      });
      assert.equal(await store.confirmWebLoginChallenge({
        code,
        userId: owner.user.id,
        sessionExpiresAt: "2099-10-05T00:00:00.000Z",
        createPollTokenSession: false,
      }), true);
    }
    const storedSessions = (store as unknown as {
      sessions: Map<string, { userId: string }>;
    }).sessions;
    assert.equal(
      [...storedSessions.values()].filter((session) => session.userId === owner.user.id).length,
      MAX_ACTIVE_SESSIONS_PER_USER,
    );
    assert.ok(await store.resolveSession(newestSessionTokenHash));
  });

  it("atomically confirms once and enforces unique session-token hashes in PostgreSQL", async () => {
    const database = new PGlite();
    const store = new PostgresStore(poolFor(database));
    try {
      for (const migration of await loadMigrationFiles()) await database.exec(migration.sql);
      const owner = await store.createDevSession({
        displayName: "PostgreSQL 配对用户",
        tokenHash: tokenHash("1"),
        expiresAt: "2099-10-05T00:00:00.000Z",
        startingCredits: 0,
      });
      await store.createWebLoginChallenge({
        tokenHash: tokenHash("2"),
        sessionTokenHash: tokenHash("3"),
        code: "300001",
        expiresAt: "2099-10-05T00:00:00.000Z",
      });

      const results = await Promise.all([
        store.confirmWebLoginChallenge({
          code: "300001",
          userId: owner.user.id,
          sessionExpiresAt: "2099-10-05T00:00:00.000Z",
          createPollTokenSession: false,
        }),
        store.confirmWebLoginChallenge({
          code: "300001",
          userId: owner.user.id,
          sessionExpiresAt: "2099-10-05T00:00:00.000Z",
          createPollTokenSession: false,
        }),
      ]);
      assert.deepEqual(results.sort(), [false, true]);
      assert.ok(await store.resolveSession(tokenHash("3")));
      assert.equal(await store.resolveSession(tokenHash("2")), null);

      await assert.rejects(
        store.createWebLoginChallenge({
          tokenHash: tokenHash("4"),
          sessionTokenHash: tokenHash("3"),
          code: "300002",
          expiresAt: "2099-10-05T00:00:00.000Z",
        }),
        (error: unknown) => error instanceof AppError && error.code === "WEB_LOGIN_CODE_COLLISION",
      );

      const stored = await database.query<{ token_hash: string }>(
        "SELECT token_hash FROM sessions WHERE user_id = $1 ORDER BY token_hash",
        [owner.user.id],
      );
      assert.deepEqual(stored.rows.map((row) => row.token_hash), [tokenHash("1"), tokenHash("3")]);
    } finally {
      await store.close();
    }
  });

  it("migrations 0047-0048 invalidate challenges and every indistinguishable legacy poll-token session", async () => {
    const database = new PGlite();
    try {
      const migrations = await loadMigrationFiles();
      for (const migration of migrations.filter((item) => item.version < "0047_web_login_session_token_domain.sql")) {
        await database.exec(migration.sql);
      }
      await database.exec(`
        INSERT INTO users(id, display_name)
        VALUES ('00000000-0000-4000-8000-000000000047', 'Legacy Web user');

        INSERT INTO web_login_challenges(token_hash, code, expires_at)
        VALUES ('${tokenHash("a")}', '470001', clock_timestamp() + interval '5 minutes');

        INSERT INTO sessions(token_hash, user_id, expires_at)
        VALUES
          ('${tokenHash("a")}', '00000000-0000-4000-8000-000000000047', clock_timestamp() + interval '30 days'),
          ('${tokenHash("f")}', '00000000-0000-4000-8000-000000000047', clock_timestamp() + interval '30 days')
      `);
      const migration0047 = migrations.find((item) => item.version === "0047_web_login_session_token_domain.sql");
      assert.ok(migration0047);
      await database.exec(migration0047.sql);
      const migration0048 = migrations.find((item) => item.version === "0048_revoke_legacy_web_poll_sessions.sql");
      assert.ok(migration0048);
      await database.exec(migration0048.sql);

      const state = await database.query<{ challenge_count: number; nullable: string; session_count: number }>(`
        SELECT
          (SELECT count(*)::integer FROM web_login_challenges) AS challenge_count,
          (SELECT count(*)::integer FROM sessions) AS session_count,
          (SELECT is_nullable FROM information_schema.columns
           WHERE table_name = 'web_login_challenges' AND column_name = 'session_token_hash') AS nullable
      `);
      assert.equal(state.rows[0]?.challenge_count, 0);
      assert.equal(state.rows[0]?.session_count, 0);
      assert.equal(state.rows[0]?.nullable, "NO");

      await database.exec(`
        INSERT INTO web_login_challenges(token_hash, session_token_hash, code, expires_at)
        VALUES ('${tokenHash("b")}', '${tokenHash("c")}', '470002', clock_timestamp() + interval '5 minutes')
      `);
      await assert.rejects(
        database.exec(`
          INSERT INTO web_login_challenges(token_hash, session_token_hash, code, expires_at)
          VALUES ('${tokenHash("d")}', '${tokenHash("c")}', '470003', clock_timestamp() + interval '5 minutes')
        `),
        /web_login_challenges_session_token_hash_key|duplicate key/i,
      );
      await assert.rejects(
        database.exec(`
          INSERT INTO web_login_challenges(token_hash, session_token_hash, code, expires_at)
          VALUES ('${tokenHash("e")}', '${tokenHash("e")}', '470004', clock_timestamp() + interval '5 minutes')
        `),
        /web_login_challenges_session_token_hash_contract/i,
      );
    } finally {
      await database.close();
    }
  });
});
