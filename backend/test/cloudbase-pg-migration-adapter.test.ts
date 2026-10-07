import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applicationChecksum,
  createMigrationMirror,
  DEFAULT_MIRROR_EPOCH_UTC,
  mapMigrationSources,
  planApplicationLedgerRepair,
  readMigrationSources,
  sha256,
  verifyMigrationMirror,
} from "../scripts/cloudbase-pg-migration-adapter.js";

const allContractsVerified = {
  historyTableResolved: true,
  historyVersionSemanticsResolved: true,
  historyChecksumSemanticsResolved: true,
  singleFileAtomicityVerified: true,
  failedFileHistoryTimingVerified: true,
  lockBehaviorVerified: true,
  applicationLedgerRepairTransactionVerified: true,
};

test("CloudBase 14-digit filenames deterministically map the 58 canonical migrations", async () => {
  const sources = await readMigrationSources(fileURLToPath(new URL("../migrations/", import.meta.url)));
  const entries = mapMigrationSources(sources);
  assert.equal(entries.length, 58);
  assert.equal(entries[0]?.sourceFileName, "0001_foundation.sql");
  assert.equal(entries[0]?.cloudbaseFileName, "20261007000001_foundation.sql");
  assert.equal(entries.at(-1)?.sourceFileName, "0058_credit_product_pricing.sql");
  assert.equal(entries.at(-1)?.cloudbaseFileName, "20261007000058_credit_product_pricing.sql");
  assert.equal(new Set(entries.map((entry) => entry.cloudbaseFileName)).size, entries.length);
  assert.equal(new Set(entries.map((entry) => entry.sourceVersion)).size, entries.length);
  assert.ok(entries.every((entry) => /^\d{14}_[a-z0-9][a-z0-9_]*\.sql$/.test(entry.cloudbaseFileName)));
  assert.equal(entries[0]?.cloudbaseVersion, "20261007000001");
  assert.equal(DEFAULT_MIRROR_EPOCH_UTC, "20261007000000");
});

test("offline mirror preserves source bytes exactly and rejects later drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pindou-cloudbase-migration-adapter-"));
  const sourceDirectory = join(root, "source");
  const firstMirror = join(root, "mirror-a");
  const secondMirror = join(root, "mirror-b");
  await mkdir(sourceDirectory);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const exactBytes = Buffer.from("SELECT 1;\r\n-- UTF-8: 脱机\r\n", "utf8");
  await writeFile(join(sourceDirectory, "0001_foundation.sql"), exactBytes);

  const first = await createMigrationMirror({ sourceDirectory, mirrorDirectory: firstMirror });
  const second = await createMigrationMirror({ sourceDirectory, mirrorDirectory: secondMirror });
  assert.deepEqual(first.entries, second.entries);
  assert.deepEqual(await readFile(join(firstMirror, first.entries[0]!.cloudbaseFileName)), exactBytes);
  assert.equal(first.entries[0]?.sourceByteSha256, sha256(exactBytes));
  assert.notEqual(first.entries[0]?.sourceByteSha256, applicationChecksum(exactBytes));
  await assert.doesNotReject(verifyMigrationMirror({ sourceDirectory, mirrorDirectory: firstMirror }));

  await writeFile(join(firstMirror, first.entries[0]!.cloudbaseFileName), Buffer.from("SELECT 2;\r\n"));
  await assert.rejects(
    verifyMigrationMirror({ sourceDirectory, mirrorDirectory: firstMirror }),
    /bytes differ from canonical source/,
  );
});

test("migration naming rejects gaps and normalizes source hyphens for CloudBase", () => {
  assert.throws(() => mapMigrationSources([
    { fileName: "0001_foundation.sql", bytes: Buffer.from("SELECT 1;") },
    { fileName: "0003_gap.sql", bytes: Buffer.from("SELECT 3;") },
  ]), /continuous 0001-based prefix/);
  const normalized = mapMigrationSources([
    { fileName: "0001_alpha-beta.sql", bytes: Buffer.from("SELECT 1;") },
  ]);
  assert.equal(normalized[0]?.cloudbaseFileName, "20261007000001_alpha_beta.sql");
  assert.throws(() => mapMigrationSources([
    { fileName: "0001_Uppercase.sql", bytes: Buffer.from("SELECT 1;") },
  ]), /continuous 0001-based prefix/);
});

