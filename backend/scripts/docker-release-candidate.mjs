import { randomBytes } from "node:crypto";

export const releaseImageFlag = "PINDOU_RELEASE_IMAGE";
export const requireReleaseImageFlag = "PINDOU_RELEASE_REQUIRE_IMAGE";
export const expectedReleaseRevisionFlag = "PINDOU_RELEASE_EXPECTED_REVISION";
export const expectedReleaseSourceDigestFlag = "PINDOU_RELEASE_EXPECTED_SOURCE_DIGEST";
export const dockerBridgeReleaseAcknowledgementFlag =
  "PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED";

const immutableImageIdPattern = /^sha256:[a-f0-9]{64}$/;
const dockerResourceNamePattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const buildRevisionLabel = "org.opencontainers.image.revision";
const sourceDigestLabel = "io.pindou.source-digest";

function fail(message) {
  const error = new Error(message);
  error.name = "ReleaseGateConfigurationError";
  throw error;
}

function exactOptionalBoolean(name, value) {
  if (value === undefined || value.trim() === "") return false;
  if (value !== "true" && value !== "false") fail(`${name} must be exactly true or false.`);
  return value === "true";
}

export function validateReleaseCandidateEnvironment(environment = process.env) {
  const requireImage = exactOptionalBoolean(
    requireReleaseImageFlag,
    environment[requireReleaseImageFlag],
  );
  const imageReference = environment[releaseImageFlag]?.trim();
  if (requireImage && !imageReference) {
    fail(`${releaseImageFlag} is required when ${requireReleaseImageFlag}=true.`);
  }
  if (imageReference && (imageReference.startsWith("-") || /\s|\0/.test(imageReference))) {
    fail(`${releaseImageFlag} contains an unsafe image reference.`);
  }
  if (!imageReference) return { mode: "source", requireImage };

  const expectedRevision = environment[expectedReleaseRevisionFlag]?.trim();
  const expectedSourceDigest = environment[expectedReleaseSourceDigestFlag]?.trim();
  for (const [name, value] of [
    [expectedReleaseRevisionFlag, expectedRevision],
    [expectedReleaseSourceDigestFlag, expectedSourceDigest],
  ]) {
    if (!value) fail(`${name} is required when ${releaseImageFlag} is set.`);
    if (value.length > 256 || /[\r\n\0]/.test(value)) fail(`${name} contains an invalid value.`);
  }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(expectedRevision)) {
    fail(`${expectedReleaseRevisionFlag} must be a full 40- or 64-hex commit ID.`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedSourceDigest)) {
    fail(`${expectedReleaseSourceDigestFlag} must be a lowercase sha256 digest.`);
  }
  return { mode: "image", imageReference, requireImage, expectedRevision, expectedSourceDigest };
}

export function rewriteDatabaseUrlForDocker(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const usesHostGateway = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (usesHostGateway) parsed.hostname = "host.docker.internal";
  return { databaseUrl: parsed.toString(), usesHostGateway };
}

export function parseDockerImageInspection(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail("Docker image inspection did not return valid JSON.");
  }
  const image = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
  const imageId = image?.Id;
  if (typeof imageId !== "string" || !immutableImageIdPattern.test(imageId)) {
    fail("Docker image inspection did not resolve exactly one immutable sha256 image ID.");
  }
  const labels = image?.Config?.Labels;
  const environment = Array.isArray(image?.Config?.Env) ? image.Config.Env : [];
  const revision = typeof labels?.[buildRevisionLabel] === "string"
    ? labels[buildRevisionLabel]
    : undefined;
  const sourceDigest = typeof labels?.[sourceDigestLabel] === "string"
    ? labels[sourceDigestLabel]
    : undefined;
  if (!revision || !sourceDigest) {
    fail(`Docker candidate must contain ${buildRevisionLabel} and ${sourceDigestLabel} labels.`);
  }
  if (!environment.includes(`PINDOU_BUILD_REVISION=${revision}`)
    || !environment.includes(`PINDOU_SOURCE_DIGEST=${sourceDigest}`)) {
    fail("Docker candidate build provenance labels and runtime environment do not match.");
  }
  return { imageId, revision, sourceDigest };
}

