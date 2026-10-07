#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, chmod, lstat, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(backendRoot, "..");
const targetArgument = process.argv[2];
const includeSeedEntrypoint = process.argv[3] === "--include-seed";
if (process.argv.length > 4 || (process.argv[3] && !includeSeedEntrypoint)) {
  throw new Error("用法：node backend/scripts/package-cloudbase-function.mjs <不存在的输出目录> [--include-seed]");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function assertNoForbiddenFiles(root, relative = "") {
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    if (/^(?:\.env(?:\..*)?|secrets|private\..*\.key|.*\.pem)$/i.test(entry.name)) {
      throw new Error(`发布包含有禁止文件：${join(relative, entry.name)}`);
    }
    if (entry.isDirectory()) await assertNoForbiddenFiles(root, join(relative, entry.name));
  }
}

const removableDirectories = new Set(["__tests__", "bench", "benchmark", "benchmarks", "docs", "example", "examples", "test", "tests"]);
const removableExtensions = /\.(?:map|ts|mts|cts)$/i;
const removableDocumentation = /^(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|MIGRATION|GOVERNANCE|PROJECT_CHARTER|SPONSORS)(?:[-_.].*)?$/i;
const documentationExtension = /\.(?:md|markdown|txt|rst|adoc)$/i;
const removablePackageManagerFiles = new Set([
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "node_modules/.modules.yaml",
  "node_modules/.package-map.json",
  "node_modules/.pnpm-workspace-state-v1.json",
  "node_modules/.pnpm/lock.yaml",
]);
const removableNestedPackageManagerFiles = new Set([
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
]);
const removablePdfLibDirectories = new Set(["dist", "es", "ts3.4"]);
// The HTTP function starts from dist/src/index.js. These standalone local or
// scheduled-job entrypoints are not imported by that HTTP runtime and will be
// packaged separately if/when CloudBase worker functions are introduced.
const removableHttpPackageEntrypoints = new Set([
  "dist/src/dev-memory.js",
  "dist/src/run-export-worker.js",
  "dist/src/run-generation-worker.js",
  "dist/src/run-payment-reconciliation-worker.js",
  "dist/src/purge-expired-assets.js",
  "dist/src/purge-expired-export-artifacts.js",
]);
const seedEntrypoint = "dist/src/seed.js";

async function pruneFunctionPackage(root, relative = "", options = {}) {
  // Node resolves pdf-lib through its `main` field (`cjs/index.js`); its ESM,
  // browser bundles, and TS 3.4 compatibility output are not part of this runtime.
  const isPdfLibRuntimePackage = /(?:^|\/)pdf-lib$/.test(relative);
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const entryPath = join(relative, entry.name);
    const fullPath = join(root, entryPath);
    if (entryPath === "node_modules/.pnpm") {
      if (!entry.isDirectory()) {
        throw new Error("hoisted 生产依赖目录 node_modules/.pnpm 不是普通目录，拒绝裁剪");
      }

      for (const artifact of await readdir(fullPath, { withFileTypes: true })) {
        const artifactPath = join(entryPath, artifact.name);
        const artifactFullPath = join(root, artifactPath);
        if (artifact.isFile() && removablePackageManagerFiles.has(artifactPath)) {
          await rm(artifactFullPath);
          continue;
        }
        if (artifact.isDirectory() && (await readdir(artifactFullPath)).length === 0) {
          await rmdir(artifactFullPath);
          continue;
        }
        throw new Error("hoisted 生产依赖目录仍含未知 pnpm 文件或真实包内容，拒绝裁剪");
      }

      await rmdir(fullPath);
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    if (entryPath === "node_modules/.bin") {
      await rm(fullPath, { recursive: true, force: true });
      continue;
    }
    if (removableHttpPackageEntrypoints.has(entryPath)) {
      await rm(fullPath, { force: true });
      continue;
    }
    if (entryPath === seedEntrypoint && !options.includeSeedEntrypoint) {
      await rm(fullPath, { force: true });
      continue;
    }
    if (entry.isDirectory()) {
      if (isPdfLibRuntimePackage && removablePdfLibDirectories.has(entry.name)) {
        await rm(fullPath, { recursive: true, force: true });
        continue;
      }
      if (removableDirectories.has(entry.name.toLowerCase())) {
        await rm(fullPath, { recursive: true, force: true });
      } else {
        await pruneFunctionPackage(root, entryPath, options);
      }
      continue;
    }
    if (entry.isFile() && (
      removablePackageManagerFiles.has(entryPath) ||
      removableNestedPackageManagerFiles.has(entry.name) ||
      removableExtensions.test(entry.name) ||
      (removableDocumentation.test(entry.name)
        && (!/\.[^./]+$/.test(entry.name) || documentationExtension.test(entry.name)))
    )) {
      await rm(fullPath, { force: true });
    }
  }
}

