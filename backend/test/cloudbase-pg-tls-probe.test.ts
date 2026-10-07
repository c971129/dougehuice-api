import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createHandler, getPoolOptions } = require("../../cloudbase/functions/pindou-pg-tls-probe/index.js") as {
  createHandler: (options?: Record<string, unknown>) => (event?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getPoolOptions: (env: Record<string, string>) => Record<string, unknown>;
};

const validEnvironment: Record<string, string> = {
  DATABASE_URL: "postgresql://probe_user:secret-value@pg.example.internal:5432/pindou",
  DATABASE_SSL: "true",
  DATABASE_POOL_MAX: "2",
  DATABASE_EXPECTED_ROLE: "probe_user",
};

const safeRoleRow = {
  ssl: true,
  read_only: "on",
  actual_role: "probe_user",
  is_superuser: false,
  can_create_role: false,
  can_create_database: false,
  can_replicate: false,
  can_bypass_rls: false,
  can_create_public: false,
};

function fakePool(input: {
  row?: Partial<typeof safeRoleRow>;
  queryError?: Error;
} = {}) {
  const queries: string[] = [];
  const calls: string[] = [];
  class FakePool {
    constructor(options: Record<string, unknown>) {
      calls.push(JSON.stringify({ max: options.max, ssl: options.ssl }));
    }
    async connect() {
      return {
        query: async (sql: string) => {
          queries.push(sql);
          if (sql === "BEGIN READ ONLY" || sql === "ROLLBACK") return { rows: [] };
          if (input.queryError) throw input.queryError;
          return { rows: [{ ...safeRoleRow, ...input.row }] };
        },
        release: () => calls.push("release"),
      };
    }
    async end() {
      calls.push("end");
    }
  }
  return { Pool: FakePool, queries, calls };
}

test("PG TLS probe requires a remote PostgreSQL URL, TLS verification, pool max 2, and expected role", () => {
  const options = getPoolOptions(validEnvironment);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(options.max, 2);
  assert.equal(options.application_name, "pindou-cloudbase-readonly-tls-probe");

  for (const environment of [
    { ...validEnvironment, DATABASE_SSL: "false" },
    { ...validEnvironment, DATABASE_POOL_MAX: "10" },
    { ...validEnvironment, DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/db" },
    { ...validEnvironment, DATABASE_URL: "postgres://user:pass@db.example:5432/db?sslmode=disable" },
  ]) {
    assert.throws(() => getPoolOptions(environment), { code: "DATABASE_CONFIG_INVALID" });
  }
});

test("probe verifies TLS, read-only transaction, exact role, and least privilege before rollback", async () => {
  const fake = fakePool();
  const events: Array<Record<string, unknown>> = [];
  const run = createHandler({
    Pool: fake.Pool,
    env: validEnvironment,
    log: (entry: string) => events.push(JSON.parse(entry) as Record<string, unknown>),
  });
  const result = await run();

  assert.deepEqual(result, { ok: true, tls: true, readOnly: true, roleVerified: true, poolMax: 2 });
  assert.deepEqual(fake.queries.slice(0, 1), ["BEGIN READ ONLY"]);
  assert.match(fake.queries[1] ?? "", /^SELECT\b/);
  for (const column of [
    "current_user",
    "pg_roles",
    "rolsuper",
    "rolcreaterole",
    "rolcreatedb",
    "rolreplication",
    "rolbypassrls",
    "has_schema_privilege",
    "'public'",
    "'CREATE'",
  ]) {
    assert.ok(fake.queries[1]?.includes(column), `role inspection query must include ${column}`);
  }
  assert.equal(fake.queries.at(-1), "ROLLBACK");
  assert.equal(fake.queries.length, 3);
  assert.match(fake.queries[1] ?? "", /^SELECT\b/);
  assert.deepEqual(events, []);
  assert.deepEqual(fake.calls, [JSON.stringify({ max: 2, ssl: { rejectUnauthorized: true } }), "release", "end"]);
  assert.equal(JSON.stringify(result).includes("probe_user"), false);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("missing expected-role configuration fails before opening a pool", async () => {
  const missingRole = { ...validEnvironment };
  delete missingRole.DATABASE_EXPECTED_ROLE;
  for (const env of [missingRole, { ...validEnvironment, DATABASE_EXPECTED_ROLE: "" }, {
    ...validEnvironment,
    DATABASE_EXPECTED_ROLE: " probe_user",
  }]) {
    const fake = fakePool();
    const events: string[] = [];
    const result = await createHandler({
      Pool: fake.Pool,
      env,
      log: (entry: string) => events.push(entry),
    })();

    assert.deepEqual(result, { ok: false, code: "DATABASE_ROLE_CONFIG_INVALID" });
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(fake.queries, []);
    assert.deepEqual(events, [JSON.stringify({
      event: "cloudbase_pg_tls_probe",
      ok: false,
      code: "DATABASE_ROLE_CONFIG_INVALID",
    })]);
    assert.equal(events.join(" ").includes("probe_user"), false);
    assert.equal(events.join(" ").includes("secret-value"), false);
  }
});

test("a current_user mismatch fails closed without returning or logging either role name", async () => {
  const fake = fakePool({ row: { actual_role: "unexpected_role" } });
  const events: string[] = [];
  const result = await createHandler({
    Pool: fake.Pool,
    env: validEnvironment,
    log: (entry: string) => events.push(entry),
  })();

  assert.deepEqual(result, { ok: false, code: "DATABASE_ROLE_MISMATCH" });
  assert.equal(fake.queries.at(-1), "ROLLBACK");
  assert.equal(JSON.stringify(result).includes("probe_user"), false);
  assert.equal(JSON.stringify(result).includes("unexpected_role"), false);
  assert.equal(events.join(" ").includes("probe_user"), false);
  assert.equal(events.join(" ").includes("unexpected_role"), false);
  assert.equal(events.join(" ").includes("secret-value"), false);
});

test("any elevated role attribute or public CREATE privilege fails closed", async () => {
  const privilegeCases: Array<[keyof typeof safeRoleRow, boolean | null]> = [
    ["is_superuser", true],
    ["can_create_role", true],
    ["can_create_database", true],
    ["can_replicate", true],
    ["can_bypass_rls", true],
    ["can_create_public", true],
    ["can_create_role", null],
  ];

  for (const [field, value] of privilegeCases) {
    const fake = fakePool({ row: { [field]: value } as Partial<typeof safeRoleRow> });
    const events: string[] = [];
    const result = await createHandler({
      Pool: fake.Pool,
      env: validEnvironment,
      log: (entry: string) => events.push(entry),
    })();
    assert.deepEqual(result, { ok: false, code: "DATABASE_ROLE_PRIVILEGED" }, `${field}=${value}`);
    assert.equal(fake.queries.at(-1), "ROLLBACK", `${field}=${value}`);
    assert.equal(events.join(" ").includes("probe_user"), false);
    assert.equal(events.join(" ").includes("secret-value"), false);
  }
});

test("TLS and read-only checks remain mandatory and failures are sanitized", async () => {
  for (const [row, expectedCode] of [
    [{ ssl: false }, "TLS_NOT_ACTIVE"],
    [{ read_only: "off" }, "READ_ONLY_NOT_ACTIVE"],
  ] as const) {
    const fake = fakePool({ row });
    const result = await createHandler({ Pool: fake.Pool, env: validEnvironment, log: () => undefined })();
    assert.deepEqual(result, { ok: false, code: expectedCode });
    assert.equal(fake.queries.at(-1), "ROLLBACK");
  }

  const fake = fakePool({ queryError: new Error("private connection detail for probe_user secret-value") });
  const events: string[] = [];
  const result = await createHandler({
    Pool: fake.Pool,
    env: validEnvironment,
    log: (entry: string) => events.push(entry),
  })();
  assert.deepEqual(result, { ok: false, code: "DATABASE_CONNECT_FAILED" });
  assert.equal(fake.queries.at(-1), "ROLLBACK");
  assert.equal(JSON.stringify(result).includes("probe_user"), false);
  assert.equal(events.join(" ").includes("probe_user"), false);
  assert.equal(events.join(" ").includes("secret-value"), false);
  assert.equal(events.join(" ").includes("private connection detail"), false);
});

test("runtime-only mode confirms driver load without opening a database connection", async () => {
  const events: string[] = [];
  const FakePool = class {};
  const run = createHandler({ Pool: FakePool, env: {}, log: (entry: string) => events.push(entry) });

  assert.deepEqual(await run({ probeRuntime: true }), { ok: true, runtimeOnly: true, driverLoaded: true });
  assert.deepEqual(events, []);
});
