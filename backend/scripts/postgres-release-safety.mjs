import { spawn } from "node:child_process";

import pg from "pg";

const { Pool } = pg;

const databaseUrlFlag = "PINDOU_TEST_POSTGRES_URL";
const databaseConfirmationFlag = "PINDOU_TEST_POSTGRES_CONFIRM_DATABASE";
const mutationConfirmationFlag = "PINDOU_TEST_POSTGRES_ALLOW_MUTATION";
const databaseSslFlag = "PINDOU_TEST_POSTGRES_DATABASE_SSL";
const regressionDatabaseIdentityErrorCode = "PINDOU_REGRESSION_DATABASE_IDENTITY_MISMATCH";
const regressionDatabaseBusyErrorCode = "PINDOU_REGRESSION_DATABASE_NOT_ISOLATED";

function fail(message) {
  const error = new Error(message);
  error.name = "ReleaseGateConfigurationError";
  throw error;
}

function parseStrictBoolean(name, value, fallback) {
  if (value === undefined || value.trim() === "") return fallback;
  if (value !== "true" && value !== "false") fail(`${name} must be exactly true or false.`);
  return value === "true";
}

export function readRegressionDatabaseSsl(environment = process.env) {
  return parseStrictBoolean(
    databaseSslFlag,
    environment[databaseSslFlag],
    false,
  );
}

export function strictDatabaseSslOptions(enabled) {
  return enabled ? { rejectUnauthorized: true } : false;
}

function databaseNameFromUrl(parsed) {
  if (!parsed.hostname) fail(`${databaseUrlFlag} must include an explicit database host.`);
  if (!parsed.username) fail(`${databaseUrlFlag} must include an explicit database user.`);
  if (!parsed.port || !/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535) {
    fail(`${databaseUrlFlag} must include an explicit database port between 1 and 65535.`);
  }
  if (parsed.hash) fail(`${databaseUrlFlag} must not contain a URL fragment.`);
  if (parsed.search) {
    fail(
      `${databaseUrlFlag} must not contain query parameters; use ${databaseSslFlag} for TLS.`,
    );
  }

  if (!/^\/[^/]+$/.test(parsed.pathname)) {
    fail(`${databaseUrlFlag} must identify exactly one database in its path.`);
  }
  const rawPath = parsed.pathname.slice(1);
  let databaseName;
  try {
    databaseName = decodeURIComponent(rawPath);
  } catch {
    fail(`${databaseUrlFlag} contains an invalid encoded database name.`);
  }
  if (!databaseName || databaseName.includes("/") || databaseName.includes("\0")) {
    fail(`${databaseUrlFlag} contains an invalid database name.`);
  }
  return databaseName;
}

