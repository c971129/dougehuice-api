#!/usr/bin/env node
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(backendRoot, "..");
const probeRoot = join(repositoryRoot, "cloudbase/functions/pindou-pg-tls-probe");
const destination = join(probeRoot, "node_modules");
const probePackage = JSON.parse(await readFile(join(probeRoot, "package.json"), "utf8"));

async function findPackageRoot(resolvedFile, expectedName) {
  let current = dirname(resolvedFile);
  while (current.startsWith(repositoryRoot)) {
    try {
      const metadata = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (metadata.name === expectedName) return current;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`无法从项目依赖树定位包：${expectedName}`);
}

async function resolvePackageRoot(importerRoot, name, optional = false) {
  try {
    const resolvedFile = createRequire(join(importerRoot, "package.json")).resolve(name);
    return await findPackageRoot(resolvedFile, name);
  } catch (error) {
    if (optional && (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED")) return null;
    throw error;
  }
}

async function collectRuntimePackages() {
  const rootMetadata = JSON.parse(await readFile(join(backendRoot, "package.json"), "utf8"));
  const requestedVersion = rootMetadata.dependencies?.pg;
  if (requestedVersion !== probePackage.dependencies?.pg) {
    throw new Error(`探针 pg 版本 ${probePackage.dependencies?.pg} 与 backend 锁定依赖 ${requestedVersion} 不一致`);
  }

  const roots = new Map();
  const pending = [{ importerRoot: backendRoot, name: "pg", optional: false }];
  while (pending.length > 0) {
    const item = pending.pop();
    const packageRoot = await resolvePackageRoot(item.importerRoot, item.name, item.optional);
    if (!packageRoot) continue;
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const existing = roots.get(metadata.name);
    if (existing && existing.version !== metadata.version) {
      throw new Error(`运行依赖存在多个版本，不能安全平铺：${metadata.name} ${existing.version} / ${metadata.version}`);
    }
    if (existing) continue;
    roots.set(metadata.name, { root: packageRoot, version: metadata.version });
    for (const name of Object.keys(metadata.dependencies ?? {})) {
      pending.push({ importerRoot: packageRoot, name, optional: false });
    }
    for (const name of Object.keys(metadata.optionalDependencies ?? {})) {
      pending.push({ importerRoot: packageRoot, name, optional: true });
    }
  }
  return roots;
}

async function assertNoSymlinks(path) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    const info = await lstat(entryPath);
    if (info.isSymbolicLink()) throw new Error(`运行依赖包不允许符号链接：${relative(path, entryPath)}`);
    if (info.isDirectory()) await assertNoSymlinks(entryPath);
  }
}

async function assertExistingOutputIsManaged(expectedNames) {
  try {
    await access(destination, constants.F_OK);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const existing = (await readdir(destination, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expected = [...expectedNames].sort();
  if (JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error(`目标 node_modules 内容与探针依赖闭包不一致，拒绝覆盖。当前：${existing.join(", ")}`);
  }
  const otherEntries = (await readdir(destination, { withFileTypes: true }))
    .filter((entry) => !entry.isDirectory());
  if (otherEntries.length > 0) throw new Error("目标 node_modules 含有非目录文件，拒绝覆盖");
}

async function prepare() {
  const packages = await collectRuntimePackages();
  await assertExistingOutputIsManaged(packages.keys());

  const stageRoot = await mkdtemp(join(probeRoot, ".pg-probe-stage-"));
  const stagedModules = join(stageRoot, "node_modules");
  const backup = join(probeRoot, `.pg-probe-node-modules-backup-${process.pid}`);
  let movedExisting = false;
  try {
    await mkdir(stagedModules, { recursive: true });
    for (const [name, item] of packages) {
      await cp(item.root, join(stagedModules, name), { recursive: true, dereference: true, preserveTimestamps: true });
    }
    await assertNoSymlinks(stagedModules);
    const runtimeRequire = createRequire(join(stageRoot, "runtime-check.cjs"));
    const Pg = runtimeRequire(join(stagedModules, "pg"));
    if (typeof Pg.Pool !== "function") throw new Error("重建的 pg 包没有导出 Pool");
    for (const [name, item] of packages) {
      const copied = JSON.parse(await readFile(join(stagedModules, name, "package.json"), "utf8"));
      if (copied.version !== item.version) throw new Error(`依赖复制后版本不符：${name}`);
    }

    try {
      await rename(destination, backup);
      movedExisting = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(stagedModules, destination);
    if (movedExisting) await rm(backup, { recursive: true, force: true });
    console.log(`PG 探针依赖已从 backend 锁定依赖树重建：${packages.size} 个包，pg ${packages.get("pg").version}`);
  } catch (error) {
    if (movedExisting) {
      try {
        await rm(destination, { recursive: true, force: true });
        await rename(backup, destination);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "重建失败且无法自动恢复原依赖目录");
      }
    }
    throw error;
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

await prepare();
