import { fileURLToPath } from "node:url";

import {
  assertRegressionDatabaseIsIsolated,
  redactReleaseMessage,
  releaseDatabaseSecrets,
  runBoundedNodeCommand,
  validateRegressionReleaseEnvironment,
} from "./postgres-release-safety.mjs";

const paymentCheckTimeoutMilliseconds = 10 * 60_000;

let configuration;
try {
  configuration = validateRegressionReleaseEnvironment(process.env);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

try {
  process.stdout.write("validating explicitly confirmed isolated PostgreSQL regression database\n");
  await assertRegressionDatabaseIsIsolated(configuration);
} catch (error) {
  const message = redactReleaseMessage(
    error instanceof Error ? error.message : String(error),
    releaseDatabaseSecrets(configuration.databaseUrl),
  );
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const backendDirectory = fileURLToPath(new URL("../", import.meta.url));
const outcome = await runBoundedNodeCommand({
  label: "PostgreSQL lock-order release check",
  arguments_: ["--import", "tsx", "--test", "test/postgres-asset-project-lock-order.integration.test.ts"],
  cwd: backendDirectory,
  environment: {
    ...process.env,
    PINDOU_TEST_POSTGRES_URL: configuration.databaseUrl,
    PINDOU_REQUIRE_REAL_POSTGRES_RELEASE: "false",
    PINDOU_REQUIRE_REAL_POSTGRES_LOCK_ORDER: "true",
  },
  timeoutMilliseconds: paymentCheckTimeoutMilliseconds,
});
if (!outcome.passed) {
  process.stderr.write(`${outcome.message}\n`);
  process.exit(1);
}

process.exit(0);
