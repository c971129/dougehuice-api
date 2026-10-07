import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PGlite } from "@electric-sql/pglite";

// @ts-ignore The release gate is intentionally kept as an executable JavaScript module.
import { PINNED_BUILTIN_PALETTE_IDS, assertPinnedBuiltinPaletteIds, createRedactor, emptyDatabaseStateSql, releaseDatabaseRedactionSecrets, retainedProcessEnvironment, validateReleaseEnvironment } from "../scripts/current-schema-e2e-release-check.mjs";
// @ts-ignore The Docker candidate helper is executable JavaScript without declarations.
import { assertDockerCandidateProvenance, createCandidateResourceNames, createDockerRuntimeEnvironment, dockerRunArguments, parseDockerImageInspection, rewriteDatabaseUrlForDocker, serializeDockerEnvFile, validateReleaseCandidateEnvironment } from "../scripts/docker-release-candidate.mjs";
// @ts-ignore The release digest helper is executable JavaScript without declarations.
import { assertReleaseProvenanceMatchesCheckoutValues, computeReleaseSourceDigest, isBackendBuildContextEntryExcluded, releaseCheckoutRevision } from "../scripts/compute-release-source-digest.mjs";

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(backendDirectory, "scripts/current-schema-e2e-release-check.mjs");
const fullScriptPath = resolve(backendDirectory, "scripts/full-postgres-release-check.mjs");
const safetyVariables = [
  "PINDOU_E2E_DATABASE_URL",
  "PINDOU_E2E_CONFIRM_DATABASE",
  "PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION",
  "PINDOU_E2E_DATABASE_SSL",
  "PINDOU_E2E_TIMEOUT_MS",
  "PINDOU_TEST_POSTGRES_URL",
  "PINDOU_TEST_POSTGRES_CONFIRM_DATABASE",
  "PINDOU_TEST_POSTGRES_ALLOW_MUTATION",
  "PINDOU_TEST_POSTGRES_DATABASE_SSL",
  "PINDOU_RELEASE_IMAGE",
  "PINDOU_RELEASE_REQUIRE_IMAGE",
  "PINDOU_RELEASE_EXPECTED_REVISION",
  "PINDOU_RELEASE_EXPECTED_SOURCE_DIGEST",
  "PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED",
] as const;
const testRevision = "1".repeat(40);
const otherTestRevision = "2".repeat(40);
const testSourceDigest = `sha256:${"3".repeat(64)}`;

