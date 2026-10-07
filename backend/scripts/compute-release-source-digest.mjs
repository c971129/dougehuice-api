import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");
const backendRoot = join(repositoryRoot, "backend");
const execFileAsync = promisify(execFile);

const excludedBackendDirectories = new Set([
  ".git",
  ".github",
  ".idea",
  ".vscode",
  "dist",
  "docs",
  "node_modules",
]);
const excludedBackendRootDirectories = new Set([".data", "secrets"]);
const excludedExtensions = new Set([
  ".jpeg",
  ".jpg",
  ".local",
  ".log",
  ".pem",
  ".png",
  ".webp",
]);

export function isBackendBuildContextEntryExcluded(relativePath, isDirectory = false) {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/");
  const name = segments.at(-1) ?? "";
  const isBackendRootEntry = segments.length === 1;
  if (isDirectory) {
    return excludedBackendDirectories.has(name)
      || (isBackendRootEntry && excludedBackendRootDirectories.has(name));
  }
  if (isBackendRootEntry && /^\.env/i.test(name)) return true;
  if (isBackendRootEntry && /^private\..+\.key$/i.test(name)) return true;
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  return excludedExtensions.has(extension);
}

function normalizedRelativePath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

async function backendBuildContextFiles(directory = backendRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(backendRoot, absolutePath);
    if (entry.isDirectory()) {
      if (!isBackendBuildContextEntryExcluded(relativePath, true)) {
        files.push(...await backendBuildContextFiles(absolutePath));
      }
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported non-file build-context entry: ${normalizedRelativePath(absolutePath)}`);
    }
    if (!isBackendBuildContextEntryExcluded(relativePath)) files.push(absolutePath);
  }
  return files;
}

export async function computeReleaseSourceDigest() {
  const files = [
    join(repositoryRoot, ".dockerignore"),
    join(repositoryRoot, "package.json"),
    join(repositoryRoot, "pnpm-lock.yaml"),
    join(repositoryRoot, "pnpm-workspace.yaml"),
    ...await backendBuildContextFiles(),
  ].sort((left, right) => {
    const leftPath = normalizedRelativePath(left);
    const rightPath = normalizedRelativePath(right);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  const hash = createHash("sha256");
  for (const path of files) {
    const relativePath = normalizedRelativePath(path);
    const bytes = await readFile(path);
    hash.update(`${Buffer.byteLength(relativePath, "utf8")}:${relativePath}:${bytes.length}:`, "utf8");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function releaseCheckoutRevision() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
    ));
  } catch {
    throw new Error("Cannot resolve the current Git HEAD for Docker candidate provenance validation.");
  }
  const revision = stdout.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(revision)) {
    throw new Error("Current Git HEAD is not a full 40- or 64-hex commit ID.");
  }
  return revision;
}

export async function assertReleaseCheckoutClean() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    ));
  } catch {
    throw new Error("Cannot verify that the Docker candidate release checkout is clean.");
  }
  if (stdout.trim()) {
    throw new Error(
      "Docker candidate image mode requires a clean Git checkout; staged, unstaged, or untracked files are present.",
    );
  }
}

export function assertReleaseProvenanceMatchesCheckoutValues(configuration, checkout) {
  if (configuration.mode !== "image") return undefined;
  if (configuration.expectedRevision.toLowerCase() !== checkout.revision.toLowerCase()) {
    throw new Error(
      "PINDOU_RELEASE_EXPECTED_REVISION does not exactly match the current checkout Git HEAD.",
    );
  }
  if (configuration.expectedSourceDigest !== checkout.sourceDigest) {
    throw new Error(
      "PINDOU_RELEASE_EXPECTED_SOURCE_DIGEST does not exactly match the current checkout build inputs.",
    );
  }
  return checkout;
}

export async function assertReleaseProvenanceMatchesCurrentCheckout(configuration) {
  if (configuration.mode !== "image") return undefined;
  await assertReleaseCheckoutClean();
  const [revision, sourceDigest] = await Promise.all([
    releaseCheckoutRevision(),
    computeReleaseSourceDigest(),
  ]);
  const attestation = assertReleaseProvenanceMatchesCheckoutValues(
    configuration,
    { revision, sourceDigest },
  );
  await assertReleaseCheckoutClean();
  return attestation;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  process.stdout.write(`${await computeReleaseSourceDigest()}\n`);
}
