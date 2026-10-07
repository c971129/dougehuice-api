import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  assertDockerCandidateProvenance,
  createCandidateResourceNames,
  createDockerRuntimeEnvironment,
  dockerBridgeReleaseAcknowledgementFlag,
  dockerCandidateAttestation,
  dockerRunArguments,
  parseDockerImageInspection,
  rewriteDatabaseUrlForDocker,
  serializeDockerEnvFile,
  validateReleaseCandidateEnvironment,
} from "./docker-release-candidate.mjs";
import { strictDatabaseSslOptions } from "./postgres-release-safety.mjs";
import { assertReleaseProvenanceMatchesCurrentCheckout } from "./compute-release-source-digest.mjs";

const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const backendDirectory = resolve(dirname(scriptPath), "..");
const migrationsDirectory = join(backendDirectory, "migrations");
const confirmationFlag = "PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION";
const databaseUrlFlag = "PINDOU_E2E_DATABASE_URL";
const databaseConfirmationFlag = "PINDOU_E2E_CONFIRM_DATABASE";
const defaultSmokeTimeoutMilliseconds = 240_000;
const childLogLimitBytes = 128 * 1024;

export const PINNED_BUILTIN_PALETTE_IDS = [
  "mard-48-v1",
  "mard-72-v1",
  "mard-144-v1",
  "mard-221-v1",
  "mard-291-v1",
];

export function assertPinnedBuiltinPaletteIds(actualIds) {
  if (!Array.isArray(actualIds)
    || actualIds.length !== PINNED_BUILTIN_PALETTE_IDS.length
    || PINNED_BUILTIN_PALETTE_IDS.some((id, index) => actualIds[index] !== id)) {
    throw new Error(
      `Active built-in palettes must exactly match the five pinned MARD reference catalogs; got ${JSON.stringify(actualIds)}.`,
    );
  }
}

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

function parseSmokeTimeout(value) {
  if (value === undefined || value.trim() === "") return defaultSmokeTimeoutMilliseconds;
  if (!/^\d+$/.test(value)) fail("PINDOU_E2E_TIMEOUT_MS must be a decimal integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 60_000 || parsed > 600_000) {
    fail("PINDOU_E2E_TIMEOUT_MS must be between 60000 and 600000 milliseconds.");
  }
  return parsed;
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
      `${databaseUrlFlag} must not contain query parameters; use PINDOU_E2E_DATABASE_SSL for TLS.`,
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

export function validateReleaseEnvironment(environment = process.env) {
  const databaseUrl = environment[databaseUrlFlag]?.trim();
  if (!databaseUrl) {
    fail(`${databaseUrlFlag} is required; refusing to use DATABASE_URL or the development default.`);
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
  if (environment[confirmationFlag] !== "true") {
    fail(`${confirmationFlag} must be exactly true; refusing to migrate an unconfirmed database.`);
  }

  const databaseSsl = parseStrictBoolean(
    "PINDOU_E2E_DATABASE_SSL",
    environment.PINDOU_E2E_DATABASE_SSL,
    false,
  );
  if (!isExplicitLoopbackHost(parsed.hostname) && !databaseSsl) {
    fail("PINDOU_E2E_DATABASE_SSL must be exactly true for a non-loopback PostgreSQL host.");
  }

  return {
    databaseUrl,
    databaseName,
    databaseSsl,
    smokeTimeoutMilliseconds: parseSmokeTimeout(environment.PINDOU_E2E_TIMEOUT_MS),
  };
}

export function databaseIdentity(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return `${parsed.hostname.toLowerCase()}:${parsed.port}/${databaseNameFromUrl(parsed)}`;
}

function createTailBuffer(maximumBytes = childLogLimitBytes) {
  let text = "";
  return {
    append(chunk) {
      text += chunk.toString("utf8");
      while (Buffer.byteLength(text, "utf8") > maximumBytes) {
        text = text.slice(Math.max(1, Math.floor(text.length / 4)));
      }
    },
    read() {
      return text;
    },
  };
}

export function retainedProcessEnvironment(environment) {
  const retained = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "HOME",
    "LOCALAPPDATA",
    "APPDATA",
    "LANG",
    "LC_ALL",
    "TZ",
    // Authentication-only PostgreSQL input. Target-selection PG* variables
    // stay excluded because the validated connection URL owns host, port,
    // user, and database identity for every child process.
    "PGPASSWORD",
  ]) {
    if (environment[name] !== undefined) retained[name] = environment[name];
  }
  return retained;
}

