import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_MIRROR_EPOCH_UTC = "20261007000000";
export const MIGRATION_MAP_FILE = "cloudbase-migration-map.json";

const REQUIRED_LEDGER_CONTRACTS = [
  "historyTableResolved",
  "historyVersionSemanticsResolved",
  "historyChecksumSemanticsResolved",
  "singleFileAtomicityVerified",
  "failedFileHistoryTimingVerified",
  "lockBehaviorVerified",
  "applicationLedgerRepairTransactionVerified",
];

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function applicationChecksum(bytes) {
  const sql = bytes.toString("utf8");
  if (!Buffer.from(sql, "utf8").equals(bytes)) {
    throw new Error("Migration SQL is not valid UTF-8; refusing a lossy checksum or mirror");
  }
  return sha256(Buffer.from(sql.replace(/\r\n?/g, "\n"), "utf8"));
}

function cloudbaseTimestamp(epochUtc, sequence) {
  if (!/^\d{14}$/.test(epochUtc)) throw new Error("Mirror epoch must be YYYYMMDDHHmmss UTC");
  const year = Number(epochUtc.slice(0, 4));
  const month = Number(epochUtc.slice(4, 6)) - 1;
  const day = Number(epochUtc.slice(6, 8));
  const hour = Number(epochUtc.slice(8, 10));
  const minute = Number(epochUtc.slice(10, 12));
  const second = Number(epochUtc.slice(12, 14));
  const base = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (Number.isNaN(base.getTime())
    || base.getUTCFullYear() !== year
    || base.getUTCMonth() !== month
    || base.getUTCDate() !== day
    || base.getUTCHours() !== hour
    || base.getUTCMinutes() !== minute
    || base.getUTCSeconds() !== second) {
    throw new Error("Mirror epoch is not a valid UTC timestamp");
  }
  const timestamp = new Date(base.getTime() + sequence * 1_000);
  return [
    String(timestamp.getUTCFullYear()).padStart(4, "0"),
    String(timestamp.getUTCMonth() + 1).padStart(2, "0"),
    String(timestamp.getUTCDate()).padStart(2, "0"),
    String(timestamp.getUTCHours()).padStart(2, "0"),
    String(timestamp.getUTCMinutes()).padStart(2, "0"),
    String(timestamp.getUTCSeconds()).padStart(2, "0"),
  ].join("");
}

export function mapMigrationSources(sources, epochUtc = DEFAULT_MIRROR_EPOCH_UTC) {
  const ordered = [...sources].sort((left, right) => left.fileName.localeCompare(right.fileName, "en"));
  const entries = [];
  const usedCloudbaseNames = new Set();

  ordered.forEach((source, index) => {
    const expectedSequence = String(index + 1).padStart(4, "0");
    const match = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/.exec(source.fileName);
    if (!match || match[1] !== expectedSequence) {
      throw new Error(`Migration sources must be a continuous 0001-based prefix; invalid source: ${source.fileName}`);
    }
    if (!Buffer.isBuffer(source.bytes)) throw new Error(`Migration source bytes are missing: ${source.fileName}`);

    const cloudbaseVersion = cloudbaseTimestamp(epochUtc, index + 1);
    const cloudbaseSuffix = match[2].replaceAll("-", "_");
    const cloudbaseFileName = `${cloudbaseVersion}_${cloudbaseSuffix}.sql`;
    if (!/^\d{14}_[a-z0-9][a-z0-9_]*\.sql$/.test(cloudbaseFileName)
      || usedCloudbaseNames.has(cloudbaseFileName)) {
      throw new Error(`CloudBase migration filename is invalid or duplicated: ${cloudbaseFileName}`);
    }
    usedCloudbaseNames.add(cloudbaseFileName);
    entries.push({
      sourceFileName: source.fileName,
      sourceVersion: source.fileName,
      sourceByteSha256: sha256(source.bytes),
      sourceChecksum: applicationChecksum(source.bytes),
      cloudbaseFileName,
      cloudbaseVersion,
    });
  });

  if (entries.length === 0) throw new Error("No migration SQL files found");
  return entries;
}

export async function readMigrationSources(sourceDirectory) {
  const names = (await readdir(sourceDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right, "en"));
  return Promise.all(names.map(async (fileName) => ({
    fileName,
    bytes: await readFile(join(sourceDirectory, fileName)),
  })));
}

export function createMirrorManifest(entries, epochUtc = DEFAULT_MIRROR_EPOCH_UTC) {
  return {
    format: "pindou-cloudbase-pg-migration-map-v1",
    sourceOfTruth: "backend/migrations",
    mirrorEpochUtc: epochUtc,
    checksumSemantics: "applicationChecksum is SHA-256 after CRLF-only normalization; sourceByteSha256 is raw bytes",
    cloudbaseHistoryContract: "unverified; this map does not assert a CloudBase history table or checksum format",
    entries,
  };
}

