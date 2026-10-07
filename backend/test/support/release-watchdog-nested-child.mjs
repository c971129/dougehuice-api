import { resolve } from "node:path";

import { runBoundedNodeCommand } from "../../scripts/postgres-release-safety.mjs";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("A descendant PID file is required.");
const innerTimeoutMilliseconds = Number.parseInt(process.argv[3] ?? "30000", 10);
if (!Number.isSafeInteger(innerTimeoutMilliseconds) || innerTimeoutMilliseconds < 1) {
  throw new Error("The inner timeout must be a positive integer.");
}

const stubbornLeaf = [
  "const { writeFileSync } = require('node:fs');",
  "writeFileSync(process.argv[1], String(process.pid));",
  "process.on('SIGTERM', () => {});",
  // This fallback keeps a broken regression finite while remaining much
  // longer than the outer watchdog's asserted deadline.
  "setTimeout(() => process.exit(0), 10000);",
].join(" ");
const intermediateChild = [
  "const { spawn } = require('node:child_process');",
  `spawn(process.execPath, ['-e', ${JSON.stringify(stubbornLeaf)}, process.argv[1]], { stdio: 'inherit' });`,
  // The intermediate exits gracefully while its child intentionally ignores
  // SIGTERM, reproducing the leader-exit/descendant-survival edge case.
  "process.on('SIGTERM', () => process.exit(0));",
  "setTimeout(() => process.exit(0), 10000);",
].join(" ");

const outcome = await runBoundedNodeCommand({
  label: "nested stubborn release child",
  arguments_: ["-e", intermediateChild, resolve(pidFile)],
  cwd: process.cwd(),
  environment: process.env,
  timeoutMilliseconds: innerTimeoutMilliseconds,
  terminationGraceMilliseconds: 100,
  forceKillSettleMilliseconds: 100,
  stdio: "inherit",
});

process.exit(outcome.passed ? 0 : 1);