function createChildEnvironment({
  sourceEnvironment,
  databaseUrl,
  databaseSsl,
  port,
  storageRoot,
  dotenvPath,
  assetEncryptionKey,
  internalWorkerKey,
}) {
  return {
    ...retainedProcessEnvironment(sourceEnvironment),
    DOTENV_CONFIG_PATH: dotenvPath,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: String(databaseSsl),
    DATABASE_POOL_MAX: "8",
    DEV_AUTH_ENABLED: "true",
    DEV_STARTING_CREDITS: "6",
    CUSTOM_PALETTES_ENABLED: "true",
    TRUSTED_PROXIES: "",
    ASSET_STORAGE_PROVIDER: "local",
    ASSET_STORAGE_ROOT: storageRoot,
    ASSET_ENCRYPTION_KEY_BASE64: assetEncryptionKey,
    ASSET_ENCRYPTION_ACTIVE_KEY_ID: "current-schema-e2e",
    ASSET_ENCRYPTION_LEGACY_KEY_ID: "current-schema-e2e",
    ASSET_ENCRYPTION_READ_KEYS_JSON: "{}",
    ASSET_CONSENT_VERSION: "current-schema-e2e-v1",
    ASSET_CONSENT_PROCESSOR: "release-gate-local-deterministic-provider",
    ASSET_CONSENT_PURPOSE_TEXT: "isolated current-schema HTTP end-to-end release gate",
    ASSET_CONSENT_RETENTION_TEXT: "temporary local encrypted storage removed when the gate exits",
    INTERNAL_WORKER_KEY: internalWorkerKey,
    GENERATION_PROVIDER_URL: "",
    GENERATION_PROVIDER_API_KEY: "",
    WECHAT_APP_ID: "",
    WECHAT_APP_SECRET: "",
    WECHAT_PAY_MCH_ID: "",
    WECHAT_PAY_MERCHANT_CERT_SERIAL: "",
    WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: "",
    WECHAT_PAY_VERIFIER_SERIAL: "",
    WECHAT_PAY_VERIFIER_PUBLIC_KEY_PATH: "",
    WECHAT_PAY_ADDITIONAL_VERIFIERS: "",
    WECHAT_PAY_API_V3_KEY: "",
    WECHAT_PAY_NOTIFY_URL: "",
  };
}

