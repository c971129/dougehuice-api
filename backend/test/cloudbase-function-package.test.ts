import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as packageTools from "../scripts/package-cloudbase-function.mjs";
const { assertFunctionPackage, assertNoForbiddenFiles } = packageTools;

test("CloudBase function package accepts the minimal runtime layout", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "pindou-cloudbase-package-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (const path of ["node_modules/fastify", "node_modules/pg", "dist/src", "migrations"]) {
    await mkdir(join(root, path), { recursive: true });
  }
  await writeFile(join(root, "package.json"), '{"main":"index.js"}\n');
  await writeFile(join(root, "node_modules/fastify/package.json"), "{}\n");
  await writeFile(join(root, "node_modules/pg/package.json"), "{}\n");
  await writeFile(join(root, "index.js"), 'import "./dist/src/index.js";\n');
  await writeFile(join(root, "dist/src/index.js"), "\n");
  await writeFile(join(root, "scf_bootstrap"), "#!/bin/bash\n");
  await chmod(join(root, "scf_bootstrap"), 0o755);

  await assert.doesNotReject(assertFunctionPackage(root));
  await rm(join(root, "index.js"));
  await assert.rejects(assertFunctionPackage(root), /index.js/);
});

test("CloudBase function package rejects environment and private key files", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "pindou-cloudbase-package-secret-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".env"), "DO_NOT_PRINT=secret\n");
  await writeFile(join(root, "private.pem"), "PRIVATE KEY MATERIAL\n");

  await assert.rejects(assertNoForbiddenFiles(root), /禁止文件/);
});

test("CloudBase function package pruning removes development artifacts but keeps runtime and license files", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "pindou-cloudbase-prune-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const files = [
    "node_modules/runtime-fixture/dist/index.js",
    "node_modules/runtime-fixture/dist/index.js.map",
    "node_modules/runtime-fixture/src/index.ts",
    "node_modules/runtime-fixture/types/index.d.ts",
    "node_modules/runtime-fixture/README.md",
    "node_modules/runtime-fixture/README-es.md",
    "node_modules/runtime-fixture/LICENSE",
    "node_modules/runtime-fixture/test/sample.js",
    "node_modules/runtime-fixture/examples/demo.js",
    "node_modules/runtime-fixture/native.node",
  ];
  for (const path of files) {
    const fullPath = join(root, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, "fixture\n");
  }

  await packageTools.pruneFunctionPackage(root);

  for (const path of [
    "node_modules/runtime-fixture/dist/index.js",
    "node_modules/runtime-fixture/LICENSE",
    "node_modules/runtime-fixture/native.node",
  ]) {
    await assert.doesNotReject(import("node:fs/promises").then(({ access }) => access(join(root, path))));
  }
  for (const path of [
    "node_modules/runtime-fixture/dist/index.js.map",
    "node_modules/runtime-fixture/src/index.ts",
    "node_modules/runtime-fixture/types/index.d.ts",
    "node_modules/runtime-fixture/README.md",
    "node_modules/runtime-fixture/README-es.md",
    "node_modules/runtime-fixture/test/sample.js",
    "node_modules/runtime-fixture/examples/demo.js",
  ]) {
    await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(root, path))));
  }
});