test("CloudBase ledger repair fails closed while any external migration contract is unverified", () => {
  const entries = mapMigrationSources([
    { fileName: "0001_foundation.sql", bytes: Buffer.from("SELECT 1;\n") },
  ]);
  assert.throws(() => planApplicationLedgerRepair({
    mappingEntries: entries,
    contract: {},
    cloudbaseHistoryRows: [],
    applicationRows: [],
  }), /historyTableResolved.*singleFileAtomicityVerified.*lockBehaviorVerified/);
});

test("ledger planner proposes deterministic, idempotent backfill only behind verified gates", () => {
  const entries = mapMigrationSources([
    { fileName: "0001_foundation.sql", bytes: Buffer.from("SELECT 1;\n") },
    { fileName: "0002_private_assets.sql", bytes: Buffer.from("SELECT 2;\n") },
  ]);
  const cloudbaseHistoryRows = entries.map((entry) => ({
    cloudbaseFileName: entry.cloudbaseFileName,
    sourceChecksum: entry.sourceChecksum,
  }));
  const firstPlan = planApplicationLedgerRepair({
    mappingEntries: entries,
    contract: allContractsVerified,
    cloudbaseHistoryRows,
    applicationRows: [{ version: entries[0]!.sourceVersion, checksum: entries[0]!.sourceChecksum }],
  });
  assert.deepEqual(firstPlan.operations, [{
    kind: "insert",
    version: entries[1]!.sourceVersion,
    checksum: entries[1]!.sourceChecksum,
  }]);
  assert.equal(firstPlan.writesExecuted, false);

  const replayPlan = planApplicationLedgerRepair({
    mappingEntries: entries,
    contract: allContractsVerified,
    cloudbaseHistoryRows,
    applicationRows: entries.map((entry) => ({ version: entry.sourceVersion, checksum: entry.sourceChecksum })),
  });
  assert.deepEqual(replayPlan.operations, []);

  const legacyChecksumPlan = planApplicationLedgerRepair({
    mappingEntries: entries,
    contract: allContractsVerified,
    cloudbaseHistoryRows,
    applicationRows: [
      { version: entries[0]!.sourceVersion, checksum: null },
      { version: entries[1]!.sourceVersion, checksum: entries[1]!.sourceChecksum },
    ],
  });
  assert.deepEqual(legacyChecksumPlan.operations, [{
    kind: "checksum-backfill",
    version: entries[0]!.sourceVersion,
    checksum: entries[0]!.sourceChecksum,
  }]);
});

test("ledger planner rejects unknown versions, gaps, and checksum drift", () => {
  const entries = mapMigrationSources([
    { fileName: "0001_foundation.sql", bytes: Buffer.from("SELECT 1;\n") },
    { fileName: "0002_private_assets.sql", bytes: Buffer.from("SELECT 2;\n") },
  ]);
  const history = entries.map((entry) => ({
    cloudbaseFileName: entry.cloudbaseFileName,
    sourceChecksum: entry.sourceChecksum,
  }));
  const input = {
    mappingEntries: entries,
    contract: allContractsVerified,
    cloudbaseHistoryRows: history,
  };
  assert.throws(() => planApplicationLedgerRepair({
    ...input,
    cloudbaseHistoryRows: [{ cloudbaseFileName: "20261007999999_future.sql", sourceChecksum: "0".repeat(64) }],
    applicationRows: [],
  }), /unmapped migration/);
  assert.throws(() => planApplicationLedgerRepair({
    ...input,
    cloudbaseHistoryRows: [{ ...history[0]!, sourceChecksum: "f".repeat(64) }],
    applicationRows: [],
  }), /history checksum does not match/);
  assert.throws(() => planApplicationLedgerRepair({
    ...input,
    applicationRows: [
      { version: entries[0]!.sourceVersion, checksum: entries[0]!.sourceChecksum },
      { version: "0002_future.sql", checksum: "0".repeat(64) },
    ],
  }), /unknown version/);
  assert.throws(() => planApplicationLedgerRepair({
    ...input,
    applicationRows: [{ version: entries[1]!.sourceVersion, checksum: entries[1]!.sourceChecksum }],
  }), /continuous source prefix/);
  assert.throws(() => planApplicationLedgerRepair({
    ...input,
    applicationRows: [{ version: entries[0]!.sourceVersion, checksum: "f".repeat(64) }],
  }), /checksum mismatch/);
});