async function assertFunctionPackage(root, options = {}) {
  const required = ["package.json", "index.js", "node_modules/fastify/package.json", "node_modules/pg/package.json", "dist/src/index.js", "migrations", "scf_bootstrap"];
  for (const relative of required) {
    await access(join(root, relative), constants.R_OK);
  }
  const bootstrap = await stat(join(root, "scf_bootstrap"));
  if ((bootstrap.mode & 0o111) === 0) throw new Error("scf_bootstrap 没有可执行权限");
  const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (packageMetadata.main !== "index.js") throw new Error("CloudBase HTTP 函数 package.json 必须指向根目录 index.js");
  await assertNoForbiddenFiles(root);
  const entries = await readdir(root);
  for (const forbidden of ["src", "test", "Dockerfile", "tsconfig.json"]) {
    if (entries.includes(forbidden)) throw new Error(`发布包不应包含 ${forbidden}`);
  }
  for (const relative of ["node_modules/.pnpm", "node_modules/.bin"]) {
    try {
      await access(join(root, relative), constants.F_OK);
      throw new Error(`发布包不应包含 pnpm 安装/命令目录 ${relative}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const relative of removablePackageManagerFiles) {
    try {
      await access(join(root, relative), constants.F_OK);
      throw new Error(`发布包不应包含安装期文件 ${relative}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const relative of removableHttpPackageEntrypoints) {
    try {
      await access(join(root, relative), constants.F_OK);
      throw new Error(`HTTP 函数包不应包含独立入口 ${relative}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (options.includeSeedEntrypoint) {
    await access(join(root, seedEntrypoint), constants.R_OK);
  } else {
    try {
      await access(join(root, seedEntrypoint), constants.F_OK);
      throw new Error(`HTTP 函数包不应包含独立入口 ${seedEntrypoint}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const pdfLibRoot = join(root, "node_modules");
  try {
    for (const entry of await readdir(pdfLibRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name !== "pdf-lib") continue;
      const packageRoot = join(pdfLibRoot, entry.name);
      for (const unnecessary of ["dist", "es", "ts3.4"]) {
        try {
          await access(join(packageRoot, unnecessary), constants.F_OK);
          throw new Error(`pdf-lib Node.js CJS 部署包不应包含未使用目录 ${entry.name}/${unnecessary}`);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export { assertFunctionPackage, assertNoForbiddenFiles, pruneFunctionPackage };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("CloudBase 函数包含 sharp Linux/x64 原生依赖；请在 Linux/x64 CI 环境打包，不能上传其他系统或架构的产物。");
  }
  if (!targetArgument) {
    throw new Error("用法：node backend/scripts/package-cloudbase-function.mjs <不存在的输出目录>");
  }
  const target = resolve(targetArgument);
  if (!isAbsolute(targetArgument)) throw new Error("输出目录必须使用绝对路径，以避免误覆盖当前项目文件。");
  if (target === repositoryRoot || target.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("输出目录必须位于仓库之外；脚本不会覆盖或清理仓库内路径。");
  }
  try {
    await lstat(target);
    throw new Error(`输出目录已存在，拒绝覆盖：${target}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  run("pnpm", ["--filter", "@pindou/backend", "build"], repositoryRoot);
  // The target's workspace settings are written after deploy, so select the
  // flat linker here as well to avoid carrying an isolated .pnpm package store
  // into the serverless artifact.
  run("pnpm", ["--config.inject-workspace-packages=true", "--config.node-linker=hoisted", "--filter", "@pindou/backend", "deploy", "--prod", target], repositoryRoot);
  await writeFile(join(target, "pnpm-workspace.yaml"), "nodeLinker: hoisted\n");
  run("pnpm", ["install", "--prod", "--frozen-lockfile"], target);
  await pruneFunctionPackage(target, "", { includeSeedEntrypoint });
  await chmod(join(target, "scf_bootstrap"), 0o755);
  await assertFunctionPackage(target, { includeSeedEntrypoint });
  console.log(`CloudBase 函数包已生成并通过本地结构检查：${target}`);
}
