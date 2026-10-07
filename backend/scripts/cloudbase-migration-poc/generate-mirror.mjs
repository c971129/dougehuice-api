#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMigrationMirror,
  verifyMigrationMirror,
} from "../cloudbase-pg-migration-adapter.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const backendDirectory = resolve(scriptDirectory, "../..");
const sourceDirectory = resolve(backendDirectory, "migrations");
const mirrorWorkspace = resolve(scriptDirectory, "mirror");
const mirrorDirectory = resolve(mirrorWorkspace, "migrations");
const manifestPath = resolve(mirrorDirectory, "cloudbase-migration-map.json");

async function assertOutputDoesNotExist(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing POC mirror path: ${path}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

await assertOutputDoesNotExist(mirrorDirectory);

const created = await createMigrationMirror({ sourceDirectory, mirrorDirectory });
const verified = await verifyMigrationMirror({ sourceDirectory, mirrorDirectory });
if (JSON.stringify(created.entries) !== JSON.stringify(verified.entries)) {
  throw new Error("Mirror mapping changed between generation and verification");
}

const manifestBytes = await readFile(manifestPath);
process.stdout.write(`${JSON.stringify({
  mode: "local-file-only",
  sourceDirectory,
  mirrorDirectory,
  sourceCount: verified.entries.length,
  byteIdentical: true,
  manifestSha256: sha256(manifestBytes),
  first: verified.entries[0],
  last: verified.entries.at(-1),
  entries: verified.entries,
  databaseWrites: false,
  cloudbaseRequests: false,
}, null, 2)}\n`);
