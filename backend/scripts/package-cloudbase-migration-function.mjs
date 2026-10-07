#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(backendRoot, "..");
const functionRoot = join(repositoryRoot, "cloudbase/functions/pindou-schema-migration");
const bundleDirectory = join(functionRoot, "bundle");

function fail(code) {
  throw new Error(code);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`BACKEND_FUNCTION_PACKAGE_FAILED:${result.status ?? "unknown"}`);
}

try {
  await access(bundleDirectory, constants.F_OK);
  fail("MIGRATION_BUNDLE_ALREADY_EXISTS; inspect it before replacing it");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "pindou-cloudbase-migration-"));
const backendPackage = join(temporaryRoot, "backend-package");
const stagingDirectory = join(functionRoot, `.bundle-${randomUUID()}`);
let stagingCreated = false;

try {
  // Migration Event runs runSeed after DDL; the shared packager removes
  // dist/src/seed.js unless --include-seed is passed explicitly.
  run(process.execPath, [
    join(backendRoot, "scripts/package-cloudbase-function.mjs"),
    backendPackage,
    "--include-seed",
  ], repositoryRoot);

  const required = [
    "dist/src/cloudbase/migration-event.js",
    "dist/src/migrate.js",
    "dist/src/seed.js",
    "dist/src/config.js",
    "dist/src/db.js",
    "dist/src/domain/palettes.js",
    "dist/src/migration-manifest.js",
    "migrations",
    "node_modules/pg/package.json",
  ];
  for (const relative of required) {
    try {
      await access(join(backendPackage, relative), constants.R_OK);
    } catch {
      fail(`MIGRATION_PACKAGE_INPUT_MISSING:${relative}`);
    }
  }

  const migrationFiles = (await readdir(join(backendPackage, "migrations")))
    .filter((name) => name.endsWith(".sql"));
  if (migrationFiles.length !== 58) fail("MIGRATION_PACKAGE_REQUIRES_EXACTLY_58_SQL_FILES");

  await cp(backendPackage, stagingDirectory, { recursive: true, errorOnExist: true });
  stagingCreated = true;
  await writeFile(
    join(stagingDirectory, "index.js"),
    await readFile(join(functionRoot, "index.js"), "utf8"),
    { flag: "w" },
  );
  await rm(join(stagingDirectory, "scf_bootstrap"), { force: true });
  await rename(stagingDirectory, bundleDirectory);
  stagingCreated = false;
  console.log("One-shot migration Event package prepared; no CloudBase deployment was performed.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  if (stagingCreated) await rm(stagingDirectory, { recursive: true, force: true });
}