function isExplicitLoopbackHost(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function validateRegressionReleaseEnvironment(environment = process.env) {
  const databaseUrl = environment[databaseUrlFlag]?.trim();
  if (!databaseUrl) {
    fail(`${databaseUrlFlag} is required; refusing to use DATABASE_URL or skip the real checks.`);
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail(`${databaseUrlFlag} must be a valid PostgreSQL URL.`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    fail(`${databaseUrlFlag} must use the postgres: or postgresql: protocol.`);
  }

  const databaseName = databaseNameFromUrl(parsed);
  if (!/(?:^|[_-])(?:e2e|test)(?:[_-]|$)/i.test(databaseName)) {
    fail(`${databaseUrlFlag} database name must contain a standalone e2e or test marker.`);
  }
  if (["postgres", "template0", "template1", "pindou", "production", "prod"].includes(databaseName.toLowerCase())) {
    fail(`${databaseUrlFlag} points at a reserved or production-like database name.`);
  }
  if (environment[databaseConfirmationFlag] !== databaseName) {
    fail(`${databaseConfirmationFlag} must exactly equal the isolated database name.`);
  }
  if (environment[mutationConfirmationFlag] !== "true") {
    fail(
      `${mutationConfirmationFlag} must be exactly true; refusing to create, update, or delete test data.`,
    );
  }

  const databaseSsl = readRegressionDatabaseSsl(environment);
  if (!isExplicitLoopbackHost(parsed.hostname) && !databaseSsl) {
    fail(`${databaseSslFlag} must be exactly true for a non-loopback PostgreSQL host.`);
  }

  return {
    databaseUrl,
    databaseName,
    databaseSsl,
  };
}

const defaultTerminationGraceMilliseconds = 2_000;
const defaultForceKillSettleMilliseconds = 500;
const windowsTaskkillTimeoutMilliseconds = 1_000;
const managedProcessGroupParentFlag = "PINDOU_RELEASE_WATCHDOG_PARENT_PID";

function signalPosixProcessGroup(processGroupId, child, signal) {
  if (processGroupId) {
    try {
      // The child is spawned as a detached process-group leader on POSIX so
      // its ordinary descendants receive the same timeout escalation.
      process.kill(-processGroupId, signal);
      return;
    } catch {
      // ESRCH can also mean this is an intentionally non-detached nested
      // runner. Always retain the direct-child fallback.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A concurrent exit is equivalent to successful termination here.
  }
}

function forceWindowsProcessTree(pid, child) {
  if (!pid) return;
  // Windows has no POSIX grace-signal equivalent for console process trees.
  // Start the native forced tree kill first so descendants are enumerated
  // while the leader still exists, then keep a separately bounded direct
  // child kill as a fallback if taskkill cannot make progress.
  const killDirectChild = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // A concurrent tree termination is already the desired outcome.
    }
  };
  let killer;
  try {
    killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    killDirectChild();
  }

  if (!killer) return;
  const taskkillDeadline = setTimeout(() => {
    try {
      killer.kill("SIGKILL");
    } catch {
      // taskkill may already have exited.
    }
    killDirectChild();
  }, windowsTaskkillTimeoutMilliseconds);
  taskkillDeadline.unref();
  killer.once("close", () => {
    clearTimeout(taskkillDeadline);
    // This fallback runs only after taskkill has had its chance to enumerate
    // the intact tree, avoiding a race that could orphan descendants.
    killDirectChild();
  });
  killer.once("error", () => {
    clearTimeout(taskkillDeadline);
    killDirectChild();
  });
  killer.unref();
}

export function runBoundedNodeCommand({
  label,
  arguments_,
  cwd,
  environment,
  timeoutMilliseconds,
  terminationGraceMilliseconds = defaultTerminationGraceMilliseconds,
  forceKillSettleMilliseconds = defaultForceKillSettleMilliseconds,
  stdio = "inherit",
  executable = process.execPath,
}) {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    fail("Release command timeout must be a positive integer.");
  }
  if (!Number.isSafeInteger(terminationGraceMilliseconds) || terminationGraceMilliseconds < 1) {
    fail("Release command termination grace must be a positive integer.");
  }
  if (!Number.isSafeInteger(forceKillSettleMilliseconds) || forceKillSettleMilliseconds < 1) {
    fail("Release command force-kill settlement must be a positive integer.");
  }

  return new Promise((resolveOutcome) => {
    let child;
    const inheritedManagedGroup = process.platform !== "win32"
      && process.env[managedProcessGroupParentFlag] === String(process.ppid);
    const ownsManagedProcessGroup = process.platform !== "win32" && !inheritedManagedGroup;
    try {
      child = spawn(executable, arguments_, {
        cwd,
        env: {
          ...environment,
          // A nested release wrapper must stay in the outer watchdog's group;
          // otherwise its own detached children could escape the outer cutoff.
          [managedProcessGroupParentFlag]: String(process.pid),
        },
        stdio,
        detached: ownsManagedProcessGroup,
        windowsHide: true,
      });
    } catch {
      resolveOutcome({ passed: false, message: `${label} could not be started.` });
      return;
    }

    // Drain captured pipes so a verbose child cannot block on a full buffer.
    child.stdout?.resume();
    child.stderr?.resume();

    const childPid = child.pid;
    const processGroupId = ownsManagedProcessGroup ? childPid : undefined;
    let settled = false;
    let timedOut = false;
    let forceTimer;
    let postForceTimer;
    let deadlineTimer;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (postForceTimer) clearTimeout(postForceTimer);
      resolveOutcome(outcome);
    };

    const finishTimedOut = () => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.removeAllListeners();
      child.unref();
      finish({
        passed: false,
        message: `${label} exceeded its ${timeoutMilliseconds} ms deadline.`,
      });
    };

    const forceTerminate = () => {
      if (settled) return;
      if (process.platform === "win32") {
        forceWindowsProcessTree(childPid, child);
      } else {
        // Retain the original process-group ID even if the leader already
        // exited after SIGTERM; descendants can still occupy that group.
        signalPosixProcessGroup(processGroupId, child, "SIGKILL");
      }
      // Never wait forever for close/reaping after the force signal. Release
      // all observable handles and return the fixed safe timeout result.
      const settlementBound = process.platform === "win32"
        ? Math.max(
          forceKillSettleMilliseconds,
          windowsTaskkillTimeoutMilliseconds + 250,
        )
        : forceKillSettleMilliseconds;
      postForceTimer = setTimeout(finishTimedOut, settlementBound);
    };

    deadlineTimer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        // SIGTERM is already termination semantics on Windows; use bounded
        // native forced tree cleanup immediately instead of a fictitious
        // graceful interval that could orphan descendants.
        forceTerminate();
      } else {
        signalPosixProcessGroup(processGroupId, child, "SIGTERM");
        forceTimer = setTimeout(forceTerminate, terminationGraceMilliseconds);
      }
    }, timeoutMilliseconds);

    child.once("error", () => {
      if (timedOut) return;
      finish({ passed: false, message: `${label} could not be started.` });
    });
    child.once("close", (code, signal) => {
      // Once the deadline fires, leader exit must not cancel the scheduled
      // process-group escalation: a stubborn descendant may still be alive.
      if (timedOut) return;
      if (ownsManagedProcessGroup) {
        // Even a normally exiting wrapper may have left a descendant behind.
        // Clean the private group before reporting the leader's result.
        signalPosixProcessGroup(processGroupId, child, "SIGKILL");
      }
      if (signal) {
        finish({ passed: false, message: `${label} terminated by ${signal}.` });
      } else if (code !== 0) {
        finish({ passed: false, message: `${label} exited with status ${String(code)}.` });
      } else {
        finish({ passed: true, message: `${label} passed.` });
      }
    });
  });
}

