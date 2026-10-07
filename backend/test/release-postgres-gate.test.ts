import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// @ts-ignore The release wrapper is intentionally kept as an executable JavaScript module.
import { assertRegressionPreflightState, runBoundedNodeCommand, validateRegressionReleaseEnvironment } from "../scripts/postgres-release-safety.mjs";
import {
  assertRealPostgresTestDatabaseIsIsolated,
  loadRealPostgresTestConfig,
} from "./support/real-postgres-config.js";

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(backendDirectory, "scripts/postgres-release-check.mjs");
const paymentScriptPath = resolve(backendDirectory, "scripts/payment-lock-order-release-check.mjs");
const nestedWatchdogScriptPath = resolve(
  backendDirectory,
  "test/support/release-watchdog-nested-child.mjs",
);
const realPostgresTestFiles = [
  "postgres-asset-project-lock-order.integration.test.ts",
  "postgres-export-lease-recovery.integration.test.ts",
  "postgres-generation-lease-recovery.integration.test.ts",
  "postgres-pool-timeouts.integration.test.ts",
] as const;
const safetyVariables = [
  "PINDOU_TEST_POSTGRES_URL",
  "PINDOU_TEST_POSTGRES_CONFIRM_DATABASE",
  "PINDOU_TEST_POSTGRES_ALLOW_MUTATION",
  "PINDOU_TEST_POSTGRES_DATABASE_SSL",
  "PINDOU_REQUIRE_REAL_POSTGRES_RELEASE",
  "PINDOU_REQUIRE_REAL_POSTGRES_LOCK_ORDER",
] as const;

function processIsAlive(pid: number) {
  if (process.platform !== "win32") {
    const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      windowsHide: true,
    });
    return status.status === 0 && status.stdout.trim() !== "" && !/^Z/.test(status.stdout.trim());
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMilliseconds = 2_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !processIsAlive(pid);
}

function forceCleanupProcess(pid: number) {
  if (!processIsAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 2_000,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort cleanup for a regression failure.
  }
}

