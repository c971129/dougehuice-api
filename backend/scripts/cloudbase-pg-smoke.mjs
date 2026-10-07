#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import {
  createMigrationMirror,
  DEFAULT_MIRROR_EPOCH_UTC,
  sourceDirectoryFromBackendRoot,
} from "./cloudbase-pg-migration-adapter.js";

const scriptPath = fileURLToPath(import.meta.url);
const backendRoot = resolve(scriptPath, "..", "..");

function parseArguments(args) {
  const options = { sourceDirectory: sourceDirectoryFromBackendRoot(backendRoot) };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--source-dir") {
      options.sourceDirectory = resolve(requireValue(args, ++index, argument));
    } else if (argument === "--output-dir") {
      options.mirrorDirectory = resolve(requireValue(args, ++index, argument));
    } else if (argument === "--epoch-utc") {
      options.epochUtc = requireValue(args, ++index, argument);
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function printHelp() {
  process.stdout.write([
    "Offline CloudBase PG migration mirror smoke test.",
    "",
    "Usage: node backend/scripts/cloudbase-pg-smoke.mjs [--source-dir DIR] [--output-dir NEW_DIR] [--epoch-utc YYYYMMDDHHmmss]",
    "",
    "Reads canonical migration SQL, writes a new local mirror, and verifies exact bytes and mapping.",
    "It does not read environment variables, connect to a database, or call CloudBase.",
    "",
  ].join("\n"));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const mirrorDirectory = options.mirrorDirectory
    ?? resolve(tmpdir(), `pindou-cloudbase-pg-mirror-${randomUUID()}`);
  const result = await createMigrationMirror({
    sourceDirectory: options.sourceDirectory,
    mirrorDirectory,
    ...(options.epochUtc ? { epochUtc: options.epochUtc } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    mode: "offline-only",
    sourceCount: result.entries.length,
    first: result.entries[0],
    last: result.entries.at(-1),
    mirrorDirectory: result.mirrorDirectory,
    cloudbaseHistoryContract: result.manifest.cloudbaseHistoryContract,
    databaseWrites: false,
    cloudbaseRequests: false,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Offline migration smoke failed"}\n`);
    process.exitCode = 1;
  });
}