export async function verifyMigrationMirror(input) {
  const sources = await readMigrationSources(input.sourceDirectory);
  const entries = mapMigrationSources(sources, input.epochUtc ?? DEFAULT_MIRROR_EPOCH_UTC);
  const actualSqlFiles = (await readdir(input.mirrorDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const expectedSqlFiles = entries.map((entry) => entry.cloudbaseFileName).sort();
  if (JSON.stringify(actualSqlFiles) !== JSON.stringify(expectedSqlFiles)) {
    throw new Error("CloudBase mirror SQL filenames differ from the deterministic source mapping");
  }

  for (const [index, entry] of entries.entries()) {
    const source = sources[index];
    if (!source || source.fileName !== entry.sourceFileName) throw new Error("Migration source order changed during mirror verification");
    const mirrorBytes = await readFile(join(input.mirrorDirectory, entry.cloudbaseFileName));
    if (!mirrorBytes.equals(source.bytes)) {
      throw new Error(`CloudBase mirror bytes differ from canonical source ${entry.sourceFileName}`);
    }
  }

  const manifestBytes = await readFile(join(input.mirrorDirectory, MIGRATION_MAP_FILE));
  const expectedManifest = Buffer.from(`${JSON.stringify(createMirrorManifest(entries, input.epochUtc ?? DEFAULT_MIRROR_EPOCH_UTC), null, 2)}\n`);
  if (!manifestBytes.equals(expectedManifest)) throw new Error("CloudBase mirror mapping metadata drifted");
  return { entries, manifest: JSON.parse(manifestBytes.toString("utf8")) };
}

/** Writes a new, isolated mirror directory and verifies every SQL file byte-for-byte. */
export async function createMigrationMirror(input) {
  const sources = await readMigrationSources(input.sourceDirectory);
  const epochUtc = input.epochUtc ?? DEFAULT_MIRROR_EPOCH_UTC;
  const entries = mapMigrationSources(sources, epochUtc);
  await mkdir(input.mirrorDirectory, { recursive: false });
  try {
    for (const [index, entry] of entries.entries()) {
      const source = sources[index];
      if (!source) throw new Error(`Missing canonical source bytes for ${entry.sourceFileName}`);
      await writeFile(join(input.mirrorDirectory, entry.cloudbaseFileName), source.bytes, { flag: "wx" });
    }
    const manifest = createMirrorManifest(entries, epochUtc);
    await writeFile(
      join(input.mirrorDirectory, MIGRATION_MAP_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    const verified = await verifyMigrationMirror({
      sourceDirectory: input.sourceDirectory,
      mirrorDirectory: input.mirrorDirectory,
      epochUtc,
    });
    return { ...verified, mirrorDirectory: input.mirrorDirectory };
  } catch (error) {
    await rm(input.mirrorDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Pure planner for reconciling normalized CloudBase history with the public app ledger. */
export function planApplicationLedgerRepair(input) {
  const missingContracts = REQUIRED_LEDGER_CONTRACTS.filter((name) => input.contract?.[name] !== true);
  if (missingContracts.length > 0) {
    throw new Error(`CloudBase ledger repair is blocked until contracts are verified: ${missingContracts.join(", ")}`);
  }

  const entries = input.mappingEntries;
  const byCloudbaseName = new Map(entries.map((entry) => [entry.cloudbaseFileName, entry]));
  const bySourceVersion = new Map(entries.map((entry) => [entry.sourceVersion, entry]));
  const cloudRows = input.cloudbaseHistoryRows;
  const appRows = input.applicationRows;

  assertPrefix(cloudRows.map((row) => {
    const entry = byCloudbaseName.get(row.cloudbaseFileName);
    if (!entry) throw new Error(`CloudBase history contains an unmapped migration: ${row.cloudbaseFileName}`);
    if (row.sourceChecksum !== entry.sourceChecksum) {
      throw new Error(`CloudBase history checksum does not match source mapping: ${entry.sourceVersion}`);
    }
    return entry.sourceVersion;
  }), entries.map((entry) => entry.sourceVersion), "CloudBase history");

  const appVersions = appRows.map((row) => {
    const entry = bySourceVersion.get(row.version);
    if (!entry) throw new Error(`public.schema_migrations contains an unknown version: ${row.version}`);
    if (row.checksum !== null && row.checksum !== entry.sourceChecksum) {
      throw new Error(`public.schema_migrations checksum mismatch for ${row.version}`);
    }
    return entry.sourceVersion;
  });
  assertPrefix(appVersions, entries.map((entry) => entry.sourceVersion), "public.schema_migrations");

  const cloudVersions = cloudRows.map((row) => byCloudbaseName.get(row.cloudbaseFileName).sourceVersion);
  if (appVersions.length > cloudVersions.length) {
    throw new Error("public.schema_migrations is ahead of CloudBase migration history; refusing reconciliation");
  }
  for (let index = 0; index < appVersions.length; index += 1) {
    if (appVersions[index] !== cloudVersions[index]) {
      throw new Error("CloudBase history and public.schema_migrations diverge; refusing reconciliation");
    }
  }

  const appRowsByVersion = new Map(appRows.map((row) => [row.version, row]));
  const operations = cloudVersions.slice(appVersions.length).map((version) => {
    const entry = bySourceVersion.get(version);
    if (!entry) throw new Error(`Missing source mapping for version ${version}`);
    return { kind: "insert", version: entry.sourceVersion, checksum: entry.sourceChecksum };
  });
  const backfillOperations = [];
  for (const row of appRows) {
    if (row.checksum !== null) continue;
    const entry = bySourceVersion.get(row.version);
    if (!entry || !cloudVersions.includes(entry.sourceVersion)) {
      throw new Error(`Legacy checksum cannot be backfilled without matching CloudBase history: ${row.version}`);
    }
    backfillOperations.push({ kind: "checksum-backfill", version: row.version, checksum: entry.sourceChecksum });
  }

  return {
    status: "verified-plan-only",
    writesExecuted: false,
    sourceLedger: "CloudBase history",
    targetLedger: "public.schema_migrations",
    operations: [...backfillOperations, ...operations],
  };
}

function assertPrefix(versions, expectedVersions, label) {
  if (versions.length > expectedVersions.length) throw new Error(`${label} has more migrations than the source manifest`);
  for (let index = 0; index < versions.length; index += 1) {
    if (versions[index] !== expectedVersions[index]) throw new Error(`${label} is not a continuous source prefix`);
  }
}

export function sourceDirectoryFromBackendRoot(backendRoot) {
  return join(backendRoot, "migrations");
}
