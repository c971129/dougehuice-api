// @ts-expect-error The release-safety module is executable JavaScript without a declaration file.
import { assertRegressionDatabaseIsIsolated, isRegressionDatabaseBusyError, redactReleaseMessage, releaseDatabaseSecrets, strictDatabaseSslOptions, validateRegressionReleaseEnvironment } from "../../scripts/postgres-release-safety.mjs";

export type RealPostgresRequirementFlag =
  | "PINDOU_REQUIRE_REAL_POSTGRES_RELEASE"
  | "PINDOU_REQUIRE_REAL_POSTGRES_LOCK_ORDER";

export interface DisabledRealPostgresTestConfig {
  enabled: false;
  skipReason: string;
}

export interface EnabledRealPostgresTestConfig {
  enabled: true;
  databaseUrl: string;
  databaseName: string;
  databaseSsl: boolean;
  poolSsl: { rejectUnauthorized: true } | false;
}

export type RealPostgresTestConfig =
  | DisabledRealPostgresTestConfig
  | EnabledRealPostgresTestConfig;

interface RealPostgresTestPreflightOptions {
  assertIsolated?: (configuration: EnabledRealPostgresTestConfig) => Promise<void>;
  retryWindowMilliseconds?: number;
  retryDelayMilliseconds?: number;
}

const defaultRequirementFlags = ["PINDOU_REQUIRE_REAL_POSTGRES_RELEASE"] as const;
const defaultPreflightRetryWindowMilliseconds = 2_000;
const defaultPreflightRetryDelayMilliseconds = 50;

/**
 * Keep ordinary test runs inert even when a developer or CI host happens to
 * expose a PostgreSQL URL. Only an exact opt-in flag enables the destructive
 * integration test; once enabled, the complete release-gate validation is
 * mandatory and fails closed before a test is registered against the target.
 * This helper is synchronous and never opens a socket.
 */
export function loadRealPostgresTestConfig(
  environment: NodeJS.ProcessEnv = process.env,
  requirementFlags: readonly RealPostgresRequirementFlag[] = defaultRequirementFlags,
): RealPostgresTestConfig {
  const enabled = requirementFlags.some((flag) => environment[flag] === "true");
  if (!enabled) {
    return {
      enabled: false,
      skipReason: `run the fail-closed PostgreSQL release wrapper (it sets ${requirementFlags.join(" or ")} to exactly true)`,
    };
  }

  const configuration = validateRegressionReleaseEnvironment(environment) as {
    databaseUrl: string;
    databaseName: string;
    databaseSsl: boolean;
  };
  return {
    enabled: true,
    ...configuration,
    poolSsl: strictDatabaseSslOptions(configuration.databaseSsl) as
      | { rejectUnauthorized: true }
      | false,
  };
}

/**
 * Re-run the server-identity and zero-other-connections preflight immediately
 * before each integration test constructs its own Pool. The release wrapper's
 * earlier check is intentionally not treated as sufficient because another
 * connection could appear between processes.
 */
export async function assertRealPostgresTestDatabaseIsIsolated(
  configuration: EnabledRealPostgresTestConfig,
  options: RealPostgresTestPreflightOptions = {},
): Promise<void> {
  const assertIsolated = options.assertIsolated ?? assertRegressionDatabaseIsIsolated;
  const retryWindowMilliseconds = options.retryWindowMilliseconds
    ?? defaultPreflightRetryWindowMilliseconds;
  const retryDelayMilliseconds = options.retryDelayMilliseconds
    ?? defaultPreflightRetryDelayMilliseconds;
  const deadline = Date.now() + retryWindowMilliseconds;

  while (true) {
    try {
      await assertIsolated(configuration);
      return;
    } catch (error) {
      const remainingMilliseconds = deadline - Date.now();
      if (isRegressionDatabaseBusyError(error) && remainingMilliseconds > 0) {
        await new Promise((resolve) => setTimeout(
          resolve,
          Math.min(retryDelayMilliseconds, remainingMilliseconds),
        ));
        continue;
      }

      const message = redactReleaseMessage(
        error instanceof Error ? error.message : String(error),
        releaseDatabaseSecrets(configuration.databaseUrl),
      );
      const sanitizedError = new Error(message);
      sanitizedError.name = "RealPostgresTestPreflightError";
      throw sanitizedError;
    }
  }
}