function runGate(
  overrides: Record<string, string | undefined>,
  executablePath = scriptPath,
) {
  const environment = { ...process.env };
  // A child `node --test` must not inherit the parent's recursive-run marker;
  // otherwise Node intentionally skips the file instead of exercising its
  // top-level gate.
  delete environment.NODE_TEST_CONTEXT;
  for (const name of safetyVariables) delete environment[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return spawnSync(process.execPath, [executablePath], {
    cwd: backendDirectory,
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function runRealPostgresTest(
  fileName: (typeof realPostgresTestFiles)[number],
  overrides: Record<string, string | undefined>,
) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  for (const name of safetyVariables) delete environment[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", `test/${fileName}`],
    {
      cwd: backendDirectory,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("real PostgreSQL release gate", () => {
  it("requires an exact opt-in before reading any real-PostgreSQL target configuration", () => {
    const disabled = loadRealPostgresTestConfig({
      PINDOU_TEST_POSTGRES_URL: "postgresql://user:secret@production.example:5432/production?host=elsewhere",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "production",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
      PINDOU_TEST_POSTGRES_DATABASE_SSL: "yes",
      PGSSLMODE: "require",
    });
    assert.equal(disabled.enabled, false);
    if (!disabled.enabled) assert.match(disabled.skipReason, /fail-closed PostgreSQL release wrapper/i);
    assert.equal(loadRealPostgresTestConfig({
      PINDOU_REQUIRE_REAL_POSTGRES_RELEASE: "TRUE",
      PINDOU_TEST_POSTGRES_URL: "not a URL",
    }).enabled, false);
    assert.equal(loadRealPostgresTestConfig({
      PINDOU_REQUIRE_REAL_POSTGRES_LOCK_ORDER: "true",
      PINDOU_TEST_POSTGRES_URL: "not a URL",
    }).enabled, false, "the dedicated lock-order flag must not enable the other three tests");

    assert.deepEqual(loadRealPostgresTestConfig({
      PINDOU_REQUIRE_REAL_POSTGRES_RELEASE: "true",
      PINDOU_TEST_POSTGRES_URL: "  postgresql://user@example.test:5432/pindou_test_release  ",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
      PINDOU_TEST_POSTGRES_DATABASE_SSL: "true",
    }), {
      enabled: true,
      databaseUrl: "postgresql://user@example.test:5432/pindou_test_release",
      databaseName: "pindou_test_release",
      databaseSsl: true,
      poolSsl: { rejectUnauthorized: true },
    });
    assert.equal(loadRealPostgresTestConfig({
      PINDOU_REQUIRE_REAL_POSTGRES_LOCK_ORDER: "true",
      PINDOU_TEST_POSTGRES_URL: "postgresql://user@example.test:5432/pindou_test_release",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
      PINDOU_TEST_POSTGRES_DATABASE_SSL: "true",
    }, [
      "PINDOU_REQUIRE_REAL_POSTGRES_RELEASE",
      "PINDOU_REQUIRE_REAL_POSTGRES_LOCK_ORDER",
    ]).enabled, true, "the payment test may use its dedicated exact opt-in");
    assert.throws(
      () => loadRealPostgresTestConfig({
        PINDOU_REQUIRE_REAL_POSTGRES_RELEASE: "true",
        PINDOU_TEST_POSTGRES_URL: "postgresql://user@example.test:5432/pindou_test_release",
        PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
        PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
        PINDOU_TEST_POSTGRES_DATABASE_SSL: "yes",
      }),
      /PINDOU_TEST_POSTGRES_DATABASE_SSL must be exactly true or false/i,
    );
    assert.throws(
      () => loadRealPostgresTestConfig({
        PINDOU_REQUIRE_REAL_POSTGRES_RELEASE: "true",
        PINDOU_TEST_POSTGRES_URL: "postgresql://user@example.test:5432/pindou_test_release",
        PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
      }),
      /CONFIRM_DATABASE.*exactly equal/i,
    );
    assert.throws(
      () => loadRealPostgresTestConfig({
        PINDOU_REQUIRE_REAL_POSTGRES_RELEASE: "true",
        PINDOU_TEST_POSTGRES_URL: "postgresql://user@example.test:5432/pindou_test_release",
        PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
      }),
      /ALLOW_MUTATION.*exactly true/i,
    );
  });

  it("keeps all four direct test entries disconnected when only a URL is present", () => {
    for (const fileName of realPostgresTestFiles) {
      const result = runRealPostgresTest(fileName, {
        PINDOU_TEST_POSTGRES_URL: "postgresql://user:do-not-print@127.0.0.1:1/production?host=production",
        PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "production",
        PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
        PINDOU_TEST_POSTGRES_DATABASE_SSL: "yes",
      });
      assert.equal(result.status, 0, `${fileName}: ${result.stderr}`);
      assert.match(result.stdout, /SKIP|skipped/i, fileName);
      assert.match(result.stdout, /fail-closed PostgreSQL release wrapper/i, fileName);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ECONNREFUSED|do-not-print/i, fileName);
    }
  });

  it("fails all four direct test entries before connecting when opt-in confirmation is incomplete", () => {
    for (const fileName of realPostgresTestFiles) {
      const isLockOrder = fileName === "postgres-asset-project-lock-order.integration.test.ts";
      const result = runRealPostgresTest(fileName, {
        PINDOU_TEST_POSTGRES_URL: "postgresql://user:do-not-print@127.0.0.1:1/pindou_test_release",
        PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
        PINDOU_REQUIRE_REAL_POSTGRES_RELEASE: isLockOrder ? "false" : "true",
        PINDOU_REQUIRE_REAL_POSTGRES_LOCK_ORDER: isLockOrder ? "true" : "false",
      });
      assert.equal(result.status, 1, `${fileName}: ${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /CONFIRM_DATABASE.*exactly equal/i, fileName);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ECONNREFUSED|do-not-print/i, fileName);
    }
  });

  it("puts a fresh isolation preflight before every direct test business pool", () => {
    for (const fileName of realPostgresTestFiles) {
      const source = readFileSync(resolve(backendDirectory, "test", fileName), "utf8");
      assert.match(source, /skip:\s*realPostgres\.enabled\s*\?\s*false\s*:\s*realPostgres\.skipReason/, fileName);
      const preflightIndex = source.indexOf("await assertRealPostgresTestDatabaseIsIsolated(realPostgres)");
      const poolIndex = fileName === "postgres-pool-timeouts.integration.test.ts"
        ? source.indexOf("const pool = createPool(")
        : source.indexOf("const pool = new Pool(");
      assert.ok(preflightIndex >= 0, `${fileName} is missing its async isolation preflight`);
      assert.ok(poolIndex > preflightIndex, `${fileName} creates its business pool before preflight`);
    }

    const lockOrderSource = readFileSync(
      resolve(backendDirectory, "test", "postgres-asset-project-lock-order.integration.test.ts"),
      "utf8",
    );
    assert.match(lockOrderSource, /PINDOU_REQUIRE_REAL_POSTGRES_RELEASE/);
    assert.match(lockOrderSource, /PINDOU_REQUIRE_REAL_POSTGRES_LOCK_ORDER/);

    const rawPoolFiles = [
      "postgres-asset-project-lock-order.integration.test.ts",
      "postgres-export-lease-recovery.integration.test.ts",
      "postgres-generation-lease-recovery.integration.test.ts",
    ];
    for (const fileName of rawPoolFiles) {
      const source = readFileSync(resolve(backendDirectory, "test", fileName), "utf8");
      assert.match(source, /loadRealPostgresTestConfig\(/);
      assert.match(source, /ssl:\s*realPostgres\.poolSsl/);
      assert.doesNotMatch(source, /databaseSsl:\s*false/);
    }

    const timeoutPoolSource = readFileSync(
      resolve(backendDirectory, "test", "postgres-pool-timeouts.integration.test.ts"),
      "utf8",
    );
    assert.match(timeoutPoolSource, /loadRealPostgresTestConfig\(\)/);
    assert.match(timeoutPoolSource, /databaseSsl:\s*realPostgres\.databaseSsl/);
    assert.doesNotMatch(timeoutPoolSource, /databaseSsl:\s*false/);

    const supportSource = readFileSync(
      resolve(backendDirectory, "test", "support", "real-postgres-config.ts"),
      "utf8",
    );
    assert.match(supportSource, /options\.assertIsolated\s*\?\?\s*assertRegressionDatabaseIsIsolated/);
    assert.match(supportSource, /await assertIsolated\(configuration\)/);
    assert.match(supportSource, /isRegressionDatabaseBusyError\(error\)/);
    assert.match(supportSource, /redactReleaseMessage/);
    assert.match(supportSource, /releaseDatabaseSecrets/);

    for (const scriptName of [
      "postgres-release-check.mjs",
      "payment-lock-order-release-check.mjs",
    ]) {
      const wrapperSource = readFileSync(resolve(backendDirectory, "scripts", scriptName), "utf8");
      assert.match(
        wrapperSource,
        /await assertRegressionDatabaseIsIsolated\(configuration\)/,
        `${scriptName} must retain its immediate first preflight`,
      );
      assert.match(wrapperSource, /runBoundedNodeCommand/);
      assert.match(wrapperSource, /timeoutMilliseconds/);
      assert.doesNotMatch(wrapperSource, /assertRealPostgresTestDatabaseIsIsolated/);
    }
    const fullWrapperSource = readFileSync(
      resolve(backendDirectory, "scripts", "full-postgres-release-check.mjs"),
      "utf8",
    );
    assert.match(
      fullWrapperSource,
      /await assertRegressionDatabaseIsIsolated\(regressionConfiguration\)/,
      "the full wrapper must retain its immediate first preflight",
    );
    assert.match(fullWrapperSource, /runBoundedNodeCommand/);
    assert.match(fullWrapperSource, /timeoutMilliseconds/);
    assert.doesNotMatch(fullWrapperSource, /assertRealPostgresTestDatabaseIsIsolated/);
  });

  it("retries a transient child-process handoff connection and then succeeds", async () => {
    const configuration = loadRealPostgresTestConfig({
      PINDOU_REQUIRE_REAL_POSTGRES_RELEASE: "true",
      PINDOU_TEST_POSTGRES_URL: "postgresql://user@example.test:5432/pindou_test_release",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
      PINDOU_TEST_POSTGRES_DATABASE_SSL: "true",
    });
    assert.equal(configuration.enabled, true);
    if (!configuration.enabled) return;

    let attempts = 0;
    await assertRealPostgresTestDatabaseIsIsolated(configuration, {
      retryWindowMilliseconds: 100,
      retryDelayMilliseconds: 1,
      assertIsolated: async () => {
        attempts += 1;
        if (attempts === 1) {
          assertRegressionPreflightState({
            database_name: configuration.databaseName,
            other_connection_count: 1,
          }, configuration.databaseName);
        }
      },
    });
    assert.equal(attempts, 2);
  });

  it("fails closed after a bounded wait while another connection persists", async () => {
    const configuration = loadRealPostgresTestConfig({
      PINDOU_REQUIRE_REAL_POSTGRES_RELEASE: "true",
      PINDOU_TEST_POSTGRES_URL: "postgresql://user@example.test:5432/pindou_test_release",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
      PINDOU_TEST_POSTGRES_DATABASE_SSL: "true",
    });
    assert.equal(configuration.enabled, true);
    if (!configuration.enabled) return;

    let attempts = 0;
    await assert.rejects(
      assertRealPostgresTestDatabaseIsIsolated(configuration, {
        retryWindowMilliseconds: 10,
        retryDelayMilliseconds: 1,
        assertIsolated: async () => {
          attempts += 1;
          assertRegressionPreflightState({
            database_name: configuration.databaseName,
            other_connection_count: 1,
          }, configuration.databaseName);
        },
      }),
      /other active connections.*non-isolated/i,
    );
    assert.ok(attempts > 1, "persistent isolation failures should be retried within the bound");
  });

  it("does not retry or swallow an actual database identity mismatch", async () => {
    const configuration = loadRealPostgresTestConfig({
      PINDOU_REQUIRE_REAL_POSTGRES_RELEASE: "true",
      PINDOU_TEST_POSTGRES_URL: "postgresql://user@example.test:5432/pindou_test_release",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
      PINDOU_TEST_POSTGRES_DATABASE_SSL: "true",
    });
    assert.equal(configuration.enabled, true);
    if (!configuration.enabled) return;

    let attempts = 0;
    await assert.rejects(
      assertRealPostgresTestDatabaseIsIsolated(configuration, {
        retryWindowMilliseconds: 100,
        retryDelayMilliseconds: 1,
        assertIsolated: async () => {
          attempts += 1;
          assertRegressionPreflightState({
            database_name: "production",
            other_connection_count: 0,
          }, configuration.databaseName);
        },
      }),
      /does not match.*confirmed database name/i,
    );
    assert.equal(attempts, 1);
  });

  it("fails closed instead of inheriting DATABASE_URL or skipping when its URL is absent or blank", () => {
    for (const value of [undefined, "   "]) {
      const result = runGate({
        DATABASE_URL: "postgresql://user:fallback-secret@example.test/production",
        PINDOU_TEST_POSTGRES_URL: value,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /required.*refusing.*skip/i);
      assert.doesNotMatch(result.stderr, /fallback-secret/);
    }
  });

  it("rejects malformed, non-PostgreSQL, ambiguous, and production-like targets before connecting", () => {
    const malformed = runGate({ PINDOU_TEST_POSTGRES_URL: "not a url" });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /valid PostgreSQL URL/i);

    const wrongProtocol = runGate({
      PINDOU_TEST_POSTGRES_URL: "https://database.example.test/pindou_test_release",
    });
    assert.equal(wrongProtocol.status, 1);
    assert.match(wrongProtocol.stderr, /postgres:.*postgresql:/i);

    const queryOverride = runGate({
      PINDOU_TEST_POSTGRES_URL: "postgresql://user:do-not-print@example.test:5432/pindou_test_release?host=production",
    });
    assert.equal(queryOverride.status, 1);
    assert.match(queryOverride.stderr, /must not contain query parameters/i);
    assert.doesNotMatch(queryOverride.stderr, /do-not-print/);

    const productionName = runGate({
      PINDOU_TEST_POSTGRES_URL: "postgresql://user:do-not-print@example.test:5432/pindou",
    });
    assert.equal(productionName.status, 1);
    assert.match(productionName.stderr, /standalone e2e or test marker/i);
    assert.doesNotMatch(productionName.stderr, /do-not-print/);

    for (const [target, expected] of [
      ["postgresql:///pindou_test_release", /explicit database host/i],
      ["postgresql://example.test:5432/pindou_test_release", /explicit database user/i],
      ["postgresql://user@example.test/pindou_test_release", /explicit database port/i],
      ["postgresql://user@example.test:5432", /exactly one database/i],
      ["postgresql://user@example.test:5432/first/second", /exactly one database/i],
      ["postgresql://user@example.test:5432/first%2Fsecond", /invalid database name/i],
    ] as const) {
      const incomplete = runGate({
        PINDOU_TEST_POSTGRES_URL: target,
        PGPORT: "6543",
      });
      assert.equal(incomplete.status, 1);
      assert.match(incomplete.stderr, expected);
      assert.doesNotMatch(incomplete.stdout, /running real PostgreSQL release check/i);
    }
  });

  it("requires an exact database-name confirmation and an explicit mutation acknowledgement", () => {
    const target = "postgresql://user:do-not-print@127.0.0.1:1/pindou_test_release";
    const missingNameConfirmation = runGate({
      PINDOU_TEST_POSTGRES_URL: target,
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
    });
    assert.equal(missingNameConfirmation.status, 1);
    assert.match(missingNameConfirmation.stderr, /CONFIRM_DATABASE.*exactly equal/i);

    const mismatchedNameConfirmation = runGate({
      PINDOU_TEST_POSTGRES_URL: target,
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_other",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
    });
    assert.equal(mismatchedNameConfirmation.status, 1);
    assert.match(mismatchedNameConfirmation.stderr, /CONFIRM_DATABASE.*exactly equal/i);

    const missingMutationAcknowledgement = runGate({
      PINDOU_TEST_POSTGRES_URL: target,
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
    });
    assert.equal(missingMutationAcknowledgement.status, 1);
    assert.match(missingMutationAcknowledgement.stderr, /ALLOW_MUTATION.*exactly true/i);
  });

  it("strictly validates TLS configuration before opening a database connection", () => {
    const result = runGate({
      PINDOU_TEST_POSTGRES_URL: "postgresql://user:do-not-print@127.0.0.1:1/pindou_test_release",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
      PINDOU_TEST_POSTGRES_DATABASE_SSL: "yes",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_SSL must be exactly true or false/i);
    assert.doesNotMatch(result.stderr, /do-not-print/);

    for (const databaseSsl of [undefined, "false"] as const) {
      const remote = runGate({
        PINDOU_TEST_POSTGRES_URL: "postgresql://user:remote-secret@example.test:5432/pindou_test_release",
        PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
        PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
        PINDOU_TEST_POSTGRES_DATABASE_SSL: databaseSsl,
        PGSSLMODE: "require",
      });
      assert.equal(remote.status, 1);
      assert.match(remote.stderr, /DATABASE_SSL must be exactly true.*non-loopback/i);
      assert.doesNotMatch(remote.stderr, /remote-secret/);
      assert.doesNotMatch(remote.stdout, /running real PostgreSQL release check/i);
    }
  });

  it("accepts a passwordless URL only when host, user, port, and database are explicit", () => {
    assert.deepEqual(validateRegressionReleaseEnvironment({
      PINDOU_TEST_POSTGRES_URL: "postgresql://user@example.test:5432/pindou_test_release",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
      PINDOU_TEST_POSTGRES_DATABASE_SSL: "true",
      PGPORT: "6543",
    }), {
      databaseUrl: "postgresql://user@example.test:5432/pindou_test_release",
      databaseName: "pindou_test_release",
      databaseSsl: true,
    });
  });

  it("bounds a nested watchdog and removes its SIGTERM-ignoring descendant without echoing secrets", async () => {
    const secret = "bounded-child-secret-do-not-print";
    const temporaryRoot = mkdtempSync(join(tmpdir(), "pindou-release-watchdog-"));
    const descendantPidFile = join(temporaryRoot, "descendant.pid");
    let descendantPid: number | undefined;
    try {
      const startedAt = Date.now();
      const outcome = await runBoundedNodeCommand({
        label: "bounded nested release child",
        arguments_: [nestedWatchdogScriptPath, descendantPidFile],
        cwd: backendDirectory,
        environment: { ...process.env, PINDOU_TIMEOUT_TEST_SECRET: secret },
        timeoutMilliseconds: 1_500,
        terminationGraceMilliseconds: 100,
        forceKillSettleMilliseconds: 250,
        stdio: "pipe",
      });
      const elapsedMilliseconds = Date.now() - startedAt;
      descendantPid = Number.parseInt(readFileSync(descendantPidFile, "utf8"), 10);

      assert.equal(outcome.passed, false);
      assert.match(outcome.message, /exceeded.*1500 ms deadline/i);
      assert.doesNotMatch(outcome.message, new RegExp(secret));
      assert.ok(
        elapsedMilliseconds < 4_000,
        `the hard deadline took ${elapsedMilliseconds} ms despite the descendant ignoring SIGTERM`,
      );
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
      assert.equal(
        await waitForProcessExit(descendantPid),
        true,
        `stubborn descendant ${descendantPid} survived the watchdog process-tree cleanup`,
      );

      const helperSource = readFileSync(
        resolve(backendDirectory, "scripts", "postgres-release-safety.mjs"),
        "utf8",
      );
      assert.match(helperSource, /signalPosixProcessGroup\(processGroupId, child, ["']SIGTERM["']\)/);
      assert.match(helperSource, /signalPosixProcessGroup\(processGroupId, child, ["']SIGKILL["']\)/);
      assert.match(helperSource, /managedProcessGroupParentFlag/);
      assert.match(helperSource, /["']taskkill["']/);
      assert.match(helperSource, /child\.stdout\?\.destroy\(\)/);
      assert.match(helperSource, /child\.removeAllListeners\(\)/);
      assert.match(helperSource, /child\.unref\(\)/);
    } finally {
      if (descendantPid) forceCleanupProcess(descendantPid);
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("cleans a private outer group when a nested watchdog fails before the outer deadline", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "pindou-release-nested-timeout-"));
    const descendantPidFile = join(temporaryRoot, "descendant.pid");
    let descendantPid: number | undefined;
    try {
      const startedAt = Date.now();
      const outcome = await runBoundedNodeCommand({
        label: "outer release watchdog",
        arguments_: [nestedWatchdogScriptPath, descendantPidFile, "500"],
        cwd: backendDirectory,
        environment: process.env,
        timeoutMilliseconds: 5_000,
        terminationGraceMilliseconds: 100,
        forceKillSettleMilliseconds: 250,
        // With no inherited pipe keeping `close` pending, this specifically
        // exercises normal outer-leader completion plus residual-group cleanup.
        stdio: "ignore",
      });
      const elapsedMilliseconds = Date.now() - startedAt;
      descendantPid = Number.parseInt(readFileSync(descendantPidFile, "utf8"), 10);

      assert.equal(outcome.passed, false);
      assert.match(outcome.message, /exited with status 1/i);
      assert.ok(
        elapsedMilliseconds < 3_000,
        `the nested timeout did not settle before the outer deadline (${elapsedMilliseconds} ms)`,
      );
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
      assert.equal(
        await waitForProcessExit(descendantPid),
        true,
        `nested timeout left descendant ${descendantPid} alive after outer group cleanup`,
      );
    } finally {
      if (descendantPid) forceCleanupProcess(descendantPid);
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("redacts credentials and starts no checks when the connection preflight fails", () => {
    const result = runGate({
      PINDOU_TEST_POSTGRES_URL: "postgresql://user:do-not-print@127.0.0.1:1/pindou_test_release",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_release",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /do-not-print/);
    assert.doesNotMatch(result.stdout, /running real PostgreSQL release check/i);
  });

  it("applies the same fail-closed contract to the standalone payment lock-order gate", () => {
    const missingAcknowledgement = runGate({
      PINDOU_TEST_POSTGRES_URL: "postgresql://user:do-not-print@127.0.0.1:1/pindou_test_payment",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_payment",
    }, paymentScriptPath);
    assert.equal(missingAcknowledgement.status, 1);
    assert.match(missingAcknowledgement.stderr, /ALLOW_MUTATION.*exactly true/i);
    assert.doesNotMatch(missingAcknowledgement.stderr, /do-not-print/);

    const failedPreflight = runGate({
      PINDOU_TEST_POSTGRES_URL: "postgresql://user:do-not-print@127.0.0.1:1/pindou_test_payment",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_payment",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
    }, paymentScriptPath);
    assert.equal(failedPreflight.status, 1);
    assert.doesNotMatch(failedPreflight.stderr, /do-not-print/);
  });

  it("rejects a mismatched server identity or other active connections", () => {
    assert.throws(
      () => assertRegressionPreflightState({
        database_name: "production",
        other_connection_count: 0,
      }, "pindou_test_release"),
      /does not match.*confirmed database name/i,
    );
    assert.throws(
      () => assertRegressionPreflightState({
        database_name: "pindou_test_release",
        other_connection_count: 1,
      }, "pindou_test_release"),
      /other active connections.*non-isolated/i,
    );
    assert.doesNotThrow(() => assertRegressionPreflightState({
      database_name: "pindou_test_release",
      other_connection_count: 0,
    }, "pindou_test_release"));
  });
});
