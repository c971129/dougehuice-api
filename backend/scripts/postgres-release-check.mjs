import { fileURLToPath } from "node:url";

import {
  assertRegressionDatabaseIsIsolated,
  redactReleaseMessage,
  releaseDatabaseSecrets,
  runBoundedNodeCommand,
  validateRegressionReleaseEnvironment,
} from "./postgres-release-safety.mjs";

const specializedCheckTimeoutMilliseconds = 10 * 60_000;

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
const checks = [
  {
    name: "payment lock order",
    file: "test/postgres-asset-project-lock-order.integration.test.ts",
  },
  {
    name: "export lease recovery and index plan",
    file: "test/postgres-export-lease-recovery.integration.test.ts",
  },
  {
    name: "generation lease recovery, refunds, and fencing",
    file: "test/postgres-generation-lease-recovery.integration.test.ts",
  },
  {
    name: "pool and lock timeouts",
    file: "test/postgres-pool-timeouts.integration.test.ts",
  },
];

for (const check of checks) {
  process.stdout.write(`running real PostgreSQL release check: ${check.name}\n`);
  const outcome = await runBoundedNodeCommand({
    label: `PostgreSQL ${check.name} check`,
    arguments_: ["--import", "tsx", "--test", check.file],
    cwd: backendDirectory,
    environment: {
      ...process.env,
      PINDOU_TEST_POSTGRES_URL: configuration.databaseUrl,
      PINDOU_REQUIRE_REAL_POSTGRES_RELEASE: "true",
      PINDOU_REQUIRE_REAL_POSTGRES_LOCK_ORDER: "true",
    },
    timeoutMilliseconds: specializedCheckTimeoutMilliseconds,
  });
  if (!outcome.passed) {
    process.stderr.write(`${outcome.message}\n`);
    process.exit(1);
  }
}

process.stdout.write("all real PostgreSQL release checks passed\n");