export function serializeDockerEnvFile(environment) {
  return Object.entries(environment)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) fail(`Invalid Docker environment name: ${name}.`);
      const text = String(value);
      if (/[\r\n\0]/.test(text)) fail(`Docker environment value ${name} contains a control character.`);
      return `${name}=${text}`;
    })
    .join("\n") + "\n";
}

export function createDockerRuntimeEnvironment(childEnvironment, dockerDatabaseUrl) {
  const omittedHostVariables = new Set([
    "SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "TMPDIR",
    "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "LANG", "LC_ALL", "TZ",
  ]);
  const result = {};
  for (const [name, value] of Object.entries(childEnvironment)) {
    if (!omittedHostVariables.has(name) && value !== undefined) result[name] = value;
  }
  return {
    ...result,
    DOTENV_CONFIG_PATH: "/dev/null",
    HOST: "0.0.0.0",
    PORT: "8787",
    DATABASE_URL: dockerDatabaseUrl,
    ASSET_STORAGE_ROOT: "/app/.data/private-assets",
  };
}

export function createCandidateResourceNames(suffix = randomBytes(8).toString("hex")) {
  if (!/^[a-f0-9]{16}$/.test(suffix)) fail("Docker release resource suffix must be 16 lowercase hex characters.");
  const prefix = `pindou-release-${suffix}`;
  return {
    volume: `${prefix}-assets`,
    migration: `${prefix}-migration`,
    seed: `${prefix}-seed`,
    api: `${prefix}-api`,
    generationWorker: `${prefix}-generation`,
    exportWorker: `${prefix}-export`,
    paymentWorker: `${prefix}-payment`,
  };
}

function assertDockerResourceName(name) {
  if (!dockerResourceNamePattern.test(name)) fail(`Unsafe Docker resource name: ${name}.`);
}

export function dockerRunArguments({
  name,
  envFilePath,
  volumeName,
  imageId,
  command,
  detach = false,
  remove = false,
  hostPort,
  usesHostGateway = false,
  secretDirectoryPath,
}) {
  assertDockerResourceName(name);
  assertDockerResourceName(volumeName);
  if (!immutableImageIdPattern.test(imageId)) fail("Docker run requires an immutable sha256 image ID.");
  if (!envFilePath || /[\r\n\0]/.test(envFilePath)) fail("Docker run requires a safe environment-file path.");
  if (secretDirectoryPath && /[\r\n\0,]/.test(secretDirectoryPath)) {
    fail("Docker run requires a safe secret-directory path.");
  }
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => /[\r\n\0]/.test(part))) {
    fail("Docker run requires a non-empty safe command array.");
  }
  if (hostPort !== undefined
    && (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65_535)) {
    fail("Docker host port must be between 1 and 65535.");
  }

  const arguments_ = ["run"];
  if (detach) arguments_.push("--detach");
  if (remove) arguments_.push("--rm");
  arguments_.push("--name", name, "--env-file", envFilePath);
  if (usesHostGateway) arguments_.push("--add-host", "host.docker.internal:host-gateway");
  if (hostPort !== undefined) arguments_.push("--publish", `127.0.0.1:${hostPort}:8787`);
  arguments_.push(
    "--mount",
    `type=volume,src=${volumeName},dst=/app/.data/private-assets`,
    ...(secretDirectoryPath
      ? ["--mount", `type=bind,src=${secretDirectoryPath},dst=/app/.release-secrets,readonly`]
      : []),
    imageId,
    ...command,
  );
  return arguments_;
}

export function dockerCandidateAttestation(candidate) {
  if (!immutableImageIdPattern.test(candidate.imageId)) fail("Invalid immutable Docker image ID.");
  return `Resolved Docker release candidate ${candidate.imageId}; revision=${candidate.revision}; source-digest=${candidate.sourceDigest}.`;
}

export function assertDockerCandidateProvenance(candidate, configuration) {
  if (candidate.revision !== configuration.expectedRevision
    || candidate.sourceDigest !== configuration.expectedSourceDigest) {
    fail(
      "Docker candidate provenance labels do not exactly match the explicitly expected revision and source digest.",
    );
  }
}