export function createRedactor(secrets) {
  const values = [...new Set(secrets.filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => right.length - left.length);
  return (input) => {
    let output = String(input);
    for (const value of values) output = output.split(value).join("[REDACTED]");
    return output;
  };
}

function decodeUrlComponentForRedaction(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function releaseDatabaseRedactionSecrets(
  databaseUrl,
  environment = process.env,
  additionalSecrets = [],
) {
  const parsedUrl = new URL(databaseUrl);
  return [
    databaseUrl,
    parsedUrl.password,
    decodeUrlComponentForRedaction(parsedUrl.password),
    environment.PGPASSWORD,
    ...additionalSecrets,
  ];
}

function spawnCommand(label, command, arguments_, environment, activeChildren) {
  const stdout = createTailBuffer();
  const stderr = createTailBuffer();
  const child = spawn(command, arguments_, {
    cwd: backendDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => stdout.append(chunk));
  child.stderr?.on("data", (chunk) => stderr.append(chunk));

  let settleExit;
  const exitPromise = new Promise((resolveExit) => {
    settleExit = resolveExit;
  });
  let settled = false;
  let record;
  const settle = (result) => {
    if (settled) return;
    settled = true;
    if (record) activeChildren.delete(record);
    settleExit(result);
  };
  child.once("error", (error) => settle({ error }));
  child.once("exit", (code, signal) => settle({ code, signal }));

  record = { label, child, stdout, stderr, exitPromise, get settled() { return settled; } };
  activeChildren.add(record);
  return record;
}

function spawnChild(label, arguments_, environment, activeChildren) {
  return spawnCommand(label, process.execPath, arguments_, environment, activeChildren);
}

async function terminateChild(record) {
  if (record.settled) return;
  try {
    record.child.kill("SIGTERM");
  } catch {
    // The process may have exited between the settled check and kill.
  }
  const graceful = await Promise.race([
    record.exitPromise.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (graceful || record.settled) return;
  try {
    record.child.kill("SIGKILL");
  } catch {
    // Preserve the gate result; cleanup reports a live process below if needed.
  }
  await Promise.race([
    record.exitPromise,
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
}

function childFailure(record, result, redact) {
  const reason = result.error
    ? result.error.stack ?? result.error.message
    : result.signal
      ? `terminated by ${result.signal}`
      : `exited with status ${String(result.code)}`;
  const stdout = redact(record.stdout.read()).trim();
  const stderr = redact(record.stderr.read()).trim();
  return new Error([
    `${record.label} ${redact(reason)}`,
    stdout ? `--- ${record.label} stdout (tail) ---\n${stdout}` : "",
    stderr ? `--- ${record.label} stderr (tail) ---\n${stderr}` : "",
  ].filter(Boolean).join("\n"));
}

async function runStep({
  label,
  arguments_,
  environment,
  activeChildren,
  timeoutMilliseconds,
  redact,
  command = process.execPath,
}) {
  process.stdout.write(`${label}...\n`);
  const record = spawnCommand(label, command, arguments_, environment, activeChildren);
  let timer;
  const result = await Promise.race([
    record.exitPromise,
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ timeout: true }), timeoutMilliseconds);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (result.timeout) {
    await terminateChild(record);
    throw new Error(`${label} exceeded its ${timeoutMilliseconds} ms deadline.`);
  }
  if (result.error || result.signal || result.code !== 0) throw childFailure(record, result, redact);
  process.stdout.write(`${label} passed.\n`);
  return record;
}

async function runDockerStep(options) {
  return runStep({ ...options, command: "docker" });
}

function dockerCliEnvironment(sourceEnvironment) {
  const environment = retainedProcessEnvironment(sourceEnvironment);
  for (const name of [
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
  ]) {
    if (sourceEnvironment[name] !== undefined) environment[name] = sourceEnvironment[name];
  }
  // The Docker client receives application credentials only through the
  // temporary --env-file. They are intentionally absent from this process
  // environment as well as the command line.
  delete environment.PGPASSWORD;
  return environment;
}

async function resolveDockerCandidate({
  imageReference,
  environment,
  activeChildren,
  redact,
}) {
  const inspection = await runDockerStep({
    label: "Resolving and attesting the Docker release candidate",
    arguments_: ["image", "inspect", imageReference],
    environment,
    activeChildren,
    timeoutMilliseconds: 30_000,
    redact,
  });
  return parseDockerImageInspection(inspection.stdout.read());
}

async function startDockerService({
  label,
  name,
  arguments_,
  environment,
  activeChildren,
  containers,
  redact,
}) {
  containers.add(name);
  const started = await runDockerStep({
    label: `Starting ${label}`,
    arguments_,
    environment,
    activeChildren,
    timeoutMilliseconds: 30_000,
    redact,
  });
  if (!/^[a-f0-9]{64}$/i.test(started.stdout.read().trim())) {
    throw new Error(`${label} did not return a Docker container ID.`);
  }
  const monitor = spawnCommand(
    `${label} container monitor`,
    "docker",
    ["wait", name],
    environment,
    activeChildren,
  );
  return {
    label,
    dockerName: name,
    monitor,
    exitPromise: monitor.exitPromise,
    get settled() { return monitor.settled; },
  };
}

async function serviceFailure(service, result, {
  dockerEnvironment,
  activeChildren,
  redact,
}) {
  if (!service.dockerName) return childFailure(service, result, redact);
  let logs = "";
  try {
    const logRecord = await runDockerStep({
      label: `Reading ${service.label} failure logs`,
      arguments_: ["logs", "--tail", "200", service.dockerName],
      environment: dockerEnvironment,
      activeChildren,
      timeoutMilliseconds: 10_000,
      redact,
    });
    logs = redact(`${logRecord.stdout.read()}\n${logRecord.stderr.read()}`).trim();
  } catch (error) {
    logs = redact(error instanceof Error ? error.message : String(error));
  }
  const monitorReason = result.error
    ? result.error.message
    : result.signal
      ? `Docker monitor terminated by ${result.signal}`
      : `container exited with status ${service.monitor.stdout.read().trim() || "unknown"}`;
  return new Error([
    `${service.label} ${redact(monitorReason)}`,
    logs ? `--- ${service.label} logs (tail) ---\n${logs}` : "",
  ].filter(Boolean).join("\n"));
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  if (!port) throw new Error("Could not reserve a loopback port for the isolated API.");
  return port;
}

export const emptyDatabaseStateSql = `
  SELECT
    (SELECT count(*)::integer
     FROM pg_class AS c
     JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname !~ '^pg_toast'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')) AS relation_count,
    (SELECT count(*)::integer
     FROM pg_proc AS p
     JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname !~ '^pg_toast') AS routine_count,
    (SELECT count(*)::integer
     FROM pg_type AS t
     JOIN pg_namespace AS n ON n.oid = t.typnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname !~ '^pg_toast') AS user_type_count,
    (SELECT count(*)::integer
     FROM pg_namespace
     WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
       AND nspname !~ '^pg_toast') AS custom_schema_count,
    (SELECT count(*)::integer FROM pg_extension WHERE extname <> 'plpgsql') AS extra_extension_count,
    (SELECT count(*)::integer
     FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid()) AS other_connection_count
`;

async function assertDatabaseIsEmpty({ databaseUrl, databaseName, databaseSsl }) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: strictDatabaseSslOptions(databaseSsl),
    application_name: "pindou_current_schema_e2e_preflight",
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    max: 1,
  });
  try {
    const identity = await pool.query("SELECT current_database() AS database_name");
    if (identity.rows[0]?.database_name !== databaseName) {
      throw new Error("Connected PostgreSQL database does not match the explicitly confirmed database name.");
    }
    const state = await pool.query(emptyDatabaseStateSql);
    const counts = state.rows[0];
    if (!counts || Object.values(counts).some((value) => Number(value) !== 0)) {
      throw new Error("The confirmed E2E database is not empty; refusing to migrate or overwrite it.");
    }
  } finally {
    await pool.end();
  }
}

async function expectedMigrationManifest() {
  const fileNames = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right, "en"));
  return Promise.all(fileNames.map(async (version) => {
    const sql = await readFile(join(migrationsDirectory, version), "utf8");
    return {
      version,
      checksum: createHash("sha256").update(sql.replace(/\r\n?/g, "\n"), "utf8").digest("hex"),
    };
  }));
}

async function assertCurrentSchemaAndSeed({ databaseUrl, databaseSsl }) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: strictDatabaseSslOptions(databaseSsl),
    application_name: "pindou_current_schema_e2e_verify",
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    max: 1,
  });
  try {
    const [expected, applied, seeded] = await Promise.all([
      expectedMigrationManifest(),
      pool.query("SELECT version, checksum::text AS checksum FROM schema_migrations ORDER BY version"),
      pool.query(
        `SELECT COALESCE(
           array_agg(id ORDER BY array_position($1::text[], id)),
           ARRAY[]::text[]
         ) AS ids
         FROM palettes
         WHERE owner_user_id IS NULL AND NOT retired`,
        [PINNED_BUILTIN_PALETTE_IDS],
      ),
    ]);
    if (applied.rows.length !== expected.length
      || expected.some((migration, index) => migration.version !== applied.rows[index]?.version
        || migration.checksum !== applied.rows[index]?.checksum)) {
      throw new Error("Applied schema_migrations does not exactly match the current source manifest and checksums.");
    }
    assertPinnedBuiltinPaletteIds(seeded.rows[0]?.ids);
    return { count: expected.length, latest: expected.at(-1)?.version ?? "none" };
  } finally {
    await pool.end();
  }
}