export function releaseDatabaseSecrets(databaseUrl) {
  const parsed = new URL(databaseUrl);
  let decodedPassword = parsed.password;
  try {
    decodedPassword = decodeURIComponent(parsed.password);
  } catch {
    // Keep the encoded password in the redaction set when it cannot be decoded.
  }
  return [databaseUrl, parsed.password, decodedPassword].filter(Boolean);
}

export function redactReleaseMessage(input, secrets) {
  let output = String(input);
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

export function assertRegressionPreflightState(row, databaseName) {
  if (row?.database_name !== databaseName) {
    const error = new Error(
      "Connected PostgreSQL database does not match the explicitly confirmed database name.",
    );
    error.code = regressionDatabaseIdentityErrorCode;
    throw error;
  }
  if (Number(row.other_connection_count) !== 0) {
    const error = new Error(
      `${databaseUrlFlag} has other active connections; refusing to mutate a non-isolated database.`,
    );
    error.code = regressionDatabaseBusyErrorCode;
    throw error;
  }
}

export function isRegressionDatabaseBusyError(error) {
  return error?.code === regressionDatabaseBusyErrorCode;
}

export async function assertRegressionDatabaseIsIsolated({
  databaseUrl,
  databaseName,
  databaseSsl,
}) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: strictDatabaseSslOptions(databaseSsl),
    application_name: "pindou_postgres_release_preflight",
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    max: 1,
  });
  try {
    const result = await pool.query(`
      SELECT current_database() AS database_name,
             (SELECT count(*)::integer
              FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()) AS other_connection_count
    `);
    assertRegressionPreflightState(result.rows[0], databaseName);
  } finally {
    await pool.end();
  }
}