function runGate(overrides: Record<string, string | undefined>, full = false) {
  const environment = { ...process.env };
  for (const name of safetyVariables) delete environment[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return spawnSync(process.execPath, [full ? fullScriptPath : scriptPath], {
    cwd: backendDirectory,
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("current-schema HTTP E2E release gate safety", () => {
  it("fails closed when an immutable Docker candidate is required but absent", () => {
    assert.throws(
      () => validateReleaseCandidateEnvironment({ PINDOU_RELEASE_REQUIRE_IMAGE: "true" }),
      /PINDOU_RELEASE_IMAGE is required/i,
    );
    assert.throws(
      () => validateReleaseCandidateEnvironment({ PINDOU_RELEASE_REQUIRE_IMAGE: "TRUE" }),
      /must be exactly true or false/i,
    );
    assert.deepEqual(validateReleaseCandidateEnvironment({}), {
      mode: "source",
      requireImage: false,
    });
    assert.deepEqual(validateReleaseCandidateEnvironment({
      PINDOU_RELEASE_REQUIRE_IMAGE: "true",
      PINDOU_RELEASE_IMAGE: "pindou-backend:candidate",
      PINDOU_RELEASE_EXPECTED_REVISION: testRevision,
      PINDOU_RELEASE_EXPECTED_SOURCE_DIGEST: testSourceDigest,
    }), {
      mode: "image",
      imageReference: "pindou-backend:candidate",
      requireImage: true,
      expectedRevision: testRevision,
      expectedSourceDigest: testSourceDigest,
    });
    assert.throws(
      () => validateReleaseCandidateEnvironment({
        PINDOU_RELEASE_IMAGE: "pindou-backend:candidate",
      }),
      /PINDOU_RELEASE_EXPECTED_REVISION is required/i,
    );
    assert.throws(
      () => validateReleaseCandidateEnvironment({
        PINDOU_RELEASE_IMAGE: "pindou-backend:candidate",
        PINDOU_RELEASE_EXPECTED_REVISION: "unknown",
        PINDOU_RELEASE_EXPECTED_SOURCE_DIGEST: "unknown",
      }),
      /full 40- or 64-hex commit ID/i,
    );

    const missingImage = runGate({
      PINDOU_E2E_DATABASE_URL: "postgresql://user:do-not-print@127.0.0.1:1/pindou_e2e_release",
      PINDOU_E2E_CONFIRM_DATABASE: "pindou_e2e_release",
      PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION: "true",
      PINDOU_RELEASE_REQUIRE_IMAGE: "true",
    });
    assert.equal(missingImage.status, 1);
    assert.match(missingImage.stderr, /PINDOU_RELEASE_IMAGE is required/i);
    assert.doesNotMatch(missingImage.stderr, /ECONNREFUSED|do-not-print/i);

    const missingProvenance = runGate({
      PINDOU_E2E_DATABASE_URL: "postgresql://user:do-not-print@127.0.0.1:1/pindou_e2e_release",
      PINDOU_E2E_CONFIRM_DATABASE: "pindou_e2e_release",
      PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION: "true",
      PINDOU_RELEASE_REQUIRE_IMAGE: "true",
      PINDOU_RELEASE_IMAGE: "pindou-backend:candidate",
    });
    assert.equal(missingProvenance.status, 1);
    assert.match(missingProvenance.stderr, /PINDOU_RELEASE_EXPECTED_REVISION is required/i);
    assert.doesNotMatch(missingProvenance.stderr, /ECONNREFUSED|do-not-print/i);
  });

  it("builds a credential-safe immutable Docker subprocess configuration", () => {
    const original = "postgresql://release-user:super-secret@127.0.0.1:54329/pindou_e2e_release";
    const rewritten = rewriteDatabaseUrlForDocker(original);
    assert.equal(rewritten.usesHostGateway, true);
    assert.equal(new URL(rewritten.databaseUrl).hostname, "host.docker.internal");
    assert.equal(new URL(rewritten.databaseUrl).port, "54329");
    assert.deepEqual(
      rewriteDatabaseUrlForDocker("postgresql://release-user@db.example.test:5432/pindou_e2e_release"),
      {
        databaseUrl: "postgresql://release-user@db.example.test:5432/pindou_e2e_release",
        usesHostGateway: false,
      },
    );

    const imageId = `sha256:${"a".repeat(64)}`;
    const candidate = parseDockerImageInspection(JSON.stringify([{
      Id: imageId,
      Config: {
        Labels: {
          "org.opencontainers.image.revision": testRevision,
          "io.pindou.source-digest": testSourceDigest,
        },
        Env: [
          `PINDOU_BUILD_REVISION=${testRevision}`,
          `PINDOU_SOURCE_DIGEST=${testSourceDigest}`,
        ],
      },
    }]));
    assert.equal(candidate.imageId, imageId);
    assert.doesNotThrow(() => assertDockerCandidateProvenance(candidate, {
      expectedRevision: testRevision,
      expectedSourceDigest: testSourceDigest,
    }));
    assert.throws(
      () => assertDockerCandidateProvenance(candidate, {
        expectedRevision: otherTestRevision,
        expectedSourceDigest: testSourceDigest,
      }),
      /do not exactly match/i,
    );
    assert.throws(
      () => parseDockerImageInspection(JSON.stringify([{ Id: "pindou:latest", Config: {} }])),
      /immutable sha256 image ID/i,
    );

    const runtime = createDockerRuntimeEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: original,
      ASSET_STORAGE_ROOT: "C:\\host\\private-assets",
      PGPASSWORD: "ambient-secret",
      PATH: "C:\\host-bin",
    }, rewritten.databaseUrl);
    assert.equal(runtime.DATABASE_URL, rewritten.databaseUrl);
    assert.equal(runtime.ASSET_STORAGE_ROOT, "/app/.data/private-assets");
    assert.equal(runtime.HOST, "0.0.0.0");
    assert.equal(runtime.PGPASSWORD, "ambient-secret");
    assert.equal(runtime.PATH, undefined);

    const resources = createCandidateResourceNames("0123456789abcdef");
    assert.equal(resources.paymentWorker, "pindou-release-0123456789abcdef-payment");
    const envFilePath = "C:\\secure-temp\\candidate.env";
    const secretDirectoryPath = "C:\\secure-temp\\candidate-secrets";
    const arguments_ = dockerRunArguments({
      name: resources.api,
      envFilePath,
      volumeName: resources.volume,
      imageId,
      command: ["node", "dist/src/index.js"],
      detach: true,
      hostPort: 48787,
      usesHostGateway: true,
      secretDirectoryPath,
    });
    assert.equal(arguments_[0], "run");
    assert.ok(arguments_.includes(imageId));
    assert.ok(arguments_.includes(envFilePath));
    assert.ok(arguments_.includes("host.docker.internal:host-gateway"));
    assert.ok(arguments_.includes("127.0.0.1:48787:8787"));
    assert.ok(arguments_.includes(`type=bind,src=${secretDirectoryPath},dst=/app/.release-secrets,readonly`));
    assert.doesNotMatch(arguments_.join(" "), /super-secret|ambient-secret/);
    const envFile = serializeDockerEnvFile(runtime);
    assert.match(envFile, /DATABASE_URL=postgresql:\/\/release-user:super-secret@host\.docker\.internal:54329/);
    assert.match(envFile, /PGPASSWORD=ambient-secret/);
    assert.throws(
      () => dockerRunArguments({
        name: resources.api,
        envFilePath,
        volumeName: resources.volume,
        imageId: "pindou-backend:latest",
        command: ["node", "dist/src/index.js"],
      }),
      /immutable sha256 image ID/i,
    );
  });

  it("computes a stable sha256 digest for the Docker release source inputs", async () => {
    const first = await computeReleaseSourceDigest();
    const second = await computeReleaseSourceDigest();
    assert.match(first, /^sha256:[a-f0-9]{64}$/);
    assert.equal(second, first);
    const revision = await releaseCheckoutRevision();
    assert.match(revision, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i);
    const imageConfiguration = {
      mode: "image",
      expectedRevision: revision,
      expectedSourceDigest: first,
    };
    assert.deepEqual(
      assertReleaseProvenanceMatchesCheckoutValues(imageConfiguration, {
        revision,
        sourceDigest: first,
      }),
      { revision, sourceDigest: first },
    );
    assert.throws(
      () => assertReleaseProvenanceMatchesCheckoutValues(imageConfiguration, {
        revision,
        sourceDigest: testSourceDigest,
      }),
      /does not exactly match the current checkout build inputs/i,
    );
    for (const secretPath of [
      "private.merchant.key",
      "PRIVATE.merchant.KEY",
      "wechat/platform.pem",
      "nested/deeper/verifier.PEM",
      ".env",
      ".env.production",
      ".env.staging",
      ".env.test.local",
      ".ENV.secret",
      ".env.production.example",
      "secrets",
      ".data",
    ]) {
      const directory = secretPath === "secrets" || secretPath === ".data";
      assert.equal(
        isBackendBuildContextEntryExcluded(secretPath, directory),
        true,
        `${secretPath} must stay outside both the Docker context and provenance digest`,
      );
    }
    assert.equal(isBackendBuildContextEntryExcluded("src/config.ts"), false);
    assert.equal(isBackendBuildContextEntryExcluded("migrations/0054_probe.sql"), false);
    const dockerIgnore = readFileSync(resolve(backendDirectory, "../.dockerignore"), "utf8");
    assert.match(dockerIgnore, /^\*\*$/m);
    for (const includedInput of [
      "!.dockerignore",
      "!package.json",
      "!pnpm-lock.yaml",
      "!pnpm-workspace.yaml",
      "!backend",
      "!backend/**",
    ]) {
      assert.ok(dockerIgnore.split(/\r?\n/).includes(includedInput));
    }
    assert.match(dockerIgnore, /^backend\/\.env\*$/m);
    assert.match(dockerIgnore, /^backend\/\.\[eE\]\[nN\]\[vV\]\*$/m);
    assert.match(dockerIgnore, /^backend\/private\.\*\.key$/m);
    assert.match(dockerIgnore, /^backend\/\[pP\].*\[kK\]\[eE\]\[yY\]$/m);
    assert.match(dockerIgnore, /^backend\/\*\.pem$/m);
    assert.match(dockerIgnore, /^backend\/\*\*\/\*\.pem$/m);
    const dockerfile = readFileSync(resolve(backendDirectory, "Dockerfile"), "utf8");
    assert.match(dockerfile, /FROM node:24-bookworm-slim AS build[\s\S]*ARG PINDOU_SOURCE_DIGEST=unknown/);
    assert.match(dockerfile, /COPY \.dockerignore package\.json pnpm-lock\.yaml pnpm-workspace\.yaml/);
    assert.match(
      dockerfile,
      /actual_source_digest="\$\(node backend\/scripts\/compute-release-source-digest\.mjs\)"[\s\S]*actual_source_digest" != "\$PINDOU_SOURCE_DIGEST"/,
    );
    const currentGateSource = readFileSync(scriptPath, "utf8");
    const fullGateSource = readFileSync(fullScriptPath, "utf8");
    assert.ok(
      (currentGateSource.match(/assertReleaseProvenanceMatchesCurrentCheckout\(candidateConfiguration\)/g) ?? []).length >= 2,
      "standalone image gate must attest the checkout both before work and before success",
    );
    assert.ok(
      (fullGateSource.match(/assertReleaseProvenanceMatchesCurrentCheckout\(candidateConfiguration\)/g) ?? []).length >= 2,
      "full image gate must attest the checkout both before phases and before success",
    );
  });

  it("requires exactly the five active pinned MARD reference palettes", () => {
    assert.doesNotThrow(() => assertPinnedBuiltinPaletteIds([...PINNED_BUILTIN_PALETTE_IDS]));
    assert.throws(
      () => assertPinnedBuiltinPaletteIds(PINNED_BUILTIN_PALETTE_IDS.slice(0, 4)),
      /exactly match the five pinned MARD reference catalogs/i,
    );
    assert.throws(
      () => assertPinnedBuiltinPaletteIds([...PINNED_BUILTIN_PALETTE_IDS, "mard-basic-v1"]),
      /exactly match the five pinned MARD reference catalogs/i,
    );
  });

  it("fails closed instead of inheriting DATABASE_URL when its isolated URL is absent", () => {
    const result = runGate({ DATABASE_URL: "postgresql://user:secret@example.test/production" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PINDOU_E2E_DATABASE_URL is required.*refusing/i);
    assert.doesNotMatch(result.stderr, /secret/);
  });

  it("rejects non-PostgreSQL and production-like database targets before connecting", () => {
    const wrongProtocol = runGate({
      PINDOU_E2E_DATABASE_URL: "https://example.test/pindou_e2e",
      PINDOU_E2E_CONFIRM_DATABASE: "pindou_e2e",
      PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION: "true",
    });
    assert.equal(wrongProtocol.status, 1);
    assert.match(wrongProtocol.stderr, /postgres:.*postgresql:/i);

    const queryOverride = runGate({
      PINDOU_E2E_DATABASE_URL: "postgresql://user:do-not-print@127.0.0.1:5432/pindou_e2e_release?host=production.example.test",
      PINDOU_E2E_CONFIRM_DATABASE: "pindou_e2e_release",
      PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION: "true",
    });
    assert.equal(queryOverride.status, 1);
    assert.match(queryOverride.stderr, /must not contain query parameters/i);
    assert.doesNotMatch(queryOverride.stderr, /do-not-print/);

    const productionName = runGate({
      PINDOU_E2E_DATABASE_URL: "postgresql://user:do-not-print@example.test:5432/pindou",
      PINDOU_E2E_CONFIRM_DATABASE: "pindou",
      PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION: "true",
    });
    assert.equal(productionName.status, 1);
    assert.match(productionName.stderr, /standalone e2e or test marker/i);
    assert.doesNotMatch(productionName.stderr, /do-not-print/);

    for (const [target, expected] of [
      ["postgresql:///pindou_e2e_release", /explicit database host/i],
      ["postgresql://example.test:5432/pindou_e2e_release", /explicit database user/i],
      ["postgresql://user@example.test/pindou_e2e_release", /explicit database port/i],
      ["postgresql://user@example.test:5432", /exactly one database/i],
      ["postgresql://user@example.test:5432/first/second", /exactly one database/i],
      ["postgresql://user@example.test:5432/first%2Fsecond", /invalid database name/i],
    ] as const) {
      const incomplete = runGate({
        PINDOU_E2E_DATABASE_URL: target,
        PGPORT: "6543",
      });
      assert.equal(incomplete.status, 1);
      assert.match(incomplete.stderr, expected);
      assert.doesNotMatch(incomplete.stdout, /Migrating the empty database/i);
    }
  });

  it("accepts a passwordless URL only when host, user, port, and database are explicit", () => {
    assert.deepEqual(validateReleaseEnvironment({
      PINDOU_E2E_DATABASE_URL: "postgresql://user@example.test:5432/pindou_e2e_release",
      PINDOU_E2E_CONFIRM_DATABASE: "pindou_e2e_release",
      PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION: "true",
      PINDOU_E2E_DATABASE_SSL: "true",
      PGPORT: "6543",
    }), {
      databaseUrl: "postgresql://user@example.test:5432/pindou_e2e_release",
      databaseName: "pindou_e2e_release",
      databaseSsl: true,
      smokeTimeoutMilliseconds: 240_000,
    });
  });

  it("requires the dedicated TLS flag for every non-loopback E2E database", () => {
    for (const databaseSsl of [undefined, "false"] as const) {
      assert.throws(
        () => validateReleaseEnvironment({
          PINDOU_E2E_DATABASE_URL: "postgresql://user:remote-secret@example.test:5432/pindou_e2e_release",
          PINDOU_E2E_CONFIRM_DATABASE: "pindou_e2e_release",
          PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION: "true",
          PINDOU_E2E_DATABASE_SSL: databaseSsl,
          PGSSLMODE: "require",
        }),
        /PINDOU_E2E_DATABASE_SSL must be exactly true.*non-loopback/i,
      );
    }
    assert.equal(validateReleaseEnvironment({
      PINDOU_E2E_DATABASE_URL: "postgresql://user@127.0.0.1:5432/pindou_e2e_release",
      PINDOU_E2E_CONFIRM_DATABASE: "pindou_e2e_release",
      PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION: "true",
      PGSSLMODE: "require",
    }).databaseSsl, false, "ambient PGSSLMODE must not override the explicit loopback policy");
  });

  it("preserves only the password credential for passwordless child connections and redacts it", () => {
    const password = "ambient-release-password-do-not-print";
    const retained = retainedProcessEnvironment({
      PGPASSWORD: password,
      PGHOST: "production.example.test",
      PGPORT: "6543",
      PGUSER: "wrong-user",
      PGDATABASE: "production",
      PGSERVICE: "production-service",
      PGSERVICEFILE: "production-service-file",
      PGPASSFILE: "production-password-file",
      PGSSLMODE: "disable",
      PGOPTIONS: "-c search_path=production",
    });

    assert.equal(retained.PGPASSWORD, password);
    for (const targetVariable of [
      "PGHOST",
      "PGPORT",
      "PGUSER",
      "PGDATABASE",
      "PGSERVICE",
      "PGSERVICEFILE",
      "PGPASSFILE",
      "PGSSLMODE",
      "PGOPTIONS",
    ]) {
      assert.equal(retained[targetVariable], undefined, targetVariable);
    }

    const databaseUrl = "postgresql://release-user@example.test:5432/pindou_e2e_release";
    const redact = createRedactor(releaseDatabaseRedactionSecrets(
      databaseUrl,
      { PGPASSWORD: password },
    ));
    assert.equal(
      redact(`connection failed for ${databaseUrl} with password ${password}`),
      "connection failed for [REDACTED] with password [REDACTED]",
    );
  });

  it("treats a user-defined composite type as non-empty database state", async () => {
    const database = new PGlite();
    try {
      await database.exec("CREATE TYPE public.release_gate_probe AS (value integer)");
      const state = await database.query<{
        relation_count: number;
        routine_count: number;
        user_type_count: number;
      }>(emptyDatabaseStateSql);
      assert.equal(state.rows[0]?.relation_count, 0);
      assert.equal(state.rows[0]?.routine_count, 0);
      assert.ok(
        Number(state.rows[0]?.user_type_count) > 0,
        "CREATE TYPE ... AS must make the current-schema target non-empty",
      );
    } finally {
      await database.close();
    }
  });

  it("requires both an exact database-name confirmation and an explicit migration acknowledgement", () => {
    const target = "postgresql://user:do-not-print@127.0.0.1:1/pindou_e2e_release";
    const missingNameConfirmation = runGate({
      PINDOU_E2E_DATABASE_URL: target,
      PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION: "true",
    });
    assert.equal(missingNameConfirmation.status, 1);
    assert.match(missingNameConfirmation.stderr, /CONFIRM_DATABASE.*exactly equal/i);

    const missingAcknowledgement = runGate({
      PINDOU_E2E_DATABASE_URL: target,
      PINDOU_E2E_CONFIRM_DATABASE: "pindou_e2e_release",
    });
    assert.equal(missingAcknowledgement.status, 1);
    assert.match(missingAcknowledgement.stderr, /ALLOW_EMPTY_DATABASE_MIGRATION.*exactly true/i);
  });

  it("validates all full-gate inputs before running the four regression checks", () => {
    const result = runGate({
      PINDOU_TEST_POSTGRES_URL: "postgresql://user:secret@127.0.0.1:1/pindou_test_regression",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_regression",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
    }, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PINDOU_E2E_DATABASE_URL is required/i);
    assert.doesNotMatch(result.stdout, /running real PostgreSQL release check/i);
    assert.doesNotMatch(result.stderr, /secret/);
  });

  it("makes the full wrapper enforce and forward the Docker candidate requirement", () => {
    const result = runGate({
      PINDOU_TEST_POSTGRES_URL: "postgresql://user:test-secret@127.0.0.1:1/pindou_test_regression",
      PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_regression",
      PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
      PINDOU_E2E_DATABASE_URL: "postgresql://user:e2e-secret@127.0.0.1:1/pindou_e2e_release",
      PINDOU_E2E_CONFIRM_DATABASE: "pindou_e2e_release",
      PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION: "true",
      PINDOU_RELEASE_REQUIRE_IMAGE: "true",
    }, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PINDOU_RELEASE_IMAGE is required/i);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ECONNREFUSED|test-secret|e2e-secret/i);
    assert.doesNotMatch(result.stdout, /running four real PostgreSQL regression gates/i);
  });

  it("rejects a dirty image checkout before any database connection", async () => {
    const revision = await releaseCheckoutRevision();
    const dirtyProbe = resolve(backendDirectory, `.release-dirty-probe-${process.pid}`);
    writeFileSync(dirtyProbe, "release gate dirty checkout probe\n", "utf8");
    try {
      const result = runGate({
        PINDOU_TEST_POSTGRES_URL: "postgresql://user:test-secret@127.0.0.1:1/pindou_test_regression",
        PINDOU_TEST_POSTGRES_CONFIRM_DATABASE: "pindou_test_regression",
        PINDOU_TEST_POSTGRES_ALLOW_MUTATION: "true",
        PINDOU_E2E_DATABASE_URL: "postgresql://user:e2e-secret@127.0.0.1:1/pindou_e2e_release",
        PINDOU_E2E_CONFIRM_DATABASE: "pindou_e2e_release",
        PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION: "true",
        PINDOU_RELEASE_REQUIRE_IMAGE: "true",
        PINDOU_RELEASE_IMAGE: "pindou-backend:stale-candidate",
        PINDOU_RELEASE_EXPECTED_REVISION: revision,
        PINDOU_RELEASE_EXPECTED_SOURCE_DIGEST: testSourceDigest,
      }, true);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /requires a clean Git checkout/i);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ECONNREFUSED|test-secret|e2e-secret/i);
      assert.doesNotMatch(result.stdout, /running four real PostgreSQL regression gates/i);
    } finally {
      rmSync(dirtyProbe, { force: true });
    }
  });
});