async function createProductionE2eSession({ databaseUrl, databaseSsl }) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const userId = randomUUID();
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: strictDatabaseSslOptions(databaseSsl),
    application_name: "pindou_release_e2e_fixture",
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO users(id, display_name) VALUES ($1, $2)",
      [userId, "发布候选端到端验收"],
    );
    await client.query(
      "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [tokenHash, userId],
    );
    await client.query(
      "INSERT INTO credit_accounts(user_id, balance) VALUES ($1, 20)",
      [userId],
    );
    await client.query(
      `INSERT INTO credit_ledger(id, user_id, delta, balance_after, reason, reference_id)
       VALUES ($1, $2, 20, 20, 'release_e2e_grant', $3)`,
      [randomUUID(), userId, `release-e2e:${userId}`],
    );
    await client.query("COMMIT");
    return token;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function waitForReady({
  baseUrl,
  api,
  timeoutMilliseconds,
  redact,
  dockerEnvironment,
  activeChildren,
}) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (api.settled) {
      const result = await api.exitPromise;
      throw await serviceFailure(api, result, { dockerEnvironment, activeChildren, redact });
    }
    try {
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {
      // The API may still be starting; retry until the bounded deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`API readiness did not return 200 within ${timeoutMilliseconds} ms.`);
}

function assertSafeTemporaryRoot(path) {
  const resolvedRoot = resolve(path);
  const resolvedTemp = resolve(tmpdir());
  const withinTemp = resolvedRoot.toLowerCase().startsWith(`${resolvedTemp.toLowerCase()}${sep}`);
  if (!isAbsolute(resolvedRoot) || !withinTemp || !basename(resolvedRoot).startsWith("pindou-current-schema-e2e-")) {
    throw new Error("Refusing to remove an unexpected temporary storage path.");
  }
}

async function removeDockerResource({
  kind,
  name,
  environment,
  activeChildren,
  redact,
}) {
  try {
    await runDockerStep({
      label: `Removing isolated Docker ${kind} ${name}`,
      arguments_: [kind, "rm", "--force", name],
      environment,
      activeChildren,
      timeoutMilliseconds: 30_000,
      redact,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No such (?:container|volume)/i.test(message)) return;
    throw error;
  }
}

async function main() {
  let validated;
  let candidateConfiguration;
  try {
    validated = validateReleaseEnvironment(process.env);
    candidateConfiguration = validateReleaseCandidateEnvironment(process.env);
    await assertReleaseProvenanceMatchesCurrentCheckout(candidateConfiguration);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const activeChildren = new Set();
  const dockerContainers = new Set();
  const dockerEnvironment = dockerCliEnvironment(process.env);
  let dockerVolume;
  let temporaryRoot;
  let stoppingSignal;
  const stop = (signal) => {
    stoppingSignal ??= signal;
    for (const record of activeChildren) {
      try {
        record.child.kill("SIGTERM");
      } catch {
        // The finalizer will retry and escalate if necessary.
      }
    }
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  try {
    process.stdout.write("Validating explicitly confirmed empty PostgreSQL database...\n");
    await assertDatabaseIsEmpty(validated);
    if (stoppingSignal) throw new Error(`Release gate interrupted by ${stoppingSignal}.`);

    temporaryRoot = await mkdtemp(join(tmpdir(), "pindou-current-schema-e2e-"));
    const storageRoot = join(temporaryRoot, "private-objects");
    const dotenvPath = join(temporaryRoot, "empty.env");
    await writeFile(dotenvPath, "# intentionally empty; release gate does not inherit backend/.env\n", "utf8");
    const port = await reserveLoopbackPort();
    const assetEncryptionKey = randomBytes(32).toString("base64");
    const internalWorkerKey = randomBytes(32).toString("base64url");
    const childEnvironment = createChildEnvironment({
      sourceEnvironment: process.env,
      databaseUrl: validated.databaseUrl,
      databaseSsl: validated.databaseSsl,
      port,
      storageRoot,
      dotenvPath,
      assetEncryptionKey,
      internalWorkerKey,
    });
    let redact = createRedactor(releaseDatabaseRedactionSecrets(
      validated.databaseUrl,
      process.env,
      [assetEncryptionKey, internalWorkerKey],
    ));

    let services;
    let productionE2eToken;
    if (candidateConfiguration.mode === "image") {
      const candidate = await resolveDockerCandidate({
        imageReference: candidateConfiguration.imageReference,
        environment: dockerEnvironment,
        activeChildren,
        redact,
      });
      assertDockerCandidateProvenance(candidate, candidateConfiguration);
      process.stdout.write(`${dockerCandidateAttestation(candidate)}\n`);

      const dockerDatabase = rewriteDatabaseUrlForDocker(validated.databaseUrl);
      const candidateSecretDirectory = join(temporaryRoot, "candidate-secrets");
      // The random parent remains owner-only. The bind mount itself must be
      // traversable by the image's non-root uid after Docker mounts it at
      // /app/.release-secrets.
      await mkdir(candidateSecretDirectory, { recursive: false, mode: 0o755 });
      const paymentKeyPair = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      await Promise.all([
        writeFile(
          join(candidateSecretDirectory, "merchant-private.pem"),
          paymentKeyPair.privateKey,
          { encoding: "utf8", mode: 0o644 },
        ),
        writeFile(
          join(candidateSecretDirectory, "wechat-verifier.pem"),
          paymentKeyPair.publicKey,
          { encoding: "utf8", mode: 0o644 },
        ),
      ]);
      const wechatAppSecret = randomBytes(24).toString("hex");
      const wechatPayApiKey = randomBytes(16).toString("hex");
      const generationProviderApiKey = randomBytes(24).toString("base64url");
      redact = createRedactor(releaseDatabaseRedactionSecrets(
        validated.databaseUrl,
        process.env,
        [
          assetEncryptionKey,
          internalWorkerKey,
          dockerDatabase.databaseUrl,
          wechatAppSecret,
          wechatPayApiKey,
          generationProviderApiKey,
        ],
      ));
      const dockerHostEnvironment = createDockerRuntimeEnvironment(
        childEnvironment,
        dockerDatabase.databaseUrl,
      );
      const dockerDatabaseEnvironment = {
        DOTENV_CONFIG_PATH: dockerHostEnvironment.DOTENV_CONFIG_PATH,
        NODE_ENV: "production",
        DATABASE_URL: dockerHostEnvironment.DATABASE_URL,
        DATABASE_SSL: dockerHostEnvironment.DATABASE_SSL,
        DATABASE_POOL_MAX: dockerHostEnvironment.DATABASE_POOL_MAX,
        ...(dockerHostEnvironment.PGPASSWORD
          ? { PGPASSWORD: dockerHostEnvironment.PGPASSWORD }
          : {}),
        ...(dockerDatabase.usesHostGateway
          ? { [dockerBridgeReleaseAcknowledgementFlag]: "true" }
          : {}),
      };
      const dockerStorageEnvironment = {
        ...dockerDatabaseEnvironment,
        ASSET_STORAGE_PROVIDER: "local",
        ASSET_STORAGE_ROOT: dockerHostEnvironment.ASSET_STORAGE_ROOT,
        ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED: "true",
        ASSET_ENCRYPTION_KEY_BASE64: dockerHostEnvironment.ASSET_ENCRYPTION_KEY_BASE64,
        ASSET_ENCRYPTION_ACTIVE_KEY_ID: dockerHostEnvironment.ASSET_ENCRYPTION_ACTIVE_KEY_ID,
        ASSET_ENCRYPTION_LEGACY_KEY_ID: dockerHostEnvironment.ASSET_ENCRYPTION_LEGACY_KEY_ID,
        ASSET_ENCRYPTION_READ_KEYS_JSON: dockerHostEnvironment.ASSET_ENCRYPTION_READ_KEYS_JSON,
      };
      const dockerWechatEnvironment = {
        WECHAT_APP_ID: "wx0000000000000000",
        WECHAT_APP_SECRET: wechatAppSecret,
        WECHAT_PAY_MCH_ID: "1900000001",
        WECHAT_PAY_MERCHANT_CERT_SERIAL: "RELEASE_GATE_CERT_0001",
        WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: "/app/.release-secrets/merchant-private.pem",
        WECHAT_PAY_VERIFIER_SERIAL: "PUB_KEY_ID_RELEASE_GATE_0001",
        WECHAT_PAY_VERIFIER_PUBLIC_KEY_PATH: "/app/.release-secrets/wechat-verifier.pem",
        WECHAT_PAY_API_V3_KEY: wechatPayApiKey,
        WECHAT_PAY_NOTIFY_URL: "https://release-gate.invalid/api/v1/wechat-pay/notifications",
      };
      const dockerApiEnvironment = {
        ...dockerStorageEnvironment,
        ...dockerWechatEnvironment,
        HOST: "0.0.0.0",
        PORT: "8787",
        DEV_AUTH_ENABLED: "false",
        CUSTOM_PALETTES_ENABLED: "false",
        TRUSTED_PROXIES: "127.0.0.1/32",
        ASSET_CONSENT_VERSION: dockerHostEnvironment.ASSET_CONSENT_VERSION,
        ASSET_CONSENT_PROCESSOR: dockerHostEnvironment.ASSET_CONSENT_PROCESSOR,
        ASSET_CONSENT_PURPOSE_TEXT: dockerHostEnvironment.ASSET_CONSENT_PURPOSE_TEXT,
        ASSET_CONSENT_RETENTION_TEXT: dockerHostEnvironment.ASSET_CONSENT_RETENTION_TEXT,
        INTERNAL_WORKER_KEY: dockerHostEnvironment.INTERNAL_WORKER_KEY,
      };
      const dockerGenerationEnvironment = {
        ...dockerStorageEnvironment,
        GENERATION_PROVIDER_URL: "https://generation.release-gate.invalid/v1/generate",
        GENERATION_PROVIDER_API_KEY: generationProviderApiKey,
        GENERATION_PROVIDER_TIMEOUT_MS: "30000",
      };
      const dockerExportEnvironment = dockerStorageEnvironment;
      const dockerPaymentEnvironment = {
        ...dockerDatabaseEnvironment,
        ...dockerWechatEnvironment,
      };
      // Exercise the production maintenance acknowledgement and exclusive
      // preflight inside the exact candidate image. The narrow bridge ACK is
      // accepted only for this explicitly acknowledged local Docker hop.
      const dockerMigrationEnvironment = {
        ...dockerDatabaseEnvironment,
        PINDOU_MIGRATION_MAINTENANCE_ACKNOWLEDGED: "true",
      };
      const migrationEnvPath = join(temporaryRoot, "candidate-migration.env");
      const seedEnvPath = join(temporaryRoot, "candidate-seed.env");
      const apiEnvPath = join(temporaryRoot, "candidate-api.env");
      const generationEnvPath = join(temporaryRoot, "candidate-generation.env");
      const exportEnvPath = join(temporaryRoot, "candidate-export.env");
      const paymentEnvPath = join(temporaryRoot, "candidate-payment.env");
      await Promise.all([
        writeFile(migrationEnvPath, serializeDockerEnvFile(dockerMigrationEnvironment), { encoding: "utf8", mode: 0o600 }),
        writeFile(seedEnvPath, serializeDockerEnvFile(dockerDatabaseEnvironment), { encoding: "utf8", mode: 0o600 }),
        writeFile(apiEnvPath, serializeDockerEnvFile(dockerApiEnvironment), { encoding: "utf8", mode: 0o600 }),
        writeFile(generationEnvPath, serializeDockerEnvFile(dockerGenerationEnvironment), { encoding: "utf8", mode: 0o600 }),
        writeFile(exportEnvPath, serializeDockerEnvFile(dockerExportEnvironment), { encoding: "utf8", mode: 0o600 }),
        writeFile(paymentEnvPath, serializeDockerEnvFile(dockerPaymentEnvironment), { encoding: "utf8", mode: 0o600 }),
      ]);

      const resources = createCandidateResourceNames();
      dockerVolume = resources.volume;
      const volumeRecord = await runDockerStep({
        label: "Creating the isolated Docker candidate asset volume",
        arguments_: ["volume", "create", dockerVolume],
        environment: dockerEnvironment,
        activeChildren,
        timeoutMilliseconds: 30_000,
        redact,
      });
      if (volumeRecord.stdout.read().trim() !== dockerVolume) {
        throw new Error("Docker did not return the exact requested candidate asset volume name.");
      }

      dockerContainers.add(resources.migration);
      await runDockerStep({
        label: "Migrating with the immutable Docker release candidate",
        arguments_: dockerRunArguments({
          name: resources.migration,
          envFilePath: migrationEnvPath,
          volumeName: dockerVolume,
          imageId: candidate.imageId,
          command: ["node", "dist/src/migrate.js"],
          remove: true,
          usesHostGateway: dockerDatabase.usesHostGateway,
        }),
        environment: dockerEnvironment,
        activeChildren,
        timeoutMilliseconds: 180_000,
        redact,
      });
      dockerContainers.delete(resources.migration);

      dockerContainers.add(resources.seed);
      await runDockerStep({
        label: "Seeding with the immutable Docker release candidate",
        arguments_: dockerRunArguments({
          name: resources.seed,
          envFilePath: seedEnvPath,
          volumeName: dockerVolume,
          imageId: candidate.imageId,
          command: ["node", "dist/src/seed.js"],
          remove: true,
          usesHostGateway: dockerDatabase.usesHostGateway,
        }),
        environment: dockerEnvironment,
        activeChildren,
        timeoutMilliseconds: 60_000,
        redact,
      });
      dockerContainers.delete(resources.seed);

      productionE2eToken = await createProductionE2eSession(validated);
      redact = createRedactor(releaseDatabaseRedactionSecrets(
        validated.databaseUrl,
        process.env,
        [
          assetEncryptionKey,
          internalWorkerKey,
          dockerDatabase.databaseUrl,
          wechatAppSecret,
          wechatPayApiKey,
          generationProviderApiKey,
          productionE2eToken,
        ],
      ));

      const serviceDefinitions = [
        ["isolated API", resources.api, ["node", "dist/src/index.js"], apiEnvPath, port, true],
        ["independent generation worker", resources.generationWorker, ["node", "dist/src/run-generation-worker.js"], generationEnvPath],
        ["independent export worker", resources.exportWorker, ["node", "dist/src/run-export-worker.js"], exportEnvPath],
        ["independent payment reconciliation worker", resources.paymentWorker, ["node", "dist/src/run-payment-reconciliation-worker.js"], paymentEnvPath, undefined, true],
      ];
      services = [];
      for (const [label, name, command, envFilePath, hostPort, needsPaymentSecrets] of serviceDefinitions) {
        services.push(await startDockerService({
          label,
          name,
          arguments_: dockerRunArguments({
            name,
            envFilePath,
            volumeName: dockerVolume,
            imageId: candidate.imageId,
            command,
            detach: true,
            ...(needsPaymentSecrets ? { secretDirectoryPath: candidateSecretDirectory } : {}),
            ...(hostPort ? { hostPort } : {}),
            usesHostGateway: dockerDatabase.usesHostGateway,
          }),
          environment: dockerEnvironment,
          activeChildren,
          containers: dockerContainers,
          redact,
        }));
      }
    } else {
      // Source mode remains useful for ordinary development tests. It is
      // deliberately unavailable when PINDOU_RELEASE_REQUIRE_IMAGE=true.
      const migrationEnvironment = {
        ...childEnvironment,
        NODE_ENV: "production",
        PINDOU_MIGRATION_MAINTENANCE_ACKNOWLEDGED: "true",
      };
      await runStep({
        label: "Building the backend release artifact",
        arguments_: [join("node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
        environment: childEnvironment,
        activeChildren,
        timeoutMilliseconds: 120_000,
        redact,
      });
      await runStep({
        label: "Migrating the empty database to the current source schema",
        arguments_: ["dist/src/migrate.js"],
        environment: migrationEnvironment,
        activeChildren,
        timeoutMilliseconds: 180_000,
        redact,
      });
      await runStep({
        label: "Seeding the current source data",
        arguments_: ["dist/src/seed.js"],
        environment: childEnvironment,
        activeChildren,
        timeoutMilliseconds: 60_000,
        redact,
      });
      services = [
        spawnChild("isolated API", ["dist/src/index.js"], childEnvironment, activeChildren),
        spawnChild(
          "independent generation worker",
          ["dist/src/run-generation-worker.js"],
          childEnvironment,
          activeChildren,
        ),
        spawnChild(
          "independent export worker",
          ["dist/src/run-export-worker.js"],
          childEnvironment,
          activeChildren,
        ),
      ];
    }
    const manifest = await assertCurrentSchemaAndSeed(validated);
    process.stdout.write(`Verified ${manifest.count} migration checksums; latest is ${manifest.latest}.\n`);

    const [api] = services;
    const baseUrl = `http://127.0.0.1:${port}/api/v1`;
    await waitForReady({
      baseUrl,
      api,
      timeoutMilliseconds: 45_000,
      redact,
      dockerEnvironment,
      activeChildren,
    });
    for (const service of services) {
      if (service.settled) {
        throw await serviceFailure(
          service,
          await service.exitPromise,
          { dockerEnvironment, activeChildren, redact },
        );
      }
    }
    process.stdout.write(
      candidateConfiguration.mode === "image"
        ? "Production API readiness passed with independent generation, export, and payment workers alive.\n"
        : "API readiness passed with independent generation and export workers alive.\n",
    );

    const smokeEnvironment = {
      ...childEnvironment,
      E2E_BASE_URL: baseUrl,
      E2E_EXTERNAL_WORKERS: "true",
      ...(productionE2eToken
        ? {
            E2E_AUTH_TOKEN: productionE2eToken,
            E2E_PRODUCTION_CANDIDATE: "true",
          }
        : {}),
    };
    const smokeRecord = spawnChild(
      "current-schema external-worker HTTP E2E smoke",
      ["scripts/e2e-smoke.mjs"],
      smokeEnvironment,
      activeChildren,
    );
    let smokeTimer;
    const firstResult = await Promise.race([
      smokeRecord.exitPromise.then((result) => ({ kind: "smoke", record: smokeRecord, result })),
      ...services.map((service) => service.exitPromise.then((result) => ({ kind: "service", record: service, result }))),
      new Promise((resolveTimeout) => {
        smokeTimer = setTimeout(
          () => resolveTimeout({ kind: "timeout" }),
          validated.smokeTimeoutMilliseconds,
        );
      }),
    ]);
    if (smokeTimer) clearTimeout(smokeTimer);
    if (firstResult.kind === "timeout") {
      await terminateChild(smokeRecord);
      throw new Error(`Current-schema HTTP E2E smoke exceeded ${validated.smokeTimeoutMilliseconds} ms.`);
    }
    if (firstResult.kind === "service") {
      await terminateChild(smokeRecord);
      throw await serviceFailure(
        firstResult.record,
        firstResult.result,
        { dockerEnvironment, activeChildren, redact },
      );
    }
    if (firstResult.result.error || firstResult.result.signal || firstResult.result.code !== 0) {
      throw childFailure(smokeRecord, firstResult.result, redact);
    }
    for (const service of services) {
      if (service.settled) {
        throw await serviceFailure(
          service,
          await service.exitPromise,
          { dockerEnvironment, activeChildren, redact },
        );
      }
    }
    const smokeOutput = redact(smokeRecord.stdout.read()).trim();
    if (!smokeOutput.includes('"workerMode": "external-processes"')) {
      throw new Error("E2E smoke did not attest external-process worker mode.");
    }
    if (candidateConfiguration.mode === "image"
      && !smokeOutput.includes('"candidateRuntime": "production"')) {
      throw new Error("E2E smoke did not attest production candidate runtime mode.");
    }
    if (smokeOutput) process.stdout.write(`${smokeOutput}\n`);
    await assertReleaseProvenanceMatchesCurrentCheckout(candidateConfiguration);
    process.stdout.write("Current-schema HTTP + independent-worker E2E release gate passed.\n");
  } catch (error) {
    const safeError = createRedactor(releaseDatabaseRedactionSecrets(
      validated.databaseUrl,
      process.env,
    ))(error instanceof Error ? error.stack ?? error.message : String(error));
    process.stderr.write(`${safeError}\n`);
    process.exitCode = 1;
  } finally {
    const cleanupRedact = createRedactor(releaseDatabaseRedactionSecrets(
      validated.databaseUrl,
      process.env,
    ));
    for (const name of dockerContainers) {
      try {
        await removeDockerResource({
          kind: "container",
          name,
          environment: dockerEnvironment,
          activeChildren,
          redact: cleanupRedact,
        });
      } catch (error) {
        process.stderr.write(`Docker container cleanup failed: ${cleanupRedact(
          error instanceof Error ? error.message : String(error),
        )}\n`);
        process.exitCode = 1;
      }
    }
    await Promise.allSettled([...activeChildren].map((record) => terminateChild(record)));
    if (dockerVolume) {
      try {
        await removeDockerResource({
          kind: "volume",
          name: dockerVolume,
          environment: dockerEnvironment,
          activeChildren,
          redact: cleanupRedact,
        });
      } catch (error) {
        process.stderr.write(`Docker volume cleanup failed: ${cleanupRedact(
          error instanceof Error ? error.message : String(error),
        )}\n`);
        process.exitCode = 1;
      }
    }
    if (temporaryRoot) {
      try {
        assertSafeTemporaryRoot(temporaryRoot);
        await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        process.stderr.write(`Temporary storage cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    }
    if (stoppingSignal && process.exitCode === undefined) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  await main();
}
