export interface MigrationSourceBytes {
  fileName: string;
  bytes: Buffer;
}

export interface CloudbaseMigrationMapEntry {
  sourceFileName: string;
  sourceVersion: string;
  sourceByteSha256: string;
  sourceChecksum: string;
  cloudbaseFileName: string;
  cloudbaseVersion: string;
}

export interface LedgerRepairContract {
  historyTableResolved: boolean;
  historyVersionSemanticsResolved: boolean;
  historyChecksumSemanticsResolved: boolean;
  singleFileAtomicityVerified: boolean;
  failedFileHistoryTimingVerified: boolean;
  lockBehaviorVerified: boolean;
  applicationLedgerRepairTransactionVerified: boolean;
}

export const DEFAULT_MIRROR_EPOCH_UTC: string;
export const MIGRATION_MAP_FILE: string;
export function sha256(bytes: Buffer): string;
export function applicationChecksum(bytes: Buffer): string;
export function mapMigrationSources(
  sources: MigrationSourceBytes[],
  epochUtc?: string,
): CloudbaseMigrationMapEntry[];
export function readMigrationSources(sourceDirectory: string): Promise<MigrationSourceBytes[]>;
export function createMirrorManifest(entries: CloudbaseMigrationMapEntry[], epochUtc?: string): object;
export function verifyMigrationMirror(input: {
  sourceDirectory: string;
  mirrorDirectory: string;
  epochUtc?: string;
}): Promise<{ entries: CloudbaseMigrationMapEntry[]; manifest: object }>;
export function createMigrationMirror(input: {
  sourceDirectory: string;
  mirrorDirectory: string;
  epochUtc?: string;
}): Promise<{ entries: CloudbaseMigrationMapEntry[]; manifest: object; mirrorDirectory: string }>;
export function planApplicationLedgerRepair(input: {
  mappingEntries: CloudbaseMigrationMapEntry[];
  contract: Partial<LedgerRepairContract>;
  cloudbaseHistoryRows: Array<{ cloudbaseFileName: string; sourceChecksum: string }>;
  applicationRows: Array<{ version: string; checksum: string | null }>;
}): {
  status: "verified-plan-only";
  writesExecuted: false;
  sourceLedger: "CloudBase history";
  targetLedger: "public.schema_migrations";
  operations: Array<{ kind: "insert" | "checksum-backfill"; version: string; checksum: string }>;
};
export function sourceDirectoryFromBackendRoot(backendRoot: string): string;
