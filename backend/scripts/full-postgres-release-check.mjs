import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  databaseIdentity,
  validateReleaseEnvironment,
} from "./current-schema-e2e-release-check.mjs";
import { validateReleaseCandidateEnvironment } from "./docker-release-candidate.mjs";
import { assertReleaseProvenanceMatchesCurrentCheckout } from "./compute-release-source-digest.mjs";
import {
  assertRegressionDatabaseIsIsolated,
  redactReleaseMessage,
  releaseDatabaseSecrets,
  runBoundedNodeCommand,
  validateRegressionReleaseEnvironment,
} from "./postgres-release-safety.mjs";

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const regressionPhaseTimeoutMilliseconds = 60 * 60_000;

let regressionConfiguration;
let e2eConfiguration;
let candidateConfiguration;
try {
  regressionConfiguration = validateRegressionReleaseEnvironment(process.env);
  e2eConfiguration = validateReleaseEnvironment(process.env);
  candidateConfiguration = validateReleaseCandidateEnvironment(process.env);
  await assertReleaseProvenanceMatchesCurrentCheckout(candidateConfiguration);
  if (databaseIdentity(regressionConfiguration.databaseUrl) === databaseIdentity(e2eConfiguration.databaseUrl)) {
    throw new Error(
      "PINDOU_TEST_POSTGRES_URL and PINDOU_E2E_DATABASE_URL must identify two different databases.",
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

try {
  await assertRegressionDatabaseIsIsolated(regressionConfiguration);
} catch (error) {
  const message = redactReleaseMessage(
    error instanceof Error ? error.message : String(error),
    releaseDatabaseSecrets(regressionConfiguration.databaseUrl),
  );
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

for (const [label, script, timeoutMilliseconds] of [
  [
    "four real PostgreSQL regression gates",
    "scripts/postgres-release-check.mjs",
    regressionPhaseTimeoutMilliseconds,
  ],
  [
    "current-schema HTTP + independent-worker E2E gate",
    "scripts/current-schema-e2e-release-check.mjs",
    e2eConfiguration.smokeTimeoutMilliseconds + 8 * 60_000,
  ],
]) {
  process.stdout.write(`running ${label}\n`);
  const outcome = await runBoundedNodeCommand({
    label,
    arguments_: [script],
    cwd: backendDirectory,
    environment: process.env,
    timeoutMilliseconds,
  });
  if (!outcome.passed) {
    process.stderr.write(`${outcome.message}\n`);
    process.exit(1);
  }
}

try {
  await assertReleaseProvenanceMatchesCurrentCheckout(candidateConfiguration);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

process.stdout.write("all PostgreSQL regression and current-schema E2E release gates passed\n");
