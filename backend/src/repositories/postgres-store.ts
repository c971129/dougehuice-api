import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { AppError } from "../errors.js";
import { REQUIRED_MIGRATION_VERSIONS } from "../migration-manifest.js";
import { loadMigrationFiles } from "../migrate.js";
import { assertAssetConsentPolicySnapshot } from "../domain/asset-consent.js";
import { resolveBuildNavigationCursor } from "../domain/build-progress.js";
import {
  copyDefaultGenerationOptions,
  deserializeGenerationOptions,
  generationOptionsEqual,
} from "../domain/generation-options.js";
import { assertGenerationCandidatesStructure, generationOutputSlots } from "../domain/generation-candidates.js";
import {
  assertProjectLifecycleStatus,
  assertProjectMode,
  normalizeProjectBackground,
} from "../domain/project-metadata.js";
import {
  assertProjectDeviceSource,
  defaultProjectCopyName,
  normalizeProjectSearch,
  normalizeProjectTagFilter,
  normalizeProjectTags,
} from "../domain/project-library.js";
import type {
  AssetConsentEvent,
  AssetMimeType,
  AssetPurpose,
  AssetRecord,
  AssetUploadReservation,
  AuthSession,
  BuildProgress,
  CreationDraft,
  CreditAccount,
  CreditProduct,
  CreditLedgerEntry,
  ExportArtifactRecord,
  ExportArtifactPurgeRecord,
  ExportFormat,
  ExportJobRecord,
  ExportJobStatus,
  ExportOptions,
  GenerationCandidate,
  GenerationCandidateOutputSlot,
  GenerationActiveStatus,
  GenerationJob,
  GenerationKind,
  GenerationOptions,
  InventoryItem,
  InventoryMutationResult,
  InventoryOperation,
  InventoryTransaction,
  Palette,
  PaletteColor,
  PatternGrid,
  PaymentOrderRecord,
  PaymentReconciliationJob,
  ProjectDetail,
  ProjectBackgroundMode,
  ProjectCompletionPhotoRecord,
  ProjectCompletionPhotoUploadReservation,
  ProjectDraft,
  ProjectLifecycleStatus,
  ProjectListItem,
  ProjectMode,
  ProjectInventoryConsumption,
  ProjectStatusStats,
  ProjectSummary,
} from "../domain/models.js";
import { BUILTIN_PALETTES } from "../domain/palettes.js";
import {
  INITIAL_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS,
  PAYMENT_RECONCILIATION_REPAIR_LIMIT,
  assertPaymentReconciliationDelayMilliseconds,
  assertPaymentReconciliationError,
} from "../domain/payment-reconciliation.js";
import {
  ASSET_PUBLISH_TIMEOUT_MILLISECONDS,
  ASSET_UPLOAD_LEASE_MILLISECONDS,
  AUTH_RATE_LIMIT_CLEANUP_BATCH_SIZE,
  AUTH_RATE_LIMIT_RETENTION_MILLISECONDS,
  COMPLETION_PHOTO_UPLOAD_LEASE_MILLISECONDS,
  EXPORT_ARTIFACT_PUBLISH_TIMEOUT_MILLISECONDS,
  MAX_ACTIVE_ASSET_BYTES_PER_USER,
  MAX_ACTIVE_ASSETS_PER_USER,
  MAX_ACTIVE_COMPLETION_PHOTO_BYTES_PER_USER,
  MAX_ACTIVE_COMPLETION_PHOTOS_PER_USER,
  MAX_ACTIVE_SESSIONS_PER_USER,
  MAX_ACTIVE_EXPORT_JOBS_PER_USER,
  MAX_ACTIVE_GENERATION_JOBS_PER_USER,
  MAX_ACTIVE_PROJECTS_PER_USER,
  MAX_ASSET_HISTORY_PER_USER,
  MAX_CUSTOM_PALETTES_PER_USER,
  MAX_CUSTOM_PALETTE_COLORS_PER_USER,
  MAX_EXPORT_HISTORY_PER_USER,
  MAX_GENERATION_HISTORY_PER_USER,
  MAX_GENERATION_CANDIDATE_CELLS_PER_USER,
  MAX_IDEMPOTENCY_RECORDS_PER_USER,
  MAX_INVENTORY_BATCH_ITEMS,
  MAX_INVENTORY_TRANSACTIONS_PER_USER,
  MAX_PAYMENT_EFFECT_CLAIMS_PER_USER,
  MAX_PAYMENT_ORDER_SLOT_HISTORY_PER_USER,
  MAX_PENDING_PAYMENT_ORDERS_PER_USER,
  MAX_PROJECT_COMPLETION_PHOTOS_PER_REVISION,
  MAX_PROJECT_HISTORY_PER_USER,
  MAX_PROJECT_REVISION_CELLS_PER_USER,
  MAX_PROJECT_REVISIONS,
  MAX_UNPURGED_EXPORT_ARTIFACT_BYTES_PER_USER,
  MAX_UNPURGED_EXPORT_ARTIFACTS_PER_USER,
  OPERATIONAL_HISTORY_RETENTION_MILLISECONDS,
  PURGE_CLAIM_MILLISECONDS,
  PURGE_RETRY_BASE_MILLISECONDS,
  PURGE_RETRY_MAX_MILLISECONDS,
  USER_RATE_LIMITS,
} from "../domain/resource-limits.js";
import { assertWorkerLeaseMilliseconds } from "../domain/worker-lease.js";
import type {
  AppStore,
  CreateAssetInput,
  CreateProjectInput,
  ExportJobStats,
  IdempotentExecutionResult,
  IdempotentOperationResult,
  ListProjectsInput,
  PaymentEffectClaimResult,
  PaymentEffectFence,
  PaymentOrderSlotReservation,
  PaletteMigrationAuditInput,
  RateLimitResult,
  SaveCreationDraftInput,
  UpdateProjectMetadataInput,
} from "./store.js";

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  mode: ProjectMode;
  lifecycle_status: ProjectLifecycleStatus;
  metadata_revision: number;
  tags: string[];
  device_source: ProjectSummary["deviceSource"];
  source_asset_id: string | null;
  preview_asset_id: string | null;
  palette_id: string;
  background_mode: ProjectBackgroundMode;
  background_color: string | null;
  current_revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  encoding?: "palette-code-v1";
  width?: number;
  height?: number;
  cells?: Array<string | null>;
  revision_device_source?: ProjectSummary["deviceSource"];
  revision_updated_at?: Date | string;
}

interface ProjectListRow extends ProjectRow {
  width: number;
  height: number;
  color_count: number | string;
  bead_count: number | string;
  completed_bead_count: number | string;
  progress_started: boolean;
  has_draft: boolean;
}

interface ProjectDraftRow {
  project_id: string;
  base_project_revision: number;
  draft_revision: number;
  name: string;
  encoding: "palette-code-v1";
  width: number;
  height: number;
  cells: Array<string | null>;
  updated_at: Date | string;
}

interface CreationDraftRow {
  user_id: string;
  id: string;
  draft_revision: number;
  name: string;
  kind: GenerationKind;
  setup_step: 1 | 2 | 3;
  palette_id: string;
  source_asset_id: string | null;
  width: number;
  height: number;
  options: unknown;
  grid_encoding: "palette-code-v1" | null;
  grid_cells: Array<string | null> | null;
  updated_at: Date | string;
}

interface ProjectStatusStatsRow {
  total: number | string;
  draft: number | string;
  in_progress: number | string;
  completed: number | string;
}

interface ProjectRevisionMetadataRow {
  project_id: string;
  revision: number;
  palette_id: string;
  width: number;
  height: number;
  device_source: ProjectSummary["deviceSource"];
  created_at: Date | string;
  updated_at: Date | string;
}

interface JobRow {
  id: string;
  user_id: string;
  parent_job_id: string | null;
  kind: GenerationKind;
  status: GenerationJob["status"];
  palette_id: string;
  source_asset_id: string | null;
  options: unknown;
  cost: number;
  seed: string;
  width: number;
  height: number;
  progress: number;
  attempt_count: number;
  max_attempts: number;
  available_at: Date | string;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  error_code: string | null;
  error_message: string | null;
  accepted_candidate_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  canceled_at: Date | string | null;
}

interface CandidateRow {
  id: string;
  job_id: string;
  ordinal: number;
  variant_ordinal: number;
  output_slot: GenerationCandidateOutputSlot;
  subject_slot: 1 | 2 | null;
  accepted_project_id: string | null;
  accepted_at: Date | string | null;
  encoding: "palette-code-v1";
  width: number;
  height: number;
  cells: Array<string | null>;
  created_at: Date | string;
}

interface AssetRow {
  id: string;
  user_id: string;
  purpose: AssetPurpose;
  consent_version: string | null;
  sha256: string;
  mime_type: AssetMimeType;
  size_bytes: number | string;
  width: number;
  height: number;
  storage_key: string;
  expires_at: Date | string | null;
  ready_at: Date | string | null;
  deleted_at: Date | string | null;
  purged_at: Date | string | null;
  created_at: Date | string;
}

interface AssetConsentEventRow {
  id: string;
  user_id: string;
  asset_id: string;
  consent_version: string;
  asset_purpose: AssetConsentEvent["assetPurpose"];
  policy_sha256: string;
  processor: string;
  processing_purpose: string;
  retention: string;
  source: AssetConsentEvent["source"];
  occurred_at: Date | string;
  recorded_at: Date | string;
}

interface ProjectCompletionPhotoRow {
  photo_id: string;
  photo_user_id: string;
  project_id: string;
  project_revision: number;
  photo_asset_id: string;
  photo_created_at: Date | string;
  photo_deleted_at: Date | string | null;
  asset_id: string;
  asset_user_id: string;
  asset_purpose: AssetPurpose;
  asset_consent_version: string | null;
  asset_sha256: string;
  asset_mime_type: AssetMimeType;
  asset_size_bytes: number | string;
  asset_width: number;
  asset_height: number;
  asset_storage_key: string;
  asset_expires_at: Date | string | null;
  asset_ready_at: Date | string | null;
  asset_deleted_at: Date | string | null;
  asset_purged_at: Date | string | null;
  asset_created_at: Date | string;
}

interface ExportJobRow {
  id: string;
  user_id: string;
  project_id: string;
  project_revision: number;
  format: ExportFormat;
  file_name: string;
  options: ExportOptions;
  status: ExportJobStatus;
  progress: number;
  attempt_count: number;
  max_attempts: number;
  available_at: Date | string;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
  artifact_id: string | null;
  artifact_job_id: string | null;
  artifact_storage_key: string | null;
  artifact_mime_type: "image/png" | "application/pdf" | null;
  artifact_file_name: string | null;
  artifact_size_bytes: number | string | null;
  artifact_sha256: string | null;
  artifact_expires_at: Date | string | null;
  artifact_created_at: Date | string | null;
}

interface ExportArtifactPurgeRow {
  id: string;
  job_id: string;
  user_id: string;
  storage_key: string;
  mime_type: "image/png" | "application/pdf";
  file_name: string;
  size_bytes: number | string;
  sha256: string;
  expires_at: Date | string;
  created_at: Date | string;
}

interface PaymentOrderRow {
  id: string;
  user_id: string;
  product_id: string;
  product_version: number;
  product_name: string;
  credit_amount: number;
  amount_cents: number;
  currency: "CNY";
  out_trade_no: string;
  status: PaymentOrderRecord["status"];
  provider_reference: string;
  provider_trade_state: string | null;
  provider_transaction_id: string | null;
  payment_expires_at: Date | string;
  paid_at: Date | string | null;
  closed_at: Date | string | null;
  last_reconciled_at: Date | string | null;
  late_success_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PaymentReconciliationJobRow {
  order_id: string;
  state: PaymentReconciliationJob["state"];
  available_at: Date | string;
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  last_observed_trade_state: PaymentReconciliationJob["lastObservedTradeState"];
  last_error_code: string | null;
  last_error_message: string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PaymentOrderAttemptRow {
  order_id: string;
  user_id: string;
  attempt_no: number;
  out_trade_no: string;
  state: PaymentOrderSlotReservation["state"];
  recovery_ciphertext: string | null;
  provider_reference_sha256: string | null;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface InventoryRow {
  user_id: string;
  palette_id: string;
  color_code: string;
  quantity: number;
  location: string | null;
  revision: number;
  updated_at: Date | string;
}

interface InventoryOperationRow {
  id: string;
  user_id: string;
  transaction_type: InventoryOperation["type"];
  project_id: string | null;
  project_revision: number | null;
  idempotency_reference: string;
  consumed_at: Date | string | null;
  created_at: Date | string;
}

interface InventoryTransactionRow {
  id: string;
  operation_id: string;
  user_id: string;
  transaction_type: InventoryTransaction["type"];
  palette_id: string;
  color_code: string;
  quantity_before: number;
  delta: number;
  quantity_after: number;
  location_before: string | null;
  location_after: string | null;
  project_id: string | null;
  project_revision: number | null;
  idempotency_reference: string;
  created_at: Date | string;
}

const GENERATION_ACTIVE_STATUSES: GenerationJob["status"][] = [
  "preprocessing",
  "generating",
  "mapping_colors",
  "finalizing",
];

const GENERATION_CANCELABLE_STATUSES: GenerationJob["status"][] = [
  "queued",
  "retry_wait",
  ...GENERATION_ACTIVE_STATUSES,
];

const GENERATION_TERMINAL_STATUSES: GenerationJob["status"][] = [
  "completed",
  "accepted",
  "failed",
  "canceled",
];

interface ReadinessPaletteRow {
  id: string;
  palette_name: string;
  brand: string;
  series: string;
  material: string;
  bead_size_mm: number | string;
  verified: boolean;
  version: number;
  source_name: string;
  source_url: string;
  source_revision: string;
  source_license: string;
  retired: boolean;
  code: string | null;
  color_name: string | null;
  hex: string | null;
  finish: NonNullable<Palette["colors"][number]["finish"]> | null;
  unit_price_cents: number | null;
  sort_order: number | null;
  available: boolean | null;
}

interface ReadinessMigrationRow {
  version: string;
  checksum: string | null;
}

let requiredMigrationManifestPromise: Promise<readonly {
  version: string;
  checksum: string;
}[]> | undefined;

async function requiredMigrationManifest(): Promise<readonly {
  version: string;
  checksum: string;
}[]> {
  requiredMigrationManifestPromise ??= loadMigrationFiles().then((migrations) => {
    const discoveredVersions = migrations.map((migration) => migration.version);
    if (discoveredVersions.length !== REQUIRED_MIGRATION_VERSIONS.length
      || REQUIRED_MIGRATION_VERSIONS.some(
        (version, index) => discoveredVersions[index] !== version,
      )) {
      throw new Error("Runtime migration files do not match REQUIRED_MIGRATION_VERSIONS");
    }
    return migrations.map(({ version, checksum }) => ({ version, checksum }));
  });
  return requiredMigrationManifestPromise;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function projectSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    mode: row.mode,
    lifecycleStatus: row.lifecycle_status,
    metadataRevision: row.metadata_revision,
    tags: row.tags,
    deviceSource: row.device_source,
    sourceAssetId: row.source_asset_id,
    previewAssetId: row.preview_asset_id,
    paletteId: row.palette_id,
    backgroundMode: row.background_mode,
    backgroundColor: row.background_color,
    currentRevision: row.current_revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function projectDetail(row: ProjectRow): ProjectDetail {
  if (!row.encoding || row.width === undefined || row.height === undefined || !row.cells) {
    throw new AppError(500, "PROJECT_REVISION_CORRUPTED", "项目版本缺少网格数据");
  }
  return {
    ...projectSummary(row),
    grid: { encoding: row.encoding, width: row.width, height: row.height, cells: row.cells },
    revisionDeviceSource: row.revision_device_source ?? row.device_source,
    revisionUpdatedAt: iso(row.revision_updated_at ?? row.updated_at),
  };
}

function projectListItem(row: ProjectListRow): ProjectListItem {
  const beadCount = Number(row.bead_count);
  const colorCount = Number(row.color_count);
  const completedBeadCount = Number(row.completed_bead_count);
  const status = beadCount > 0 && completedBeadCount >= beadCount
    ? "completed" as const
    : row.progress_started ? "in_progress" as const : "draft" as const;
  return {
    ...projectSummary(row),
    width: row.width,
    height: row.height,
    colorCount,
    beadCount,
    completedBeadCount,
    status,
    hasDraft: row.has_draft,
  };
}

function projectDraft(row: ProjectDraftRow): ProjectDraft {
  return {
    projectId: row.project_id,
    baseProjectRevision: row.base_project_revision,
    draftRevision: row.draft_revision,
    name: row.name,
    grid: {
      encoding: row.encoding,
      width: row.width,
      height: row.height,
      cells: row.cells,
    },
    updatedAt: iso(row.updated_at),
  };
}

function creationDraft(row: CreationDraftRow): CreationDraft {
  return {
    id: row.id,
    draftRevision: row.draft_revision,
    name: row.name,
    kind: row.kind,
    setupStep: row.setup_step,
    paletteId: row.palette_id,
    sourceAssetId: row.source_asset_id,
    width: row.width,
    height: row.height,
    options: deserializeGenerationOptions(row.options),
    grid: row.grid_encoding && row.grid_cells
      ? {
        encoding: row.grid_encoding,
        width: row.width,
        height: row.height,
        cells: row.grid_cells,
      }
      : null,
    updatedAt: iso(row.updated_at),
  };
}

function candidate(row: CandidateRow): GenerationCandidate {
  return {
    id: row.id,
    jobId: row.job_id,
    ordinal: row.ordinal,
    variantOrdinal: row.variant_ordinal,
    outputSlot: row.output_slot,
    ...(row.subject_slot == null ? {} : { subject: row.subject_slot }),
    ...(row.accepted_project_id == null ? {} : { acceptedProjectId: row.accepted_project_id }),
    ...(row.accepted_at == null ? {} : { acceptedAt: iso(row.accepted_at) }),
    grid: { encoding: row.encoding, width: row.width, height: row.height, cells: row.cells },
    createdAt: iso(row.created_at),
  };
}

function assetRecord(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    consentVersion: row.consent_version,
    sha256: row.sha256,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    storageKey: row.storage_key,
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    readyAt: row.ready_at ? iso(row.ready_at) : null,
    deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
    purgedAt: row.purged_at ? iso(row.purged_at) : null,
    createdAt: iso(row.created_at),
  };
}

function assetConsentEvent(row: AssetConsentEventRow): AssetConsentEvent {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    consentVersion: row.consent_version,
    assetPurpose: row.asset_purpose,
    policySha256: row.policy_sha256,
    processor: row.processor,
    processingPurpose: row.processing_purpose,
    retention: row.retention,
    source: row.source,
    occurredAt: iso(row.occurred_at),
    recordedAt: iso(row.recorded_at),
  };
}

function projectCompletionPhotoRecord(row: ProjectCompletionPhotoRow): ProjectCompletionPhotoRecord {
  return {
    id: row.photo_id,
    userId: row.photo_user_id,
    projectId: row.project_id,
    projectRevision: row.project_revision,
    assetId: row.photo_asset_id,
    createdAt: iso(row.photo_created_at),
    deletedAt: row.photo_deleted_at ? iso(row.photo_deleted_at) : null,
    asset: assetRecord({
      id: row.asset_id,
      user_id: row.asset_user_id,
      purpose: row.asset_purpose,
      consent_version: row.asset_consent_version,
      sha256: row.asset_sha256,
      mime_type: row.asset_mime_type,
      size_bytes: row.asset_size_bytes,
      width: row.asset_width,
      height: row.asset_height,
      storage_key: row.asset_storage_key,
      expires_at: row.asset_expires_at,
      ready_at: row.asset_ready_at,
      deleted_at: row.asset_deleted_at,
      purged_at: row.asset_purged_at,
      created_at: row.asset_created_at,
    }),
  };
}

const PROJECT_COMPLETION_PHOTO_SELECT = `
  SELECT photo.id AS photo_id,
         photo.user_id AS photo_user_id,
         photo.project_id,
         photo.project_revision,
         photo.asset_id AS photo_asset_id,
         photo.created_at AS photo_created_at,
         photo.deleted_at AS photo_deleted_at,
         asset.id AS asset_id,
         asset.user_id AS asset_user_id,
         asset.purpose AS asset_purpose,
         asset.consent_version AS asset_consent_version,
         asset.sha256 AS asset_sha256,
         asset.mime_type AS asset_mime_type,
         asset.size_bytes AS asset_size_bytes,
         asset.width AS asset_width,
         asset.height AS asset_height,
         asset.storage_key AS asset_storage_key,
         asset.expires_at AS asset_expires_at,
         asset.ready_at AS asset_ready_at,
         asset.deleted_at AS asset_deleted_at,
         asset.purged_at AS asset_purged_at,
         asset.created_at AS asset_created_at
  FROM project_completion_photos AS photo
  JOIN assets AS asset ON asset.id = photo.asset_id AND asset.user_id = photo.user_id`;

function exportJobRecord(row: ExportJobRow): ExportJobRecord {
  let artifact: ExportArtifactRecord | null = null;
  if (row.artifact_id && row.artifact_job_id && row.artifact_storage_key && row.artifact_mime_type
    && row.artifact_file_name && row.artifact_size_bytes !== null && row.artifact_sha256
    && row.artifact_expires_at && row.artifact_created_at) {
    artifact = {
      id: row.artifact_id,
      jobId: row.artifact_job_id,
      storageKey: row.artifact_storage_key,
      mimeType: row.artifact_mime_type,
      fileName: row.artifact_file_name,
      sizeBytes: Number(row.artifact_size_bytes),
      sha256: row.artifact_sha256,
      expiresAt: iso(row.artifact_expires_at),
      createdAt: iso(row.artifact_created_at),
    };
  }
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    projectRevision: row.project_revision,
    format: row.format,
    fileName: row.file_name,
    options: row.options,
    status: row.status,
    progress: row.progress,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    availableAt: iso(row.available_at),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    finishedAt: row.finished_at ? iso(row.finished_at) : null,
    artifact,
  };
}

function exportArtifactPurgeRecord(row: ExportArtifactPurgeRow): ExportArtifactPurgeRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    userId: row.user_id,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    fileName: row.file_name,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

function paymentOrderRecord(row: PaymentOrderRow): PaymentOrderRecord {
  return {
    id: row.id,
    userId: row.user_id,
    productId: row.product_id,
    productVersion: row.product_version,
    productName: row.product_name,
    creditAmount: row.credit_amount,
    amountCents: row.amount_cents,
    currency: row.currency,
    outTradeNo: row.out_trade_no,
    status: row.status,
    providerReference: row.provider_reference,
    providerTradeState: row.provider_trade_state,
    providerTransactionId: row.provider_transaction_id,
    paymentExpiresAt: iso(row.payment_expires_at),
    paidAt: row.paid_at ? iso(row.paid_at) : null,
    closedAt: row.closed_at ? iso(row.closed_at) : null,
    lastReconciledAt: row.last_reconciled_at ? iso(row.last_reconciled_at) : null,
    lateSuccessAt: row.late_success_at ? iso(row.late_success_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function paymentReconciliationJob(row: PaymentReconciliationJobRow): PaymentReconciliationJob {
  return {
    orderId: row.order_id,
    state: row.state,
    availableAt: iso(row.available_at),
    attemptCount: row.attempt_count,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
    lastObservedTradeState: row.last_observed_trade_state,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function paymentOrderAttemptReservation(
  row: PaymentOrderAttemptRow,
  expired: boolean,
  created = false,
): PaymentOrderSlotReservation {
  return {
    attemptNo: row.attempt_no,
    outTradeNo: row.out_trade_no,
    expiresAt: iso(row.expires_at),
    expired,
    created,
    state: row.state,
    recoveryCiphertext: row.recovery_ciphertext,
    providerReferenceSha256: row.provider_reference_sha256,
  };
}

function inventoryItem(row: InventoryRow): InventoryItem {
  return {
    userId: row.user_id,
    paletteId: row.palette_id,
    colorCode: row.color_code,
    quantity: row.quantity,
    location: row.location,
    revision: row.revision,
    updatedAt: iso(row.updated_at),
  };
}

function inventoryOperation(row: InventoryOperationRow): InventoryOperation {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.transaction_type,
    projectId: row.project_id,
    projectRevision: row.project_revision,
    idempotencyReference: row.idempotency_reference,
    consumedAt: row.consumed_at === null ? null : iso(row.consumed_at),
    createdAt: iso(row.created_at),
  };
}

function inventoryTransaction(row: InventoryTransactionRow): InventoryTransaction {
  return {
    id: row.id,
    operationId: row.operation_id,
    userId: row.user_id,
    type: row.transaction_type,
    paletteId: row.palette_id,
    colorCode: row.color_code,
    quantityBefore: row.quantity_before,
    delta: row.delta,
    quantityAfter: row.quantity_after,
    locationBefore: row.location_before,
    locationAfter: row.location_after,
    projectId: row.project_id,
    projectRevision: row.project_revision,
    idempotencyReference: row.idempotency_reference,
    createdAt: iso(row.created_at),
  };
}

function projectGridStats(grid: PatternGrid): { beadCount: number; colorCount: number } {
  const colors = grid.cells.filter((cell): cell is string => cell !== null);
  return { beadCount: colors.length, colorCount: new Set(colors).size };
}

const EXPORT_JOB_SELECT = `
  SELECT j.*,
         a.id AS artifact_id,
         a.job_id AS artifact_job_id,
         a.storage_key AS artifact_storage_key,
         a.mime_type AS artifact_mime_type,
         a.file_name AS artifact_file_name,
         a.size_bytes AS artifact_size_bytes,
         a.sha256 AS artifact_sha256,
         a.expires_at AS artifact_expires_at,
         a.created_at AS artifact_created_at
  FROM export_jobs j
  LEFT JOIN export_artifacts a ON a.id = j.result_artifact_id AND a.ready_at IS NOT NULL`;

async function withTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function completionPhotoTableExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ relation_name: string | null }>(
    "SELECT to_regclass('public.project_completion_photos')::text AS relation_name",
  );
  return typeof result.rows[0]?.relation_name === "string";
}

async function assetUploadTableExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ relation_name: string | null }>(
    "SELECT to_regclass('public.asset_uploads')::text AS relation_name",
  );
  return typeof result.rows[0]?.relation_name === "string";
}

export class PostgresStore implements AppStore {
  constructor(
    private readonly pool: Pool,
    private readonly transactionClient?: PoolClient,
  ) {}

  private query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    return (this.transactionClient ?? this.pool).query<T>(text, values);
  }

  private async inTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.transactionClient) return operation(this.transactionClient);
    return withTransaction(this.pool, operation);
  }

  private async lockActivePaymentEffect(client: PoolClient, fence: PaymentEffectFence): Promise<void> {
    const owner = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [fence.userId],
    );
    if (!owner.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
    const claim = await client.query<{ active: boolean }>(
      `SELECT lease_expires_at > clock_timestamp() AS active
       FROM payment_effect_claims
       WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3
         AND request_hash = $4 AND lease_token = $5
       FOR UPDATE`,
      [fence.userId, fence.scope, fence.key, fence.requestHash, fence.leaseToken],
    );
    if (!claim.rows[0]?.active) {
      throw new AppError(503, "PAYMENT_EFFECT_LEASE_LOST", "支付请求处理租约已失效，请重试", null, true);
    }
  }

  private async completeActivePaymentEffect(client: PoolClient, fence: PaymentEffectFence): Promise<void> {
    const completed = await client.query(
      `DELETE FROM payment_effect_claims
       WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3
         AND request_hash = $4 AND lease_token = $5
         AND lease_expires_at > clock_timestamp()
       RETURNING user_id`,
      [fence.userId, fence.scope, fence.key, fence.requestHash, fence.leaseToken],
    );
    if (completed.rowCount !== 1) {
      throw new AppError(503, "PAYMENT_EFFECT_LEASE_LOST", "支付请求处理租约已失效，请重试", null, true);
    }
  }

  async ready(): Promise<void> {
    const [expectedMigrations, appliedMigrations] = await Promise.all([
      requiredMigrationManifest(),
      this.query<ReadinessMigrationRow>(
        "SELECT version, checksum::text AS checksum FROM schema_migrations ORDER BY version",
      ),
    ]);
    const expectedMigrationsByVersion = new Map(
      expectedMigrations.map((migration) => [migration.version, migration]),
    );
    const appliedVersions = new Set(appliedMigrations.rows.map((row) => row.version));
    const missingMigrations = expectedMigrations
      .map((migration) => migration.version)
      .filter((version) => !appliedVersions.has(version));
    const expectedVersions = new Set(expectedMigrationsByVersion.keys());
    const unexpectedMigrations = appliedMigrations.rows
      .map((row) => row.version)
      .filter((version) => !expectedVersions.has(version));
    const checksumMismatches = appliedMigrations.rows.flatMap((row) => {
      const expected = expectedMigrationsByVersion.get(row.version);
      if (!expected || row.checksum === expected.checksum) return [];
      return [{
        version: row.version,
        expectedChecksum: expected.checksum,
        actualChecksum: row.checksum,
      }];
    });
    if (missingMigrations.length > 0
      || unexpectedMigrations.length > 0
      || checksumMismatches.length > 0) {
      throw new AppError(503, "DATABASE_MIGRATIONS_PENDING", "数据库迁移尚未全部应用", {
        missingMigrations,
        unexpectedMigrations,
        checksumMismatches,
      });
    }

    const expectedPaletteIds = BUILTIN_PALETTES.map((palette) => palette.id);
    const activeBuiltinPalettes = await this.query<{ id: string }>(
      `SELECT id
       FROM palettes
       WHERE owner_user_id IS NULL AND NOT retired
       ORDER BY array_position($1::text[], id) NULLS LAST, id`,
      [expectedPaletteIds],
    );
    const activeBuiltinPaletteIds = activeBuiltinPalettes.rows.map((row) => row.id);
    if (activeBuiltinPaletteIds.length !== expectedPaletteIds.length
      || expectedPaletteIds.some((id, index) => activeBuiltinPaletteIds[index] !== id)) {
      throw new AppError(503, "DATABASE_PALETTE_SEED_INCOMPLETE", "内置色卡种子尚未就绪", {
        expectedPaletteIds,
        activeBuiltinPaletteIds,
      });
    }
    const seededPalettes = await this.query<ReadinessPaletteRow>(
      `SELECT p.id, p.name AS palette_name, p.brand, p.series, p.material,
              p.bead_size_mm, p.verified, p.version,
              p.source_name, p.source_url, p.source_revision, p.source_license, p.retired,
              c.code, c.name AS color_name, c.hex, c.finish,
              c.unit_price_cents, c.sort_order, c.available
       FROM palettes p
       LEFT JOIN palette_colors c ON c.palette_id = p.id
       WHERE p.id = ANY($1::text[])
       ORDER BY p.id, c.sort_order`,
      [expectedPaletteIds],
    );
    const palettesById = new Map<string, {
      name: string;
      brand: string;
      series: string;
      material: string;
      beadSizeMm: number;
      verified: boolean;
      version: number;
      source: NonNullable<Palette["source"]>;
      retired: boolean;
      colors: Map<string, {
        name: string;
        hex: string;
        finish: NonNullable<Palette["colors"][number]["finish"]>;
        unitPriceCents: number;
        sortOrder: number;
        available: boolean;
      }>;
    }>();
    for (const row of seededPalettes.rows) {
      const actual = palettesById.get(row.id) ?? {
        name: row.palette_name,
        brand: row.brand,
        series: row.series,
        material: row.material,
        beadSizeMm: Number(row.bead_size_mm),
        verified: row.verified,
        version: row.version,
        source: {
          name: row.source_name,
          url: row.source_url,
          revision: row.source_revision,
          license: row.source_license,
        },
        retired: row.retired,
        colors: new Map(),
      };
      if (row.code !== null && row.color_name !== null && row.hex !== null
        && row.finish !== null && row.unit_price_cents !== null
        && row.sort_order !== null && row.available !== null) {
        actual.colors.set(row.code, {
          name: row.color_name,
          hex: row.hex,
          finish: row.finish,
          unitPriceCents: row.unit_price_cents,
          sortOrder: row.sort_order,
          available: row.available,
        });
      }
      palettesById.set(row.id, actual);
    }
    const incompletePalettes = BUILTIN_PALETTES.flatMap((expected) => {
      const actual = palettesById.get(expected.id);
      const missingColorCodes = expected.colors
        .map((color) => color.code)
        .filter((code) => !actual?.colors.has(code));
      const mismatchedColorCodes = expected.colors.flatMap((color, sortOrder) => {
        const actualColor = actual?.colors.get(color.code);
        if (!actualColor || (actualColor.name === color.name
          && actualColor.hex === color.hex
          && actualColor.finish === (color.finish ?? "solid")
          && actualColor.unitPriceCents === color.unitPriceCents
          && actualColor.sortOrder === sortOrder
          && actualColor.available === color.available)) return [];
        return [color.code];
      });
      const expectedCodes = new Set(expected.colors.map((color) => color.code));
      const unexpectedColorCodes = [...(actual?.colors.keys() ?? [])]
        .filter((code) => !expectedCodes.has(code));
      const expectedSource = expected.source ?? {
        name: "user import",
        url: "",
        revision: "1",
        license: "user supplied",
      };
      if (actual?.name === expected.name
        && actual.brand === expected.brand
        && actual.series === (expected.series ?? expected.name)
        && actual.material === (expected.material ?? "PE")
        && actual.beadSizeMm === expected.beadSizeMm
        && actual.verified === expected.verified
        && actual.version === expected.version
        && actual.retired === (expected.retired ?? false)
        && actual.source.name === expectedSource.name
        && actual.source.url === expectedSource.url
        && actual.source.revision === expectedSource.revision
        && actual.source.license === expectedSource.license
        && missingColorCodes.length === 0
        && mismatchedColorCodes.length === 0
        && unexpectedColorCodes.length === 0) return [];
      return [{
        id: expected.id,
        expectedName: expected.name,
        actualName: actual?.name ?? null,
        expectedVersion: expected.version,
        actualVersion: actual?.version ?? null,
        missingColorCodes,
        mismatchedColorCodes,
        unexpectedColorCodes,
      }];
    });
    if (incompletePalettes.length > 0) {
      throw new AppError(503, "DATABASE_PALETTE_SEED_INCOMPLETE", "内置色卡种子尚未就绪", {
        incompletePalettes,
      });
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createDevSession(input: {
    displayName: string;
    tokenHash: string;
    expiresAt: string;
    startingCredits: number;
  }): Promise<AuthSession> {
    return this.inTransaction(async (client) => {
      const userId = randomUUID();
      const ledgerId = randomUUID();
      const inserted = await client.query<{ created_at: Date | string }>(
        "INSERT INTO users(id, display_name) VALUES ($1, $2) RETURNING created_at",
        [userId, input.displayName],
      );
      await client.query(
        "INSERT INTO sessions(token_hash, user_id, expires_at, created_new_user) VALUES ($1, $2, $3, true)",
        [input.tokenHash, userId, input.expiresAt],
      );
      await client.query(
        "INSERT INTO credit_accounts(user_id, balance) VALUES ($1, $2)",
        [userId, input.startingCredits],
      );
      await client.query(
        `INSERT INTO credit_ledger(id, user_id, delta, balance_after, reason)
         VALUES ($1, $2, $3, $3, 'dev_welcome_credit')`,
        [ledgerId, userId, input.startingCredits],
      );
      const createdAt = inserted.rows[0]?.created_at;
      if (!createdAt) throw new AppError(500, "USER_CREATE_FAILED", "开发用户创建失败");
      return {
        user: { id: userId, displayName: input.displayName, createdAt: iso(createdAt) },
        expiresAt: input.expiresAt,
        createdNewUser: true,
      };
    });
  }

  async createWechatSession(input: Parameters<AppStore["createWechatSession"]>[0]): Promise<AuthSession> {
    return this.inTransaction(async (client) => {
      const proposedUserId = randomUUID();
      const inserted = await client.query<{
        id: string;
        display_name: string;
        created_at: Date | string;
      }>(
        `INSERT INTO users(id, display_name, wechat_openid)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id, display_name, created_at`,
        [proposedUserId, input.displayName, input.openId],
      );
      const createdUser = inserted.rows[0];
      let user = createdUser;
      if (!user) {
        const existing = await client.query<{
          id: string;
          display_name: string;
          created_at: Date | string;
        }>(
          "SELECT id, display_name, created_at FROM users WHERE wechat_openid = $1 FOR UPDATE",
          [input.openId],
        );
        user = existing.rows[0];
      }
      if (!user) throw new AppError(500, "WECHAT_USER_CREATE_FAILED", "微信用户创建失败");
      const createdNewUser = Boolean(createdUser);
      const startingCredits = createdUser ? input.developmentStartingCredits ?? 0 : 0;
      await client.query(
        `INSERT INTO credit_accounts(user_id, balance)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [user.id, startingCredits],
      );
      if (createdUser && startingCredits > 0) {
        await client.query(
          `INSERT INTO credit_ledger(id, user_id, delta, balance_after, reason)
           VALUES ($1, $2, $3, $3, 'dev_welcome_credit')`,
          [randomUUID(), user.id, startingCredits],
        );
      }
      await client.query(
        "DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()",
        [user.id],
      );
      await client.query(
        "INSERT INTO sessions(token_hash, user_id, expires_at, created_new_user) VALUES ($1, $2, $3, $4)",
        [input.tokenHash, user.id, input.expiresAt, createdNewUser],
      );
      await client.query(
        `DELETE FROM sessions
         WHERE token_hash IN (
           SELECT token_hash
           FROM sessions
           WHERE user_id = $1 AND expires_at > now()
           ORDER BY (token_hash = $2) DESC, created_at DESC, token_hash DESC
           OFFSET $3
         )`,
        [user.id, input.tokenHash, MAX_ACTIVE_SESSIONS_PER_USER],
      );
      return {
        user: { id: user.id, displayName: user.display_name, createdAt: iso(user.created_at) },
        expiresAt: input.expiresAt,
        createdNewUser,
      };
    });
  }

  async resolveSession(tokenHash: string): Promise<AuthSession | null> {
    const result = await this.query<{
      id: string;
      display_name: string;
      created_at: Date | string;
      expires_at: Date | string;
      created_new_user: boolean | null;
    }>(
      `SELECT u.id, u.display_name, u.created_at, s.expires_at, s.created_new_user
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? {
      user: { id: row.id, displayName: row.display_name, createdAt: iso(row.created_at) },
      expiresAt: iso(row.expires_at),
      createdNewUser: Boolean(row.created_new_user),
    } : null;
  }

  async revokeSession(tokenHash: string): Promise<boolean> {
    const result = await this.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
    return (result.rowCount ?? 0) > 0;
  }

  async getWechatOpenId(userId: string): Promise<string | null> {
    const result = await this.query<{ wechat_openid: string | null }>(
      "SELECT wechat_openid FROM users WHERE id = $1",
      [userId],
    );
    return result.rows[0]?.wechat_openid ?? null;
  }

  async createWebLoginChallenge(input: Parameters<AppStore["createWebLoginChallenge"]>[0]): Promise<void> {
    await this.inTransaction(async (client) => {
      await client.query(
        `DELETE FROM web_login_challenges
         WHERE token_hash IN (
           SELECT token_hash FROM web_login_challenges
           WHERE expires_at <= clock_timestamp()
           ORDER BY expires_at, token_hash
           FOR UPDATE SKIP LOCKED
           LIMIT 500
         )`,
      );
      const inserted = await client.query(
        `INSERT INTO web_login_challenges(token_hash, session_token_hash, code, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING token_hash`,
        [input.tokenHash, input.sessionTokenHash, input.code, input.expiresAt],
      );
      if (!inserted.rows[0]) throw new AppError(409, "WEB_LOGIN_CODE_COLLISION", "登录码冲突，请重试");
    });
  }

  async getWebLoginChallenge(tokenHash: string): Promise<{ status: "pending" | "approved" | "expired"; expiresAt: string } | null> {
    const result = await this.query<{ status: "pending" | "approved"; expires_at: Date | string }>(
      "SELECT status, expires_at FROM web_login_challenges WHERE token_hash = $1",
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    const expiresAt = iso(row.expires_at);
    return { status: Date.parse(expiresAt) <= Date.now() ? "expired" : row.status, expiresAt };
  }

  async confirmWebLoginChallenge(input: Parameters<AppStore["confirmWebLoginChallenge"]>[0]): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const owner = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [input.userId],
      );
      if (!owner.rows[0]) return false;
      await client.query(
        "DELETE FROM sessions WHERE user_id = $1 AND expires_at <= clock_timestamp()",
        [input.userId],
      );
      const result = await client.query<{ token_hash: string; session_token_hash: string }>(
        `UPDATE web_login_challenges
         SET status = 'approved', user_id = $2, approved_at = now()
         WHERE code = $1 AND status = 'pending' AND expires_at > clock_timestamp()
         RETURNING token_hash, session_token_hash`,
        [input.code, input.userId],
      );
      const challenge = result.rows[0];
      if (!challenge) return false;
      await client.query(
        "INSERT INTO sessions(token_hash, user_id, expires_at, created_new_user) VALUES ($1, $2, $3, false)",
        [challenge.session_token_hash, input.userId, input.sessionExpiresAt],
      );
      if (input.createPollTokenSession) {
        await client.query(
          "INSERT INTO sessions(token_hash, user_id, expires_at, created_new_user) VALUES ($1, $2, $3, false)",
          [challenge.token_hash, input.userId, input.sessionExpiresAt],
        );
      }
      await client.query(
        `DELETE FROM sessions
         WHERE token_hash IN (
           SELECT token_hash FROM sessions
           WHERE user_id = $1 AND expires_at > clock_timestamp()
           ORDER BY
             CASE token_hash WHEN $2 THEN 2 WHEN $3 THEN 1 ELSE 0 END DESC,
             created_at DESC,
             token_hash DESC
           OFFSET $4
         )`,
        [
          input.userId,
          challenge.session_token_hash,
          input.createPollTokenSession ? challenge.token_hash : null,
          MAX_ACTIVE_SESSIONS_PER_USER,
        ],
      );
      return true;
    });
  }

  async getCreationDraft(userId: string): Promise<CreationDraft | null> {
    const result = await this.query<CreationDraftRow>(
      "SELECT * FROM creation_drafts WHERE user_id = $1",
      [userId],
    );
    const row = result.rows[0];
    return row ? creationDraft(row) : null;
  }

  async saveCreationDraft(input: SaveCreationDraftInput): Promise<CreationDraft> {
    return this.inTransaction(async (client) => {
      const options = deserializeGenerationOptions(input.options);
      const owner = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [input.userId],
      );
      if (!owner.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
      await this.requireSelectablePalette(client, input.userId, input.paletteId);
      const existingResult = await client.query<CreationDraftRow>(
        "SELECT * FROM creation_drafts WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        if (input.draftId !== null || input.baseDraftRevision !== 0) {
          throw new AppError(409, "CREATION_DRAFT_REVISION_CONFLICT", "创建草稿已被清除或替换", {
            currentDraftId: null,
            currentDraftRevision: 0,
          });
        }
      } else if (input.draftId !== existing.id) {
        throw new AppError(409, "CREATION_DRAFT_ID_CONFLICT", "另一个创建流程已替换当前草稿", {
          currentDraftId: existing.id,
          currentDraftRevision: existing.draft_revision,
        });
      } else if (input.baseDraftRevision !== existing.draft_revision) {
        throw new AppError(409, "CREATION_DRAFT_REVISION_CONFLICT", "创建草稿已在其他设备更新", {
          currentDraftId: existing.id,
          currentDraftRevision: existing.draft_revision,
        });
      }
      if (input.sourceAssetId !== null) {
        const source = await client.query<{ id: string }>(
          `SELECT id FROM assets
           WHERE id = $1 AND user_id = $2 AND purpose = 'ai-source'
             AND ready_at IS NOT NULL
             AND deleted_at IS NULL AND purged_at IS NULL
             AND expires_at > clock_timestamp()
           FOR SHARE`,
          [input.sourceAssetId, input.userId],
        );
        if (!source.rows[0]) {
          throw new AppError(404, "CREATION_DRAFT_SOURCE_ASSET_NOT_FOUND", "创建草稿引用的原始素材不存在");
        }
      }
      const saved = await client.query<CreationDraftRow>(
        `INSERT INTO creation_drafts(
           user_id, id, draft_revision, name, kind, setup_step, palette_id,
           source_asset_id, width, height, options, grid_encoding, grid_cells, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11::jsonb, $12, $13::jsonb, clock_timestamp()
         )
         ON CONFLICT (user_id) DO UPDATE SET
           id = EXCLUDED.id,
           draft_revision = EXCLUDED.draft_revision,
           name = EXCLUDED.name,
           kind = EXCLUDED.kind,
           setup_step = EXCLUDED.setup_step,
           palette_id = EXCLUDED.palette_id,
           source_asset_id = EXCLUDED.source_asset_id,
           width = EXCLUDED.width,
           height = EXCLUDED.height,
           options = EXCLUDED.options,
           grid_encoding = EXCLUDED.grid_encoding,
           grid_cells = EXCLUDED.grid_cells,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          input.userId,
          existing?.id ?? randomUUID(),
          (existing?.draft_revision ?? 0) + 1,
          input.name,
          input.kind,
          input.setupStep,
          input.paletteId,
          input.sourceAssetId,
          input.width,
          input.height,
          JSON.stringify(options),
          input.grid?.encoding ?? null,
          input.grid ? JSON.stringify(input.grid.cells) : null,
        ],
      );
      const row = saved.rows[0];
      if (!row) throw new AppError(500, "CREATION_DRAFT_SAVE_FAILED", "创建草稿保存失败");
      return creationDraft(row);
    });
  }

  async commitCreationDraft(
    input: Parameters<AppStore["commitCreationDraft"]>[0],
  ): Promise<ProjectDetail> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      const draftResult = await client.query<CreationDraftRow>(
        "SELECT * FROM creation_drafts WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      const draft = draftResult.rows[0];
      if (!draft) throw new AppError(404, "CREATION_DRAFT_NOT_FOUND", "创建草稿不存在");
      if (draft.id !== input.draftId) {
        throw new AppError(409, "CREATION_DRAFT_ID_CONFLICT", "另一个创建流程已替换当前草稿", {
          currentDraftId: draft.id,
          currentDraftRevision: draft.draft_revision,
        });
      }
      if (draft.draft_revision !== input.draftRevision) {
        throw new AppError(409, "CREATION_DRAFT_REVISION_CONFLICT", "创建草稿已在其他设备更新", {
          currentDraftId: draft.id,
          currentDraftRevision: draft.draft_revision,
        });
      }
      if (!draft.grid_encoding || !draft.grid_cells) {
        throw new AppError(409, "CREATION_DRAFT_NOT_READY", "创建草稿尚未生成可提交的图纸");
      }
      const sourceAssetId = draft.source_asset_id
        && await this.projectAssetIsAvailable(client, input.userId, draft.source_asset_id, "ai-source")
        ? draft.source_asset_id
        : null;
      const draftOptions = deserializeGenerationOptions(draft.options);
      const project = await this.insertProject(client, input.userId, {
        name: draft.name,
        paletteId: draft.palette_id,
        grid: {
          encoding: draft.grid_encoding,
          width: draft.width,
          height: draft.height,
          cells: draft.grid_cells,
        },
        mode: draft.kind,
        lifecycleStatus: "editable",
        sourceAssetId,
        previewAssetId: null,
        backgroundMode: draftOptions.transparentBackground ? "transparent" : "white",
        backgroundColor: null,
      });
      await client.query("DELETE FROM creation_drafts WHERE user_id = $1", [input.userId]);
      return project;
    });
  }

  async discardCreationDraft(
    input: Parameters<AppStore["discardCreationDraft"]>[0],
  ): Promise<boolean> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      const draftResult = await client.query<CreationDraftRow>(
        "SELECT * FROM creation_drafts WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      const draft = draftResult.rows[0];
      if (!draft) return false;
      if (draft.id !== input.draftId) {
        throw new AppError(409, "CREATION_DRAFT_ID_CONFLICT", "另一个创建流程已替换当前草稿", {
          currentDraftId: draft.id,
          currentDraftRevision: draft.draft_revision,
        });
      }
      if (draft.draft_revision !== input.draftRevision) {
        throw new AppError(409, "CREATION_DRAFT_REVISION_CONFLICT", "创建草稿已在其他设备更新", {
          currentDraftId: draft.id,
          currentDraftRevision: draft.draft_revision,
        });
      }
      await client.query("DELETE FROM creation_drafts WHERE user_id = $1", [input.userId]);
      return true;
    });
  }

  async createAsset(input: CreateAssetInput): Promise<AssetRecord> {
    const completionAsset = input.purpose === "project-completion";
    if (completionAsset
      ? input.consentVersion !== null || input.expiresAt !== null
      : input.consentVersion === null || input.expiresAt === null) {
      throw new AppError(400, "ASSET_LIFECYCLE_INVALID", "素材用途与隐私同意、保留期限不匹配");
    }
    return this.inTransaction(async (client) => {
      const owner = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [input.userId],
      );
      if (!owner.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
      const historyCutoff = new Date(
        Date.parse(input.createdAt) - OPERATIONAL_HISTORY_RETENTION_MILLISECONDS,
      ).toISOString();
      await client.query(
        `DELETE FROM assets AS asset
         WHERE asset.user_id = $1
           AND asset.purged_at < $2
           AND NOT EXISTS (
             SELECT 1 FROM generation_jobs AS job WHERE job.source_asset_id = asset.id
           )`,
        [input.userId, historyCutoff],
      );
      const history = await client.query<{ asset_count: number | string }>(
        "SELECT count(*) AS asset_count FROM assets WHERE user_id = $1",
        [input.userId],
      );
      if (Number(history.rows[0]?.asset_count ?? 0) >= MAX_ASSET_HISTORY_PER_USER) {
        throw new AppError(429, "ASSET_HISTORY_LIMIT_EXCEEDED", "素材历史记录已达到上限", {
          limit: MAX_ASSET_HISTORY_PER_USER,
          retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
        });
      }
      const usage = await client.query<{ asset_count: number | string; total_bytes: number | string }>(
        `SELECT count(*) AS asset_count, COALESCE(sum(size_bytes), 0) AS total_bytes
         FROM assets
         WHERE user_id = $1 AND purged_at IS NULL
           AND CASE WHEN $2::boolean
             THEN purpose = 'project-completion'
             ELSE purpose <> 'project-completion'
           END`,
        [input.userId, completionAsset],
      );
      const activeCount = Number(usage.rows[0]?.asset_count ?? 0);
      const activeBytes = Number(usage.rows[0]?.total_bytes ?? 0);
      const maxAssetCount = completionAsset
        ? MAX_ACTIVE_COMPLETION_PHOTOS_PER_USER
        : MAX_ACTIVE_ASSETS_PER_USER;
      const maxTotalBytes = completionAsset
        ? MAX_ACTIVE_COMPLETION_PHOTO_BYTES_PER_USER
        : MAX_ACTIVE_ASSET_BYTES_PER_USER;
      if (activeCount >= maxAssetCount || activeBytes + input.sizeBytes > maxTotalBytes) {
        throw new AppError(429, completionAsset ? "COMPLETION_PHOTO_STORAGE_LIMIT_EXCEEDED" : "ASSET_QUOTA_EXCEEDED", completionAsset
          ? "完工照片私有空间已达到上限"
          : "私有素材空间已达到上限", {
          maxAssetCount,
          maxTotalBytes,
        });
      }
      const result = await client.query<AssetRow>(
        `INSERT INTO assets(
           id, user_id, purpose, consent_version, sha256, mime_type, size_bytes,
           width, height, storage_key, expires_at, created_at, purge_available_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         RETURNING *`,
        [
          input.id,
          input.userId,
          input.purpose,
          input.consentVersion,
          input.sha256,
          input.mimeType,
          input.sizeBytes,
          input.width,
          input.height,
          input.storageKey,
          input.expiresAt,
          input.createdAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new AppError(500, "ASSET_CREATE_FAILED", "素材元数据创建失败");
      return assetRecord(row);
    });
  }

  async reserveAssetUpload(
    input: Parameters<AppStore["reserveAssetUpload"]>[0],
  ): Promise<AssetUploadReservation> {
    if (input.asset.userId !== input.userId || input.asset.purpose === "project-completion"
      || input.asset.consentVersion === null || input.asset.expiresAt === null
      || input.scope.length < 1 || input.scope.length > 100
      || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128
      || !/^[0-9a-f]{64}$/.test(input.requestHash)
      || !input.uploadLeaseToken || !Number.isFinite(Date.parse(input.uploadLeaseAcquiredAt))) {
      throw new AppError(400, "ASSET_UPLOAD_RESERVATION_INVALID", "素材上传预约参数无效");
    }
    return this.inTransaction(async (client) => {
      const owner = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [input.userId],
      );
      if (!owner.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");

      const found = await client.query<{
        request_hash: string;
        asset_id: string;
        upload_lease_token: string;
        upload_lease_expires_at: Date | string;
      }>(
        `SELECT request_hash, asset_id, upload_lease_token::text, upload_lease_expires_at
         FROM asset_uploads
         WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3`,
        [input.userId, input.scope, input.idempotencyKey],
      );
      const candidate = found.rows[0];
      if (candidate) {
        if (candidate.request_hash !== input.requestHash) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
        }
        const lockedAsset = await client.query<AssetRow & { expired: boolean }>(
          `SELECT asset.*,
                  asset.expires_at IS NOT NULL AND asset.expires_at <= clock_timestamp() AS expired
           FROM assets AS asset
           WHERE asset.id = $1 AND asset.user_id = $2
           FOR UPDATE`,
          [candidate.asset_id, input.userId],
        );
        const lockedUpload = await client.query<{
          request_hash: string;
          asset_id: string;
          upload_lease_token: string;
          upload_lease_expires_at: Date | string;
        }>(
          `SELECT request_hash, asset_id, upload_lease_token::text, upload_lease_expires_at
           FROM asset_uploads
           WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3
           FOR UPDATE`,
          [input.userId, input.scope, input.idempotencyKey],
        );
        const upload = lockedUpload.rows[0];
        const row = lockedAsset.rows[0];
        if (!upload || upload.asset_id !== candidate.asset_id || !row
          || row.deleted_at !== null || row.purged_at !== null
          || row.expired) {
          throw new AppError(410, "ASSET_UPLOAD_UNAVAILABLE", "该素材上传已删除或超时，请使用新的幂等键重试");
        }
        let uploadLeaseToken = upload.upload_lease_token;
        let uploadLeaseExpiresAt = iso(upload.upload_lease_expires_at);
        if (row.ready_at === null) {
          const renewed = await client.query<{
            upload_lease_token: string;
            upload_lease_expires_at: Date | string;
          }>(
            `UPDATE asset_uploads
             SET upload_lease_token = CASE
                   WHEN upload_lease_expires_at > clock_timestamp() THEN upload_lease_token
                   ELSE $4::uuid
                 END,
                 upload_lease_expires_at = GREATEST(
                   upload_lease_expires_at,
                   clock_timestamp() + ($5::bigint * interval '1 millisecond')
                 )
             WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3
             RETURNING upload_lease_token::text, upload_lease_expires_at`,
            [
              input.userId,
              input.scope,
              input.idempotencyKey,
              input.uploadLeaseToken,
              ASSET_UPLOAD_LEASE_MILLISECONDS,
            ],
          );
          const renewedRow = renewed.rows[0];
          if (!renewedRow) {
            throw new AppError(410, "ASSET_UPLOAD_UNAVAILABLE", "该素材上传已删除或超时，请使用新的幂等键重试");
          }
          uploadLeaseToken = renewedRow.upload_lease_token;
          uploadLeaseExpiresAt = iso(renewedRow.upload_lease_expires_at);
          await client.query(
            `UPDATE assets
             SET purge_available_at = GREATEST(purge_available_at, $2)
             WHERE id = $1 AND deleted_at IS NULL AND purged_at IS NULL`,
            [row.id, uploadLeaseExpiresAt],
          );
        }
        return {
          asset: assetRecord(row),
          replayed: true,
          uploadLeaseToken,
          uploadLeaseExpiresAt,
        };
      }

      const transactionStore = new PostgresStore(this.pool, client);
      const rateLimit = await transactionStore.consumeUserRateLimit({
        userId: input.userId,
        ...USER_RATE_LIMITS.assetUpload,
        now: input.uploadLeaseAcquiredAt,
      });
      if (!rateLimit.allowed) {
        throw new AppError(429, "USER_RATE_LIMITED", "请求过于频繁，请稍后重试", {
          retryAfterMilliseconds: rateLimit.retryAfterMilliseconds,
        });
      }
      const asset = await transactionStore.createAsset(input.asset);
      const inserted = await client.query<{
        upload_lease_token: string;
        upload_lease_expires_at: Date | string;
      }>(
        `INSERT INTO asset_uploads(
           user_id, scope, idempotency_key, request_hash, asset_id, asset_purpose,
           upload_lease_token, upload_lease_expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           clock_timestamp() + ($8::bigint * interval '1 millisecond')
         )
         RETURNING upload_lease_token::text, upload_lease_expires_at`,
        [
          input.userId,
          input.scope,
          input.idempotencyKey,
          input.requestHash,
          asset.id,
          asset.purpose,
          input.uploadLeaseToken,
          ASSET_UPLOAD_LEASE_MILLISECONDS,
        ],
      );
      const upload = inserted.rows[0];
      if (!upload) throw new AppError(500, "ASSET_UPLOAD_RESERVE_FAILED", "素材上传预约失败");
      const uploadLeaseExpiresAt = iso(upload.upload_lease_expires_at);
      await client.query(
        `UPDATE assets
         SET purge_available_at = GREATEST(purge_available_at, $2)
         WHERE id = $1`,
        [asset.id, uploadLeaseExpiresAt],
      );
      return {
        asset,
        replayed: false,
        uploadLeaseToken: upload.upload_lease_token,
        uploadLeaseExpiresAt,
      };
    });
  }

  async publishAssetUpload(
    input: Parameters<AppStore["publishAssetUpload"]>[0],
  ): Promise<AssetRecord> {
    return this.inTransaction(async (client) => {
      const found = await client.query<{ asset_id: string }>(
        `SELECT asset_id FROM asset_uploads
         WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3`,
        [input.userId, input.scope, input.idempotencyKey],
      );
      if (found.rows[0]?.asset_id !== input.assetId) {
        throw new AppError(410, "ASSET_UPLOAD_UNAVAILABLE", "素材上传预约已删除或超时");
      }
      const lockedAsset = await client.query<AssetRow & { expired: boolean }>(
        `SELECT asset.*,
                asset.expires_at IS NOT NULL AND asset.expires_at <= clock_timestamp() AS expired
         FROM assets AS asset
         WHERE asset.id = $1 AND asset.user_id = $2
         FOR UPDATE`,
        [input.assetId, input.userId],
      );
      const lockedUpload = await client.query<{
        upload_lease_token: string;
        upload_lease_active: boolean;
      }>(
        `SELECT upload_lease_token::text,
                upload_lease_expires_at > clock_timestamp() AS upload_lease_active
         FROM asset_uploads
         WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3 AND asset_id = $4
         FOR UPDATE`,
        [input.userId, input.scope, input.idempotencyKey, input.assetId],
      );
      const upload = lockedUpload.rows[0];
      if (!upload) throw new AppError(410, "ASSET_UPLOAD_UNAVAILABLE", "素材上传预约已删除或超时");
      if (upload.upload_lease_token !== input.uploadLeaseToken) {
        throw new AppError(409, "ASSET_UPLOAD_LEASE_LOST", "素材上传租约已过期或被接管，请重试", undefined, true);
      }
      const row = lockedAsset.rows[0];
      if (!row || row.deleted_at !== null || row.purged_at !== null || row.expired) {
        throw new AppError(410, "ASSET_UPLOAD_UNAVAILABLE", "素材上传已删除或超时");
      }
      const appendConsentEvent = async (readyRow: AssetRow): Promise<void> => {
        if (readyRow.purpose === "project-completion" || readyRow.consent_version === null
          || readyRow.ready_at === null) {
          throw new AppError(500, "ASSET_CONSENT_EVENT_INVALID", "AI 素材同意审计数据无效");
        }
        assertAssetConsentPolicySnapshot(readyRow.consent_version, input.consentPolicy);
        await client.query(
          `INSERT INTO asset_consent_events(
             id, user_id, asset_id, consent_version, asset_purpose,
             policy_sha256, processor, processing_purpose, retention, source,
             occurred_at, recorded_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'asset-upload', $10, $11)
           ON CONFLICT (asset_id) DO NOTHING`,
          [
            randomUUID(),
            readyRow.user_id,
            readyRow.id,
            readyRow.consent_version,
            readyRow.purpose,
            input.consentPolicy.policySha256,
            input.consentPolicy.processor,
            input.consentPolicy.processingPurpose,
            input.consentPolicy.retention,
            readyRow.created_at,
            readyRow.ready_at,
          ],
        );
        const persisted = await client.query<AssetConsentEventRow>(
          `SELECT id, user_id, asset_id, consent_version, asset_purpose,
                  policy_sha256, processor, processing_purpose, retention, source,
                  occurred_at, recorded_at
           FROM asset_consent_events
           WHERE asset_id = $1 AND user_id = $2`,
          [readyRow.id, readyRow.user_id],
        );
        const event = persisted.rows[0];
        if (!event
          || event.consent_version !== readyRow.consent_version
          || event.asset_purpose !== readyRow.purpose
          || event.policy_sha256 !== input.consentPolicy.policySha256
          || event.processor !== input.consentPolicy.processor
          || event.processing_purpose !== input.consentPolicy.processingPurpose
          || event.retention !== input.consentPolicy.retention) {
          throw new AppError(409, "ASSET_CONSENT_EVENT_CONFLICT", "素材已绑定不同的同意政策快照");
        }
      };
      if (row.ready_at !== null) {
        await appendConsentEvent(row);
        return assetRecord(row);
      }
      if (!upload.upload_lease_active) {
        throw new AppError(409, "ASSET_UPLOAD_LEASE_LOST", "素材上传租约已过期或被接管，请重试", undefined, true);
      }
      const published = await client.query<AssetRow>(
        `UPDATE assets
         SET ready_at = COALESCE(ready_at, $3)
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND purged_at IS NULL
           AND expires_at > clock_timestamp()
         RETURNING *`,
        [input.assetId, input.userId, input.readyAt],
      );
      const publishedRow = published.rows[0];
      if (!publishedRow) throw new AppError(410, "ASSET_UPLOAD_UNAVAILABLE", "素材上传已删除或超时");
      await appendConsentEvent(publishedRow);
      return assetRecord(publishedRow);
    });
  }

  async listAssetConsentEvents(
    input: Parameters<AppStore["listAssetConsentEvents"]>[0],
  ): Promise<AssetConsentEvent[]> {
    const result = await this.query<AssetConsentEventRow>(
      `SELECT id, user_id, asset_id, consent_version, asset_purpose,
              policy_sha256, processor, processing_purpose, retention, source,
              occurred_at, recorded_at
       FROM asset_consent_events
       WHERE user_id = $1
       ORDER BY occurred_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [input.userId, input.limit, input.offset],
    );
    return result.rows.map(assetConsentEvent);
  }

  async markAssetReady(userId: string, assetId: string, readyAt: string): Promise<AssetRecord | null> {
    const result = await this.query<AssetRow>(
      `UPDATE assets
       SET ready_at = COALESCE(ready_at, $3)
       WHERE id = $1 AND user_id = $2
         AND deleted_at IS NULL AND purged_at IS NULL
         AND (expires_at IS NULL OR expires_at > $3)
       RETURNING *`,
      [assetId, userId, readyAt],
    );
    const row = result.rows[0];
    return row ? assetRecord(row) : null;
  }

  async getAsset(userId: string, assetId: string): Promise<AssetRecord | null> {
    const result = await this.query<AssetRow>(
      "SELECT * FROM assets WHERE id = $1 AND user_id = $2",
      [assetId, userId],
    );
    const row = result.rows[0];
    return row ? assetRecord(row) : null;
  }

  async listAssets(input: Parameters<AppStore["listAssets"]>[0]): Promise<AssetRecord[]> {
    const result = await this.query<AssetRow>(
      `SELECT * FROM assets
       WHERE user_id = $1
         AND ($2::text IS NULL OR purpose = $2)
         AND ($3::text[] IS NULL OR purpose = ANY($3::text[]))
         AND (
           (ready_at IS NOT NULL AND (
             $4::boolean OR (
               deleted_at IS NULL AND purged_at IS NULL
               AND (expires_at IS NULL OR expires_at > $5)
             )
           ))
           OR ($4::boolean AND ready_at IS NULL AND deleted_at IS NOT NULL)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT $6 OFFSET $7`,
      [
        input.userId,
        input.purpose ?? null,
        input.purposes ?? null,
        input.includeDeleted,
        input.now,
        input.limit,
        input.offset ?? 0,
      ],
    );
    return result.rows.map(assetRecord);
  }

  async markAssetDeleted(userId: string, assetId: string, deletedAt: string): Promise<AssetRecord | null> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      await this.lockProjectsReferencingAsset(client, userId, assetId);
      const result = await client.query<AssetRow>(
        `UPDATE assets SET deleted_at = COALESCE(deleted_at, $3)
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [assetId, userId, deletedAt],
      );
      const row = result.rows[0];
      if (!row) return null;

      if (await completionPhotoTableExists(client)) {
        await client.query(
          `UPDATE project_completion_photos
           SET deleted_at = COALESCE(deleted_at, $2)
           WHERE asset_id = $1`,
          [assetId, deletedAt],
        );
      }

      await client.query(
        `UPDATE projects
         SET source_asset_id = CASE WHEN source_asset_id = $2 THEN NULL ELSE source_asset_id END,
             preview_asset_id = CASE WHEN preview_asset_id = $2 THEN NULL ELSE preview_asset_id END,
             updated_at = $3
         WHERE user_id = $1 AND (source_asset_id = $2 OR preview_asset_id = $2)`,
        [userId, assetId, deletedAt],
      );

      const jobs = await client.query<JobRow>(
        `SELECT * FROM generation_jobs
         WHERE user_id = $1 AND source_asset_id = $2
           AND status = ANY($3::text[])
         ORDER BY created_at, id
         FOR UPDATE`,
        [userId, assetId, GENERATION_CANCELABLE_STATUSES],
      );
      for (const job of jobs.rows) {
        const canceled = await client.query(
          `UPDATE generation_jobs
           SET status = 'canceled', lease_token = NULL, lease_expires_at = NULL,
               canceled_at = $2, updated_at = $2
           WHERE id = $1 AND status = ANY($3::text[])`,
          [job.id, deletedAt, GENERATION_CANCELABLE_STATUSES],
        );
        if ((canceled.rowCount ?? 0) > 0) {
          await this.releaseGenerationCredits(client, job, deletedAt);
        }
      }
      return assetRecord(row);
    });
  }

  async listAssetsForPurge(_now: string, limit: number): Promise<AssetRecord[]> {
    return this.inTransaction(async (client) => {
      const hasCompletionPhotos = await completionPhotoTableExists(client);
      const hasAssetUploads = await assetUploadTableExists(client);
      const uploadLeaseAvailable = `${hasCompletionPhotos
        ? `AND NOT EXISTS (
             SELECT 1 FROM project_completion_photo_uploads AS upload
             WHERE upload.asset_id = asset.id
               AND upload.upload_lease_expires_at > (SELECT now_at FROM database_clock)
           )`
        : ""}
        ${hasAssetUploads
    ? `AND NOT EXISTS (
             SELECT 1 FROM asset_uploads AS upload
             WHERE upload.asset_id = asset.id
               AND upload.upload_lease_expires_at > (SELECT now_at FROM database_clock)
           )`
    : ""}`;
      const result = await client.query<AssetRow>(
        `WITH database_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS now_at
         ), candidates AS (
         SELECT asset.*, 0 AS purge_priority, asset.deleted_at AS purge_sort_at
         FROM assets AS asset
         WHERE asset.purged_at IS NULL
           AND asset.deleted_at IS NOT NULL
           AND asset.purge_available_at <= (SELECT now_at FROM database_clock)
           ${uploadLeaseAvailable}
         UNION ALL
         SELECT asset.*, 1 AS purge_priority, asset.created_at AS purge_sort_at
         FROM assets AS asset
         WHERE asset.purged_at IS NULL
           AND asset.deleted_at IS NULL
           AND asset.ready_at IS NULL
           AND asset.created_at <= (SELECT now_at FROM database_clock)
             - ($2::bigint * interval '1 millisecond')
           AND asset.purge_available_at <= (SELECT now_at FROM database_clock)
           ${uploadLeaseAvailable}
         UNION ALL
         SELECT asset.*, 2 AS purge_priority, asset.expires_at AS purge_sort_at
         FROM assets AS asset
         WHERE asset.purged_at IS NULL
           AND asset.deleted_at IS NULL
           AND asset.expires_at <= (SELECT now_at FROM database_clock)
           AND (
             asset.ready_at IS NOT NULL
             OR asset.created_at > (SELECT now_at FROM database_clock)
               - ($2::bigint * interval '1 millisecond')
           )
           AND asset.purge_available_at <= (SELECT now_at FROM database_clock)
           ${uploadLeaseAvailable}
       )
       SELECT * FROM candidates
       ORDER BY purge_priority, purge_sort_at, id
       LIMIT $1`,
        [limit, ASSET_PUBLISH_TIMEOUT_MILLISECONDS],
      );
      return result.rows.map(assetRecord);
    });
  }

  async claimAssetForPurge(userId: string, assetId: string, _now: string): Promise<AssetRecord | null> {
    return this.inTransaction(async (client) => {
      const hasCompletionPhotos = await completionPhotoTableExists(client);
      const hasAssetUploads = await assetUploadTableExists(client);
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      await this.lockProjectsReferencingAsset(client, userId, assetId);
      const uploadLeaseAvailable = `${hasCompletionPhotos
        ? `AND NOT EXISTS (
             SELECT 1 FROM project_completion_photo_uploads AS upload
             WHERE upload.asset_id = asset.id
               AND upload.upload_lease_expires_at > database_clock.now_at
           )`
        : ""}
        ${hasAssetUploads
    ? `AND NOT EXISTS (
             SELECT 1 FROM asset_uploads AS upload
             WHERE upload.asset_id = asset.id
               AND upload.upload_lease_expires_at > database_clock.now_at
           )`
    : ""}`;
      const result = await client.query<AssetRow & { claim_at: Date | string }>(
        `WITH database_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS now_at
         )
         UPDATE assets AS asset
         SET deleted_at = COALESCE(deleted_at, database_clock.now_at),
             purge_available_at = database_clock.now_at + ($4::bigint * interval '1 millisecond')
         FROM database_clock
         WHERE asset.id = $1 AND asset.user_id = $2 AND asset.purged_at IS NULL
           AND asset.purge_available_at <= database_clock.now_at
           ${uploadLeaseAvailable}
           AND (
             asset.deleted_at IS NOT NULL
             OR asset.expires_at <= database_clock.now_at
             OR (
               asset.ready_at IS NULL
               AND asset.created_at <= database_clock.now_at
                 - ($3::bigint * interval '1 millisecond')
             )
           )
         RETURNING asset.*, database_clock.now_at AS claim_at`,
        [assetId, userId, ASSET_PUBLISH_TIMEOUT_MILLISECONDS, PURGE_CLAIM_MILLISECONDS],
      );
      const row = result.rows[0];
      if (!row) return null;
      const claimAt = iso(row.claim_at);

      if (hasCompletionPhotos) {
        await client.query(
          `UPDATE project_completion_photos
           SET deleted_at = COALESCE(deleted_at, $2)
           WHERE asset_id = $1`,
          [assetId, claimAt],
        );
      }

      await client.query(
        `UPDATE projects
         SET source_asset_id = CASE WHEN source_asset_id = $2 THEN NULL ELSE source_asset_id END,
             preview_asset_id = CASE WHEN preview_asset_id = $2 THEN NULL ELSE preview_asset_id END,
             updated_at = $3
         WHERE user_id = $1 AND (source_asset_id = $2 OR preview_asset_id = $2)`,
        [userId, assetId, claimAt],
      );

      const jobs = await client.query<JobRow>(
        `SELECT * FROM generation_jobs
         WHERE user_id = $1 AND source_asset_id = $2
           AND status = ANY($3::text[])
         ORDER BY created_at, id
         FOR UPDATE`,
        [userId, assetId, GENERATION_CANCELABLE_STATUSES],
      );
      for (const job of jobs.rows) {
        const canceled = await client.query(
          `UPDATE generation_jobs
           SET status = 'canceled', lease_token = NULL, lease_expires_at = NULL,
               canceled_at = $2, updated_at = $2
           WHERE id = $1 AND status = ANY($3::text[])`,
          [job.id, claimAt, GENERATION_CANCELABLE_STATUSES],
        );
        if ((canceled.rowCount ?? 0) > 0) await this.releaseGenerationCredits(client, job, claimAt);
      }
      return assetRecord(row);
    });
  }

  async recordAssetPurgeFailure(assetId: string, _failedAt: string): Promise<void> {
    await this.query(
      `WITH database_clock AS MATERIALIZED (
         SELECT clock_timestamp() AS now_at
       )
       UPDATE assets AS asset
       SET deleted_at = COALESCE(asset.deleted_at, database_clock.now_at),
           purged_at = NULL,
           purge_attempt_count = asset.purge_attempt_count + 1,
           purge_available_at = database_clock.now_at + (
             LEAST(
               $3::double precision,
               $2::double precision * power(2, LEAST(asset.purge_attempt_count, 16))
             ) * interval '1 millisecond'
           )
       FROM database_clock
       WHERE asset.id = $1`,
      [assetId, PURGE_RETRY_BASE_MILLISECONDS, PURGE_RETRY_MAX_MILLISECONDS],
    );
  }

  async markAssetPurged(assetId: string, purgedAt: string): Promise<void> {
    await this.inTransaction(async (client) => {
      const hasCompletionPhotos = await completionPhotoTableExists(client);
      const hasAssetUploads = await assetUploadTableExists(client);
      const owner = await client.query<{ user_id: string }>(
        "SELECT user_id FROM assets WHERE id = $1",
        [assetId],
      );
      const userId = owner.rows[0]?.user_id;
      if (!userId) return;
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      await this.lockProjectsReferencingAsset(client, userId, assetId);
      const inactiveUploadLease = `${hasCompletionPhotos
        ? `AND NOT EXISTS (
             SELECT 1 FROM project_completion_photo_uploads AS upload
             WHERE upload.asset_id = assets.id
               AND upload.upload_lease_expires_at > clock_timestamp()
           )`
        : ""}
        ${hasAssetUploads
    ? `AND NOT EXISTS (
             SELECT 1 FROM asset_uploads AS upload
             WHERE upload.asset_id = assets.id
               AND upload.upload_lease_expires_at > clock_timestamp()
           )`
    : ""}`;
      const purged = await client.query<{ user_id: string }>(
        `UPDATE assets
         SET deleted_at = COALESCE(deleted_at, $2), purged_at = COALESCE(purged_at, $2)
         WHERE id = $1 AND user_id = $3
           ${inactiveUploadLease}
         RETURNING user_id`,
        [assetId, purgedAt, userId],
      );
      const row = purged.rows[0];
      if (!row) return;
      if (hasCompletionPhotos) {
        await client.query(
          `UPDATE project_completion_photos
           SET deleted_at = COALESCE(deleted_at, $2)
           WHERE asset_id = $1`,
          [assetId, purgedAt],
        );
      }
      await client.query(
        `UPDATE projects
         SET source_asset_id = CASE WHEN source_asset_id = $2 THEN NULL ELSE source_asset_id END,
             preview_asset_id = CASE WHEN preview_asset_id = $2 THEN NULL ELSE preview_asset_id END,
             updated_at = $3
         WHERE user_id = $1 AND (source_asset_id = $2 OR preview_asset_id = $2)`,
        [row.user_id, assetId, purgedAt],
      );
    });
  }

  async listPalettes(userId: string): Promise<Palette[]> {
    const result = await this.query<{
      id: string;
      palette_name: string;
      brand: string;
      series: string;
      material: string;
      bead_size_mm: number | string;
      verified: boolean;
      version: number;
      source_name: string;
      source_url: string;
      source_revision: string;
      source_license: string;
      retired: boolean;
      code: string;
      color_name: string;
      hex: string;
      finish: NonNullable<Palette["colors"][number]["finish"]>;
      unit_price_cents: number;
      available: boolean;
      owner_user_id: string | null;
    }>(
      `SELECT p.id, p.name AS palette_name, p.brand, p.series, p.material,
              p.bead_size_mm, p.verified, p.version, p.owner_user_id,
              p.source_name, p.source_url, p.source_revision, p.source_license, p.retired,
              c.code, c.name AS color_name, c.hex, c.finish, c.unit_price_cents, c.available
       FROM palettes p JOIN palette_colors c ON c.palette_id = p.id
       WHERE (p.owner_user_id IS NULL OR p.owner_user_id = $1) AND NOT p.retired
       ORDER BY array_position($2::text[], p.id) NULLS LAST, p.id, c.sort_order`,
      [userId, BUILTIN_PALETTES.map((palette) => palette.id)],
    );
    const grouped = new Map<string, Palette>();
    for (const row of result.rows) {
      const item = grouped.get(row.id) ?? {
        id: row.id,
        name: row.palette_name,
        brand: row.brand,
        series: row.series,
        material: row.material,
        beadSizeMm: Number(row.bead_size_mm),
        verified: row.verified,
        version: row.version,
        ownerUserId: row.owner_user_id,
        retired: row.retired,
        source: {
          name: row.source_name,
          url: row.source_url,
          revision: row.source_revision,
          license: row.source_license,
        },
        colors: [],
      };
      item.colors.push({
        code: row.code,
        name: row.color_name,
        hex: row.hex,
        finish: row.finish,
        unitPriceCents: row.unit_price_cents,
        available: row.available,
      });
      grouped.set(row.id, item);
    }
    return [...grouped.values()];
  }

  async getPalette(paletteId: string, userId: string): Promise<Palette | null> {
    const result = await this.query<{
      id: string;
      palette_name: string;
      brand: string;
      series: string;
      material: string;
      bead_size_mm: number | string;
      verified: boolean;
      version: number;
      source_name: string;
      source_url: string;
      source_revision: string;
      source_license: string;
      retired: boolean;
      code: string;
      color_name: string;
      hex: string;
      finish: NonNullable<Palette["colors"][number]["finish"]>;
      unit_price_cents: number;
      available: boolean;
      owner_user_id: string | null;
    }>(
      `SELECT p.id, p.name AS palette_name, p.brand, p.series, p.material,
              p.bead_size_mm, p.verified, p.version, p.owner_user_id,
              p.source_name, p.source_url, p.source_revision, p.source_license, p.retired,
              c.code, c.name AS color_name, c.hex, c.finish, c.unit_price_cents, c.available
       FROM palettes p JOIN palette_colors c ON c.palette_id = p.id
       WHERE p.id = $1
         AND (p.owner_user_id IS NULL OR p.owner_user_id = $2)
       ORDER BY c.sort_order`,
      [paletteId, userId],
    );
    const first = result.rows[0];
    if (!first) return null;
    return {
      id: first.id,
      name: first.palette_name,
      brand: first.brand,
      series: first.series,
      material: first.material,
      beadSizeMm: Number(first.bead_size_mm),
      verified: first.verified,
      version: first.version,
      ownerUserId: first.owner_user_id,
      retired: first.retired,
      source: {
        name: first.source_name,
        url: first.source_url,
        revision: first.source_revision,
        license: first.source_license,
      },
      colors: result.rows.map((row) => ({
        code: row.code,
        name: row.color_name,
        hex: row.hex,
        finish: row.finish,
        unitPriceCents: row.unit_price_cents,
        available: row.available,
      })),
    };
  }

  async createPalette(userId: string, palette: Palette): Promise<Palette> {
    return this.inTransaction(async (client) => {
      const owner = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [userId],
      );
      if (!owner.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
      const usage = await client.query<{ palette_count: number | string; color_count: number | string }>(
        `SELECT count(DISTINCT palette.id) AS palette_count,
                count(color.code) AS color_count
         FROM palettes AS palette
         LEFT JOIN palette_colors AS color ON color.palette_id = palette.id
         WHERE palette.owner_user_id = $1`,
        [userId],
      );
      const paletteCount = Number(usage.rows[0]?.palette_count ?? 0);
      const colorCount = Number(usage.rows[0]?.color_count ?? 0);
      if (paletteCount >= MAX_CUSTOM_PALETTES_PER_USER) {
        throw new AppError(429, "CUSTOM_PALETTE_LIMIT_EXCEEDED", "自定义色卡数量已达到上限", {
          limit: MAX_CUSTOM_PALETTES_PER_USER,
        });
      }
      if (colorCount + palette.colors.length > MAX_CUSTOM_PALETTE_COLORS_PER_USER) {
        throw new AppError(429, "CUSTOM_PALETTE_COLOR_LIMIT_EXCEEDED", "自定义色卡颜色总数已达到上限", {
          limit: MAX_CUSTOM_PALETTE_COLORS_PER_USER,
        });
      }
      await client.query(
        `INSERT INTO palettes(
           id, name, version, brand, series, material, bead_size_mm, verified, owner_user_id,
           source_name, source_url, source_revision, source_license
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11, $12)`,
        [
          palette.id, palette.name, palette.version, palette.brand,
          palette.series ?? palette.name, palette.material ?? "PE", palette.beadSizeMm, userId,
          palette.source?.name ?? "user import", palette.source?.url ?? "",
          palette.source?.revision ?? "1", palette.source?.license ?? "user supplied",
        ],
      );
      for (const [index, color] of palette.colors.entries()) {
        await client.query(
          `INSERT INTO palette_colors(palette_id, code, name, hex, finish, unit_price_cents, sort_order, available)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            palette.id, color.code, color.name, color.hex, color.finish ?? "solid",
            color.unitPriceCents, index, color.available,
          ],
        );
      }
      return {
        ...palette,
        series: palette.series ?? palette.name,
        material: palette.material ?? "PE",
        ownerUserId: userId,
        verified: false,
        retired: false,
        source: palette.source ?? {
          name: "user import",
          url: "",
          revision: "1",
          license: "user supplied",
        },
        colors: palette.colors.map((color) => ({ ...color, finish: color.finish ?? "solid" })),
      };
    });
  }

  async createProject(userId: string, input: CreateProjectInput): Promise<ProjectDetail> {
    return this.inTransaction(async (client) => this.insertProject(client, userId, input));
  }

  async copyProject(input: Parameters<AppStore["copyProject"]>[0]): Promise<ProjectDetail | null> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      const source = await this.getProject(input.userId, input.projectId, input.revision);
      if (!source) return null;
      let sourceAssetId = source.sourceAssetId
        && await this.projectAssetIsAvailable(client, input.userId, source.sourceAssetId, "ai-source")
        ? source.sourceAssetId
        : null;
      let previewAssetId = source.previewAssetId
        && await this.projectAssetIsAvailable(client, input.userId, source.previewAssetId, "ai-intermediate")
        ? source.previewAssetId
        : null;

      for (;;) {
        try {
          const copied = await this.insertProject(client, input.userId, {
            name: input.name ?? defaultProjectCopyName(source.name),
            paletteId: source.paletteId,
            grid: source.grid,
            mode: source.mode,
            lifecycleStatus: "editable",
            sourceAssetId,
            previewAssetId,
            backgroundMode: source.backgroundMode,
            backgroundColor: source.backgroundColor,
            tags: source.tags,
            ...(input.deviceSource === undefined ? {} : { deviceSource: input.deviceSource }),
          });
          return copied;
        } catch (error) {
          if (error instanceof AppError && error.code === "PROJECT_SOURCE_ASSET_NOT_FOUND" && sourceAssetId) {
            sourceAssetId = null;
            continue;
          }
          if (error instanceof AppError && error.code === "PROJECT_PREVIEW_ASSET_NOT_FOUND" && previewAssetId) {
            previewAssetId = null;
            continue;
          }
          throw error;
        }
      }
    });
  }

  private async purgeExpiredDeletedProjects(client: PoolClient, userId: string): Promise<void> {
    await client.query(
      `DELETE FROM projects AS project
       WHERE project.user_id = $1
         AND project.deleted_at < clock_timestamp() - ($2::bigint * interval '1 millisecond')
         AND NOT EXISTS (
           SELECT 1
           FROM export_jobs AS job
           LEFT JOIN export_artifacts AS artifact ON artifact.job_id = job.id
           WHERE job.project_id = project.id
             AND (
               job.status = ANY($3::text[])
               OR (artifact.id IS NOT NULL AND artifact.purged_at IS NULL)
             )
         )`,
      [
        userId,
        OPERATIONAL_HISTORY_RETENTION_MILLISECONDS,
        ["queued", "running", "retry_wait"],
      ],
    );
  }

  private async projectAssetIsAvailable(
    client: PoolClient,
    userId: string,
    assetId: string,
    purpose: AssetPurpose,
  ): Promise<boolean> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM assets
       WHERE id = $1 AND user_id = $2 AND purpose = $3
         AND ready_at IS NOT NULL
         AND deleted_at IS NULL AND purged_at IS NULL
         AND expires_at > clock_timestamp()
       FOR SHARE`,
      [assetId, userId, purpose],
    );
    return Boolean(result.rows[0]);
  }

  private async lockProjectsReferencingAsset(
    client: PoolClient,
    userId: string,
    assetId: string,
  ): Promise<void> {
    // Callers first lock the stable user row, including when no project refers
    // to the asset yet, then preserve project -> asset order for existing refs.
    await client.query(
      `SELECT id FROM projects
       WHERE user_id = $1 AND (source_asset_id = $2 OR preview_asset_id = $2)
       ORDER BY id
       FOR UPDATE`,
      [userId, assetId],
    );
  }

  private async requireAvailableProjectAsset(
    client: PoolClient,
    userId: string,
    assetId: string | null | undefined,
    purpose: AssetPurpose,
    field: "source" | "preview",
  ): Promise<void> {
    if (assetId == null) return;
    if (!await this.projectAssetIsAvailable(client, userId, assetId, purpose)) {
      const code = field === "source" ? "PROJECT_SOURCE_ASSET_NOT_FOUND" : "PROJECT_PREVIEW_ASSET_NOT_FOUND";
      const label = field === "source" ? "原始素材" : "预览素材";
      throw new AppError(404, code, `作品引用的${label}不存在、未就绪或已失效`);
    }
  }

  private async requireSelectablePalette(
    client: PoolClient,
    userId: string,
    paletteId: string,
    notFoundCode: "PALETTE_NOT_FOUND" | "PALETTE_COLOR_NOT_FOUND" = "PALETTE_NOT_FOUND",
  ): Promise<void> {
    const result = await client.query<{ retired: boolean }>(
      `SELECT COALESCE((to_jsonb(palette) ->> 'retired')::boolean, false) AS retired
       FROM palettes AS palette
       WHERE palette.id = $1
         AND (to_jsonb(palette) ->> 'owner_user_id' IS NULL
              OR to_jsonb(palette) ->> 'owner_user_id' = $2::text)
       FOR SHARE OF palette`,
      [paletteId, userId],
    );
    const palette = result.rows[0];
    if (!palette) {
      throw new AppError(
        404,
        notFoundCode,
        notFoundCode === "PALETTE_COLOR_NOT_FOUND" ? "色卡或色号不存在" : "色卡不存在",
      );
    }
    if (palette.retired) {
      throw new AppError(409, "PALETTE_RETIRED", "该色卡已停用，请先迁移到当前可用的 MARD 非官方参考色卡");
    }
  }

  private async insertProject(client: PoolClient, userId: string, input: CreateProjectInput): Promise<ProjectDetail> {
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    await this.requireSelectablePalette(client, userId, input.paletteId);
    await this.purgeExpiredDeletedProjects(client, userId);
    const projectCount = await client.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM projects WHERE user_id = $1 AND deleted_at IS NULL",
      [userId],
    );
    if (Number(projectCount.rows[0]?.count ?? 0) >= MAX_ACTIVE_PROJECTS_PER_USER) {
      throw new AppError(429, "PROJECT_LIMIT_EXCEEDED", "活动作品数量已达到上限", {
        limit: MAX_ACTIVE_PROJECTS_PER_USER,
      });
    }
    const projectHistory = await client.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM projects WHERE user_id = $1",
      [userId],
    );
    if (Number(projectHistory.rows[0]?.count ?? 0) >= MAX_PROJECT_HISTORY_PER_USER) {
      throw new AppError(429, "PROJECT_HISTORY_LIMIT_EXCEEDED", "作品历史记录已达到上限", {
        limit: MAX_PROJECT_HISTORY_PER_USER,
        retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
      });
    }
    const retained = await client.query<{ cell_count: number | string }>(
      `SELECT COALESCE(SUM(revision.width::bigint * revision.height::bigint), 0) AS cell_count
       FROM projects AS project
       JOIN project_revisions AS revision ON revision.project_id = project.id
       WHERE project.user_id = $1`,
      [userId],
    );
    if (Number(retained.rows[0]?.cell_count ?? 0) + input.grid.cells.length
      > MAX_PROJECT_REVISION_CELLS_PER_USER) {
      throw new AppError(429, "PROJECT_STORAGE_LIMIT_EXCEEDED", "作品图纸历史占用已达到上限", {
        limitCells: MAX_PROJECT_REVISION_CELLS_PER_USER,
      });
    }
    const mode = input.mode ?? "normal";
    const lifecycleStatus = input.lifecycleStatus ?? "editable";
    const deviceSource = input.deviceSource ?? "unknown";
    assertProjectMode(mode);
    assertProjectLifecycleStatus(lifecycleStatus);
    assertProjectDeviceSource(deviceSource);
    const tags = normalizeProjectTags(input.tags ?? []);
    await this.requireAvailableProjectAsset(client, userId, input.sourceAssetId, "ai-source", "source");
    await this.requireAvailableProjectAsset(client, userId, input.previewAssetId, "ai-intermediate", "preview");
    const background = normalizeProjectBackground(
      input.backgroundMode ?? "white",
      input.backgroundColor ?? null,
    );
    const { beadCount, colorCount } = projectGridStats(input.grid);
    const id = randomUUID();
    const inserted = await client.query<ProjectRow>(
      `INSERT INTO projects(
         id, user_id, name, mode, lifecycle_status, source_asset_id, preview_asset_id,
         palette_id, background_mode, background_color, tags, device_source,
         current_revision, current_bead_count, current_color_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12, 1, $13, $14)
       RETURNING *`,
      [
        id,
        userId,
        input.name,
        mode,
        lifecycleStatus,
        input.sourceAssetId ?? null,
        input.previewAssetId ?? null,
        input.paletteId,
        background.backgroundMode,
        background.backgroundColor,
        tags,
        deviceSource,
        beadCount,
        colorCount,
      ],
    );
    const revision = await client.query<{
      device_source: ProjectSummary["deviceSource"];
      updated_at: Date | string;
    }>(
      `INSERT INTO project_revisions(
         project_id, revision, encoding, width, height, cells, device_source
       ) VALUES ($1, 1, $2, $3, $4, $5::jsonb, $6)
       RETURNING device_source, updated_at`,
      [id, input.grid.encoding, input.grid.width, input.grid.height, JSON.stringify(input.grid.cells), deviceSource],
    );
    const row = inserted.rows[0];
    const revisionRow = revision.rows[0];
    if (!row || !revisionRow) throw new AppError(500, "PROJECT_CREATE_FAILED", "项目创建失败");
    return {
      ...projectSummary(row),
      grid: input.grid,
      revisionDeviceSource: revisionRow.device_source,
      revisionUpdatedAt: iso(revisionRow.updated_at),
    };
  }

  async listProjects(input: ListProjectsInput): Promise<ProjectListItem[]> {
    const query = input.q === undefined ? null : normalizeProjectSearch(input.q);
    const tag = input.tag === undefined ? null : normalizeProjectTagFilter(input.tag);
    const result = await this.query<ProjectListRow>(
      `SELECT p.id, p.user_id, p.name, p.mode, p.lifecycle_status, p.metadata_revision,
              p.tags, p.device_source,
              p.source_asset_id, p.preview_asset_id, p.palette_id,
              p.background_mode, p.background_color, p.current_revision,
              p.created_at, p.updated_at,
              r.width, r.height,
               p.current_color_count AS color_count, p.current_bead_count AS bead_count,
              CASE WHEN b.project_revision = p.current_revision
                   THEN COALESCE(cardinality(b.completed_indices), 0)
                   ELSE 0
              END::integer AS completed_bead_count,
              COALESCE(b.project_revision = p.current_revision, false) AS progress_started,
              COALESCE(d.base_project_revision = p.current_revision, false) AS has_draft
       FROM projects p
       JOIN project_revisions r
         ON r.project_id = p.id AND r.revision = p.current_revision
       LEFT JOIN build_progress b ON b.project_id = p.id
       LEFT JOIN project_drafts d ON d.project_id = p.id
       WHERE p.user_id = $1 AND p.deleted_at IS NULL
         AND ($4::text IS NULL OR position(lower($4) in lower(p.name)) > 0)
         AND ($5::text IS NULL OR (
           CASE
             WHEN p.current_bead_count > 0
               AND b.project_revision = p.current_revision
               AND COALESCE(cardinality(b.completed_indices), 0) >= p.current_bead_count
               THEN 'completed'
             WHEN b.project_revision = p.current_revision THEN 'in_progress'
             ELSE 'draft'
           END
         ) = $5)
         AND ($6::text IS NULL OR p.mode = $6)
         AND ($7::text IS NULL OR p.lifecycle_status = $7)
         AND ($8::text IS NULL OR EXISTS (
           SELECT 1 FROM unnest(p.tags) AS project_tag
           WHERE lower(project_tag) = lower($8)
         ))
       ORDER BY p.updated_at DESC, p.id DESC
       LIMIT $2 OFFSET $3`,
      [
        input.userId,
        input.limit,
        input.offset,
        query,
        input.status ?? null,
        input.mode ?? null,
        input.lifecycleStatus ?? null,
        tag,
      ],
    );
    return result.rows.map(projectListItem);
  }

  async getProjectStatusStats(userId: string): Promise<ProjectStatusStats> {
    const result = await this.query<ProjectStatusStatsRow>(
      `WITH project_counts AS (
         SELECT p.current_bead_count AS bead_count,
                CASE WHEN b.project_revision = p.current_revision
                     THEN COALESCE(cardinality(b.completed_indices), 0)
                     ELSE 0
                END::integer AS completed_bead_count,
                COALESCE(b.project_revision = p.current_revision, false) AS progress_started
         FROM projects p
         LEFT JOIN build_progress b ON b.project_id = p.id
         WHERE p.user_id = $1 AND p.deleted_at IS NULL
       )
       SELECT COUNT(*)::integer AS total,
              COUNT(*) FILTER (WHERE NOT progress_started)::integer AS draft,
              COUNT(*) FILTER (
                WHERE progress_started
                  AND (bead_count = 0 OR completed_bead_count < bead_count)
              )::integer AS in_progress,
              COUNT(*) FILTER (
                WHERE bead_count > 0 AND completed_bead_count >= bead_count
              )::integer AS completed
       FROM project_counts`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return { total: 0, draft: 0, inProgress: 0, completed: 0 };
    return {
      total: Number(row.total),
      draft: Number(row.draft),
      inProgress: Number(row.in_progress),
      completed: Number(row.completed),
    };
  }

  async getProject(userId: string, projectId: string, revision?: number): Promise<ProjectDetail | null> {
    const result = await this.query<ProjectRow>(
      `SELECT p.id, p.user_id, p.name, p.mode, p.lifecycle_status, p.metadata_revision,
              p.tags, p.device_source,
              p.source_asset_id, p.preview_asset_id, r.palette_id,
              p.background_mode, p.background_color,
              r.revision AS current_revision, p.created_at, p.updated_at,
              r.encoding, r.width, r.height, r.cells,
              r.device_source AS revision_device_source,
              r.updated_at AS revision_updated_at
       FROM projects p
       JOIN project_revisions r ON r.project_id = p.id
         AND r.revision = COALESCE($3::integer, p.current_revision)
       WHERE p.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL`,
      [projectId, userId, revision ?? null],
    );
    const row = result.rows[0];
    return row ? projectDetail(row) : null;
  }

  async getProjectForExport(
    input: Parameters<AppStore["getProjectForExport"]>[0],
  ): Promise<ProjectDetail | null> {
    const result = await this.query<ProjectRow>(
      `SELECT p.id, p.user_id, p.name, p.mode, p.lifecycle_status, p.metadata_revision,
              p.tags, p.device_source,
              p.source_asset_id, p.preview_asset_id, r.palette_id,
              p.background_mode, p.background_color,
              r.revision AS current_revision, p.created_at, p.updated_at,
              r.encoding, r.width, r.height, r.cells,
              r.device_source AS revision_device_source,
              r.updated_at AS revision_updated_at
       FROM projects p
       JOIN project_revisions r ON r.project_id = p.id AND r.revision = $3
       WHERE p.id = $1 AND p.user_id = $2`,
      [input.projectId, input.userId, input.projectRevision],
    );
    const row = result.rows[0];
    return row ? projectDetail(row) : null;
  }

  async updateProjectGrid(input: {
    userId: string;
    projectId: string;
    baseRevision: number;
    name?: string;
    paletteId?: string;
    grid: PatternGrid;
    deviceSource?: ProjectSummary["deviceSource"];
    migrationAudit?: readonly PaletteMigrationAuditInput[];
  }): Promise<ProjectDetail> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      await this.purgeExpiredDeletedProjects(client, input.userId);
      const locked = await client.query<ProjectRow>(
        "SELECT * FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
        [input.projectId, input.userId],
      );
      const current = locked.rows[0];
      if (!current) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
      if (current.current_revision !== input.baseRevision) {
        throw new AppError(409, "PROJECT_REVISION_CONFLICT", "项目已在其他设备更新", {
          currentRevision: current.current_revision,
        });
      }
      const nextPaletteId = input.paletteId ?? current.palette_id;
      await this.requireSelectablePalette(client, input.userId, nextPaletteId);
      if (current.current_revision >= MAX_PROJECT_REVISIONS) {
        throw new AppError(429, "PROJECT_REVISION_LIMIT_EXCEEDED", "作品版本数量已达到上限", {
          limit: MAX_PROJECT_REVISIONS,
        });
      }
      const retained = await client.query<{ cell_count: number | string }>(
        `SELECT COALESCE(SUM(revision.width::bigint * revision.height::bigint), 0) AS cell_count
         FROM projects AS project
         JOIN project_revisions AS revision ON revision.project_id = project.id
         WHERE project.user_id = $1`,
        [input.userId],
      );
      if (Number(retained.rows[0]?.cell_count ?? 0) + input.grid.cells.length
        > MAX_PROJECT_REVISION_CELLS_PER_USER) {
        throw new AppError(429, "PROJECT_STORAGE_LIMIT_EXCEEDED", "作品图纸历史占用已达到上限", {
          limitCells: MAX_PROJECT_REVISION_CELLS_PER_USER,
        });
      }
      const nextRevision = current.current_revision + 1;
      const deviceSource = input.deviceSource ?? "unknown";
      assertProjectDeviceSource(deviceSource);
      const { beadCount, colorCount } = projectGridStats(input.grid);
      const insertedRevision = await client.query<{
        device_source: ProjectSummary["deviceSource"];
        updated_at: Date | string;
      }>(
        `INSERT INTO project_revisions(
           project_id, revision, encoding, width, height, cells, palette_id, device_source
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING device_source, updated_at`,
        [
          input.projectId,
          nextRevision,
          input.grid.encoding,
          input.grid.width,
          input.grid.height,
          JSON.stringify(input.grid.cells),
          nextPaletteId,
          deviceSource,
        ],
      );
      const updated = await client.query<ProjectRow>(
        `UPDATE projects
         SET current_revision = $3, name = COALESCE($4, name),
              current_bead_count = $5, current_color_count = $6,
              palette_id = $7,
              device_source = $8,
              lifecycle_status = 'editable', preview_asset_id = NULL,
              updated_at = clock_timestamp()
         WHERE id = $1 AND user_id = $2 RETURNING *`,
        [
          input.projectId,
          input.userId,
          nextRevision,
          input.name ?? null,
          beadCount,
          colorCount,
          nextPaletteId,
          deviceSource,
        ],
      );
      const row = updated.rows[0];
      const revisionRow = insertedRevision.rows[0];
      if (!row || !revisionRow) throw new AppError(500, "PROJECT_UPDATE_FAILED", "项目更新失败");
      for (const audit of input.migrationAudit ?? []) {
        await client.query(
          `INSERT INTO palette_color_migration_audit(
             entity_type, entity_id, old_palette_id, old_color_code, old_hex,
             new_palette_id, new_color_code, new_hex, delta_e_2000, reliable,
             migration_version
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (
             entity_type, entity_id, old_palette_id, old_color_code, migration_version
           ) DO NOTHING`,
          [
            audit.entityType,
            audit.entityId,
            audit.oldPaletteId,
            audit.oldColorCode,
            audit.oldHex,
            audit.newPaletteId,
            audit.newColorCode,
            audit.newHex,
            audit.deltaE2000,
            audit.reliable,
            audit.migrationVersion,
          ],
        );
      }
      await client.query("DELETE FROM project_drafts WHERE project_id = $1", [input.projectId]);
      return {
        ...projectSummary(row),
        grid: input.grid,
        revisionDeviceSource: revisionRow.device_source,
        revisionUpdatedAt: iso(revisionRow.updated_at),
      };
    });
  }

  async remapProjectPalette(input: Parameters<AppStore["remapProjectPalette"]>[0]): Promise<ProjectDetail> {
    return this.updateProjectGrid(input);
  }

  async updateProjectMetadata(input: UpdateProjectMetadataInput): Promise<ProjectDetail> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      const locked = await client.query<ProjectRow>(
        "SELECT * FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
        [input.projectId, input.userId],
      );
      const current = locked.rows[0];
      if (!current) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
      if (current.current_revision !== input.baseRevision) {
        throw new AppError(409, "PROJECT_REVISION_CONFLICT", "项目已在其他设备更新", {
          currentRevision: current.current_revision,
        });
      }
      if (current.metadata_revision !== input.baseMetadataRevision) {
        throw new AppError(409, "PROJECT_METADATA_REVISION_CONFLICT", "作品元数据已在其他设备更新", {
          currentMetadataRevision: current.metadata_revision,
        });
      }
      await this.requireSelectablePalette(client, input.userId, current.palette_id);
      const mode = input.mode ?? current.mode;
      const lifecycleStatus = input.lifecycleStatus ?? current.lifecycle_status;
      const deviceSource = input.deviceSource ?? "unknown";
      assertProjectMode(mode);
      assertProjectLifecycleStatus(lifecycleStatus);
      assertProjectDeviceSource(deviceSource);
      const tags = input.tags === undefined ? current.tags : normalizeProjectTags(input.tags);
      const sourceAssetId = input.sourceAssetId === undefined
        ? current.source_asset_id
        : input.sourceAssetId;
      const previewAssetId = input.previewAssetId === undefined
        ? current.preview_asset_id
        : input.previewAssetId;
      await this.requireAvailableProjectAsset(client, input.userId, sourceAssetId, "ai-source", "source");
      await this.requireAvailableProjectAsset(client, input.userId, previewAssetId, "ai-intermediate", "preview");

      const backgroundMode = input.backgroundMode ?? current.background_mode;
      const backgroundColor = input.backgroundColor !== undefined
        ? input.backgroundColor
        : input.backgroundMode !== undefined && input.backgroundMode !== current.background_mode
          ? null
          : current.background_color;
      const background = normalizeProjectBackground(backgroundMode, backgroundColor);
      const updated = await client.query<ProjectRow>(
        `UPDATE projects
         SET mode = $3, lifecycle_status = $4,
             source_asset_id = $5, preview_asset_id = $6,
             background_mode = $7, background_color = $8,
             tags = $9::text[], device_source = $10,
             updated_at = clock_timestamp()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [
          input.projectId,
          input.userId,
          mode,
          lifecycleStatus,
          sourceAssetId,
          previewAssetId,
          background.backgroundMode,
          background.backgroundColor,
          tags,
          deviceSource,
        ],
      );
      const row = updated.rows[0];
      if (!row) throw new AppError(500, "PROJECT_METADATA_UPDATE_FAILED", "作品元数据更新失败");
      const revision = await client.query<{
        encoding: "palette-code-v1";
        width: number;
        height: number;
        cells: Array<string | null>;
        device_source: ProjectSummary["deviceSource"];
        updated_at: Date | string;
      }>(
        `SELECT encoding, width, height, cells, device_source, updated_at FROM project_revisions
         WHERE project_id = $1 AND revision = $2`,
        [input.projectId, row.current_revision],
      );
      const snapshot = revision.rows[0];
      if (!snapshot) throw new AppError(500, "PROJECT_REVISION_CORRUPTED", "项目当前版本不存在");
      return {
        ...projectSummary(row),
        grid: {
          encoding: snapshot.encoding,
          width: snapshot.width,
          height: snapshot.height,
          cells: snapshot.cells,
        },
        revisionDeviceSource: snapshot.device_source,
        revisionUpdatedAt: iso(snapshot.updated_at),
      };
    });
  }

  async listProjectRevisions(
    input: Parameters<AppStore["listProjectRevisions"]>[0],
  ): ReturnType<AppStore["listProjectRevisions"]> {
    const result = await this.query<ProjectRevisionMetadataRow>(
      `SELECT revision.project_id, revision.revision, revision.palette_id,
              revision.width, revision.height, revision.device_source,
              revision.created_at, revision.updated_at
       FROM project_revisions AS revision
       JOIN projects AS project ON project.id = revision.project_id
       WHERE project.id = $1 AND project.user_id = $2 AND project.deleted_at IS NULL
       ORDER BY revision.revision DESC
       LIMIT $3 OFFSET $4`,
      [input.projectId, input.userId, input.limit, input.offset],
    );
    return result.rows.map((row) => ({
      projectId: row.project_id,
      revision: row.revision,
      paletteId: row.palette_id,
      width: row.width,
      height: row.height,
      deviceSource: row.device_source,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }));
  }

  async restoreProjectRevision(
    input: Parameters<AppStore["restoreProjectRevision"]>[0],
  ): ReturnType<AppStore["restoreProjectRevision"]> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      await this.purgeExpiredDeletedProjects(client, input.userId);
      const locked = await client.query<ProjectRow>(
        "SELECT * FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
        [input.projectId, input.userId],
      );
      const current = locked.rows[0];
      if (!current) throw new AppError(404, "PROJECT_NOT_FOUND", "项目或指定版本不存在");
      if (current.current_revision !== input.baseRevision) {
        throw new AppError(409, "PROJECT_REVISION_CONFLICT", "项目已在其他设备更新", {
          currentRevision: current.current_revision,
        });
      }
      const sourceResult = await client.query<{
        encoding: "palette-code-v1";
        width: number;
        height: number;
        cells: Array<string | null>;
        palette_id: string;
      }>(
        `SELECT encoding, width, height, cells, palette_id
         FROM project_revisions
         WHERE project_id = $1 AND revision = $2`,
        [input.projectId, input.revision],
      );
      const source = sourceResult.rows[0];
      if (!source) throw new AppError(404, "PROJECT_REVISION_NOT_FOUND", "指定历史版本不存在");
      await this.requireSelectablePalette(client, input.userId, source.palette_id);
      if (current.current_revision >= MAX_PROJECT_REVISIONS) {
        throw new AppError(429, "PROJECT_REVISION_LIMIT_EXCEEDED", "作品版本数量已达到上限", {
          limit: MAX_PROJECT_REVISIONS,
        });
      }
      const retained = await client.query<{ cell_count: number | string }>(
        `SELECT COALESCE(SUM(revision.width::bigint * revision.height::bigint), 0) AS cell_count
         FROM projects AS project
         JOIN project_revisions AS revision ON revision.project_id = project.id
         WHERE project.user_id = $1`,
        [input.userId],
      );
      if (Number(retained.rows[0]?.cell_count ?? 0) + source.width * source.height
        > MAX_PROJECT_REVISION_CELLS_PER_USER) {
        throw new AppError(429, "PROJECT_STORAGE_LIMIT_EXCEEDED", "作品图纸历史占用已达到上限", {
          limitCells: MAX_PROJECT_REVISION_CELLS_PER_USER,
        });
      }
      const deviceSource = input.deviceSource ?? "unknown";
      assertProjectDeviceSource(deviceSource);
      const nextRevision = current.current_revision + 1;
      const revisionResult = await client.query<{
        created_at: Date | string;
        updated_at: Date | string;
        device_source: ProjectSummary["deviceSource"];
      }>(
        `INSERT INTO project_revisions(
           project_id, revision, encoding, width, height, cells, palette_id, device_source
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING created_at, updated_at, device_source`,
        [
          input.projectId,
          nextRevision,
          source.encoding,
          source.width,
          source.height,
          JSON.stringify(source.cells),
          source.palette_id,
          deviceSource,
        ],
      );
      const grid: PatternGrid = {
        encoding: source.encoding,
        width: source.width,
        height: source.height,
        cells: source.cells,
      };
      const { beadCount, colorCount } = projectGridStats(grid);
      const updated = await client.query<ProjectRow>(
        `UPDATE projects
         SET current_revision = $3, palette_id = $4,
             current_bead_count = $5, current_color_count = $6,
             lifecycle_status = 'editable', preview_asset_id = NULL,
             device_source = $7, updated_at = clock_timestamp()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [
          input.projectId,
          input.userId,
          nextRevision,
          source.palette_id,
          beadCount,
          colorCount,
          deviceSource,
        ],
      );
      const row = updated.rows[0];
      const revisionRow = revisionResult.rows[0];
      if (!row || !revisionRow) throw new AppError(500, "PROJECT_RESTORE_FAILED", "项目版本恢复失败");
      await client.query("DELETE FROM project_drafts WHERE project_id = $1", [input.projectId]);
      return {
        ...projectSummary(row),
        grid,
        revisionDeviceSource: revisionRow.device_source,
        revisionUpdatedAt: iso(revisionRow.updated_at),
      };
    });
  }

  async deleteProject(userId: string, projectId: string): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const deletedAt = new Date().toISOString();
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const result = await client.query(
        `UPDATE projects SET deleted_at = $3, updated_at = $3
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [projectId, userId, deletedAt],
      );
      if ((result.rowCount ?? 0) === 0) return false;
      if (await completionPhotoTableExists(client)) {
        await client.query(
          `UPDATE assets AS asset
           SET deleted_at = COALESCE(asset.deleted_at, $3),
               purge_available_at = LEAST(asset.purge_available_at, $3)
           FROM project_completion_photos AS photo
           WHERE photo.project_id = $1 AND photo.user_id = $2
             AND photo.asset_id = asset.id`,
          [projectId, userId, deletedAt],
        );
        await client.query(
          `UPDATE project_completion_photos
           SET deleted_at = COALESCE(deleted_at, $3)
           WHERE project_id = $1 AND user_id = $2`,
          [projectId, userId, deletedAt],
        );
      }
      await client.query("DELETE FROM project_drafts WHERE project_id = $1", [projectId]);
      return true;
    });
  }

  async getProjectDraft(userId: string, projectId: string): Promise<ProjectDraft | null> {
    const result = await this.query<ProjectDraftRow>(
      `SELECT d.*
       FROM project_drafts d
       JOIN projects p ON p.id = d.project_id
       WHERE d.project_id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
         AND d.base_project_revision = p.current_revision`,
      [projectId, userId],
    );
    const row = result.rows[0];
    return row ? projectDraft(row) : null;
  }

  async saveProjectDraft(input: Parameters<AppStore["saveProjectDraft"]>[0]): Promise<ProjectDraft> {
    return this.inTransaction(async (client) => {
      const projectResult = await client.query<{ current_revision: number; name: string; palette_id: string }>(
        `SELECT current_revision, name, palette_id FROM projects
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [input.projectId, input.userId],
      );
      const projectRow = projectResult.rows[0];
      if (!projectRow) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
      if (projectRow.current_revision !== input.baseProjectRevision) {
        throw new AppError(409, "PROJECT_DRAFT_BASE_REVISION_MISMATCH", "草稿基于的图纸版本已过期", {
          currentProjectRevision: projectRow.current_revision,
        });
      }
      await this.requireSelectablePalette(client, input.userId, projectRow.palette_id);
      const existingResult = await client.query<ProjectDraftRow>(
        "SELECT * FROM project_drafts WHERE project_id = $1 FOR UPDATE",
        [input.projectId],
      );
      const existing = existingResult.rows[0];
      const effectiveDraftRevision = existing?.base_project_revision === input.baseProjectRevision
        ? existing.draft_revision
        : 0;
      if (effectiveDraftRevision !== input.baseDraftRevision) {
        throw new AppError(409, "PROJECT_DRAFT_REVISION_CONFLICT", "草稿已在其他设备更新", {
          currentDraftRevision: effectiveDraftRevision,
        });
      }
      const saved = await client.query<ProjectDraftRow>(
        `INSERT INTO project_drafts(
           project_id, base_project_revision, draft_revision, name,
           encoding, width, height, cells, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, clock_timestamp())
         ON CONFLICT (project_id) DO UPDATE SET
           base_project_revision = EXCLUDED.base_project_revision,
           draft_revision = EXCLUDED.draft_revision,
           name = EXCLUDED.name,
           encoding = EXCLUDED.encoding,
           width = EXCLUDED.width,
           height = EXCLUDED.height,
           cells = EXCLUDED.cells,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          input.projectId,
          input.baseProjectRevision,
          effectiveDraftRevision + 1,
          input.name ?? existing?.name ?? projectRow.name,
          input.grid.encoding,
          input.grid.width,
          input.grid.height,
          JSON.stringify(input.grid.cells),
        ],
      );
      const row = saved.rows[0];
      if (!row) throw new AppError(500, "PROJECT_DRAFT_SAVE_FAILED", "项目草稿保存失败");
      await client.query(
        "UPDATE projects SET updated_at = $3 WHERE id = $1 AND user_id = $2",
        [input.projectId, input.userId, row.updated_at],
      );
      return projectDraft(row);
    });
  }

  async commitProjectDraft(input: Parameters<AppStore["commitProjectDraft"]>[0]): Promise<ProjectDetail> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      await this.purgeExpiredDeletedProjects(client, input.userId);
      const projectResult = await client.query<ProjectRow>(
        "SELECT * FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
        [input.projectId, input.userId],
      );
      const current = projectResult.rows[0];
      if (!current) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
      if (current.current_revision !== input.baseProjectRevision) {
        throw new AppError(409, "PROJECT_DRAFT_BASE_REVISION_MISMATCH", "草稿基于的图纸版本已过期", {
          currentProjectRevision: current.current_revision,
        });
      }
      await this.requireSelectablePalette(client, input.userId, current.palette_id);
      const draftResult = await client.query<ProjectDraftRow>(
        "SELECT * FROM project_drafts WHERE project_id = $1 FOR UPDATE",
        [input.projectId],
      );
      const draft = draftResult.rows[0];
      if (!draft || draft.base_project_revision !== input.baseProjectRevision) {
        throw new AppError(404, "PROJECT_DRAFT_NOT_FOUND", "项目草稿不存在");
      }
      if (draft.draft_revision !== input.draftRevision) {
        throw new AppError(409, "PROJECT_DRAFT_REVISION_CONFLICT", "草稿已在其他设备更新", {
          currentDraftRevision: draft.draft_revision,
        });
      }
      if (current.current_revision >= MAX_PROJECT_REVISIONS) {
        throw new AppError(429, "PROJECT_REVISION_LIMIT_EXCEEDED", "作品版本数量已达到上限", {
          limit: MAX_PROJECT_REVISIONS,
        });
      }
      const retained = await client.query<{ cell_count: number | string }>(
        `SELECT COALESCE(SUM(revision.width::bigint * revision.height::bigint), 0) AS cell_count
         FROM projects AS project
         JOIN project_revisions AS revision ON revision.project_id = project.id
         WHERE project.user_id = $1`,
        [input.userId],
      );
      if (Number(retained.rows[0]?.cell_count ?? 0) + draft.width * draft.height
        > MAX_PROJECT_REVISION_CELLS_PER_USER) {
        throw new AppError(429, "PROJECT_STORAGE_LIMIT_EXCEEDED", "作品图纸历史占用已达到上限", {
          limitCells: MAX_PROJECT_REVISION_CELLS_PER_USER,
        });
      }
      const grid: PatternGrid = {
        encoding: draft.encoding,
        width: draft.width,
        height: draft.height,
        cells: draft.cells,
      };
      const nextRevision = current.current_revision + 1;
      const deviceSource = input.deviceSource ?? "unknown";
      assertProjectDeviceSource(deviceSource);
      const { beadCount, colorCount } = projectGridStats(grid);
      const insertedRevision = await client.query<{
        device_source: ProjectSummary["deviceSource"];
        updated_at: Date | string;
      }>(
        `INSERT INTO project_revisions(
           project_id, revision, encoding, width, height, cells, device_source
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING device_source, updated_at`,
        [
          input.projectId,
          nextRevision,
          grid.encoding,
          grid.width,
          grid.height,
          JSON.stringify(grid.cells),
          deviceSource,
        ],
      );
      const updated = await client.query<ProjectRow>(
        `UPDATE projects
         SET current_revision = $3, name = $4,
              current_bead_count = $5, current_color_count = $6,
              lifecycle_status = 'editable', preview_asset_id = NULL,
              device_source = $7,
              updated_at = clock_timestamp()
         WHERE id = $1 AND user_id = $2 RETURNING *`,
        [input.projectId, input.userId, nextRevision, draft.name, beadCount, colorCount, deviceSource],
      );
      const row = updated.rows[0];
      const revisionRow = insertedRevision.rows[0];
      if (!row || !revisionRow) throw new AppError(500, "PROJECT_DRAFT_COMMIT_FAILED", "项目草稿提交失败");
      await client.query("DELETE FROM project_drafts WHERE project_id = $1", [input.projectId]);
      return {
        ...projectSummary(row),
        grid,
        revisionDeviceSource: revisionRow.device_source,
        revisionUpdatedAt: iso(revisionRow.updated_at),
      };
    });
  }

  async discardProjectDraft(input: Parameters<AppStore["discardProjectDraft"]>[0]): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const projectResult = await client.query<{ current_revision: number }>(
        `SELECT current_revision FROM projects
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [input.projectId, input.userId],
      );
      const projectRow = projectResult.rows[0];
      if (!projectRow) return false;
      if (projectRow.current_revision !== input.baseProjectRevision) {
        throw new AppError(409, "PROJECT_DRAFT_BASE_REVISION_MISMATCH", "草稿基于的图纸版本已过期", {
          currentProjectRevision: projectRow.current_revision,
        });
      }
      const draftResult = await client.query<{ draft_revision: number }>(
        "SELECT draft_revision FROM project_drafts WHERE project_id = $1 FOR UPDATE",
        [input.projectId],
      );
      const draft = draftResult.rows[0];
      if (!draft) return false;
      if (draft.draft_revision !== input.draftRevision) {
        throw new AppError(409, "PROJECT_DRAFT_REVISION_CONFLICT", "草稿已在其他设备更新", {
          currentDraftRevision: draft.draft_revision,
        });
      }
      await client.query("DELETE FROM project_drafts WHERE project_id = $1", [input.projectId]);
      return true;
    });
  }

  async getBuildProgress(userId: string, projectId: string): Promise<BuildProgress | null> {
    const result = await this.query<{
      id: string;
      current_revision: number;
      updated_at: Date | string;
      project_revision: number | null;
      progress_revision: number | null;
      mode: BuildProgress["mode"] | null;
      navigation_cursor: BuildProgress["navigationCursor"];
      completed_indices: number[] | null;
      elapsed_time: number | null;
      started_at: Date | string | null;
      completed_at: Date | string | null;
      progress_updated_at: Date | string | null;
    }>(
      `SELECT p.id, p.current_revision, p.updated_at,
              b.project_revision, b.progress_revision, b.mode, b.navigation_cursor, b.completed_indices,
              b.elapsed_time, b.started_at, b.completed_at, b.updated_at AS progress_updated_at
       FROM projects p LEFT JOIN build_progress b ON b.project_id = p.id
       WHERE p.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL`,
      [projectId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.project_revision !== null && row.project_revision !== row.current_revision) {
      throw new AppError(409, "BUILD_PROGRESS_REVISION_MISMATCH", "制作进度对应的图纸版本已过期", {
        progressProjectRevision: row.project_revision,
        currentProjectRevision: row.current_revision,
      });
    }
    return {
      projectId,
      projectRevision: row.project_revision ?? row.current_revision,
      progressRevision: row.progress_revision ?? 0,
      mode: row.mode ?? "color",
      navigationCursor: row.navigation_cursor ?? null,
      completedIndices: row.completed_indices ?? [],
      elapsedTime: row.elapsed_time ?? 0,
      startedAt: row.started_at ? iso(row.started_at) : null,
      completedAt: row.completed_at ? iso(row.completed_at) : null,
      updatedAt: iso(row.progress_updated_at ?? row.updated_at),
    };
  }

  async saveBuildProgress(input: Parameters<AppStore["saveBuildProgress"]>[0]): Promise<BuildProgress> {
    return this.inTransaction(async (client) => {
      const project = await client.query<{
        current_revision: number;
        cell_count: number;
        encoding: PatternGrid["encoding"];
        width: number;
        height: number;
        cells: Array<string | null>;
        palette_id: string;
      }>(
        `SELECT p.current_revision, jsonb_array_length(r.cells) AS cell_count,
                r.encoding, r.width, r.height, r.cells, r.palette_id
         FROM projects p JOIN project_revisions r ON r.project_id = p.id AND r.revision = $3
         WHERE p.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL FOR UPDATE OF p`,
        [input.projectId, input.userId, input.projectRevision],
      );
      const row = project.rows[0];
      if (!row) throw new AppError(404, "PROJECT_NOT_FOUND", "项目或指定版本不存在");
      if (row.current_revision !== input.projectRevision) {
        throw new AppError(409, "BUILD_PROGRESS_REVISION_MISMATCH", "制作进度对应的图纸版本已过期", {
          currentProjectRevision: row.current_revision,
        });
      }
      await this.requireSelectablePalette(client, input.userId, row.palette_id);
      const uniqueIndices = [...new Set(input.completedIndices)].sort((a, b) => a - b);
      if (uniqueIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= row.cell_count)) {
        throw new AppError(400, "INVALID_COMPLETED_INDICES", "完成位置超出图纸范围");
      }
      if (uniqueIndices.some((index) => row.cells[index] === null)) {
        throw new AppError(400, "INVALID_COMPLETED_INDICES", "空白格不能标记为已完成");
      }
      if (input.mode !== undefined && !["color", "region", "row-column"].includes(input.mode)) {
        throw new AppError(400, "INVALID_BUILD_MODE", "制作模式无效");
      }
      if (input.elapsedTime !== undefined && (
        !Number.isInteger(input.elapsedTime)
        || input.elapsedTime < 0
        || input.elapsedTime > 2_147_483_647
      )) {
        throw new AppError(400, "INVALID_BUILD_ELAPSED_TIME", "累计制作时长必须是有效的非负整数秒");
      }
      const existing = await client.query<{
        project_revision: number;
        progress_revision: number;
        mode: BuildProgress["mode"];
        navigation_cursor: BuildProgress["navigationCursor"];
        elapsed_time: number;
      }>(
        `SELECT project_revision, progress_revision, mode, navigation_cursor, elapsed_time
         FROM build_progress WHERE project_id = $1 FOR UPDATE`,
        [input.projectId],
      );
      const previous = existing.rows[0];
      const current = previous?.project_revision === input.projectRevision ? previous : undefined;
      const effectiveRevision = current?.progress_revision ?? 0;
      if (effectiveRevision !== input.baseProgressRevision) {
        throw new AppError(409, "BUILD_PROGRESS_REVISION_CONFLICT", "制作进度已在其他设备更新", {
          currentProgressRevision: effectiveRevision,
        });
      }
      if (current && input.elapsedTime !== undefined && input.elapsedTime < current.elapsed_time) {
        throw new AppError(409, "BUILD_PROGRESS_ELAPSED_TIME_REGRESSION", "累计制作时长不能减少", {
          currentElapsedTime: current.elapsed_time,
        });
      }
      const nextRevision = effectiveRevision + 1;
      const mode = input.mode ?? current?.mode ?? "color";
      const elapsedTime = input.elapsedTime ?? current?.elapsed_time ?? 0;
      const paletteColors = await client.query<{ code: string }>(
        "SELECT code FROM palette_colors WHERE palette_id = $1",
        [row.palette_id],
      );
      const navigationCursor = resolveBuildNavigationCursor({
        mode,
        previousMode: current?.mode,
        previousCursor: current?.navigation_cursor,
        cursorProvided: Object.prototype.hasOwnProperty.call(input, "navigationCursor"),
        requestedCursor: input.navigationCursor,
        grid: {
          encoding: row.encoding,
          width: row.width,
          height: row.height,
          cells: row.cells,
        },
        paletteColorCodes: new Set(paletteColors.rows.map((color) => color.code)),
      });
      const drawableCellCount = row.cells.reduce((count, cell) => count + (cell === null ? 0 : 1), 0);
      const isCompleted = drawableCellCount > 0 && uniqueIndices.length === drawableCellCount;
      const saved = await client.query<{
        project_revision: number;
        progress_revision: number;
        mode: BuildProgress["mode"];
        navigation_cursor: BuildProgress["navigationCursor"];
        completed_indices: number[];
        elapsed_time: number;
        started_at: Date | string;
        completed_at: Date | string | null;
        updated_at: Date | string;
      }>(
        `INSERT INTO build_progress(
           project_id, project_revision, progress_revision, mode, navigation_cursor, completed_indices,
           elapsed_time, started_at, completed_at
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::integer[], $7, now(), CASE WHEN $8::boolean THEN now() ELSE NULL END)
         ON CONFLICT (project_id) DO UPDATE SET
           project_revision = EXCLUDED.project_revision,
           progress_revision = EXCLUDED.progress_revision,
           mode = EXCLUDED.mode,
           navigation_cursor = EXCLUDED.navigation_cursor,
           completed_indices = EXCLUDED.completed_indices,
           elapsed_time = EXCLUDED.elapsed_time,
           started_at = CASE
             WHEN build_progress.project_revision = EXCLUDED.project_revision
               THEN build_progress.started_at
             ELSE EXCLUDED.started_at
           END,
           completed_at = CASE
             WHEN NOT $8::boolean THEN NULL
             WHEN build_progress.project_revision = EXCLUDED.project_revision
               THEN COALESCE(build_progress.completed_at, EXCLUDED.completed_at)
             ELSE EXCLUDED.completed_at
           END,
           updated_at = now()
         RETURNING project_revision, progress_revision, mode, navigation_cursor, completed_indices,
                   elapsed_time, started_at, completed_at, updated_at`,
        [
          input.projectId,
          input.projectRevision,
          nextRevision,
          mode,
          navigationCursor === null ? null : JSON.stringify(navigationCursor),
          uniqueIndices,
          elapsedTime,
          isCompleted,
        ],
      );
      const savedRow = saved.rows[0];
      if (!savedRow) throw new AppError(500, "BUILD_PROGRESS_SAVE_FAILED", "制作进度保存失败");
      await client.query(
        "UPDATE projects SET updated_at = $3 WHERE id = $1 AND user_id = $2",
        [input.projectId, input.userId, savedRow.updated_at],
      );
      return {
        projectId: input.projectId,
        projectRevision: savedRow.project_revision,
        progressRevision: savedRow.progress_revision,
        mode: savedRow.mode,
        navigationCursor: savedRow.navigation_cursor,
        completedIndices: savedRow.completed_indices,
        elapsedTime: savedRow.elapsed_time,
        startedAt: iso(savedRow.started_at),
        completedAt: savedRow.completed_at ? iso(savedRow.completed_at) : null,
        updatedAt: iso(savedRow.updated_at),
      };
    });
  }

  async reserveProjectCompletionPhotoUpload(
    input: Parameters<AppStore["reserveProjectCompletionPhotoUpload"]>[0],
  ): Promise<ProjectCompletionPhotoUploadReservation> {
    if (input.asset.userId !== input.userId || input.asset.purpose !== "project-completion"
      || input.asset.consentVersion !== null || input.asset.expiresAt !== null
      || !input.uploadLeaseToken
      || !Number.isFinite(Date.parse(input.uploadLeaseAcquiredAt))) {
      throw new AppError(400, "COMPLETION_PHOTO_ASSET_INVALID", "完工照片素材元数据无效");
    }
    return this.inTransaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [input.userId, `completion-photo:${input.projectId}:${input.idempotencyKey}`],
      );
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      const existing = await client.query<{
        request_hash: string;
        photo_id: string;
        asset_id: string;
        upload_lease_token: string;
        upload_lease_expires_at: Date | string;
        upload_lease_active: boolean;
      }>(
        `SELECT request_hash, photo_id, asset_id,
                upload_lease_token::text, upload_lease_expires_at,
                upload_lease_expires_at > clock_timestamp() AS upload_lease_active
         FROM project_completion_photo_uploads
         WHERE user_id = $1 AND project_id = $2 AND idempotency_key = $3`,
        [input.userId, input.projectId, input.idempotencyKey],
      );
      const reservation = existing.rows[0];
      const project = await client.query<{
        current_revision: number;
        current_bead_count: number;
        progress_project_revision: number | null;
        completed_bead_count: number;
        completed_at: Date | string | null;
        deleted_at: Date | string | null;
        palette_id: string | null;
      }>(
        `SELECT project.current_revision, project.current_bead_count,
                progress.project_revision AS progress_project_revision,
                COALESCE(cardinality(progress.completed_indices), 0)::integer AS completed_bead_count,
                progress.completed_at, project.deleted_at,
                revision.palette_id
         FROM projects AS project
         LEFT JOIN build_progress AS progress ON progress.project_id = project.id
         LEFT JOIN project_revisions AS revision
           ON revision.project_id = project.id AND revision.revision = $3
         WHERE project.id = $1 AND project.user_id = $2
         FOR UPDATE OF project`,
        [input.projectId, input.userId, input.projectRevision],
      );
      const projectRow = project.rows[0];
      if (reservation) {
        if (reservation.request_hash !== input.requestHash) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
        }
        // Purge and all explicit asset deletion paths lock the asset before
        // touching its completion-photo binding. Keep replay on that same
        // asset -> photo order after the user/project locks, then take the
        // upload reservation last.
        await client.query("SELECT id FROM assets WHERE id = $1 FOR UPDATE", [reservation.asset_id]);
        const replay = await client.query<ProjectCompletionPhotoRow>(
          `${PROJECT_COMPLETION_PHOTO_SELECT}
           WHERE photo.id = $1 AND photo.user_id = $2 AND photo.project_id = $3
             AND photo.asset_id = $4
           FOR UPDATE OF photo`,
          [reservation.photo_id, input.userId, input.projectId, reservation.asset_id],
        );
        const row = replay.rows[0];
        if (!row || !projectRow) {
          throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "该完工照片上传已删除或超时，请使用新的幂等键重试");
        }
        const record = projectCompletionPhotoRecord(row);
        if (projectRow.deleted_at !== null || record.deletedAt !== null
          || record.asset.deletedAt !== null || record.asset.purgedAt !== null) {
          throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "该完工照片上传已删除或超时，请使用新的幂等键重试");
        }
        let uploadLeaseToken = reservation.upload_lease_token;
        let uploadLeaseExpiresAt = iso(reservation.upload_lease_expires_at);
        if (record.asset.readyAt === null) {
          if (!projectRow.palette_id) {
            throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "该完工照片上传已删除或超时，请使用新的幂等键重试");
          }
          await this.requireSelectablePalette(client, input.userId, projectRow.palette_id);
          const renewed = await client.query<{
            upload_lease_token: string;
            upload_lease_expires_at: Date | string;
          }>(
            `UPDATE project_completion_photo_uploads
             SET upload_lease_token = CASE
                   WHEN upload_lease_expires_at > clock_timestamp() THEN upload_lease_token
                   ELSE $4::uuid
                 END,
                 upload_lease_expires_at = clock_timestamp()
                   + ($5::bigint * interval '1 millisecond')
             WHERE user_id = $1 AND project_id = $2 AND idempotency_key = $3
             RETURNING upload_lease_token::text, upload_lease_expires_at`,
            [
              input.userId,
              input.projectId,
              input.idempotencyKey,
              input.uploadLeaseToken,
              COMPLETION_PHOTO_UPLOAD_LEASE_MILLISECONDS,
            ],
          );
          const renewedRow = renewed.rows[0];
          if (!renewedRow) {
            throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "该完工照片上传已删除或超时，请使用新的幂等键重试");
          }
          uploadLeaseToken = renewedRow.upload_lease_token;
          uploadLeaseExpiresAt = iso(renewedRow.upload_lease_expires_at);
          // Touch the target asset row in the same transaction as the lease.
          // A purge UPDATE that scanned before this transaction must recheck
          // purge_available_at against the post-wait row version (EPQ), so a
          // stale NOT EXISTS snapshot cannot steal the upload.
          await client.query(
            `UPDATE assets
             SET purge_available_at = GREATEST(purge_available_at, $2)
             WHERE id = $1 AND deleted_at IS NULL AND purged_at IS NULL`,
            [record.asset.id, uploadLeaseExpiresAt],
          );
        }
        return { photo: record, replayed: true, uploadLeaseToken, uploadLeaseExpiresAt };
      }

      if (!projectRow || projectRow.deleted_at !== null) {
        throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
      }
      if (projectRow.current_revision !== input.projectRevision) {
        throw new AppError(409, "PROJECT_COMPLETION_REVISION_MISMATCH", "完工照片只能绑定作品当前版本", {
          currentProjectRevision: projectRow.current_revision,
        });
      }
      if (!projectRow.palette_id) {
        throw new AppError(404, "PROJECT_NOT_FOUND", "项目或指定版本不存在");
      }
      await this.requireSelectablePalette(client, input.userId, projectRow.palette_id);
      const completed = projectRow.current_bead_count > 0
        && projectRow.progress_project_revision === input.projectRevision
        && projectRow.completed_bead_count === projectRow.current_bead_count
        && projectRow.completed_at !== null;
      if (!completed) {
        throw new AppError(409, "PROJECT_BUILD_NOT_COMPLETED", "完成全部非空拼豆格后才能上传完工照片", {
          completedBeadCount: projectRow.progress_project_revision === input.projectRevision
            ? projectRow.completed_bead_count
            : 0,
          beadCount: projectRow.current_bead_count,
        });
      }
      const photoCount = await client.query<{ photo_count: number | string }>(
        `SELECT count(*) AS photo_count
         FROM project_completion_photos AS photo
         JOIN assets AS asset ON asset.id = photo.asset_id
         WHERE photo.project_id = $1 AND photo.project_revision = $2
           AND photo.deleted_at IS NULL AND asset.deleted_at IS NULL AND asset.purged_at IS NULL`,
        [input.projectId, input.projectRevision],
      );
      if (Number(photoCount.rows[0]?.photo_count ?? 0) >= MAX_PROJECT_COMPLETION_PHOTOS_PER_REVISION) {
        throw new AppError(429, "COMPLETION_PHOTO_LIMIT_EXCEEDED", "当前作品版本的完工照片已达到上限", {
          limit: MAX_PROJECT_COMPLETION_PHOTOS_PER_REVISION,
        });
      }

      const transactionStore = new PostgresStore(this.pool, client);
      const rateLimit = await transactionStore.consumeUserRateLimit({
        userId: input.userId,
        ...USER_RATE_LIMITS.completionPhotoUpload,
        now: input.asset.createdAt,
      });
      if (!rateLimit.allowed) {
        throw new AppError(429, "USER_RATE_LIMITED", "请求过于频繁，请稍后重试", {
          retryAfterMilliseconds: rateLimit.retryAfterMilliseconds,
        });
      }
      const asset = await transactionStore.createAsset(input.asset);
      await client.query(
        `INSERT INTO project_completion_photos(
           id, user_id, project_id, project_revision, asset_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.photoId, input.userId, input.projectId, input.projectRevision, asset.id, input.asset.createdAt],
      );
      const insertedUpload = await client.query<{
        upload_lease_token: string;
        upload_lease_expires_at: Date | string;
      }>(
        `INSERT INTO project_completion_photo_uploads(
           user_id, project_id, idempotency_key, request_hash, photo_id, asset_id,
           upload_lease_token, upload_lease_expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           clock_timestamp() + ($8::bigint * interval '1 millisecond')
         )
         RETURNING upload_lease_token::text, upload_lease_expires_at`,
        [
          input.userId,
          input.projectId,
          input.idempotencyKey,
          input.requestHash,
          input.photoId,
          asset.id,
          input.uploadLeaseToken,
          COMPLETION_PHOTO_UPLOAD_LEASE_MILLISECONDS,
        ],
      );
      const insertedUploadRow = insertedUpload.rows[0];
      if (!insertedUploadRow) throw new AppError(500, "COMPLETION_PHOTO_UPLOAD_RESERVE_FAILED", "完工照片上传预约失败");
      const uploadLeaseExpiresAt = iso(insertedUploadRow.upload_lease_expires_at);
      await client.query(
        `UPDATE assets
         SET purge_available_at = GREATEST(purge_available_at, $2)
         WHERE id = $1`,
        [asset.id, uploadLeaseExpiresAt],
      );
      return {
        photo: {
          id: input.photoId,
          userId: input.userId,
          projectId: input.projectId,
          projectRevision: input.projectRevision,
          assetId: asset.id,
          createdAt: input.asset.createdAt,
          deletedAt: null,
          asset,
        },
        replayed: false,
        uploadLeaseToken: insertedUploadRow.upload_lease_token,
        uploadLeaseExpiresAt,
      };
    });
  }

  async publishProjectCompletionPhoto(
    input: Parameters<AppStore["publishProjectCompletionPhoto"]>[0],
  ): Promise<ProjectCompletionPhotoRecord> {
    const outcome = await this.inTransaction(async (client): Promise<
      | { record: ProjectCompletionPhotoRecord; conflict: null }
      | { record: null; conflict: { currentProjectRevision: number; photoProjectRevision: number } }
    > => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      const projectState = await client.query<{
        current_revision: number;
        current_bead_count: number;
        progress_project_revision: number | null;
        completed_bead_count: number;
        completed_at: Date | string | null;
        palette_id: string;
      }>(
        `SELECT project.current_revision, project.current_bead_count,
                progress.project_revision AS progress_project_revision,
                COALESCE(cardinality(progress.completed_indices), 0)::integer AS completed_bead_count,
                progress.completed_at, project.palette_id
         FROM projects AS project
         LEFT JOIN build_progress AS progress ON progress.project_id = project.id
         WHERE project.id = $1 AND project.user_id = $2 AND project.deleted_at IS NULL
         FOR UPDATE OF project`,
        [input.projectId, input.userId],
      );
      await client.query("SELECT id FROM assets WHERE id = $1 FOR UPDATE", [input.assetId]);
      const locked = await client.query<ProjectCompletionPhotoRow>(
        `${PROJECT_COMPLETION_PHOTO_SELECT}
         WHERE photo.id = $1 AND photo.user_id = $2 AND photo.project_id = $3
           AND photo.asset_id = $4
         FOR UPDATE OF photo`,
        [input.photoId, input.userId, input.projectId, input.assetId],
      );
      const row = locked.rows[0];
      if (!row) throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "完工照片上传已删除或超时");
      if (row.photo_deleted_at !== null || row.asset_deleted_at !== null || row.asset_purged_at !== null) {
        throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "完工照片上传已删除或超时");
      }
      const upload = await client.query<{
        upload_lease_token: string;
        upload_lease_active: boolean;
      }>(
        `SELECT upload_lease_token::text,
                upload_lease_expires_at > clock_timestamp() AS upload_lease_active
         FROM project_completion_photo_uploads
         WHERE user_id = $1 AND project_id = $2 AND photo_id = $3 AND asset_id = $4
         FOR UPDATE`,
        [input.userId, input.projectId, input.photoId, input.assetId],
      );
      const uploadRow = upload.rows[0];
      if (!uploadRow) {
        throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "完工照片上传预约已删除或超时");
      }
      if (uploadRow.upload_lease_token !== input.uploadLeaseToken) {
        throw new AppError(409, "COMPLETION_PHOTO_UPLOAD_LEASE_LOST", "完工照片上传租约已过期或被接管，请重试", undefined, true);
      }
      if (row.asset_ready_at !== null) {
        return { record: projectCompletionPhotoRecord(row), conflict: null };
      }
      const state = projectState.rows[0];
      if (state) {
        await this.requireSelectablePalette(client, input.userId, state.palette_id);
      }
      if (!uploadRow.upload_lease_active) {
        throw new AppError(409, "COMPLETION_PHOTO_UPLOAD_LEASE_LOST", "完工照片上传租约已过期或被接管，请重试", undefined, true);
      }
      const stillCompleted = state !== undefined
        && state.current_revision === row.project_revision
        && state.current_bead_count > 0
        && state.progress_project_revision === row.project_revision
        && state.completed_bead_count === state.current_bead_count
        && state.completed_at !== null;
      if (!stillCompleted) {
        await client.query(
          `UPDATE project_completion_photos
           SET deleted_at = COALESCE(deleted_at, $2)
           WHERE id = $1`,
          [input.photoId, input.readyAt],
        );
        await client.query(
          `UPDATE assets
           SET deleted_at = COALESCE(deleted_at, $2),
               purge_available_at = LEAST(purge_available_at, $2)
           WHERE id = $1`,
          [input.assetId, input.readyAt],
        );
        return {
          record: null,
          conflict: {
            currentProjectRevision: state?.current_revision ?? -1,
            photoProjectRevision: row.project_revision,
          },
        };
      }
      const published = await client.query<AssetRow>(
        `UPDATE assets SET ready_at = COALESCE(ready_at, $3)
         WHERE id = $1 AND user_id = $2 AND purpose = 'project-completion'
           AND deleted_at IS NULL AND purged_at IS NULL
         RETURNING *`,
        [input.assetId, input.userId, input.readyAt],
      );
      const assetRow = published.rows[0];
      if (!assetRow) throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "完工照片上传已删除或超时");
      return {
        record: {
          ...projectCompletionPhotoRecord(row),
          asset: assetRecord(assetRow),
        },
        conflict: null,
      };
    });
    if (outcome.conflict) {
      throw new AppError(409, "PROJECT_COMPLETION_STATE_CHANGED", "作品版本或制作进度已变化，完工照片未发布", {
        currentProjectRevision: outcome.conflict.currentProjectRevision < 0
          ? null
          : outcome.conflict.currentProjectRevision,
        photoProjectRevision: outcome.conflict.photoProjectRevision,
      });
    }
    return outcome.record;
  }

  async listProjectCompletionPhotos(
    input: Parameters<AppStore["listProjectCompletionPhotos"]>[0],
  ): Promise<ProjectCompletionPhotoRecord[]> {
    const result = await this.query<ProjectCompletionPhotoRow>(
      `${PROJECT_COMPLETION_PHOTO_SELECT}
       JOIN projects AS project ON project.id = photo.project_id AND project.user_id = photo.user_id
       WHERE photo.user_id = $1 AND photo.project_id = $2 AND photo.project_revision = $3
         AND project.deleted_at IS NULL AND photo.deleted_at IS NULL
         AND asset.ready_at IS NOT NULL AND asset.deleted_at IS NULL AND asset.purged_at IS NULL
         AND (asset.expires_at IS NULL OR asset.expires_at > $4)
       ORDER BY photo.created_at DESC, photo.id DESC
       LIMIT $5 OFFSET $6`,
      [input.userId, input.projectId, input.projectRevision, input.now, input.limit, input.offset],
    );
    return result.rows.map(projectCompletionPhotoRecord);
  }

  async getProjectCompletionPhoto(
    input: Parameters<AppStore["getProjectCompletionPhoto"]>[0],
  ): Promise<ProjectCompletionPhotoRecord | null> {
    const result = await this.query<ProjectCompletionPhotoRow>(
      `${PROJECT_COMPLETION_PHOTO_SELECT}
       JOIN projects AS project ON project.id = photo.project_id AND project.user_id = photo.user_id
       WHERE photo.id = $1 AND photo.user_id = $2 AND photo.project_id = $3
         AND project.deleted_at IS NULL
         AND ($5::boolean OR (
           photo.deleted_at IS NULL AND asset.ready_at IS NOT NULL
           AND asset.deleted_at IS NULL AND asset.purged_at IS NULL
           AND (asset.expires_at IS NULL OR asset.expires_at > $4)
         ))`,
      [input.photoId, input.userId, input.projectId, input.now, input.includeDeleted ?? false],
    );
    const row = result.rows[0];
    return row ? projectCompletionPhotoRecord(row) : null;
  }

  async deleteProjectCompletionPhoto(
    input: Parameters<AppStore["deleteProjectCompletionPhoto"]>[0],
  ): Promise<ProjectCompletionPhotoRecord | null> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      const project = await client.query<{ id: string }>(
        `SELECT id FROM projects
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [input.projectId, input.userId],
      );
      if (!project.rows[0]) return null;
      const binding = await client.query<{ asset_id: string }>(
        `SELECT asset_id FROM project_completion_photos
         WHERE id = $1 AND user_id = $2 AND project_id = $3`,
        [input.photoId, input.userId, input.projectId],
      );
      const assetId = binding.rows[0]?.asset_id;
      if (!assetId) return null;
      await client.query("SELECT id FROM assets WHERE id = $1 FOR UPDATE", [assetId]);
      const locked = await client.query<ProjectCompletionPhotoRow>(
        `${PROJECT_COMPLETION_PHOTO_SELECT}
         WHERE photo.id = $1 AND photo.user_id = $2 AND photo.project_id = $3
         FOR UPDATE OF photo`,
        [input.photoId, input.userId, input.projectId],
      );
      const row = locked.rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE project_completion_photos
         SET deleted_at = COALESCE(deleted_at, $2)
         WHERE id = $1`,
        [input.photoId, input.deletedAt],
      );
      const deletedAsset = await client.query<AssetRow>(
        `UPDATE assets
         SET deleted_at = COALESCE(deleted_at, $2),
             purge_available_at = LEAST(purge_available_at, $2)
         WHERE id = $1
         RETURNING *`,
        [row.asset_id, input.deletedAt],
      );
      const asset = deletedAsset.rows[0];
      if (!asset) throw new AppError(500, "COMPLETION_PHOTO_DELETE_FAILED", "完工照片删除失败");
      return {
        ...projectCompletionPhotoRecord(row),
        deletedAt: row.photo_deleted_at ? iso(row.photo_deleted_at) : input.deletedAt,
        asset: assetRecord(asset),
      };
    });
  }

  async getCreditAccount(userId: string): Promise<CreditAccount> {
    const result = await this.query<{ user_id: string; balance: number; updated_at: Date | string }>(
      "SELECT * FROM credit_accounts WHERE user_id = $1",
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
    return { userId: row.user_id, balance: row.balance, updatedAt: iso(row.updated_at) };
  }

  async listCreditLedger(userId: string, limit: number, offset = 0): Promise<CreditLedgerEntry[]> {
    const result = await this.query<{
      id: string;
      user_id: string;
      delta: number;
      balance_after: number;
      reason: string;
      reference_id: string | null;
      created_at: Date | string;
    }>(
      `SELECT * FROM credit_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      delta: row.delta,
      balanceAfter: row.balance_after,
      reason: row.reason,
      referenceId: row.reference_id,
      createdAt: iso(row.created_at),
    }));
  }

  async createGenerationJob(input: {
    userId: string;
    parentJobId?: string;
    kind: GenerationKind;
    paletteId: string;
    sourceAssetId: string | null;
    options?: GenerationOptions;
    cost: number;
    seed: string;
    width: number;
    height: number;
    now: string;
    jobId: string;
  }): Promise<GenerationJob> {
    return this.inTransaction(async (client) => {
      const options = input.options
        ? deserializeGenerationOptions(input.options)
        : copyDefaultGenerationOptions();
      // Serialize same-user creates on a stable row before touching any
      // generation job. Lease recovery locks jobs before accounts, so taking
      // the account only after parent/history rows preserves one global order:
      // user -> generation jobs -> credit account.
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      if (input.parentJobId) {
        const parents = await client.query<JobRow>(
          "SELECT * FROM generation_jobs WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [input.parentJobId, input.userId],
        );
        const parent = parents.rows[0];
        if (!parent) throw new AppError(404, "GENERATION_JOB_NOT_FOUND", "原生成任务不存在");
        if (parent.status !== "completed") {
          throw new AppError(409, "GENERATION_REDRAW_NOT_READY", "只有已生成且尚未采用的任务可以换一批", {
            status: parent.status,
          });
        }
        if ((parent.kind !== "portrait" && parent.kind !== "couple") || input.cost !== 1) {
          throw new AppError(409, "GENERATION_REDRAW_UNSUPPORTED", "换一批仅支持 AI 任务且固定扣 1 次");
        }
        if (input.kind !== parent.kind || input.paletteId !== parent.palette_id
          || input.sourceAssetId !== parent.source_asset_id
          || input.width !== parent.width || input.height !== parent.height
          || !generationOptionsEqual(options, deserializeGenerationOptions(parent.options))) {
          throw new AppError(500, "GENERATION_REDRAW_INPUT_MISMATCH", "换一批任务没有完整复用原任务参数");
        }
      }
      await this.requireSelectablePalette(client, input.userId, input.paletteId);
      if (input.sourceAssetId) {
        const source = await client.query<{ id: string }>(
          `SELECT id FROM assets
           WHERE id = $1 AND user_id = $2 AND purpose = 'ai-source'
             AND ready_at IS NOT NULL
             AND deleted_at IS NULL AND purged_at IS NULL AND expires_at > $3
           FOR SHARE`,
          [input.sourceAssetId, input.userId, input.now],
        );
        if (!source.rows[0]) {
          throw new AppError(404, "GENERATION_SOURCE_ASSET_NOT_FOUND", "AI 原始素材不存在或已不可用");
        }
      }
      const historyCutoff = new Date(
        Date.parse(input.now) - OPERATIONAL_HISTORY_RETENTION_MILLISECONDS,
      ).toISOString();
      await client.query(
        `UPDATE generation_jobs AS child
         SET parent_job_id = NULL
         WHERE child.parent_job_id IN (
           SELECT expired.id
           FROM generation_jobs AS expired
           WHERE expired.user_id = $1
             AND expired.status = ANY($2::text[])
             AND expired.updated_at < $3
             AND ($4::uuid IS NULL OR expired.id <> $4)
          )
            AND child.status = ANY($2::text[])`,
        [input.userId, GENERATION_TERMINAL_STATUSES, historyCutoff, input.parentJobId ?? null],
      );
      await client.query(
         `DELETE FROM generation_jobs AS expired
          WHERE expired.user_id = $1
            AND expired.status = ANY($2::text[])
            AND expired.updated_at < $3
            AND ($4::uuid IS NULL OR expired.id <> $4)
            AND NOT EXISTS (
              SELECT 1 FROM generation_jobs AS child
              WHERE child.parent_job_id = expired.id
            )`,
        [input.userId, GENERATION_TERMINAL_STATUSES, historyCutoff, input.parentJobId ?? null],
      );
      const account = await client.query<{ balance: number }>(
        "SELECT balance FROM credit_accounts WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      const current = account.rows[0];
      if (!current) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
      const activeJobs = await client.query<{ job_count: number | string }>(
        `SELECT count(*) AS job_count FROM generation_jobs
         WHERE user_id = $1 AND status = ANY($2::text[])`,
        [input.userId, GENERATION_CANCELABLE_STATUSES],
      );
      if (Number(activeJobs.rows[0]?.job_count ?? 0) >= MAX_ACTIVE_GENERATION_JOBS_PER_USER) {
        throw new AppError(429, "GENERATION_ACTIVE_LIMIT_EXCEEDED", "同时处理的生成任务已达到上限", {
          limit: MAX_ACTIVE_GENERATION_JOBS_PER_USER,
        });
      }
      const history = await client.query<{ job_count: number | string }>(
        "SELECT count(*) AS job_count FROM generation_jobs WHERE user_id = $1",
        [input.userId],
      );
      if (Number(history.rows[0]?.job_count ?? 0) >= MAX_GENERATION_HISTORY_PER_USER) {
        throw new AppError(429, "GENERATION_HISTORY_LIMIT_EXCEEDED", "生成历史记录已达到上限", {
          limit: MAX_GENERATION_HISTORY_PER_USER,
          retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
        });
      }
      if (current.balance < input.cost) {
        throw new AppError(402, "INSUFFICIENT_CREDITS", "可用次数不足", {
          balance: current.balance,
          required: input.cost,
        });
      }
      const balanceAfter = current.balance - input.cost;
      if (input.cost > 0) {
        await client.query(
          "UPDATE credit_accounts SET balance = $2, updated_at = $3 WHERE user_id = $1",
          [input.userId, balanceAfter, input.now],
        );
        await client.query(
          `INSERT INTO credit_ledger(id, user_id, delta, balance_after, reason, reference_id, created_at)
           VALUES ($1, $2, $3, $4, 'generation_reserved', $5, $6)`,
          [randomUUID(), input.userId, -input.cost, balanceAfter, input.jobId, input.now],
        );
      }
      const inserted = await client.query<JobRow>(
        `INSERT INTO generation_jobs(
           id, user_id, parent_job_id, kind, status, palette_id, source_asset_id, options, cost, seed,
           width, height, progress, attempt_count, max_attempts, available_at,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7::jsonb, $8, $9, $10, $11, 0, 0, 3, $12, $12, $12)
         RETURNING *`,
        [
          input.jobId,
          input.userId,
          input.parentJobId ?? null,
          input.kind,
          input.paletteId,
          input.sourceAssetId,
          JSON.stringify(options),
          input.cost,
          input.seed,
          input.width,
          input.height,
          input.now,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new AppError(500, "GENERATION_CREATE_FAILED", "生成任务创建失败");
      return this.mapJob(row, []);
    });
  }

  async getGenerationJob(userId: string, jobId: string): Promise<GenerationJob | null> {
    const jobs = await this.query<JobRow>(
      "SELECT * FROM generation_jobs WHERE id = $1 AND user_id = $2",
      [jobId, userId],
    );
    const jobRow = jobs.rows[0];
    if (!jobRow) return null;
    const candidates = await this.query<CandidateRow>(
      "SELECT * FROM generation_candidates WHERE job_id = $1 ORDER BY ordinal",
      [jobId],
    );
    return this.mapJob(jobRow, candidates.rows);
  }

  async listGenerationJobs(input: Parameters<AppStore["listGenerationJobs"]>[0]): Promise<GenerationJob[]> {
    const jobs = await this.query<JobRow>(
      `SELECT * FROM generation_jobs
       WHERE user_id = $1
         AND ($2::text[] IS NULL OR status = ANY($2::text[]))
       ORDER BY updated_at DESC, id DESC
       LIMIT $3 OFFSET $4`,
      [input.userId, input.statuses ?? null, input.limit, input.offset ?? 0],
    );
    if (jobs.rows.length === 0) return [];
    const candidates = await this.query<CandidateRow>(
      `SELECT * FROM generation_candidates
       WHERE job_id = ANY($1::uuid[])
       ORDER BY job_id, ordinal`,
      [jobs.rows.map((job) => job.id)],
    );
    const byJob = new Map<string, CandidateRow[]>();
    for (const row of candidates.rows) {
      const grouped = byJob.get(row.job_id) ?? [];
      grouped.push(row);
      byJob.set(row.job_id, grouped);
    }
    return jobs.rows.map((job) => this.mapJob(job, byJob.get(job.id) ?? []));
  }

  async countActiveGenerationJobs(userId: string): Promise<number> {
    const result = await this.query<{ count: number | string }>(
      `SELECT COUNT(*)::integer AS count
       FROM generation_jobs
       WHERE user_id = $1
         AND status = ANY($2::text[])`,
      [userId, ["queued", "retry_wait", ...GENERATION_ACTIVE_STATUSES]],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private mapJob(row: JobRow, rows: CandidateRow[]): GenerationJob {
    return {
      id: row.id,
      userId: row.user_id,
      parentJobId: row.parent_job_id,
      kind: row.kind,
      status: row.status,
      paletteId: row.palette_id,
      sourceAssetId: row.source_asset_id,
      options: deserializeGenerationOptions(row.options),
      cost: row.cost,
      seed: row.seed,
      width: row.width,
      height: row.height,
      progress: row.progress,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      availableAt: iso(row.available_at),
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      completedAt: row.completed_at ? iso(row.completed_at) : null,
      canceledAt: row.canceled_at ? iso(row.canceled_at) : null,
      acceptedCandidateId: row.accepted_candidate_id,
      candidates: rows.map(candidate),
    };
  }

  private async releaseGenerationCredits(client: PoolClient, job: JobRow, now: string): Promise<void> {
    if (job.cost <= 0) return;
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM credit_ledger
       WHERE reason = 'generation_released' AND reference_id = $1`,
      [job.id],
    );
    if (existing.rows[0]) return;
    const account = await client.query<{ balance: number }>(
      `UPDATE credit_accounts
       SET balance = balance + $2, updated_at = $3
       WHERE user_id = $1
       RETURNING balance`,
      [job.user_id, job.cost, now],
    );
    const row = account.rows[0];
    if (!row) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
    await client.query(
      `INSERT INTO credit_ledger(id, user_id, delta, balance_after, reason, reference_id, created_at)
       VALUES ($1, $2, $3, $4, 'generation_released', $5, $6)`,
      [randomUUID(), job.user_id, job.cost, row.balance, job.id, now],
    );
  }

  private async settleGenerationCredits(client: PoolClient, job: JobRow, now: string): Promise<void> {
    if (job.cost <= 0) return;
    const account = await client.query<{ balance: number }>(
      "SELECT balance FROM credit_accounts WHERE user_id = $1",
      [job.user_id],
    );
    const row = account.rows[0];
    if (!row) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
    await client.query(
      `INSERT INTO credit_ledger(id, user_id, delta, balance_after, reason, reference_id, created_at)
       VALUES ($1, $2, 0, $3, 'generation_settled', $4, $5)
       ON CONFLICT (reason, reference_id)
         WHERE reason IN ('generation_reserved', 'generation_settled', 'generation_released')
           AND reference_id IS NOT NULL
       DO NOTHING`,
      [randomUUID(), job.user_id, row.balance, job.id, now],
    );
  }

  async claimNextGenerationJob(input: Parameters<AppStore["claimNextGenerationJob"]>[0]): Promise<GenerationJob | null> {
    const leaseMilliseconds = assertWorkerLeaseMilliseconds(input.leaseMilliseconds);
    return this.inTransaction(async (client) => {
      // Select and expire one bounded batch inside the same SQL statement.
      // Besides saving a round trip, this prevents a concurrent history cleanup
      // from queueing an UPDATE between a standalone FOR UPDATE and our UPDATE,
      // which can otherwise form a tuple-lock cycle even when account order is
      // correct.
      const expired = await client.query<JobRow & { recovery_lease_expires_at: Date | string }>(
        `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now),
              expired_candidates AS MATERIALIZED (
                SELECT candidate.id,
                       candidate.lease_expires_at AS recovery_lease_expires_at
                FROM generation_jobs AS candidate
                WHERE candidate.status = ANY($1::text[])
                  AND candidate.lease_expires_at <= statement_timestamp()
                ORDER BY candidate.lease_expires_at, candidate.id
                FOR UPDATE OF candidate SKIP LOCKED
                LIMIT 100
              )
         UPDATE generation_jobs AS job
         SET status = CASE WHEN job.attempt_count >= job.max_attempts THEN 'failed' ELSE 'retry_wait' END,
             available_at = db_clock.now,
             lease_token = NULL,
             lease_expires_at = NULL,
             error_code = 'GENERATION_LEASE_EXPIRED',
             error_message = '生成 worker 租约已过期',
             updated_at = db_clock.now
         FROM db_clock, expired_candidates AS candidate
         WHERE job.id = candidate.id
         RETURNING job.*, candidate.recovery_lease_expires_at`,
        [GENERATION_ACTIVE_STATUSES],
      );
      if (expired.rows.length > 0) {
        // UPDATE ... RETURNING has no ordering guarantee. Preserve the same
        // deterministic expiry/id order used to choose the batch so per-account
        // ledger balance_after values remain stable under concurrent recovery.
        const expiredRows = [...expired.rows].sort((left, right) => {
          const expiryDelta =
            new Date(left.recovery_lease_expires_at).getTime() -
            new Date(right.recovery_lease_expires_at).getTime();
          return expiryDelta || left.id.localeCompare(right.id);
        });
        const expiredIds = expiredRows.map((job) => job.id);
        const expiredAtByJob = new Map(
          expiredRows.map((row) => [row.id, iso(row.updated_at)] as const),
        );
        const terminalJobs = expiredRows.filter(
          (job) => job.attempt_count >= job.max_attempts && job.cost > 0,
        );
        if (terminalJobs.length > 0) {
          const terminalIds = terminalJobs.map((job) => job.id);
          const releasedBeforeLock = await client.query<{ reference_id: string }>(
            `SELECT reference_id FROM credit_ledger
             WHERE reason = 'generation_released'
               AND reference_id = ANY($1::text[])`,
            [terminalIds],
          );
          const releasedIds = new Set(releasedBeforeLock.rows.map((row) => row.reference_id));
          const pendingBeforeLock = terminalJobs.filter((job) => !releasedIds.has(job.id));

          if (pendingBeforeLock.length > 0) {
            const userIds = [...new Set(pendingBeforeLock.map((job) => job.user_id))].sort();
            const accounts = await client.query<{ user_id: string; balance: number }>(
              `SELECT user_id, balance FROM credit_accounts
               WHERE user_id = ANY($1::uuid[])
               ORDER BY user_id
               FOR UPDATE`,
              [userIds],
            );
            if (accounts.rows.length !== userIds.length) {
              throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
            }

            // A concurrent release can commit while this transaction waits for
            // an account lock. Re-read under a fresh READ COMMITTED snapshot so
            // the batch below never credits an already released job.
            const releasedAfterLock = await client.query<{ reference_id: string }>(
              `SELECT reference_id FROM credit_ledger
               WHERE reason = 'generation_released'
                 AND reference_id = ANY($1::text[])`,
              [pendingBeforeLock.map((job) => job.id)],
            );
            for (const row of releasedAfterLock.rows) releasedIds.add(row.reference_id);
            const refunds = pendingBeforeLock.filter((job) => !releasedIds.has(job.id));

            if (refunds.length > 0) {
              const balances = new Map(accounts.rows.map((row) => [row.user_id, row.balance] as const));
              const balanceAfters = refunds.map((job) => {
                const current = balances.get(job.user_id);
                if (current === undefined) {
                  throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
                }
                const next = current + job.cost;
                balances.set(job.user_id, next);
                return next;
              });
              const refundTimes = refunds.map((job) => {
                const expiredAt = expiredAtByJob.get(job.id);
                if (!expiredAt) {
                  throw new AppError(500, "GENERATION_LEASE_EXPIRY_FAILED", "生成任务过期处理失败");
                }
                return expiredAt;
              });
              const inserted = await client.query<{ reference_id: string }>(
                `INSERT INTO credit_ledger(
                   id, user_id, delta, balance_after, reason, reference_id, created_at
                 )
                 SELECT release.id, release.user_id, release.delta, release.balance_after,
                        'generation_released', release.reference_id, release.created_at
                 FROM unnest(
                   $1::uuid[], $2::uuid[], $3::integer[], $4::integer[], $5::text[], $6::timestamptz[]
                 ) AS release(id, user_id, delta, balance_after, reference_id, created_at)
                 ON CONFLICT (reason, reference_id)
                   WHERE reason IN ('generation_reserved', 'generation_settled', 'generation_released')
                     AND reference_id IS NOT NULL
                 DO NOTHING
                 RETURNING reference_id`,
                [
                  refunds.map(() => randomUUID()),
                  refunds.map((job) => job.user_id),
                  refunds.map((job) => job.cost),
                  balanceAfters,
                  refunds.map((job) => job.id),
                  refundTimes,
                ],
              );
              const insertedIds = new Set(inserted.rows.map((row) => row.reference_id));
              if (insertedIds.size !== refunds.length || refunds.some((job) => !insertedIds.has(job.id))) {
                throw new AppError(500, "GENERATION_CREDIT_RELEASE_FAILED", "生成任务次数退还失败");
              }

              const updatedAccounts = await client.query<{ user_id: string }>(
                `WITH refund(user_id, delta) AS (
                   SELECT * FROM unnest($1::uuid[], $2::integer[])
                 ), totals AS (
                   SELECT user_id, SUM(delta)::integer AS delta
                   FROM refund
                   GROUP BY user_id
                 )
                 UPDATE credit_accounts AS account
                 SET balance = account.balance + totals.delta,
                     updated_at = $3
                 FROM totals
                 WHERE account.user_id = totals.user_id
                 RETURNING account.user_id`,
                [
                  refunds.map((job) => job.user_id),
                  refunds.map((job) => job.cost),
                  refundTimes[0],
                ],
              );
              const refundedUsers = new Set(refunds.map((job) => job.user_id));
              const updatedUserIds = new Set(updatedAccounts.rows.map((row) => row.user_id));
              if (updatedUserIds.size !== refundedUsers.size
                || [...refundedUsers].some((userId) => !updatedUserIds.has(userId))) {
                throw new AppError(500, "GENERATION_CREDIT_RELEASE_FAILED", "生成任务次数退还失败");
              }
            }
          }
        }
      }

      const selected = await client.query<{ id: string }>(
        `SELECT id FROM generation_jobs
         WHERE status IN ('queued', 'retry_wait') AND available_at <= clock_timestamp()
         ORDER BY available_at, created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      const id = selected.rows[0]?.id;
      if (!id) return null;
      const claimed = await client.query<JobRow>(
        `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
         UPDATE generation_jobs
         SET status = 'preprocessing', progress = GREATEST(progress, 5),
             attempt_count = attempt_count + 1,
             lease_token = $1,
             lease_expires_at = db_clock.now + ($2::bigint * interval '1 millisecond'),
             error_code = NULL, error_message = NULL, updated_at = db_clock.now
         FROM db_clock
         WHERE generation_jobs.id = $3
         RETURNING generation_jobs.*`,
        [input.leaseToken, leaseMilliseconds, id],
      );
      const row = claimed.rows[0];
      if (!row) throw new AppError(500, "GENERATION_CLAIM_FAILED", "生成任务领取失败");
      return this.mapJob(row, []);
    });
  }

  async renewGenerationJobLease(input: Parameters<AppStore["renewGenerationJobLease"]>[0]): Promise<boolean> {
    const leaseMilliseconds = assertWorkerLeaseMilliseconds(input.leaseMilliseconds);
    const result = await this.query(
      `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
       UPDATE generation_jobs
       SET lease_expires_at = db_clock.now + ($3::bigint * interval '1 millisecond'),
           updated_at = db_clock.now
       FROM db_clock
       WHERE generation_jobs.id = $1 AND lease_token = $2
         AND status = ANY($4::text[]) AND lease_expires_at > db_clock.now`,
      [input.jobId, input.leaseToken, leaseMilliseconds, GENERATION_ACTIVE_STATUSES],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async advanceGenerationJob(input: Parameters<AppStore["advanceGenerationJob"]>[0]): Promise<GenerationJob> {
    const updated = await this.query<JobRow>(
      `UPDATE generation_jobs
       SET status = $3, progress = GREATEST(progress, $4), updated_at = $5
       WHERE id = $1 AND lease_token = $2
         AND status = ANY($6::text[]) AND lease_expires_at > clock_timestamp()
       RETURNING *`,
      [input.jobId, input.leaseToken, input.status, input.progress, input.now, GENERATION_ACTIVE_STATUSES],
    );
    const row = updated.rows[0];
    if (!row) throw new AppError(409, "GENERATION_LEASE_LOST", "生成任务租约已失效");
    return this.mapJob(row, []);
  }

  async completeGenerationJob(input: Parameters<AppStore["completeGenerationJob"]>[0]): Promise<GenerationJob> {
    return this.inTransaction(async (client) => {
      const ownerLookup = await client.query<{ user_id: string }>(
        "SELECT user_id FROM generation_jobs WHERE id = $1",
        [input.jobId],
      );
      const userId = ownerLookup.rows[0]?.user_id;
      if (!userId) throw new AppError(409, "GENERATION_LEASE_LOST", "生成任务租约已失效");
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const locked = await client.query<JobRow & { lease_active: boolean }>(
        `SELECT generation_jobs.*,
                lease_expires_at > clock_timestamp() AS lease_active
         FROM generation_jobs WHERE id = $1 FOR UPDATE`,
        [input.jobId],
      );
      const job = locked.rows[0];
      if (!job || !GENERATION_ACTIVE_STATUSES.includes(job.status)
        || job.lease_token !== input.leaseToken || !job.lease_active) {
        throw new AppError(409, "GENERATION_LEASE_LOST", "生成任务租约已失效");
      }
      await this.requireSelectablePalette(client, userId, job.palette_id);
      const jobOptions = deserializeGenerationOptions(job.options);
      const candidateCells = assertGenerationCandidatesStructure({
        jobId: job.id,
        kind: job.kind,
        options: jobOptions,
        width: job.width,
        height: job.height,
        candidates: input.candidates,
      });
      const retained = await client.query<{ cell_count: number | string }>(
        `SELECT COALESCE(sum(c.width::bigint * c.height::bigint), 0) AS cell_count
         FROM generation_candidates AS c
         JOIN generation_jobs AS j ON j.id = c.job_id
         WHERE j.user_id = $1`,
        [userId],
      );
      const retainedCandidateCells = Number(retained.rows[0]?.cell_count ?? 0);
      if (!Number.isSafeInteger(retainedCandidateCells)
        || retainedCandidateCells + candidateCells > MAX_GENERATION_CANDIDATE_CELLS_PER_USER) {
        throw new AppError(429, "GENERATION_CANDIDATE_CELLS_LIMIT_EXCEEDED", "生成候选历史占用空间已达到上限", {
          limitCells: MAX_GENERATION_CANDIDATE_CELLS_PER_USER,
        });
      }
      for (const item of input.candidates) {
        await client.query(
          `INSERT INTO generation_candidates(
             id, job_id, ordinal, variant_ordinal, output_slot, subject_slot,
             encoding, width, height, cells, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
          [
            item.id,
            item.jobId,
            item.ordinal,
            item.variantOrdinal,
            item.outputSlot,
            item.subject ?? null,
            item.grid.encoding,
            item.grid.width,
            item.grid.height,
            JSON.stringify(item.grid.cells),
            item.createdAt,
          ],
        );
      }
      await this.settleGenerationCredits(client, job, input.now);
      const completed = await client.query<JobRow>(
        `UPDATE generation_jobs
         SET status = 'completed', progress = 100,
             lease_token = NULL, lease_expires_at = NULL,
             error_code = NULL, error_message = NULL,
             completed_at = $3, updated_at = $3
         WHERE id = $1 AND lease_token = $2
         RETURNING *`,
        [input.jobId, input.leaseToken, input.now],
      );
      const row = completed.rows[0];
      if (!row) throw new AppError(409, "GENERATION_LEASE_LOST", "生成任务租约已失效");
      return this.mapJob(row, input.candidates.map((item) => ({
        id: item.id,
        job_id: item.jobId,
        ordinal: item.ordinal,
        variant_ordinal: item.variantOrdinal,
        output_slot: item.outputSlot,
        subject_slot: item.subject ?? null,
        accepted_project_id: null,
        accepted_at: null,
        encoding: item.grid.encoding,
        width: item.grid.width,
        height: item.grid.height,
        cells: item.grid.cells,
        created_at: item.createdAt,
      })));
    });
  }

  async failGenerationJob(input: Parameters<AppStore["failGenerationJob"]>[0]): Promise<GenerationJob> {
    return this.inTransaction(async (client) => {
      const locked = await client.query<JobRow & { lease_active: boolean }>(
        `SELECT generation_jobs.*,
                lease_expires_at > clock_timestamp() AS lease_active
         FROM generation_jobs WHERE id = $1 FOR UPDATE`,
        [input.jobId],
      );
      const job = locked.rows[0];
      if (!job || !GENERATION_ACTIVE_STATUSES.includes(job.status)
        || job.lease_token !== input.leaseToken || !job.lease_active) {
        throw new AppError(409, "GENERATION_LEASE_LOST", "生成任务租约已失效");
      }
      const retry = input.retryable && job.attempt_count < job.max_attempts;
      const failed = await client.query<JobRow>(
        `UPDATE generation_jobs
         SET status = $3, available_at = $4,
             lease_token = NULL, lease_expires_at = NULL,
             error_code = $5, error_message = $6, updated_at = $7
         WHERE id = $1 AND lease_token = $2
         RETURNING *`,
        [
          input.jobId,
          input.leaseToken,
          retry ? "retry_wait" : "failed",
          input.availableAt,
          input.code,
          input.message,
          input.now,
        ],
      );
      const row = failed.rows[0];
      if (!row) throw new AppError(409, "GENERATION_LEASE_LOST", "生成任务租约已失效");
      if (!retry) await this.releaseGenerationCredits(client, job, input.now);
      return this.mapJob(row, []);
    });
  }

  async cancelGenerationJob(userId: string, jobId: string, now: string): Promise<GenerationJob> {
    return this.inTransaction(async (client) => {
      const locked = await client.query<JobRow>(
        "SELECT * FROM generation_jobs WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [jobId, userId],
      );
      const job = locked.rows[0];
      if (!job) throw new AppError(404, "GENERATION_JOB_NOT_FOUND", "生成任务不存在");
      const candidates = await client.query<CandidateRow>(
        "SELECT * FROM generation_candidates WHERE job_id = $1 ORDER BY ordinal",
        [jobId],
      );
      if (job.status === "canceled") return this.mapJob(job, candidates.rows);
      if (["completed", "accepted", "failed"].includes(job.status)) {
        throw new AppError(409, "GENERATION_NOT_CANCELABLE", "生成任务当前状态不能取消", { status: job.status });
      }
      const canceled = await client.query<JobRow>(
        `UPDATE generation_jobs
         SET status = 'canceled', lease_token = NULL, lease_expires_at = NULL,
             canceled_at = $3, updated_at = $3
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [jobId, userId, now],
      );
      const row = canceled.rows[0];
      if (!row) throw new AppError(500, "GENERATION_CANCEL_FAILED", "生成任务取消失败");
      await this.releaseGenerationCredits(client, job, now);
      return this.mapJob(row, candidates.rows);
    });
  }

  async acceptGenerationCandidate(input: {
    userId: string;
    jobId: string;
    candidateId: string;
    projectName: string;
  }): Promise<{ job: GenerationJob; project: ProjectDetail }> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      const jobs = await client.query<JobRow>(
        "SELECT * FROM generation_jobs WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [input.jobId, input.userId],
      );
      const row = jobs.rows[0];
      if (!row) throw new AppError(404, "GENERATION_JOB_NOT_FOUND", "生成任务不存在");
      if (row.status !== "completed" && row.status !== "accepted") {
        throw new AppError(409, "GENERATION_NOT_READY", "生成任务尚未完成", { status: row.status });
      }
      const candidates = await client.query<CandidateRow>(
        "SELECT * FROM generation_candidates WHERE job_id = $1 ORDER BY ordinal FOR UPDATE",
        [input.jobId],
      );
      const selected = candidates.rows.find((item) => item.id === input.candidateId);
      if (!selected) throw new AppError(404, "GENERATION_CANDIDATE_NOT_FOUND", "生成候选不存在");
      const variantOutputs = candidates.rows.filter((item) => item.variant_ordinal === selected.variant_ordinal);
      if (selected.output_slot !== "combined" || variantOutputs.length !== 1) {
        throw new AppError(
          409,
          "GENERATION_CANDIDATE_REQUIRES_VARIANT_ACCEPT",
          "多输出生成方案必须通过方案采用接口原子创建全部项目",
        );
      }
      if (row.accepted_candidate_id) {
        throw new AppError(409, "GENERATION_ALREADY_ACCEPTED", "该任务已有采用的候选方案");
      }
      if (row.status !== "completed") {
        throw new AppError(409, "GENERATION_NOT_READY", "生成任务尚未完成", { status: row.status });
      }
      if (selected.accepted_at || row.accepted_candidate_id === selected.id) {
        throw new AppError(409, "GENERATION_CANDIDATE_ALREADY_ACCEPTED", "该候选已采用为项目", {
          projectId: selected.accepted_project_id ?? undefined,
        });
      }
      const selectedCandidate = candidate(selected);
      const rowOptions = deserializeGenerationOptions(row.options);
      const sourceAssetId = row.source_asset_id
        && await this.projectAssetIsAvailable(client, input.userId, row.source_asset_id, "ai-source")
        ? row.source_asset_id
        : null;
      const project = await this.insertProject(client, input.userId, {
        name: input.projectName,
        paletteId: row.palette_id,
        grid: selectedCandidate.grid,
        mode: row.kind,
        lifecycleStatus: "editable",
        sourceAssetId,
        previewAssetId: null,
        backgroundMode: rowOptions.transparentBackground ? "transparent" : "white",
        backgroundColor: null,
      });
      const acceptedCandidate = await client.query<CandidateRow>(
        `UPDATE generation_candidates
         SET accepted_project_id = $3, accepted_at = now()
         WHERE job_id = $1 AND id = $2 AND accepted_at IS NULL
         RETURNING *`,
        [input.jobId, input.candidateId, project.id],
      );
      if (!acceptedCandidate.rows[0]) {
        throw new AppError(409, "GENERATION_CANDIDATE_ALREADY_ACCEPTED", "该候选已采用为项目");
      }
      const updated = await client.query<JobRow>(
        `UPDATE generation_jobs
         SET status = 'accepted', accepted_candidate_id = COALESCE(accepted_candidate_id, $3), updated_at = now()
         WHERE id = $1 AND user_id = $2 RETURNING *`,
        [input.jobId, input.userId, input.candidateId],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new AppError(500, "GENERATION_ACCEPT_FAILED", "候选采用失败");
      const persistedCandidates = await client.query<CandidateRow>(
        "SELECT * FROM generation_candidates WHERE job_id = $1 ORDER BY ordinal",
        [input.jobId],
      );
      return { job: this.mapJob(updatedRow, persistedCandidates.rows), project };
    });
  }

  async acceptGenerationVariant(
    input: Parameters<AppStore["acceptGenerationVariant"]>[0],
  ): ReturnType<AppStore["acceptGenerationVariant"]> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      const jobs = await client.query<JobRow>(
        "SELECT * FROM generation_jobs WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [input.jobId, input.userId],
      );
      const job = jobs.rows[0];
      if (!job) throw new AppError(404, "GENERATION_JOB_NOT_FOUND", "生成任务不存在");
      if (job.status !== "completed" || job.accepted_candidate_id !== null) {
        throw new AppError(409, "GENERATION_VARIANT_ALREADY_ACCEPTED", "该生成任务已有采用结果");
      }

      const candidates = await client.query<CandidateRow>(
        "SELECT * FROM generation_candidates WHERE job_id = $1 ORDER BY ordinal FOR UPDATE",
        [input.jobId],
      );
      const variant = candidates.rows.filter((row) => row.variant_ordinal === input.variantOrdinal);
      if (variant.length === 0) {
        throw new AppError(404, "GENERATION_VARIANT_NOT_FOUND", "生成方案不存在");
      }
      const jobOptions = deserializeGenerationOptions(job.options);
      const expectedSlots = generationOutputSlots(job.kind, jobOptions);
      if (variant.length !== expectedSlots.length
        || expectedSlots.some((slot) => !variant.some((row) => row.output_slot === slot))) {
        throw new AppError(409, "GENERATION_VARIANT_OUTPUTS_INVALID", "生成方案输出不完整");
      }
      if (variant.some((row) => row.accepted_at !== null)) {
        throw new AppError(409, "GENERATION_VARIANT_ALREADY_ACCEPTED", "该生成方案已有输出被采用");
      }

      const requestedNames = new Map<GenerationCandidateOutputSlot, string>();
      for (const item of input.projects) {
        const name = item.projectName.trim();
        if (!name || requestedNames.has(item.outputSlot)) {
          throw new AppError(400, "GENERATION_VARIANT_PROJECTS_INVALID", "每个方案输出必须提供唯一且非空的项目名称");
        }
        requestedNames.set(item.outputSlot, name);
      }
      if (requestedNames.size !== expectedSlots.length
        || expectedSlots.some((slot) => !requestedNames.has(slot))) {
        throw new AppError(400, "GENERATION_VARIANT_PROJECTS_INVALID", "项目名称必须与方案输出槽位完全一致");
      }

      const sourceAssetId = job.source_asset_id
        && await this.projectAssetIsAvailable(client, input.userId, job.source_asset_id, "ai-source")
        ? job.source_asset_id
        : null;
      const outputs = [] as Awaited<ReturnType<AppStore["acceptGenerationVariant"]>>["outputs"];
      for (const row of variant) {
        const selected = candidate(row);
        const project = await this.insertProject(client, input.userId, {
          name: requestedNames.get(row.output_slot)!,
          paletteId: job.palette_id,
          grid: selected.grid,
          mode: job.kind,
          lifecycleStatus: "editable",
          sourceAssetId,
          previewAssetId: null,
          backgroundMode: jobOptions.transparentBackground ? "transparent" : "white",
          backgroundColor: null,
        });
        const accepted = await client.query<CandidateRow>(
          `UPDATE generation_candidates
           SET accepted_project_id = $3, accepted_at = clock_timestamp()
           WHERE job_id = $1 AND id = $2 AND accepted_at IS NULL
           RETURNING *`,
          [input.jobId, row.id, project.id],
        );
        if (!accepted.rows[0]) {
          throw new AppError(409, "GENERATION_VARIANT_ALREADY_ACCEPTED", "该生成方案已有输出被采用");
        }
        outputs.push({ candidateId: row.id, outputSlot: row.output_slot, project });
      }

      const firstCandidate = variant[0];
      if (!firstCandidate) throw new AppError(409, "GENERATION_VARIANT_OUTPUTS_INVALID", "生成方案输出不完整");
      const updated = await client.query<JobRow>(
        `UPDATE generation_jobs
         SET status = 'accepted', accepted_candidate_id = $3, updated_at = clock_timestamp()
         WHERE id = $1 AND user_id = $2
           AND status = 'completed' AND accepted_candidate_id IS NULL
         RETURNING *`,
        [input.jobId, input.userId, firstCandidate.id],
      );
      const updatedJob = updated.rows[0];
      if (!updatedJob) {
        throw new AppError(409, "GENERATION_VARIANT_ALREADY_ACCEPTED", "该生成任务已有采用结果");
      }
      const persisted = await client.query<CandidateRow>(
        "SELECT * FROM generation_candidates WHERE job_id = $1 ORDER BY ordinal",
        [input.jobId],
      );
      return {
        job: this.mapJob(updatedJob, persisted.rows),
        variantOrdinal: input.variantOrdinal,
        outputs,
      };
    });
  }

  async createExportJob(input: Parameters<AppStore["createExportJob"]>[0]): Promise<ExportJobRecord> {
    return this.inTransaction(async (client) => {
      const owner = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [input.userId],
      );
      if (!owner.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
      const historyCutoff = new Date(
        Date.parse(input.now) - OPERATIONAL_HISTORY_RETENTION_MILLISECONDS,
      ).toISOString();
      await client.query(
        `DELETE FROM export_jobs AS job
         WHERE job.user_id = $1
           AND job.status = ANY($2::text[])
           AND job.updated_at < $3
           AND NOT EXISTS (
             SELECT 1 FROM export_artifacts AS artifact
             WHERE artifact.job_id = job.id AND artifact.purged_at IS NULL
           )`,
        [input.userId, ["succeeded", "failed", "canceled"], historyCutoff],
      );
      const activeJobs = await client.query<{ job_count: number | string }>(
        `SELECT count(*) AS job_count FROM export_jobs
         WHERE user_id = $1 AND status = ANY($2::text[])`,
        [input.userId, ["queued", "running", "retry_wait"]],
      );
      if (Number(activeJobs.rows[0]?.job_count ?? 0) >= MAX_ACTIVE_EXPORT_JOBS_PER_USER) {
        throw new AppError(429, "EXPORT_ACTIVE_LIMIT_EXCEEDED", "同时处理的导出任务已达到上限", {
          limit: MAX_ACTIVE_EXPORT_JOBS_PER_USER,
        });
      }
      const history = await client.query<{ job_count: number | string }>(
        "SELECT count(*) AS job_count FROM export_jobs WHERE user_id = $1",
        [input.userId],
      );
      if (Number(history.rows[0]?.job_count ?? 0) >= MAX_EXPORT_HISTORY_PER_USER) {
        throw new AppError(429, "EXPORT_HISTORY_LIMIT_EXCEEDED", "导出历史记录已达到上限", {
          limit: MAX_EXPORT_HISTORY_PER_USER,
          retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
        });
      }
      const projectRevision = await client.query<{ palette_id: string }>(
        `SELECT revision.palette_id
         FROM projects AS project
         JOIN project_revisions AS revision
           ON revision.project_id = project.id
          AND revision.revision = $3
         WHERE project.id = $2 AND project.user_id = $1 AND project.deleted_at IS NULL
         FOR SHARE OF project, revision`,
        [input.userId, input.projectId, input.projectRevision],
      );
      const targetRevision = projectRevision.rows[0];
      if (!targetRevision) {
        throw new AppError(404, "PROJECT_REVISION_NOT_FOUND", "项目或指定版本不存在");
      }
      await this.requireSelectablePalette(client, input.userId, targetRevision.palette_id);
      const result = await client.query<ExportJobRow>(
        `WITH inserted AS (
           INSERT INTO export_jobs(
             id, user_id, project_id, project_revision, format, file_name, options,
             status, progress, attempt_count, max_attempts, available_at, created_at, updated_at
           )
           SELECT $1, $2, p.id, $4, $5, $6, $7::jsonb,
                  'queued', 0, 0, 3, $8, $8, $8
           FROM projects p
           JOIN project_revisions r ON r.project_id = p.id AND r.revision = $4
           WHERE p.id = $3 AND p.user_id = $2 AND p.deleted_at IS NULL
           RETURNING *
         )
         SELECT inserted.*,
                NULL::uuid AS artifact_id, NULL::uuid AS artifact_job_id,
                NULL::text AS artifact_storage_key, NULL::text AS artifact_mime_type,
                NULL::text AS artifact_file_name, NULL::bigint AS artifact_size_bytes,
                NULL::text AS artifact_sha256, NULL::timestamptz AS artifact_expires_at,
                NULL::timestamptz AS artifact_created_at
         FROM inserted`,
        [input.id, input.userId, input.projectId, input.projectRevision, input.format, input.fileName, JSON.stringify(input.options), input.now],
      );
      const row = result.rows[0];
      if (!row) throw new AppError(404, "PROJECT_REVISION_NOT_FOUND", "项目或指定版本不存在");
      return exportJobRecord(row);
    });
  }

  async listExportJobs(userId: string, limit: number, offset = 0): Promise<ExportJobRecord[]> {
    const result = await this.query<ExportJobRow>(
      `${EXPORT_JOB_SELECT}
       WHERE j.user_id = $1
       ORDER BY j.created_at DESC, j.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return result.rows.map(exportJobRecord);
  }

  async getExportJobStats(userId: string): Promise<ExportJobStats> {
    const result = await this.query<{
      total: number | string;
      succeeded: number | string;
    }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE status = 'succeeded') AS succeeded
       FROM export_jobs
       WHERE user_id = $1`,
      [userId],
    );
    return {
      total: Number(result.rows[0]?.total ?? 0),
      succeeded: Number(result.rows[0]?.succeeded ?? 0),
    };
  }

  async getExportJob(userId: string, exportJobId: string): Promise<ExportJobRecord | null> {
    const result = await this.query<ExportJobRow>(
      `${EXPORT_JOB_SELECT} WHERE j.id = $1 AND j.user_id = $2`,
      [exportJobId, userId],
    );
    const row = result.rows[0];
    return row ? exportJobRecord(row) : null;
  }

  async claimNextExportJob(input: Parameters<AppStore["claimNextExportJob"]>[0]): Promise<ExportJobRecord | null> {
    const leaseMilliseconds = assertWorkerLeaseMilliseconds(input.leaseMilliseconds);
    return this.inTransaction(async (client) => {
      await client.query(
        `WITH expired AS MATERIALIZED (
           SELECT id FROM export_jobs
           WHERE status = 'running' AND lease_expires_at <= statement_timestamp()
           ORDER BY lease_expires_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 100
         ),
         db_clock AS MATERIALIZED (SELECT statement_timestamp() AS now)
         UPDATE export_jobs
         SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
             available_at = db_clock.now,
             lease_token = NULL,
             lease_expires_at = NULL,
             error_code = 'EXPORT_LEASE_EXPIRED',
             error_message = '导出 worker 租约已过期',
             finished_at = CASE WHEN attempt_count >= max_attempts THEN db_clock.now ELSE NULL END,
             updated_at = db_clock.now
         FROM expired, db_clock
         WHERE export_jobs.id = expired.id`,
      );
      const selected = await client.query<{ id: string }>(
        `SELECT id FROM export_jobs
         WHERE status IN ('queued', 'retry_wait') AND available_at <= clock_timestamp()
         ORDER BY available_at, created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      const id = selected.rows[0]?.id;
      if (!id) return null;
      await client.query(
        `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
         UPDATE export_jobs
         SET status = 'running', progress = GREATEST(progress, 5),
             attempt_count = attempt_count + 1,
             lease_token = $1,
             lease_expires_at = db_clock.now + ($2::bigint * interval '1 millisecond'),
             error_code = NULL, error_message = NULL, updated_at = db_clock.now
         FROM db_clock
         WHERE export_jobs.id = $3`,
        [input.leaseToken, leaseMilliseconds, id],
      );
      const result = await client.query<ExportJobRow>(`${EXPORT_JOB_SELECT} WHERE j.id = $1`, [id]);
      const row = result.rows[0];
      if (!row) throw new AppError(500, "EXPORT_CLAIM_FAILED", "导出任务领取失败");
      return exportJobRecord(row);
    });
  }

  async renewExportJobLease(input: Parameters<AppStore["renewExportJobLease"]>[0]): Promise<boolean> {
    const leaseMilliseconds = assertWorkerLeaseMilliseconds(input.leaseMilliseconds);
    const result = await this.query(
      `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
       UPDATE export_jobs
       SET lease_expires_at = db_clock.now + ($3::bigint * interval '1 millisecond'),
           updated_at = db_clock.now
       FROM db_clock
       WHERE export_jobs.id = $1 AND status = 'running' AND lease_token = $2
         AND lease_expires_at > db_clock.now`,
      [input.jobId, input.leaseToken, leaseMilliseconds],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async prepareExportArtifact(input: Parameters<AppStore["prepareExportArtifact"]>[0]): Promise<void> {
    if (input.artifact.jobId !== input.jobId) {
      throw new AppError(500, "EXPORT_ARTIFACT_MISMATCH", "导出制品与任务不匹配");
    }
    await this.inTransaction(async (client) => {
      const ownerLookup = await client.query<{ user_id: string }>(
        "SELECT user_id FROM export_jobs WHERE id = $1",
        [input.jobId],
      );
      const userId = ownerLookup.rows[0]?.user_id;
      if (!userId) throw new AppError(409, "EXPORT_LEASE_LOST", "导出任务租约已失效");
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const job = await client.query<{ user_id: string }>(
        `SELECT user_id FROM export_jobs
         WHERE id = $1 AND status = 'running' AND lease_token = $2
           AND lease_expires_at > clock_timestamp()
         FOR UPDATE`,
        [input.jobId, input.leaseToken],
      );
      if (!job.rows[0] || job.rows[0].user_id !== userId) {
        throw new AppError(409, "EXPORT_LEASE_LOST", "导出任务租约已失效");
      }
      const existing = await client.query<{
        id: string;
        job_id: string;
        storage_key: string;
        sha256: string;
        ready_at: Date | string | null;
        abandoned_at: Date | string | null;
        purged_at: Date | string | null;
      }>(
        `SELECT id, job_id, storage_key, sha256, ready_at, abandoned_at, purged_at
         FROM export_artifacts WHERE id = $1 FOR UPDATE`,
        [input.artifact.id],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (prior.job_id !== input.jobId
          || prior.storage_key !== input.artifact.storageKey
          || prior.sha256 !== input.artifact.sha256) {
          throw new AppError(409, "EXPORT_ARTIFACT_IDENTITY_CONFLICT", "导出制品身份冲突");
        }
        if (prior.abandoned_at || prior.purged_at) {
          throw new AppError(409, "EXPORT_ARTIFACT_ABANDONED", "导出制品发布窗口已关闭");
        }
        return;
      }
      const usage = await client.query<{ artifact_count: number | string; size_bytes: number | string }>(
        `SELECT count(*) AS artifact_count, COALESCE(sum(a.size_bytes), 0) AS size_bytes
         FROM export_artifacts AS a
         JOIN export_jobs AS j ON j.id = a.job_id
         WHERE j.user_id = $1 AND a.purged_at IS NULL`,
        [userId],
      );
      const artifactCount = Number(usage.rows[0]?.artifact_count ?? 0);
      const retainedBytes = Number(usage.rows[0]?.size_bytes ?? 0);
      if (!Number.isSafeInteger(retainedBytes)
        || artifactCount >= MAX_UNPURGED_EXPORT_ARTIFACTS_PER_USER
        || retainedBytes + input.artifact.sizeBytes > MAX_UNPURGED_EXPORT_ARTIFACT_BYTES_PER_USER) {
        throw new AppError(429, "EXPORT_ARTIFACT_STORAGE_LIMIT_EXCEEDED", "导出制品存储空间已达到上限", {
          maxArtifacts: MAX_UNPURGED_EXPORT_ARTIFACTS_PER_USER,
          maxBytes: MAX_UNPURGED_EXPORT_ARTIFACT_BYTES_PER_USER,
        });
      }
      await client.query(
        `INSERT INTO export_artifacts(
           id, job_id, storage_key, mime_type, file_name, size_bytes, sha256,
           expires_at, created_at, purge_available_at, ready_at, abandoned_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, NULL, NULL)`,
        [
          input.artifact.id,
          input.jobId,
          input.artifact.storageKey,
          input.artifact.mimeType,
          input.artifact.fileName,
          input.artifact.sizeBytes,
          input.artifact.sha256,
          input.artifact.expiresAt,
          input.artifact.createdAt,
        ],
      );
    });
  }

  async completeExportJob(input: Parameters<AppStore["completeExportJob"]>[0]): Promise<ExportJobRecord> {
    return this.inTransaction(async (client) => {
      const locked = await client.query<{
        status: ExportJobStatus;
        lease_token: string | null;
        lease_active: boolean;
        project_id: string;
        project_revision: number;
      }>(
        `SELECT status, lease_token, project_id, project_revision,
                lease_expires_at > clock_timestamp() AS lease_active
         FROM export_jobs WHERE id = $1 FOR UPDATE`,
        [input.jobId],
      );
      const job = locked.rows[0];
      if (!job || job.status !== "running" || job.lease_token !== input.leaseToken || !job.lease_active) {
        throw new AppError(409, "EXPORT_LEASE_LOST", "导出任务租约已失效");
      }
      const published = await client.query<{ id: string }>(
        `UPDATE export_artifacts
         SET ready_at = $4
         WHERE id = $1 AND job_id = $2 AND storage_key = $3
           AND sha256 = $5 AND ready_at IS NULL
           AND abandoned_at IS NULL AND purged_at IS NULL
         RETURNING id`,
        [input.artifact.id, input.jobId, input.artifact.storageKey, input.now, input.artifact.sha256],
      );
      if (!published.rows[0]) {
        throw new AppError(409, "EXPORT_ARTIFACT_NOT_PREPARED", "导出制品尚未登记");
      }
      await client.query(
        `UPDATE export_jobs
         SET status = 'succeeded', progress = 100, result_artifact_id = $2,
             lease_token = NULL, lease_expires_at = NULL,
             error_code = NULL, error_message = NULL,
             updated_at = $3, finished_at = $3
         WHERE id = $1`,
        [input.jobId, input.artifact.id, input.now],
      );
      await client.query(
        `UPDATE projects
         SET lifecycle_status = 'exported', updated_at = $3
         WHERE id = $1 AND current_revision = $2 AND deleted_at IS NULL`,
        [job.project_id, job.project_revision, input.now],
      );
      const result = await client.query<ExportJobRow>(`${EXPORT_JOB_SELECT} WHERE j.id = $1`, [input.jobId]);
      const row = result.rows[0];
      if (!row) throw new AppError(500, "EXPORT_COMPLETE_FAILED", "导出任务提交失败");
      return exportJobRecord(row);
    });
  }

  async failExportJob(input: Parameters<AppStore["failExportJob"]>[0]): Promise<ExportJobRecord> {
    const result = await this.query<ExportJobRow>(
      `WITH updated AS (
         UPDATE export_jobs
         SET status = CASE WHEN $5 AND attempt_count < max_attempts THEN 'retry_wait' ELSE 'failed' END,
             available_at = $6::timestamptz,
             lease_token = NULL, lease_expires_at = NULL,
             error_code = $3, error_message = left($4, 500),
             updated_at = $7::timestamptz,
             finished_at = CASE WHEN $5 AND attempt_count < max_attempts THEN NULL ELSE $7::timestamptz END
         WHERE id = $1 AND status = 'running' AND lease_token = $2
           AND lease_expires_at > clock_timestamp()
         RETURNING *
       )
       SELECT updated.*,
              NULL::uuid AS artifact_id, NULL::uuid AS artifact_job_id,
              NULL::text AS artifact_storage_key, NULL::text AS artifact_mime_type,
              NULL::text AS artifact_file_name, NULL::bigint AS artifact_size_bytes,
              NULL::text AS artifact_sha256, NULL::timestamptz AS artifact_expires_at,
              NULL::timestamptz AS artifact_created_at
       FROM updated`,
      [input.jobId, input.leaseToken, input.code, input.message, input.retryable, input.availableAt, input.now],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(409, "EXPORT_LEASE_LOST", "导出任务租约已失效");
    return exportJobRecord(row);
  }

  async cancelExportJob(userId: string, exportJobId: string, now: string): Promise<ExportJobRecord> {
    return this.inTransaction(async (client) => {
      const locked = await client.query<{ status: ExportJobStatus }>(
        "SELECT status FROM export_jobs WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [exportJobId, userId],
      );
      const current = locked.rows[0];
      if (!current) throw new AppError(404, "EXPORT_JOB_NOT_FOUND", "导出任务不存在");
      if (current.status === "succeeded") throw new AppError(409, "EXPORT_ALREADY_FINISHED", "已完成的导出不能取消");
      if (current.status !== "failed" && current.status !== "canceled") {
        await client.query(
          `UPDATE export_jobs SET status = 'canceled', lease_token = NULL, lease_expires_at = NULL,
                  updated_at = $3, finished_at = $3
           WHERE id = $1 AND user_id = $2`,
          [exportJobId, userId, now],
        );
      }
      const result = await client.query<ExportJobRow>(`${EXPORT_JOB_SELECT} WHERE j.id = $1 AND j.user_id = $2`, [exportJobId, userId]);
      const row = result.rows[0];
      if (!row) throw new AppError(500, "EXPORT_CANCEL_FAILED", "导出任务取消失败");
      return exportJobRecord(row);
    });
  }

  async listExportArtifactsForPurge(_now: string, limit: number): Promise<ExportArtifactPurgeRecord[]> {
    const result = await this.query<ExportArtifactPurgeRow>(
      `WITH database_clock AS MATERIALIZED (
         SELECT clock_timestamp() AS now_at
       )
       SELECT candidates.id, candidates.job_id, candidates.user_id,
              candidates.storage_key, candidates.mime_type, candidates.file_name,
              candidates.size_bytes, candidates.sha256, candidates.expires_at,
              candidates.created_at
       FROM (
         SELECT a.id, a.job_id, j.user_id, a.storage_key, a.mime_type, a.file_name,
                a.size_bytes, a.sha256, a.expires_at, a.created_at,
                0 AS priority, a.created_at AS due_at
         FROM export_artifacts AS a
         JOIN export_jobs AS j ON j.id = a.job_id
         WHERE a.ready_at IS NULL AND a.purged_at IS NULL
           AND a.purge_available_at <= (SELECT now_at FROM database_clock)
           AND a.created_at <= (SELECT now_at FROM database_clock)
             - ($2::bigint * interval '1 millisecond')
           AND NOT (
             j.status = 'running'
             AND j.lease_expires_at IS NOT NULL
             AND j.lease_expires_at > (SELECT now_at FROM database_clock)
           )
         UNION ALL
         SELECT a.id, a.job_id, j.user_id, a.storage_key, a.mime_type, a.file_name,
                a.size_bytes, a.sha256, a.expires_at, a.created_at,
                1 AS priority, a.expires_at AS due_at
         FROM export_artifacts AS a
         JOIN export_jobs AS j ON j.id = a.job_id
         WHERE a.ready_at IS NOT NULL AND a.purged_at IS NULL
           AND a.purge_available_at <= (SELECT now_at FROM database_clock)
           AND a.expires_at <= (SELECT now_at FROM database_clock)
       ) AS candidates
       ORDER BY candidates.priority, candidates.due_at, candidates.id
       LIMIT $1`,
      [limit, EXPORT_ARTIFACT_PUBLISH_TIMEOUT_MILLISECONDS],
    );
    return result.rows.map(exportArtifactPurgeRecord);
  }

  async claimExportArtifactForPurge(
    artifactId: string,
    _now: string,
  ): Promise<ExportArtifactPurgeRecord | null> {
    const result = await this.query<ExportArtifactPurgeRow>(
      `WITH database_clock AS MATERIALIZED (
         SELECT clock_timestamp() AS now_at
       ), locked_job AS MATERIALIZED (
         SELECT job.id, job.status, job.lease_expires_at
         FROM export_jobs AS job
         JOIN export_artifacts AS artifact ON artifact.job_id = job.id
         WHERE artifact.id = $1
         FOR UPDATE OF job
       ), claimed AS (
         UPDATE export_artifacts AS artifact
         SET purge_available_at = database_clock.now_at + ($3::bigint * interval '1 millisecond'),
             abandoned_at = CASE
               WHEN artifact.ready_at IS NULL THEN COALESCE(artifact.abandoned_at, database_clock.now_at)
               ELSE artifact.abandoned_at
             END
         FROM database_clock, locked_job
         WHERE artifact.id = $1
           AND artifact.job_id = locked_job.id
           AND artifact.purged_at IS NULL
           AND artifact.purge_available_at <= database_clock.now_at
           AND NOT (
             locked_job.status = 'running'
             AND locked_job.lease_expires_at IS NOT NULL
             AND locked_job.lease_expires_at > database_clock.now_at
           )
           AND (
             (
               artifact.ready_at IS NULL
               AND artifact.created_at <= database_clock.now_at
                 - ($2::bigint * interval '1 millisecond')
             )
             OR (artifact.ready_at IS NOT NULL AND artifact.expires_at <= database_clock.now_at)
           )
         RETURNING artifact.*
       )
       SELECT claimed.id, claimed.job_id, job.user_id, claimed.storage_key,
              claimed.mime_type, claimed.file_name, claimed.size_bytes, claimed.sha256,
              claimed.expires_at, claimed.created_at
       FROM claimed
       JOIN export_jobs AS job ON job.id = claimed.job_id`,
      [artifactId, EXPORT_ARTIFACT_PUBLISH_TIMEOUT_MILLISECONDS, PURGE_CLAIM_MILLISECONDS],
    );
    const row = result.rows[0];
    return row ? exportArtifactPurgeRecord(row) : null;
  }

  async recordExportArtifactPurgeFailure(artifactId: string, _failedAt: string): Promise<void> {
    await this.query(
      `WITH database_clock AS MATERIALIZED (
         SELECT clock_timestamp() AS now_at
       )
       UPDATE export_artifacts AS artifact
       SET purge_attempt_count = artifact.purge_attempt_count + 1,
           purge_available_at = database_clock.now_at + (
             LEAST(
               $3::double precision,
               $2::double precision * power(2, LEAST(artifact.purge_attempt_count, 16))
             ) * interval '1 millisecond'
           )
       FROM database_clock
       WHERE artifact.id = $1 AND artifact.purged_at IS NULL`,
      [artifactId, PURGE_RETRY_BASE_MILLISECONDS, PURGE_RETRY_MAX_MILLISECONDS],
    );
  }

  async markExportArtifactPurged(artifactId: string, purgedAt: string): Promise<void> {
    await this.query(
      `UPDATE export_artifacts
       SET purged_at = COALESCE(purged_at, $2)
       WHERE id = $1`,
      [artifactId, purgedAt],
    );
  }

  async listCreditProducts(): Promise<CreditProduct[]> {
    const result = await this.query<{
      id: string;
      version: number;
      name: string;
      description: string;
      credit_amount: number;
      amount_cents: number;
      currency: "CNY";
      enabled: boolean;
    }>(
      `SELECT id, version, name, description, credit_amount, amount_cents, currency, enabled
       FROM credit_products WHERE enabled = true ORDER BY amount_cents, id, version`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      version: row.version,
      name: row.name,
      description: row.description,
      creditAmount: row.credit_amount,
      amountCents: row.amount_cents,
      currency: row.currency,
      enabled: row.enabled,
    }));
  }

  async getCreditProduct(productId: string, version: number): Promise<CreditProduct | null> {
    const products = await this.query<{
      id: string;
      version: number;
      name: string;
      description: string;
      credit_amount: number;
      amount_cents: number;
      currency: "CNY";
      enabled: boolean;
    }>(
      `SELECT id, version, name, description, credit_amount, amount_cents, currency, enabled
       FROM credit_products WHERE id = $1 AND version = $2 AND enabled = true`,
      [productId, version],
    );
    const row = products.rows[0];
    return row ? {
      id: row.id,
      version: row.version,
      name: row.name,
      description: row.description,
      creditAmount: row.credit_amount,
      amountCents: row.amount_cents,
      currency: row.currency,
      enabled: row.enabled,
    } : null;
  }

  async reservePaymentOrderSlot(
    input: Parameters<AppStore["reservePaymentOrderSlot"]>[0],
  ): ReturnType<AppStore["reservePaymentOrderSlot"]> {
    return this.inTransaction(async (client) => {
      await this.lockActivePaymentEffect(client, input.effectFence);
      const persisted = await client.query<PaymentOrderRow & { expired: boolean }>(
        `SELECT payment_orders.*, payment_expires_at <= clock_timestamp() AS expired
         FROM payment_orders
         WHERE id = $1 OR out_trade_no = $2
         FOR UPDATE`,
        [input.orderId, input.outTradeNo],
      );
      const persistedOrder = persisted.rows[0];
      if (persistedOrder) {
        if (persistedOrder.id !== input.orderId
          || persistedOrder.user_id !== input.userId
          || persistedOrder.out_trade_no !== input.outTradeNo) {
          throw new AppError(409, "PAYMENT_ORDER_IDENTITY_CONFLICT", "支付订单身份已被其他请求占用");
        }
        const latest = await client.query<PaymentOrderAttemptRow & { expired: boolean }>(
          `SELECT attempt.*, attempt.expires_at <= clock_timestamp() AS expired
           FROM payment_order_attempts AS attempt
           WHERE attempt.order_id = $1
           ORDER BY attempt.attempt_no DESC LIMIT 1`,
          [input.orderId],
        );
        const attempt = latest.rows[0];
        return attempt
          ? paymentOrderAttemptReservation(attempt, attempt.expired)
          : {
            attemptNo: 1,
            outTradeNo: persistedOrder.out_trade_no,
            expiresAt: iso(persistedOrder.payment_expires_at),
            expired: persistedOrder.expired,
            created: false,
            state: "created",
            recoveryCiphertext: null,
            providerReferenceSha256: null,
          };
      }
      const slots = await client.query<PaymentOrderAttemptRow & { expired: boolean }>(
        `SELECT attempt.*, slot.expires_at AS expires_at,
                slot.expires_at <= clock_timestamp() AS expired
         FROM payment_order_slots AS slot
         JOIN payment_order_attempts AS attempt
           ON attempt.order_id = slot.order_id AND attempt.attempt_no = slot.attempt_no
         WHERE slot.order_id = $1 OR slot.out_trade_no = $2
         FOR UPDATE OF slot, attempt`,
        [input.orderId, input.outTradeNo],
      );
      const existing = slots.rows[0];
      if (existing) {
        if (existing.order_id !== input.orderId
          || existing.user_id !== input.userId) {
          throw new AppError(409, "PAYMENT_ORDER_IDENTITY_CONFLICT", "支付订单身份已被其他请求占用");
        }
        return paymentOrderAttemptReservation(existing, existing.expired);
      }
      const capacity = await client.query<{ slot_count: number | string }>(
        `SELECT (
           SELECT count(*) FROM payment_orders
           WHERE user_id = $1 AND status = 'pending' AND payment_expires_at > clock_timestamp()
         ) + (
           SELECT count(*) FROM payment_order_slots
           WHERE user_id = $1 AND expires_at > clock_timestamp()
         ) AS slot_count`,
        [input.userId],
      );
      if (Number(capacity.rows[0]?.slot_count ?? 0) >= MAX_PENDING_PAYMENT_ORDERS_PER_USER) {
        throw new AppError(429, "PAYMENT_PENDING_LIMIT_EXCEEDED", "待支付订单数量已达到上限", {
          limit: MAX_PENDING_PAYMENT_ORDERS_PER_USER,
        });
      }
      const history = await client.query<{ slot_count: number | string }>(
        "SELECT count(*) AS slot_count FROM payment_order_attempts WHERE user_id = $1",
        [input.userId],
      );
      if (Number(history.rows[0]?.slot_count ?? 0) >= MAX_PAYMENT_ORDER_SLOT_HISTORY_PER_USER) {
        throw new AppError(429, "PAYMENT_ORDER_SLOT_HISTORY_LIMIT_EXCEEDED", "支付订单尝试历史已达到上限", {
          limit: MAX_PAYMENT_ORDER_SLOT_HISTORY_PER_USER,
        });
      }
      const inserted = await client.query<PaymentOrderAttemptRow & { expired: boolean }>(
        `WITH database_clock AS (SELECT clock_timestamp() AS now_at),
         inserted_slot AS (
           INSERT INTO payment_order_slots(
             order_id, user_id, out_trade_no, attempt_no, expires_at, created_at, updated_at
           )
           SELECT $1, $2, $3, 1,
                  database_clock.now_at + ($5::timestamptz - $4::timestamptz),
                  database_clock.now_at, database_clock.now_at
           FROM database_clock
           RETURNING *
         ), inserted_attempt AS (
           INSERT INTO payment_order_attempts(
             order_id, user_id, attempt_no, out_trade_no, state,
             recovery_ciphertext, provider_reference_sha256, expires_at, created_at, updated_at
           )
           SELECT order_id, user_id, attempt_no, out_trade_no, 'reserved',
                  NULL, NULL, expires_at, created_at, updated_at
           FROM inserted_slot
           RETURNING *
         )
         SELECT inserted_attempt.*,
                inserted_attempt.expires_at <= clock_timestamp() AS expired
         FROM inserted_attempt`,
        [input.orderId, input.userId, input.outTradeNo, input.now, input.expiresAt],
      );
      const row = inserted.rows[0];
      if (!row) throw new AppError(503, "PAYMENT_ORDER_SLOT_RETRY", "支付订单名额预留失败，请重试", null, true);
      return paymentOrderAttemptReservation(row, row.expired, true);
    });
  }

  async releasePaymentOrderSlot(
    input: Parameters<AppStore["releasePaymentOrderSlot"]>[0],
  ): ReturnType<AppStore["releasePaymentOrderSlot"]> {
    return this.inTransaction(async (client) => {
      await this.lockActivePaymentEffect(client, input.effectFence);
      const result = await client.query<{ deleted: boolean }>(
        `WITH deleted_slot AS (
           DELETE FROM payment_order_slots
           WHERE order_id = $1 AND user_id = $2
           RETURNING order_id, attempt_no
         ), deleted_attempt AS (
           DELETE FROM payment_order_attempts AS attempt
           USING deleted_slot
           WHERE attempt.order_id = deleted_slot.order_id
             AND attempt.attempt_no = deleted_slot.attempt_no
             AND attempt.state = 'reserved'
         )
         SELECT EXISTS(SELECT 1 FROM deleted_slot) AS deleted`,
        [input.orderId, input.userId],
      );
      return result.rows[0]?.deleted ?? false;
    });
  }

  async getPaymentOrderRecoveryAttempt(
    userId: string,
    orderId: string,
  ): Promise<PaymentOrderSlotReservation | null> {
    const result = await this.query<PaymentOrderAttemptRow & { expired: boolean }>(
      `SELECT attempt.*, attempt.expires_at <= clock_timestamp() AS expired
       FROM payment_order_attempts AS attempt
       WHERE attempt.user_id = $1 AND attempt.order_id = $2
       ORDER BY attempt.attempt_no DESC LIMIT 1`,
      [userId, orderId],
    );
    const row = result.rows[0];
    return row ? paymentOrderAttemptReservation(row, row.expired) : null;
  }

  async beginPaymentOrderProviderAttempt(
    input: Parameters<AppStore["beginPaymentOrderProviderAttempt"]>[0],
  ): ReturnType<AppStore["beginPaymentOrderProviderAttempt"]> {
    return this.inTransaction(async (client) => {
      await this.lockActivePaymentEffect(client, input.effectFence);
      const result = await client.query<PaymentOrderAttemptRow & { expired: boolean }>(
        `UPDATE payment_order_attempts AS attempt
         SET state = CASE WHEN attempt.state = 'reserved' THEN 'creating' ELSE attempt.state END,
             updated_at = CASE WHEN attempt.state = 'reserved' THEN clock_timestamp() ELSE attempt.updated_at END
         FROM payment_order_slots AS slot
         WHERE slot.order_id = $1 AND slot.user_id = $2 AND slot.out_trade_no = $3
           AND attempt.order_id = slot.order_id AND attempt.attempt_no = slot.attempt_no
         RETURNING attempt.*, attempt.expires_at <= clock_timestamp() AS expired`,
        [input.orderId, input.userId, input.outTradeNo],
      );
      const row = result.rows[0];
      if (!row) throw new AppError(409, "PAYMENT_RECOVERY_STATE_CHANGED", "支付恢复状态已变化，请重试", null, true);
      return paymentOrderAttemptReservation(row, row.expired);
    });
  }

  async recordPaymentOrderProviderResult(
    input: Parameters<AppStore["recordPaymentOrderProviderResult"]>[0],
  ): ReturnType<AppStore["recordPaymentOrderProviderResult"]> {
    if (!/^[0-9a-f]{64}$/.test(input.providerReferenceSha256)
      || input.recoveryCiphertext.length < 16 || input.recoveryCiphertext.length > 2048) {
      throw new AppError(400, "PAYMENT_RECOVERY_RESULT_INVALID", "支付恢复结果无效");
    }
    return this.inTransaction(async (client) => {
      await this.lockActivePaymentEffect(client, input.effectFence);
      const locked = await client.query<PaymentOrderAttemptRow & { expired: boolean }>(
        `SELECT attempt.*, attempt.expires_at <= clock_timestamp() AS expired
         FROM payment_order_slots AS slot
         JOIN payment_order_attempts AS attempt
           ON attempt.order_id = slot.order_id AND attempt.attempt_no = slot.attempt_no
         WHERE slot.order_id = $1 AND slot.user_id = $2 AND slot.out_trade_no = $3
         FOR UPDATE OF slot, attempt`,
        [input.orderId, input.userId, input.outTradeNo],
      );
      const current = locked.rows[0];
      if (!current) throw new AppError(409, "PAYMENT_RECOVERY_STATE_CHANGED", "支付恢复状态已变化，请重试", null, true);
      if (current.recovery_ciphertext !== null
        && (current.recovery_ciphertext !== input.recoveryCiphertext
          || current.provider_reference_sha256 !== input.providerReferenceSha256)) {
        throw new AppError(409, "PAYMENT_RECOVERY_RESULT_CONFLICT", "支付恢复结果发生冲突");
      }
      const updated = await client.query<PaymentOrderAttemptRow & { expired: boolean }>(
        `UPDATE payment_order_attempts
         SET state = 'created', recovery_ciphertext = $4,
             provider_reference_sha256 = $5, updated_at = clock_timestamp()
         WHERE order_id = $1 AND user_id = $2 AND out_trade_no = $3
         RETURNING *, expires_at <= clock_timestamp() AS expired`,
        [input.orderId, input.userId, input.outTradeNo, input.recoveryCiphertext, input.providerReferenceSha256],
      );
      const row = updated.rows[0];
      if (!row) throw new AppError(409, "PAYMENT_RECOVERY_STATE_CHANGED", "支付恢复状态已变化，请重试", null, true);
      return paymentOrderAttemptReservation(row, row.expired);
    });
  }

  async rotatePaymentOrderProviderAttempt(
    input: Parameters<AppStore["rotatePaymentOrderProviderAttempt"]>[0],
  ): ReturnType<AppStore["rotatePaymentOrderProviderAttempt"]> {
    return this.inTransaction(async (client) => {
      await this.lockActivePaymentEffect(client, input.effectFence);
      const locked = await client.query<PaymentOrderAttemptRow>(
        `SELECT attempt.*
         FROM payment_order_slots AS slot
         JOIN payment_order_attempts AS attempt
           ON attempt.order_id = slot.order_id AND attempt.attempt_no = slot.attempt_no
         WHERE slot.order_id = $1 AND slot.user_id = $2 AND slot.out_trade_no = $3
         FOR UPDATE OF slot, attempt`,
        [input.orderId, input.userId, input.previousOutTradeNo],
      );
      const previous = locked.rows[0];
      if (!previous) throw new AppError(409, "PAYMENT_RECOVERY_STATE_CHANGED", "支付恢复状态已变化，请重试", null, true);
      const history = await client.query<{ attempt_count: number | string }>(
        "SELECT count(*) AS attempt_count FROM payment_order_attempts WHERE user_id = $1",
        [input.userId],
      );
      if (Number(history.rows[0]?.attempt_count ?? 0) >= MAX_PAYMENT_ORDER_SLOT_HISTORY_PER_USER) {
        throw new AppError(429, "PAYMENT_ORDER_SLOT_HISTORY_LIMIT_EXCEEDED", "支付订单尝试历史已达到上限", {
          limit: MAX_PAYMENT_ORDER_SLOT_HISTORY_PER_USER,
        });
      }
      const attemptNo = previous.attempt_no + 1;
      const result = await client.query<PaymentOrderAttemptRow & { expired: boolean }>(
        `WITH database_clock AS (SELECT clock_timestamp() AS now_at),
         closed AS (
           UPDATE payment_order_attempts
           SET state = 'closed', updated_at = (SELECT now_at FROM database_clock)
           WHERE order_id = $1 AND attempt_no = $4
         ), updated_slot AS (
           UPDATE payment_order_slots
           SET out_trade_no = $5, attempt_no = $6,
               expires_at = (SELECT now_at FROM database_clock) + ($8::timestamptz - $7::timestamptz),
               updated_at = (SELECT now_at FROM database_clock)
           WHERE order_id = $1 AND user_id = $2 AND out_trade_no = $3
           RETURNING *
         ), inserted_attempt AS (
           INSERT INTO payment_order_attempts(
             order_id, user_id, attempt_no, out_trade_no, state,
             recovery_ciphertext, provider_reference_sha256, expires_at, created_at, updated_at
           )
           SELECT order_id, user_id, attempt_no, out_trade_no, 'reserved', NULL, NULL,
                  expires_at, updated_at, updated_at
           FROM updated_slot
           RETURNING *
         )
         SELECT inserted_attempt.*, inserted_attempt.expires_at <= clock_timestamp() AS expired
         FROM inserted_attempt`,
        [
          input.orderId,
          input.userId,
          input.previousOutTradeNo,
          previous.attempt_no,
          input.nextOutTradeNo,
          attemptNo,
          input.rotatedAt,
          input.expiresAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new AppError(409, "PAYMENT_RECOVERY_STATE_CHANGED", "支付恢复状态已变化，请重试", null, true);
      return paymentOrderAttemptReservation(row, row.expired, true);
    });
  }

  async createPaymentOrder(input: Parameters<AppStore["createPaymentOrder"]>[0]): Promise<PaymentOrderRecord> {
    return this.inTransaction(async (client) => {
      const owner = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [input.userId],
      );
      if (!owner.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
      const existing = await client.query<PaymentOrderRow>(
        `SELECT * FROM payment_orders
         WHERE id = $1 OR out_trade_no = $2
         FOR UPDATE`,
        [input.id, input.outTradeNo],
      );
      const existingOrder = existing.rows[0];
      if (existingOrder) {
        const sameIdentity = existingOrder.id === input.id
          && existingOrder.user_id === input.userId
          && existingOrder.out_trade_no === input.outTradeNo
          && existingOrder.product_id === input.product.id
          && existingOrder.product_version === input.product.version;
        if (!sameIdentity) {
          throw new AppError(409, "PAYMENT_ORDER_IDENTITY_CONFLICT", "支付订单身份已被其他请求占用");
        }
        if (existingOrder.status === "pending") {
          await client.query(
            `INSERT INTO payment_reconciliation_jobs(
               order_id, state, available_at, attempt_count, created_at, updated_at
             ) VALUES (
               $1, 'scheduled',
               clock_timestamp() + ($2::bigint * interval '1 millisecond'),
               0, clock_timestamp(), clock_timestamp()
             )
             ON CONFLICT (order_id) DO NOTHING`,
            [existingOrder.id, INITIAL_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS],
          );
        }
        await client.query("DELETE FROM payment_order_slots WHERE order_id = $1", [input.id]);
        return paymentOrderRecord(existingOrder);
      }
      const pending = await client.query<{ order_count: number | string }>(
        `SELECT count(*) AS order_count
         FROM payment_orders
         WHERE user_id = $1 AND status = 'pending' AND payment_expires_at > clock_timestamp()`,
        [input.userId],
      );
      if (Number(pending.rows[0]?.order_count ?? 0) >= MAX_PENDING_PAYMENT_ORDERS_PER_USER) {
        throw new AppError(429, "PAYMENT_PENDING_LIMIT_EXCEEDED", "待支付订单数量已达到上限", {
          limit: MAX_PENDING_PAYMENT_ORDERS_PER_USER,
        });
      }
      const result = await client.query<PaymentOrderRow>(
        `INSERT INTO payment_orders(
           id, user_id, product_id, product_version, product_name,
           credit_amount, amount_cents, currency, out_trade_no, status,
           provider_reference, provider_trade_state, payment_expires_at, created_at, updated_at
         )
         SELECT $1, $2, p.id, p.version, p.name,
                p.credit_amount, p.amount_cents, p.currency, $5, 'pending',
                $6, 'NOTPAY', $7, $8, $8
         FROM credit_products p
         WHERE p.id = $3 AND p.version = $4 AND p.enabled = true
           AND p.name = $9 AND p.description = $10
           AND p.credit_amount = $11 AND p.amount_cents = $12 AND p.currency = $13
         RETURNING *`,
        [
          input.id,
          input.userId,
          input.product.id,
          input.product.version,
          input.outTradeNo,
          input.providerReference,
          input.paymentExpiresAt,
          input.now,
          input.product.name,
          input.product.description,
          input.product.creditAmount,
          input.product.amountCents,
          input.product.currency,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new AppError(409, "CREDIT_PRODUCT_CHANGED", "次数商品已更新，请刷新后重试");
      await client.query(
        `INSERT INTO payment_reconciliation_jobs(
           order_id, state, available_at, attempt_count, created_at, updated_at
         ) VALUES (
           $1, 'scheduled',
           clock_timestamp() + ($2::bigint * interval '1 millisecond'),
           0, clock_timestamp(), clock_timestamp()
         )`,
        [row.id, INITIAL_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS],
      );
      await client.query("DELETE FROM payment_order_slots WHERE order_id = $1", [input.id]);
      return paymentOrderRecord(row);
    });
  }

  async getPaymentOrder(userId: string, paymentOrderId: string): Promise<PaymentOrderRecord | null> {
    const result = await this.query<PaymentOrderRow>(
      "SELECT * FROM payment_orders WHERE id = $1 AND user_id = $2",
      [paymentOrderId, userId],
    );
    const row = result.rows[0];
    return row ? paymentOrderRecord(row) : null;
  }

  async getPaymentOrderByOutTradeNo(outTradeNo: string): Promise<PaymentOrderRecord | null> {
    const result = await this.query<PaymentOrderRow>(
      `SELECT payment_order.*
       FROM payment_orders AS payment_order
       WHERE payment_order.out_trade_no = $1
       UNION ALL
       SELECT payment_order.*
       FROM payment_order_attempts AS attempt
       JOIN payment_orders AS payment_order ON payment_order.id = attempt.order_id
       WHERE attempt.out_trade_no = $1 AND payment_order.out_trade_no <> $1
       LIMIT 1`,
      [outTradeNo],
    );
    const row = result.rows[0];
    return row ? paymentOrderRecord(row) : null;
  }

  async applyPaymentObservation(
    input: Parameters<AppStore["applyPaymentObservation"]>[0],
  ): Promise<PaymentOrderRecord> {
    const nextDelay = input.reconciliationLeaseToken && input.providerTradeState === "NOTPAY"
      ? assertPaymentReconciliationDelayMilliseconds(input.nextReconciliationDelayMilliseconds ?? Number.NaN)
      : null;
    const reconciliationError = assertPaymentReconciliationError({
      ...(input.reconciliationErrorCode ? { code: input.reconciliationErrorCode } : {}),
      ...(input.reconciliationErrorMessage ? { message: input.reconciliationErrorMessage } : {}),
    });
    return this.inTransaction(async (client) => {
      const locked = await client.query<PaymentOrderRow>(
        "SELECT * FROM payment_orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [input.orderId, input.userId],
      );
      const order = locked.rows[0];
      if (!order) throw new AppError(404, "PAYMENT_ORDER_NOT_FOUND", "支付订单不存在");
      if (input.reconciliationLeaseToken) {
        const fenced = await client.query<{ order_id: string }>(
          `SELECT order_id FROM payment_reconciliation_jobs
           WHERE order_id = $1 AND state = 'running' AND lease_token = $2
             AND lease_expires_at > clock_timestamp()
           FOR UPDATE`,
          [input.orderId, input.reconciliationLeaseToken],
        );
        if (!fenced.rows[0]) {
          throw new AppError(409, "PAYMENT_RECONCILIATION_LEASE_LOST", "支付对账任务租约已失效", null, true);
        }
      }
      if (order.status !== "pending") {
        if (input.reconciliationLeaseToken) {
          await client.query(
            `UPDATE payment_reconciliation_jobs
             SET state = 'completed', lease_token = NULL, lease_expires_at = NULL,
                 last_observed_trade_state = $2, last_error_code = NULL, last_error_message = NULL,
                 completed_at = COALESCE(completed_at, clock_timestamp()), updated_at = clock_timestamp()
             WHERE order_id = $1`,
            [input.orderId, order.status === "succeeded" ? "SUCCESS" : "CLOSED"],
          );
        }
        return paymentOrderRecord(order);
      }
      const updated = await client.query<PaymentOrderRow>(
        `UPDATE payment_orders
         SET status = $3, provider_trade_state = $4,
             closed_at = CASE WHEN $4 = 'CLOSED' THEN COALESCE(closed_at, $5) ELSE closed_at END,
             last_reconciled_at = $5, updated_at = $5
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [
          input.orderId,
          input.userId,
          input.providerTradeState === "CLOSED" ? "closed" : "pending",
          input.providerTradeState,
          input.observedAt,
        ],
      );
      const row = updated.rows[0];
      if (!row) throw new AppError(500, "PAYMENT_OBSERVATION_FAILED", "支付状态刷新失败");
      if (input.providerTradeState === "CLOSED") {
        await client.query(
          `UPDATE payment_reconciliation_jobs
           SET state = 'completed', lease_token = NULL, lease_expires_at = NULL,
               last_observed_trade_state = 'CLOSED', last_error_code = NULL, last_error_message = NULL,
               completed_at = COALESCE(completed_at, clock_timestamp()), updated_at = clock_timestamp()
           WHERE order_id = $1`,
          [input.orderId],
        );
      } else if (input.reconciliationLeaseToken) {
        await client.query(
          `UPDATE payment_reconciliation_jobs
           SET state = 'scheduled',
               available_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
               lease_token = NULL, lease_expires_at = NULL,
               last_observed_trade_state = 'NOTPAY', last_error_code = $4, last_error_message = $5,
               updated_at = clock_timestamp()
           WHERE order_id = $1 AND lease_token = $2`,
          [
            input.orderId,
            input.reconciliationLeaseToken,
            nextDelay,
            reconciliationError.code,
            reconciliationError.message,
          ],
        );
      }
      return paymentOrderRecord(row);
    });
  }

  async applyPaymentSuccess(input: Parameters<AppStore["applyPaymentSuccess"]>[0]): Promise<{
    order: PaymentOrderRecord;
    account: CreditAccount;
    credited: boolean;
  }> {
    if (input.source === "wechat-notify"
      && (!input.notificationId || !input.wechatSerial || !/^[0-9a-f]{64}$/.test(input.rawBodySha256 ?? ""))) {
      throw new AppError(400, "PAYMENT_NOTIFICATION_AUDIT_REQUIRED", "微信支付通知缺少审计字段");
    }
    return this.inTransaction(async (client) => {
      const locked = await client.query<PaymentOrderRow>(
        "SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE",
        [input.orderId],
      );
      const orderRow = locked.rows[0];
      if (!orderRow) throw new AppError(404, "PAYMENT_ORDER_NOT_FOUND", "支付订单不存在");

      const observedIdentity = await client.query<{ matches: boolean }>(
        `SELECT ($2 = $3 OR EXISTS (
           SELECT 1 FROM payment_order_attempts
           WHERE order_id = $1 AND out_trade_no = $2
         )) AS matches`,
        [input.orderId, input.observedOutTradeNo, orderRow.out_trade_no],
      );
      if (!observedIdentity.rows[0]?.matches) {
        throw new AppError(409, "PAYMENT_OUT_TRADE_NO_MISMATCH", "支付事件商户订单号不属于该订单");
      }

      const existingEvent = await client.query<{
        order_id: string;
        out_trade_no: string;
        provider_transaction_id: string;
        raw_body_sha256: string | null;
      }>(
        "SELECT order_id, out_trade_no, provider_transaction_id, raw_body_sha256 FROM payment_events WHERE event_key = $1",
        [input.eventKey],
      );
      const prior = existingEvent.rows[0];
      if (prior) {
        if (prior.order_id !== input.orderId
          || prior.out_trade_no !== input.observedOutTradeNo
          || prior.provider_transaction_id !== input.providerTransactionId
          || prior.raw_body_sha256 !== (input.rawBodySha256 ?? null)) {
          throw new AppError(409, "PAYMENT_EVENT_CONFLICT", "支付事件标识对应了不同交易");
        }
        const accountResult = await client.query<{ user_id: string; balance: number; updated_at: Date | string }>(
          "SELECT * FROM credit_accounts WHERE user_id = $1",
          [orderRow.user_id],
        );
        const account = accountResult.rows[0];
        if (!account) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
        await client.query(
          `UPDATE payment_reconciliation_jobs
           SET state = 'completed', lease_token = NULL, lease_expires_at = NULL,
               last_observed_trade_state = 'SUCCESS', last_error_code = NULL, last_error_message = NULL,
               completed_at = COALESCE(completed_at, clock_timestamp()), updated_at = clock_timestamp()
           WHERE order_id = $1`,
          [input.orderId],
        );
        return {
          order: paymentOrderRecord(orderRow),
          account: { userId: account.user_id, balance: account.balance, updatedAt: iso(account.updated_at) },
          credited: false,
        };
      }

      if (orderRow.status === "succeeded") {
        if (orderRow.provider_transaction_id !== input.providerTransactionId) {
          throw new AppError(409, "PAYMENT_TRANSACTION_CONFLICT", "订单已由另一笔交易支付");
        }
        await client.query(
          `INSERT INTO payment_events(
             id, event_key, order_id, source, provider_transaction_id,
             provider_trade_state, processed_at, created_at,
             notification_id, raw_body_sha256, wechat_serial, out_trade_no
           ) VALUES ($1, $2, $3, $7, $4, $5, $6, $6, $8, $9, $10, $11)`,
          [
            randomUUID(),
            input.eventKey,
            input.orderId,
            input.providerTransactionId,
            input.providerTradeState,
            input.observedAt,
            input.source,
            input.notificationId ?? null,
            input.rawBodySha256 ?? null,
            input.wechatSerial ?? null,
            input.observedOutTradeNo,
          ],
        );
        const accountResult = await client.query<{ user_id: string; balance: number; updated_at: Date | string }>(
          "SELECT * FROM credit_accounts WHERE user_id = $1",
          [orderRow.user_id],
        );
        const account = accountResult.rows[0];
        if (!account) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
        await client.query(
          `UPDATE payment_reconciliation_jobs
           SET state = 'completed', lease_token = NULL, lease_expires_at = NULL,
               last_observed_trade_state = 'SUCCESS', last_error_code = NULL, last_error_message = NULL,
               completed_at = COALESCE(completed_at, clock_timestamp()), updated_at = clock_timestamp()
           WHERE order_id = $1`,
          [input.orderId],
        );
        return {
          order: paymentOrderRecord(orderRow),
          account: { userId: account.user_id, balance: account.balance, updatedAt: iso(account.updated_at) },
          credited: false,
        };
      }
      if (orderRow.status !== "pending" && orderRow.status !== "closed") {
        throw new AppError(409, "PAYMENT_ORDER_NOT_PAYABLE", "订单当前状态不能入账");
      }
      const lateAfterClose = orderRow.status === "closed";

      const transactionConflict = await client.query<{ id: string }>(
        "SELECT id FROM payment_orders WHERE provider_transaction_id = $1 AND id <> $2",
        [input.providerTransactionId, input.orderId],
      );
      if (transactionConflict.rows[0]) {
        throw new AppError(409, "PAYMENT_TRANSACTION_CONFLICT", "该支付交易已用于其他订单");
      }
      const updatedAccount = await client.query<{ user_id: string; balance: number; updated_at: Date | string }>(
        `UPDATE credit_accounts SET balance = balance + $2, updated_at = $3
         WHERE user_id = $1 RETURNING *`,
        [orderRow.user_id, orderRow.credit_amount, input.observedAt],
      );
      const account = updatedAccount.rows[0];
      if (!account) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
      await client.query(
        `INSERT INTO credit_ledger(id, user_id, delta, balance_after, reason, reference_id, created_at)
         VALUES ($1, $2, $3, $4, 'payment_credit', $5, $6)`,
        [randomUUID(), orderRow.user_id, orderRow.credit_amount, account.balance, orderRow.id, input.observedAt],
      );
      const updatedOrder = await client.query<PaymentOrderRow>(
        `UPDATE payment_orders
         SET status = 'succeeded', provider_trade_state = $2,
             provider_transaction_id = $3, paid_at = $4,
             last_reconciled_at = CASE WHEN $6 THEN $5 ELSE last_reconciled_at END,
             late_success_at = CASE WHEN status = 'closed' THEN COALESCE(late_success_at, $5) ELSE late_success_at END,
             updated_at = $5
         WHERE id = $1 RETURNING *`,
        [
          input.orderId,
          input.providerTradeState,
          input.providerTransactionId,
          input.paidAt,
          input.observedAt,
          input.source !== "wechat-notify",
        ],
      );
      const successfulOrder = updatedOrder.rows[0];
      if (!successfulOrder) throw new AppError(500, "PAYMENT_APPLY_FAILED", "支付入账失败");
      await client.query(
        `INSERT INTO payment_events(
           id, event_key, order_id, source, provider_transaction_id,
           provider_trade_state, processed_at, created_at,
           notification_id, raw_body_sha256, wechat_serial, out_trade_no
         ) VALUES ($1, $2, $3, $7, $4, $5, $6, $6, $8, $9, $10, $11)`,
        [
          randomUUID(),
          input.eventKey,
          input.orderId,
          input.providerTransactionId,
          input.providerTradeState,
          input.observedAt,
          input.source,
          input.notificationId ?? null,
          input.rawBodySha256 ?? null,
          input.wechatSerial ?? null,
          input.observedOutTradeNo,
        ],
      );
      await client.query(
        `INSERT INTO outbox_events(id, topic, aggregate_id, payload, available_at, created_at)
         VALUES ($1, 'payment.succeeded', $2, $3::jsonb, $4, $4)`,
        [
          randomUUID(),
          input.orderId,
          JSON.stringify({
            orderId: input.orderId,
            userId: orderRow.user_id,
            ...(lateAfterClose ? { lateAfterClose: true } : {}),
          }),
          input.observedAt,
        ],
      );
      await client.query(
        `UPDATE payment_reconciliation_jobs
         SET state = 'completed', lease_token = NULL, lease_expires_at = NULL,
             last_observed_trade_state = 'SUCCESS', last_error_code = NULL, last_error_message = NULL,
             completed_at = COALESCE(completed_at, clock_timestamp()), updated_at = clock_timestamp()
         WHERE order_id = $1`,
        [input.orderId],
      );
      return {
        order: paymentOrderRecord(successfulOrder),
        account: { userId: account.user_id, balance: account.balance, updatedAt: iso(account.updated_at) },
        credited: true,
      };
    });
  }

  async getPaymentReconciliationJob(orderId: string): Promise<PaymentReconciliationJob | null> {
    const result = await this.query<PaymentReconciliationJobRow>(
      "SELECT * FROM payment_reconciliation_jobs WHERE order_id = $1",
      [orderId],
    );
    const row = result.rows[0];
    return row ? paymentReconciliationJob(row) : null;
  }

  async claimNextPaymentReconciliation(
    input: Parameters<AppStore["claimNextPaymentReconciliation"]>[0],
  ): Promise<Awaited<ReturnType<AppStore["claimNextPaymentReconciliation"]>>> {
    const leaseMilliseconds = assertWorkerLeaseMilliseconds(input.leaseMilliseconds);
    return this.inTransaction(async (client) => {
      // A pre-0037 API instance can commit a pending payment order without its
      // reconciliation job during a rolling deployment. Lock the parent order
      // before inserting the child job: PostgreSQL's FK constraint trigger may
      // otherwise check the parent only after the child row/index was written,
      // inverting the order -> job lock order used by payment mutations.
      await client.query(
        `WITH db_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS now
         ), missing AS MATERIALIZED (
           SELECT payment_order.id, db_clock.now
           FROM payment_orders AS payment_order
           CROSS JOIN db_clock
           WHERE payment_order.status = 'pending'
             AND NOT EXISTS (
               SELECT 1
               FROM payment_reconciliation_jobs AS existing_job
               WHERE existing_job.order_id = payment_order.id
             )
           ORDER BY payment_order.created_at, payment_order.id
            FOR UPDATE OF payment_order SKIP LOCKED
           LIMIT $1
         )
         INSERT INTO payment_reconciliation_jobs(
           order_id, state, available_at, attempt_count, created_at, updated_at
         )
         SELECT missing.id, 'scheduled', missing.now, 0, missing.now, missing.now
         FROM missing
         ON CONFLICT (order_id) DO NOTHING
         RETURNING order_id`,
        [PAYMENT_RECONCILIATION_REPAIR_LIMIT],
      );
      // An old API can terminalize an order after a new worker has inserted or
      // claimed its job, without completing that job itself. Converge a bounded
      // batch on every claim. The materialized selector locks parent orders first;
      // only the following UPDATE locks child jobs.
      await client.query(
        `WITH db_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS now
         ), terminal_orders AS MATERIALIZED (
           SELECT payment_order.id, payment_order.status,
                  payment_order.provider_trade_state, db_clock.now
           FROM payment_reconciliation_jobs AS job
           JOIN payment_orders AS payment_order ON payment_order.id = job.order_id
           CROSS JOIN db_clock
           WHERE job.state <> 'completed'
             AND payment_order.status <> 'pending'
           ORDER BY job.updated_at, job.order_id
           FOR UPDATE OF payment_order SKIP LOCKED
           LIMIT $1
         )
         UPDATE payment_reconciliation_jobs AS job
         SET state = 'completed', lease_token = NULL, lease_expires_at = NULL,
             last_observed_trade_state = CASE
               WHEN terminal_order.status = 'succeeded' THEN 'SUCCESS'
               WHEN terminal_order.status = 'closed' THEN 'CLOSED'
               WHEN terminal_order.provider_trade_state IN ('NOT_FOUND', 'NOTPAY', 'SUCCESS', 'CLOSED')
                 THEN terminal_order.provider_trade_state
               ELSE job.last_observed_trade_state
             END,
             last_error_code = NULL, last_error_message = NULL,
             completed_at = COALESCE(job.completed_at, terminal_order.now),
             updated_at = terminal_order.now
         FROM terminal_orders AS terminal_order
         WHERE job.order_id = terminal_order.id
           AND job.state <> 'completed'`,
        [PAYMENT_RECONCILIATION_REPAIR_LIMIT],
      );
      const claimed = await client.query<PaymentReconciliationJobRow & { claimed_at: Date | string }>(
        `WITH db_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS now
         ), candidate AS (
           SELECT job.order_id
           FROM payment_reconciliation_jobs AS job
           JOIN payment_orders AS payment_order ON payment_order.id = job.order_id
           CROSS JOIN db_clock
           WHERE payment_order.status = 'pending'
             AND (
               (job.state = 'scheduled' AND job.available_at <= db_clock.now)
               OR (job.state = 'running' AND job.lease_expires_at <= db_clock.now)
             )
           ORDER BY
             CASE WHEN job.state = 'running' THEN job.lease_expires_at ELSE job.available_at END,
             job.created_at,
             job.order_id
           FOR UPDATE OF job SKIP LOCKED
           LIMIT 1
         )
         UPDATE payment_reconciliation_jobs AS job
         SET state = 'running', attempt_count = job.attempt_count + 1,
             lease_token = $1,
             lease_expires_at = db_clock.now + ($2::bigint * interval '1 millisecond'),
             last_error_code = NULL, last_error_message = NULL,
             completed_at = NULL, updated_at = db_clock.now
         FROM candidate, db_clock
         WHERE job.order_id = candidate.order_id
         RETURNING job.*, db_clock.now AS claimed_at`,
        [input.leaseToken, leaseMilliseconds],
      );
      const jobRow = claimed.rows[0];
      if (!jobRow) return null;
      const orderResult = await client.query<PaymentOrderRow>(
        "SELECT * FROM payment_orders WHERE id = $1",
        [jobRow.order_id],
      );
      const order = orderResult.rows[0];
      if (!order) throw new AppError(500, "PAYMENT_RECONCILIATION_CLAIM_FAILED", "支付对账任务缺少订单");
      return {
        order: paymentOrderRecord(order),
        job: paymentReconciliationJob(jobRow),
        claimedAt: iso(jobRow.claimed_at),
      };
    });
  }

  async renewPaymentReconciliationLease(
    input: Parameters<AppStore["renewPaymentReconciliationLease"]>[0],
  ): Promise<boolean> {
    const leaseMilliseconds = assertWorkerLeaseMilliseconds(input.leaseMilliseconds);
    const result = await this.query(
      `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
       UPDATE payment_reconciliation_jobs AS job
       SET lease_expires_at = db_clock.now + ($3::bigint * interval '1 millisecond'),
           updated_at = db_clock.now
       FROM db_clock
       WHERE job.order_id = $1 AND job.state = 'running' AND job.lease_token = $2
         AND job.lease_expires_at > db_clock.now`,
      [input.orderId, input.leaseToken, leaseMilliseconds],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async reschedulePaymentReconciliation(
    input: Parameters<AppStore["reschedulePaymentReconciliation"]>[0],
  ): Promise<boolean> {
    const delayMilliseconds = assertPaymentReconciliationDelayMilliseconds(input.delayMilliseconds);
    const error = assertPaymentReconciliationError({
      ...(input.errorCode ? { code: input.errorCode } : {}),
      ...(input.errorMessage ? { message: input.errorMessage } : {}),
    });
    return this.inTransaction(async (client) => {
      const order = await client.query<{ status: PaymentOrderRecord["status"] }>(
        "SELECT status FROM payment_orders WHERE id = $1 FOR UPDATE",
        [input.orderId],
      );
      if (order.rows[0]?.status !== "pending") return false;
      const result = await client.query(
        `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
         UPDATE payment_reconciliation_jobs AS job
         SET state = 'scheduled',
             available_at = db_clock.now + ($3::bigint * interval '1 millisecond'),
             lease_token = NULL, lease_expires_at = NULL,
             last_observed_trade_state = COALESCE($4, last_observed_trade_state),
             last_error_code = $5, last_error_message = $6,
             updated_at = db_clock.now
         FROM db_clock
         WHERE job.order_id = $1 AND job.state = 'running' AND job.lease_token = $2
           AND job.lease_expires_at > db_clock.now`,
        [
          input.orderId,
          input.leaseToken,
          delayMilliseconds,
          input.providerTradeState ?? null,
          error.code,
          error.message,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async listInventory(userId: string, paletteId?: string): Promise<InventoryItem[]> {
    const result = await this.query<InventoryRow>(
      `SELECT * FROM inventory_items
       WHERE user_id = $1 AND ($2::text IS NULL OR palette_id = $2)
       ORDER BY palette_id, color_code`,
      [userId, paletteId ?? null],
    );
    return result.rows.map(inventoryItem);
  }

  async getInventoryStats(userId: string): Promise<{ colorCount: number; beadCount: number }> {
    const result = await this.query<{ color_count: number | string; bead_count: number | string }>(
      `SELECT COUNT(*) FILTER (WHERE quantity > 0) AS color_count,
              COALESCE(SUM(quantity) FILTER (WHERE quantity > 0), 0) AS bead_count
       FROM inventory_items
       WHERE user_id = $1`,
      [userId],
    );
    const colorCount = Number(result.rows[0]?.color_count ?? 0);
    const beadCount = Number(result.rows[0]?.bead_count ?? 0);
    if (!Number.isSafeInteger(colorCount) || !Number.isSafeInteger(beadCount)) {
      throw new AppError(500, "INVENTORY_AGGREGATE_OUT_OF_RANGE", "库存聚合结果超出安全整数范围");
    }
    return {
      colorCount,
      beadCount,
    };
  }

  async setInventoryItem(input: Parameters<AppStore["setInventoryItem"]>[0]): Promise<InventoryItem> {
    const result = await this.applyInventoryBatch({
      userId: input.userId,
      mode: "calibrate",
      entries: [{
        paletteId: input.paletteId,
        colorCode: input.colorCode,
        quantity: input.quantity,
        location: input.location,
        baseRevision: input.baseRevision,
      }],
      idempotencyReference: input.idempotencyReference ?? `internal:${randomUUID()}`,
      now: input.now,
    });
    const item = result.items[0];
    if (!item) throw new AppError(500, "INVENTORY_SAVE_FAILED", "库存保存失败");
    return item;
  }

  async applyInventoryBatch(
    input: Parameters<AppStore["applyInventoryBatch"]>[0],
  ): Promise<InventoryMutationResult> {
    if (input.entries.length < 1 || input.entries.length > MAX_INVENTORY_BATCH_ITEMS) {
      throw new AppError(400, "INVENTORY_BATCH_SIZE_INVALID", `每批库存必须包含 1-${MAX_INVENTORY_BATCH_ITEMS} 个色号`);
    }
    if (input.idempotencyReference.length < 1 || input.idempotencyReference.length > 256) {
      throw new AppError(400, "INVENTORY_REFERENCE_INVALID", "库存流水引用长度无效");
    }
    const seen = new Set<string>();
    for (const entry of input.entries) {
      const rowKey = `${entry.paletteId}:${entry.colorCode}`;
      if (seen.has(rowKey)) {
        throw new AppError(400, "INVENTORY_BATCH_DUPLICATE_COLOR", "批量库存不能包含重复的色卡色号", {
          paletteId: entry.paletteId,
          colorCode: entry.colorCode,
        });
      }
      seen.add(rowKey);
      if (!Number.isInteger(entry.baseRevision) || entry.baseRevision < 0) {
        throw new AppError(400, "INVENTORY_REVISION_INVALID", "库存基础版本必须是非负整数");
      }
      if (entry.location !== undefined
        && entry.location !== null
        && (entry.location.length < 1 || entry.location.length > 100 || !entry.location.trim())) {
        throw new AppError(400, "INVENTORY_LOCATION_REQUIRED", "存放位置必须是 1-100 字符的非空文本");
      }
      if (input.mode === "calibrate") {
        if (!Number.isInteger(entry.quantity)
          || entry.quantity === undefined
          || entry.quantity < 0
          || entry.quantity > 2_147_483_647
          || entry.delta !== undefined
          || entry.location === undefined) {
          throw new AppError(400, "INVENTORY_CALIBRATION_INVALID", "校准模式必须提供 quantity 与明确的 location/null");
        }
      } else if (!Number.isInteger(entry.delta)
        || entry.delta === undefined
        || entry.delta === 0
        || entry.delta < -2_147_483_647
        || entry.delta > 2_147_483_647
        || entry.quantity !== undefined) {
        throw new AppError(400, "INVENTORY_DELTA_INVALID", "增减模式必须提供有效的非零整数 delta");
      }
    }

    return this.inTransaction(async (client) => {
      const owner = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [input.userId],
      );
      if (!owner.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
      const duplicateReference = await client.query(
        "SELECT 1 FROM inventory_operations WHERE user_id = $1 AND idempotency_reference = $2",
        [input.userId, input.idempotencyReference],
      );
      if (duplicateReference.rows[0]) {
        throw new AppError(409, "INVENTORY_REFERENCE_CONFLICT", "该库存流水引用已被使用");
      }
      const history = await client.query<{ transaction_count: number | string }>(
        "SELECT count(*) AS transaction_count FROM inventory_transactions WHERE user_id = $1",
        [input.userId],
      );
      if (Number(history.rows[0]?.transaction_count ?? 0) + input.entries.length
        > MAX_INVENTORY_TRANSACTIONS_PER_USER) {
        throw new AppError(429, "INVENTORY_TRANSACTION_LIMIT_EXCEEDED", "库存流水记录已达到上限", {
          limit: MAX_INVENTORY_TRANSACTIONS_PER_USER,
        });
      }

      const sorted = input.entries.slice().sort((left, right) =>
        left.paletteId.localeCompare(right.paletteId) || left.colorCode.localeCompare(right.colorCode));
      for (const paletteId of [...new Set(sorted.map((entry) => entry.paletteId))]) {
        await this.requireSelectablePalette(
          client,
          input.userId,
          paletteId,
          "PALETTE_COLOR_NOT_FOUND",
        );
      }
      const existingByKey = new Map<string, InventoryRow>();
      for (const entry of sorted) {
        const color = await client.query<{ available: boolean }>(
          `SELECT color.available
           FROM palette_colors AS color
           JOIN palettes AS palette ON palette.id = color.palette_id
           WHERE color.palette_id = $1 AND color.code = $2
             AND (palette.owner_user_id IS NULL OR palette.owner_user_id = $3)`,
          [entry.paletteId, entry.colorCode, input.userId],
        );
        const colorRow = color.rows[0];
        if (!colorRow) throw new AppError(404, "PALETTE_COLOR_NOT_FOUND", "色卡或色号不存在");
        if (!colorRow.available) {
          throw new AppError(409, "PALETTE_COLOR_UNAVAILABLE", "色号当前不可用于库存操作", {
            paletteId: entry.paletteId,
            colorCode: entry.colorCode,
          });
        }
        const existing = await client.query<InventoryRow>(
          `SELECT * FROM inventory_items
           WHERE user_id = $1 AND palette_id = $2 AND color_code = $3
           FOR UPDATE`,
          [input.userId, entry.paletteId, entry.colorCode],
        );
        const row = existing.rows[0];
        if (row) existingByKey.set(`${entry.paletteId}:${entry.colorCode}`, row);
      }

      const prepared = input.entries.map((entry) => {
        const before = existingByKey.get(`${entry.paletteId}:${entry.colorCode}`);
        const effectiveRevision = before?.revision ?? 0;
        if (effectiveRevision !== entry.baseRevision) {
          throw new AppError(409, "INVENTORY_REVISION_CONFLICT", "库存已在其他设备更新", {
            currentRevision: effectiveRevision,
          });
        }
        let quantity: number;
        let location: string | null;
        if (input.mode === "calibrate") {
          quantity = entry.quantity!;
          location = entry.location!;
        } else {
          quantity = (before?.quantity ?? 0) + entry.delta!;
          if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 2_147_483_647) {
            throw new AppError(409, "INVENTORY_QUANTITY_OUT_OF_RANGE", "库存增减后数量不能为负数或超出上限", {
              paletteId: entry.paletteId,
              colorCode: entry.colorCode,
              currentQuantity: before?.quantity ?? 0,
            });
          }
          location = entry.location === undefined ? before?.location ?? null : entry.location;
        }
        return { entry, before, quantity, location };
      });

      const operationId = randomUUID();
      const type: InventoryTransaction["type"] = input.mode === "calibrate"
        ? "calibration"
        : "manual_adjustment";
      await client.query(
        `INSERT INTO inventory_operations(
           id, user_id, transaction_type, project_id, project_revision,
           idempotency_reference, created_at
         ) VALUES ($1, $2, $3, NULL, NULL, $4, $5)`,
        [operationId, input.userId, type, input.idempotencyReference, input.now],
      );
      const items: InventoryItem[] = [];
      const transactions: InventoryTransaction[] = [];
      for (const row of prepared) {
        const saved = row.before
          ? await client.query<InventoryRow>(
            `UPDATE inventory_items
             SET quantity = $4, location = $5, revision = revision + 1, updated_at = $6
             WHERE user_id = $1 AND palette_id = $2 AND color_code = $3
             RETURNING *`,
            [input.userId, row.entry.paletteId, row.entry.colorCode, row.quantity, row.location, input.now],
          )
          : await client.query<InventoryRow>(
            `INSERT INTO inventory_items(
               user_id, palette_id, color_code, quantity, location, revision, updated_at
             ) VALUES ($1, $2, $3, $4, $5, 1, $6)
             RETURNING *`,
            [input.userId, row.entry.paletteId, row.entry.colorCode, row.quantity, row.location, input.now],
          );
        const savedRow = saved.rows[0];
        if (!savedRow) throw new AppError(500, "INVENTORY_SAVE_FAILED", "库存保存失败");
        const transactionId = randomUUID();
        await client.query(
          `INSERT INTO inventory_transactions(
             id, operation_id, user_id, palette_id, color_code,
             quantity_before, delta, quantity_after, location_before, location_after
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            transactionId,
            operationId,
            input.userId,
            row.entry.paletteId,
            row.entry.colorCode,
            row.before?.quantity ?? 0,
            row.quantity - (row.before?.quantity ?? 0),
            row.quantity,
            row.before?.location ?? null,
            row.location,
          ],
        );
        items.push(inventoryItem(savedRow));
        transactions.push({
          id: transactionId,
          operationId,
          userId: input.userId,
          type,
          paletteId: row.entry.paletteId,
          colorCode: row.entry.colorCode,
          quantityBefore: row.before?.quantity ?? 0,
          delta: row.quantity - (row.before?.quantity ?? 0),
          quantityAfter: row.quantity,
          locationBefore: row.before?.location ?? null,
          locationAfter: row.location,
          projectId: null,
          projectRevision: null,
          idempotencyReference: input.idempotencyReference,
          createdAt: input.now,
        });
      }
      return { operationId, items, transactions };
    });
  }

  async listInventoryOperations(
    input: Parameters<AppStore["listInventoryOperations"]>[0],
  ): Promise<InventoryOperation[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 101
      || !Number.isInteger(input.offset ?? 0) || (input.offset ?? 0) < 0) {
      throw new AppError(400, "INVENTORY_OPERATION_PAGE_INVALID", "库存操作分页参数无效");
    }
    const result = await this.query<InventoryOperationRow>(
      `SELECT operation.id, operation.user_id, operation.transaction_type,
              operation.project_id, operation.project_revision,
              operation.idempotency_reference, marker.consumed_at,
              operation.created_at
       FROM inventory_operations AS operation
       LEFT JOIN inventory_project_consumptions AS marker
         ON marker.operation_id = operation.id
        AND marker.user_id = operation.user_id
       WHERE operation.user_id = $1
         AND ($2::uuid IS NULL OR operation.project_id = $2)
         AND ($3::text IS NULL OR operation.idempotency_reference = $3)
       ORDER BY operation.created_at DESC, operation.id DESC
       LIMIT $4 OFFSET $5`,
      [
        input.userId,
        input.projectId ?? null,
        input.idempotencyReference ?? null,
        input.limit,
        input.offset ?? 0,
      ],
    );
    return result.rows.map(inventoryOperation);
  }

  async listInventoryTransactions(
    input: Parameters<AppStore["listInventoryTransactions"]>[0],
  ): Promise<InventoryTransaction[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 101
      || !Number.isInteger(input.offset ?? 0) || (input.offset ?? 0) < 0) {
      throw new AppError(400, "INVENTORY_TRANSACTION_PAGE_INVALID", "库存流水分页参数无效");
    }
    const result = await this.query<InventoryTransactionRow>(
      `SELECT line.id, line.operation_id, line.user_id,
              operation.transaction_type, line.palette_id, line.color_code,
              line.quantity_before, line.delta, line.quantity_after,
              line.location_before, line.location_after,
              operation.project_id, operation.project_revision,
              operation.idempotency_reference, operation.created_at
       FROM inventory_transactions line
       JOIN inventory_operations operation
         ON operation.id = line.operation_id AND operation.user_id = line.user_id
       WHERE operation.user_id = $1
         AND ($2::text IS NULL OR line.palette_id = $2)
         AND ($3::uuid IS NULL OR operation.project_id = $3)
       ORDER BY operation.created_at DESC, line.id DESC
       LIMIT $4 OFFSET $5`,
      [input.userId, input.paletteId ?? null, input.projectId ?? null, input.limit, input.offset ?? 0],
    );
    return result.rows.map(inventoryTransaction);
  }

  async consumeProjectInventory(
    input: Parameters<AppStore["consumeProjectInventory"]>[0],
  ): Promise<ProjectInventoryConsumption> {
    if (!Number.isInteger(input.projectRevision) || input.projectRevision < 1) {
      throw new AppError(400, "PROJECT_REVISION_INVALID", "项目版本无效");
    }
    if (input.idempotencyReference.length < 1 || input.idempotencyReference.length > 256) {
      throw new AppError(400, "INVENTORY_REFERENCE_INVALID", "库存流水引用长度无效");
    }
    return this.inTransaction(async (client) => {
      const owner = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [input.userId],
      );
      if (!owner.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
      const project = await client.query<{
        current_revision: number;
        palette_id: string;
        cells: Array<string | null>;
      }>(
        `SELECT project.current_revision, project.palette_id, revision.cells
         FROM projects project
         JOIN project_revisions revision
           ON revision.project_id = project.id AND revision.revision = project.current_revision
         WHERE project.id = $1 AND project.user_id = $2 AND project.deleted_at IS NULL
         FOR UPDATE OF project`,
        [input.projectId, input.userId],
      );
      const projectRow = project.rows[0];
      if (!projectRow) throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
      if (projectRow.current_revision !== input.projectRevision) {
        throw new AppError(409, "INVENTORY_CONSUMPTION_REVISION_MISMATCH", "只能扣减项目当前图纸版本的库存", {
          currentProjectRevision: projectRow.current_revision,
        });
      }
      await this.requireSelectablePalette(client, input.userId, projectRow.palette_id);
      const consumed = await client.query<{ consumed_at: Date | string }>(
        `SELECT consumed_at FROM inventory_project_consumptions
         WHERE user_id = $1 AND project_id = $2 AND project_revision = $3`,
        [input.userId, input.projectId, input.projectRevision],
      );
      if (consumed.rows[0]) {
        throw new AppError(409, "PROJECT_INVENTORY_ALREADY_CONSUMED", "该项目版本已确认扣减库存", {
          consumedAt: iso(consumed.rows[0].consumed_at),
        });
      }
      const progress = await client.query<{
        project_revision: number;
        completed_at: Date | string | null;
      }>(
        `SELECT project_revision, completed_at FROM build_progress
         WHERE project_id = $1 FOR UPDATE`,
        [input.projectId],
      );
      const progressRow = progress.rows[0];
      if (!progressRow
        || progressRow.project_revision !== input.projectRevision
        || progressRow.completed_at === null) {
        throw new AppError(409, "PROJECT_BUILD_NOT_COMPLETED", "项目制作完成后才能确认扣减库存");
      }
      const duplicateReference = await client.query(
        "SELECT 1 FROM inventory_operations WHERE user_id = $1 AND idempotency_reference = $2",
        [input.userId, input.idempotencyReference],
      );
      if (duplicateReference.rows[0]) {
        throw new AppError(409, "INVENTORY_REFERENCE_CONFLICT", "该库存流水引用已被使用");
      }
      const required = new Map<string, number>();
      for (const colorCode of projectRow.cells) {
        if (colorCode !== null) required.set(colorCode, (required.get(colorCode) ?? 0) + 1);
      }
      const prepared: Array<{ colorCode: string; required: number; before: InventoryRow | undefined }> = [];
      for (const [colorCode, requiredQuantity] of [...required.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const inventory = await client.query<InventoryRow>(
          `SELECT * FROM inventory_items
           WHERE user_id = $1 AND palette_id = $2 AND color_code = $3
           FOR UPDATE`,
          [input.userId, projectRow.palette_id, colorCode],
        );
        prepared.push({ colorCode, required: requiredQuantity, before: inventory.rows[0] });
      }
      const shortages = prepared
        .filter((line) => (line.before?.quantity ?? 0) < line.required)
        .map((line) => ({
          paletteId: projectRow.palette_id,
          colorCode: line.colorCode,
          requiredQuantity: line.required,
          availableQuantity: line.before?.quantity ?? 0,
        }));
      if (shortages.length > 0) {
        throw new AppError(409, "INVENTORY_INSUFFICIENT", "豆仓库存不足，未扣减任何色号", { shortages });
      }
      const history = await client.query<{ transaction_count: number | string }>(
        "SELECT count(*) AS transaction_count FROM inventory_transactions WHERE user_id = $1",
        [input.userId],
      );
      if (Number(history.rows[0]?.transaction_count ?? 0) + prepared.length
        > MAX_INVENTORY_TRANSACTIONS_PER_USER) {
        throw new AppError(429, "INVENTORY_TRANSACTION_LIMIT_EXCEEDED", "库存流水记录已达到上限", {
          limit: MAX_INVENTORY_TRANSACTIONS_PER_USER,
        });
      }
      const operationId = randomUUID();
      await client.query(
        `INSERT INTO inventory_operations(
           id, user_id, transaction_type, project_id, project_revision,
           idempotency_reference, created_at
         ) VALUES ($1, $2, 'project_consumption', $3, $4, $5, $6)`,
        [operationId, input.userId, input.projectId, input.projectRevision, input.idempotencyReference, input.now],
      );
      await client.query(
        `INSERT INTO inventory_project_consumptions(
           user_id, project_id, project_revision, operation_id, consumed_at
         ) VALUES ($1, $2, $3, $4, $5)`,
        [input.userId, input.projectId, input.projectRevision, operationId, input.now],
      );
      const items: InventoryItem[] = [];
      const transactions: InventoryTransaction[] = [];
      for (const line of prepared) {
        const before = line.before!;
        const saved = await client.query<InventoryRow>(
          `UPDATE inventory_items
           SET quantity = quantity - $4, revision = revision + 1, updated_at = $5
           WHERE user_id = $1 AND palette_id = $2 AND color_code = $3
           RETURNING *`,
          [input.userId, projectRow.palette_id, line.colorCode, line.required, input.now],
        );
        const savedRow = saved.rows[0];
        if (!savedRow) throw new AppError(500, "INVENTORY_CONSUMPTION_FAILED", "库存扣减失败");
        const transactionId = randomUUID();
        await client.query(
          `INSERT INTO inventory_transactions(
             id, operation_id, user_id, palette_id, color_code,
             quantity_before, delta, quantity_after, location_before, location_after
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [
            transactionId,
            operationId,
            input.userId,
            projectRow.palette_id,
            line.colorCode,
            before.quantity,
            -line.required,
            savedRow.quantity,
            before.location,
          ],
        );
        items.push(inventoryItem(savedRow));
        transactions.push({
          id: transactionId,
          operationId,
          userId: input.userId,
          type: "project_consumption",
          paletteId: projectRow.palette_id,
          colorCode: line.colorCode,
          quantityBefore: before.quantity,
          delta: -line.required,
          quantityAfter: savedRow.quantity,
          locationBefore: before.location,
          locationAfter: before.location,
          projectId: input.projectId,
          projectRevision: input.projectRevision,
          idempotencyReference: input.idempotencyReference,
          createdAt: input.now,
        });
      }
      return {
        operationId,
        projectId: input.projectId,
        projectRevision: input.projectRevision,
        consumedAt: input.now,
        items,
        transactions,
      };
    });
  }

  async consumeUserRateLimit(input: Parameters<AppStore["consumeUserRateLimit"]>[0]): Promise<RateLimitResult> {
    const consumed = await this.query<{
      request_count: number;
      window_started_at: Date | string;
      current_at: Date | string;
    }>(
      `WITH database_clock AS (SELECT clock_timestamp() AS now_at)
       INSERT INTO user_rate_limits(user_id, action, window_started_at, request_count, updated_at)
       SELECT $1, $2, database_clock.now_at, 1, database_clock.now_at
       FROM database_clock
       ON CONFLICT (user_id, action) DO UPDATE SET
         window_started_at = CASE
           WHEN user_rate_limits.window_started_at + ($4::double precision * interval '1 millisecond')
                  <= EXCLUDED.window_started_at
             THEN EXCLUDED.window_started_at
           ELSE user_rate_limits.window_started_at
         END,
         request_count = CASE
           WHEN user_rate_limits.window_started_at + ($4::double precision * interval '1 millisecond')
                  <= EXCLUDED.window_started_at
             THEN 1
           ELSE user_rate_limits.request_count + 1
         END,
         updated_at = EXCLUDED.updated_at
       WHERE user_rate_limits.window_started_at + ($4::double precision * interval '1 millisecond')
               <= EXCLUDED.window_started_at
          OR user_rate_limits.request_count < $3
       RETURNING request_count, window_started_at, clock_timestamp() AS current_at`,
      [input.userId, input.action, input.limit, input.windowMilliseconds],
    );
    const accepted = consumed.rows[0];
    if (accepted) {
      const retryAfterMilliseconds = Math.max(
        1,
        Date.parse(iso(accepted.window_started_at)) + input.windowMilliseconds - Date.parse(iso(accepted.current_at)),
      );
      return {
        allowed: true,
        remaining: Math.max(0, input.limit - accepted.request_count),
        retryAfterMilliseconds,
      };
    }

    const limited = await this.query<{
      request_count: number;
      window_started_at: Date | string;
      current_at: Date | string;
    }>(
      `SELECT request_count, window_started_at, clock_timestamp() AS current_at
       FROM user_rate_limits
       WHERE user_id = $1 AND action = $2`,
      [input.userId, input.action],
    );
    const row = limited.rows[0];
    if (!row) throw new AppError(503, "RATE_LIMIT_STATE_RETRY", "请求频率状态发生变化，请重试", null, true);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMilliseconds: Math.max(
        1,
        Date.parse(iso(row.window_started_at)) + input.windowMilliseconds - Date.parse(iso(row.current_at)),
      ),
    };
  }

  async consumeAuthRateLimit(input: Parameters<AppStore["consumeAuthRateLimit"]>[0]): Promise<RateLimitResult> {
    await this.query(
      `WITH expired AS MATERIALIZED (
         SELECT ctid
         FROM auth_rate_limits
         WHERE updated_at < clock_timestamp() - ($1::bigint * interval '1 millisecond')
         ORDER BY updated_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM auth_rate_limits AS rate
       USING expired
       WHERE rate.ctid = expired.ctid`,
      [AUTH_RATE_LIMIT_RETENTION_MILLISECONDS, AUTH_RATE_LIMIT_CLEANUP_BATCH_SIZE],
    );
    const consumed = await this.query<{ request_count: number; window_started_at: Date | string; current_at: Date | string }>(
      `WITH database_clock AS (SELECT clock_timestamp() AS now_at)
       INSERT INTO auth_rate_limits(key_hash, action, window_started_at, request_count, updated_at)
       SELECT $1, $2, database_clock.now_at, 1, database_clock.now_at FROM database_clock
       ON CONFLICT (key_hash, action) DO UPDATE SET
         window_started_at = CASE WHEN auth_rate_limits.window_started_at + ($4::double precision * interval '1 millisecond') <= EXCLUDED.window_started_at THEN EXCLUDED.window_started_at ELSE auth_rate_limits.window_started_at END,
         request_count = CASE WHEN auth_rate_limits.window_started_at + ($4::double precision * interval '1 millisecond') <= EXCLUDED.window_started_at THEN 1 ELSE auth_rate_limits.request_count + 1 END,
         updated_at = EXCLUDED.updated_at
       WHERE auth_rate_limits.window_started_at + ($4::double precision * interval '1 millisecond') <= EXCLUDED.window_started_at OR auth_rate_limits.request_count < $3
       RETURNING request_count, window_started_at, clock_timestamp() AS current_at`,
      [input.keyHash, input.action, input.limit, input.windowMilliseconds],
    );
    const row = consumed.rows[0] ?? (await this.query<{ request_count: number; window_started_at: Date | string; current_at: Date | string }>(
      "SELECT request_count, window_started_at, clock_timestamp() AS current_at FROM auth_rate_limits WHERE key_hash = $1 AND action = $2",
      [input.keyHash, input.action],
    )).rows[0];
    if (!row) throw new AppError(503, "RATE_LIMIT_STATE_RETRY", "请求频率状态发生变化，请重试", null, true);
    const allowed = consumed.rows.length > 0;
    return {
      allowed,
      remaining: allowed ? Math.max(0, input.limit - row.request_count) : 0,
      retryAfterMilliseconds: Math.max(1, Date.parse(iso(row.window_started_at)) + input.windowMilliseconds - Date.parse(iso(row.current_at))),
    };
  }

  async ensureUserInviteCode(userId: string, now: string): Promise<import("../domain/models.js").UserInviteCode> {
    const { generateInviteCode } = await import("../domain/invite.js");
    return this.inTransaction(async (client) => {
      const existing = await client.query<{ user_id: string; code: string; created_at: Date | string }>(
        "SELECT user_id, code, created_at FROM user_invite_codes WHERE user_id = $1 FOR UPDATE",
        [userId],
      );
      if (existing.rows[0]) {
        return {
          userId: existing.rows[0].user_id,
          code: existing.rows[0].code,
          createdAt: iso(existing.rows[0].created_at),
        };
      }
      const user = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      if (!user.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = generateInviteCode();
        try {
          const inserted = await client.query<{ user_id: string; code: string; created_at: Date | string }>(
            `INSERT INTO user_invite_codes(user_id, code, created_at)
             VALUES ($1, $2, $3::timestamptz)
             RETURNING user_id, code, created_at`,
            [userId, code, now],
          );
          const row = inserted.rows[0]!;
          return { userId: row.user_id, code: row.code, createdAt: iso(row.created_at) };
        } catch (error) {
          if ((error as { code?: string }).code === "23505") continue;
          throw error;
        }
      }
      throw new AppError(503, "INVITE_CODE_UNAVAILABLE", "邀请码暂时不可用，请重试", null, true);
    });
  }

  async getInviteSummary(userId: string): Promise<import("../domain/models.js").InviteSummary> {
    const { buildInviteSummary } = await import("../domain/invite.js");
    const invite = await this.ensureUserInviteCode(userId, new Date().toISOString());
    const bindingResult = await this.query<{
      invitee_user_id: string;
      inviter_user_id: string;
      invite_code: string;
      bound_at: Date | string;
      invitee_was_new_user: boolean;
    }>(
      `SELECT invitee_user_id, inviter_user_id, invite_code, bound_at, invitee_was_new_user
       FROM invite_bindings WHERE invitee_user_id = $1`,
      [userId],
    );
    const entitlementResult = await this.query<{
      id: string;
      binding_invitee_user_id: string;
      beneficiary_user_id: string;
      role: "inviter" | "invitee";
      status: "awaiting_external_proof" | "credited" | "rejected";
      credit_ledger_id: string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `SELECT id, binding_invitee_user_id, beneficiary_user_id, role, status, credit_ledger_id, created_at, updated_at
       FROM invite_reward_entitlements
       WHERE beneficiary_user_id = $1 OR binding_invitee_user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [userId],
    );
    const bindingRow = bindingResult.rows[0];
    return buildInviteSummary({
      invite,
      binding: bindingRow
        ? {
          inviteeUserId: bindingRow.invitee_user_id,
          inviterUserId: bindingRow.inviter_user_id,
          inviteCode: bindingRow.invite_code,
          boundAt: iso(bindingRow.bound_at),
          inviteeWasNewUser: Boolean(bindingRow.invitee_was_new_user),
        }
        : null,
      entitlements: entitlementResult.rows.map((row) => ({
        id: row.id,
        bindingInviteeUserId: row.binding_invitee_user_id,
        beneficiaryUserId: row.beneficiary_user_id,
        role: row.role,
        status: row.status,
        creditLedgerId: row.credit_ledger_id,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
    });
  }

  async acceptInviteCode(input: {
    inviteeUserId: string;
    code: string;
    now: string;
    inviteeWasNewUser: boolean;
  }): Promise<import("../domain/models.js").InviteAcceptResult> {
    const {
      assertInviteAcceptAllowed,
      inviteRewardDeltaForInvitee,
      normalizeInviteCode,
    } = await import("../domain/invite.js");
    const { INVITE_REWARD_LEDGER_REASON } = await import("../domain/models.js");
    const code = normalizeInviteCode(input.code);
    let rewardApplied: import("../domain/models.js").InviteRewardApplied | null = null;
    await this.inTransaction(async (client) => {
      const invite = await client.query<{ user_id: string }>(
        "SELECT user_id FROM user_invite_codes WHERE code = $1 FOR UPDATE",
        [code],
      );
      const inviterUserId = invite.rows[0]?.user_id;
      if (!inviterUserId) throw new AppError(404, "INVITE_NOT_FOUND", "邀请码不存在");
      const existingResult = await client.query<{
        invitee_user_id: string;
        inviter_user_id: string;
        invite_code: string;
        bound_at: Date | string;
        invitee_was_new_user: boolean;
      }>(
        `SELECT invitee_user_id, inviter_user_id, invite_code, bound_at, invitee_was_new_user
         FROM invite_bindings WHERE invitee_user_id = $1 FOR UPDATE`,
        [input.inviteeUserId],
      );
      const existingRow = existingResult.rows[0];
      const existing = existingRow
        ? {
          inviteeUserId: existingRow.invitee_user_id,
          inviterUserId: existingRow.inviter_user_id,
          inviteCode: existingRow.invite_code,
          boundAt: iso(existingRow.bound_at),
          inviteeWasNewUser: Boolean(existingRow.invitee_was_new_user),
        }
        : null;
      const mode = assertInviteAcceptAllowed({
        inviteeUserId: input.inviteeUserId,
        inviterUserId,
        existing,
        inviteCode: code,
      });
      if (mode === "create") {
        const inviteeWasNewUser = Boolean(input.inviteeWasNewUser);
        const delta = inviteRewardDeltaForInvitee(inviteeWasNewUser);
        const entitlementId = randomUUID();
        const ledgerId = randomUUID();
        await client.query(
          `INSERT INTO invite_bindings(
             invitee_user_id, inviter_user_id, invite_code, bound_at, invitee_was_new_user
           ) VALUES ($1, $2, $3, $4::timestamptz, $5)`,
          [input.inviteeUserId, inviterUserId, code, input.now, inviteeWasNewUser],
        );
        const credited = await client.query<{ balance: number }>(
          `UPDATE credit_accounts
           SET balance = balance + $2, updated_at = $3::timestamptz
           WHERE user_id = $1
           RETURNING balance`,
          [inviterUserId, delta, input.now],
        );
        const balanceAfter = credited.rows[0]?.balance;
        if (balanceAfter === undefined) {
          throw new AppError(500, "CREDIT_ACCOUNT_MISSING", "邀请人次数账户不存在");
        }
        await client.query(
          `INSERT INTO credit_ledger(id, user_id, delta, balance_after, reason, reference_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
          [ledgerId, inviterUserId, delta, balanceAfter, INVITE_REWARD_LEDGER_REASON, entitlementId, input.now],
        );
        await client.query(
          `INSERT INTO invite_reward_entitlements(
             id, binding_invitee_user_id, beneficiary_user_id, role, status, credit_ledger_id, created_at, updated_at
           ) VALUES ($1, $2, $3, 'inviter', 'credited', $4, $5::timestamptz, $5::timestamptz)`,
          [entitlementId, input.inviteeUserId, inviterUserId, ledgerId, input.now],
        );
        rewardApplied = {
          beneficiaryRole: "inviter",
          delta,
          inviteeWasNewUser,
        };
      }
    });
    return {
      inviteSummary: await this.getInviteSummary(input.inviteeUserId),
      rewardApplied,
    };
  }

  async executeIdempotent<T>(
    input: { userId: string; scope: string; key: string; requestHash: string },
    operation: (transactionStore: AppStore) => Promise<IdempotentOperationResult<T>>,
  ): Promise<IdempotentExecutionResult<T>> {
    if (this.transactionClient) {
      throw new AppError(500, "NESTED_IDEMPOTENCY_NOT_ALLOWED", "幂等事务不能嵌套");
    }
    return withTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext('api-idempotency-user'))",
        [input.userId],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [input.userId, `${input.scope}:${input.key}`],
      );
      await client.query(
        `DELETE FROM api_idempotency
         WHERE user_id = $1
           AND scope <> 'payment-orders:create'
           AND created_at < clock_timestamp() - ($2::bigint * interval '1 millisecond')`,
        [input.userId, OPERATIONAL_HISTORY_RETENTION_MILLISECONDS],
      );
      const existingResult = await client.query<{
        request_hash: string;
        status_code: number;
        response_body: unknown;
      }>(
        `SELECT request_hash, status_code, response_body FROM api_idempotency
         WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3`,
        [input.userId, input.scope, input.key],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
        }
        return {
          statusCode: existing.status_code,
          body: existing.response_body as T,
          replayed: true,
        };
      }

      const history = await client.query<{ record_count: number | string }>(
        `SELECT count(*) AS record_count FROM api_idempotency
         WHERE user_id = $1 AND scope <> 'payment-orders:create'`,
        [input.userId],
      );
      if (Number(history.rows[0]?.record_count ?? 0) >= MAX_IDEMPOTENCY_RECORDS_PER_USER) {
        throw new AppError(429, "IDEMPOTENCY_HISTORY_LIMIT_EXCEEDED", "幂等请求历史记录已达到上限", {
          limit: MAX_IDEMPOTENCY_RECORDS_PER_USER,
          retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
        });
      }

      const transactionStore = new PostgresStore(this.pool, client);
      const result = await operation(transactionStore);
      await client.query(
        `INSERT INTO api_idempotency(user_id, scope, idempotency_key, request_hash, status_code, response_body)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          input.userId,
          input.scope,
          input.key,
          input.requestHash,
          result.statusCode,
          JSON.stringify(result.body),
        ],
      );
      return { ...result, replayed: false };
    });
  }

  async executePaymentEffectIdempotent<T>(
    input: PaymentEffectFence,
    operation: (transactionStore: AppStore) => Promise<IdempotentOperationResult<T>>,
  ): Promise<IdempotentExecutionResult<T>> {
    if (this.transactionClient) {
      throw new AppError(500, "NESTED_IDEMPOTENCY_NOT_ALLOWED", "幂等事务不能嵌套");
    }
    return withTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext('api-idempotency-user'))",
        [input.userId],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [input.userId, `${input.scope}:${input.key}`],
      );
      await this.lockActivePaymentEffect(client, input);
      await client.query(
        `DELETE FROM api_idempotency
         WHERE user_id = $1
           AND scope <> 'payment-orders:create'
           AND created_at < clock_timestamp() - ($2::bigint * interval '1 millisecond')`,
        [input.userId, OPERATIONAL_HISTORY_RETENTION_MILLISECONDS],
      );
      const existingResult = await client.query<{
        request_hash: string;
        status_code: number;
        response_body: unknown;
      }>(
        `SELECT request_hash, status_code, response_body FROM api_idempotency
         WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3`,
        [input.userId, input.scope, input.key],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
        }
        await this.completeActivePaymentEffect(client, input);
        return {
          statusCode: existing.status_code,
          body: existing.response_body as T,
          replayed: true,
        };
      }

      const history = await client.query<{ record_count: number | string }>(
        `SELECT count(*) AS record_count FROM api_idempotency
         WHERE user_id = $1 AND scope <> 'payment-orders:create'`,
        [input.userId],
      );
      if (Number(history.rows[0]?.record_count ?? 0) >= MAX_IDEMPOTENCY_RECORDS_PER_USER) {
        throw new AppError(429, "IDEMPOTENCY_HISTORY_LIMIT_EXCEEDED", "幂等请求历史记录已达到上限", {
          limit: MAX_IDEMPOTENCY_RECORDS_PER_USER,
          retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
        });
      }

      const transactionStore = new PostgresStore(this.pool, client);
      const result = await operation(transactionStore);
      await client.query(
        `INSERT INTO api_idempotency(user_id, scope, idempotency_key, request_hash, status_code, response_body)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          input.userId,
          input.scope,
          input.key,
          input.requestHash,
          result.statusCode,
          JSON.stringify(result.body),
        ],
      );
      // The ownership CAS is deliberately the final write. If the database
      // lease expired while the local transaction was running, every business
      // mutation above rolls back with this failure.
      await this.completeActivePaymentEffect(client, input);
      return { ...result, replayed: false };
    });
  }

  async getIdempotent<T>(input: {
    userId: string;
    scope: string;
    key: string;
    requestHash: string;
  }): Promise<IdempotentExecutionResult<T> | null> {
    const result = await this.query<{
      request_hash: string;
      status_code: number;
      response_body: unknown;
    }>(
      `SELECT request_hash, status_code, response_body
       FROM api_idempotency
       WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3
         AND (
           scope = 'payment-orders:create'
           OR created_at >= clock_timestamp() - ($4::bigint * interval '1 millisecond')
         )`,
      [input.userId, input.scope, input.key, OPERATIONAL_HISTORY_RETENTION_MILLISECONDS],
    );
    const existing = result.rows[0];
    if (!existing) return null;
    if (existing.request_hash !== input.requestHash) {
      throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
    }
    return {
      statusCode: existing.status_code,
      body: existing.response_body as T,
      replayed: true,
    };
  }

  async claimPaymentEffect(input: Parameters<AppStore["claimPaymentEffect"]>[0]): Promise<PaymentEffectClaimResult> {
    return this.inTransaction(async (client) => {
      const owner = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [input.userId],
      );
      if (!owner.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
      await client.query(
        `DELETE FROM payment_effect_claims
         WHERE user_id = $1
           AND lease_expires_at <= clock_timestamp()
           AND updated_at < clock_timestamp() - ($2::bigint * interval '1 millisecond')`,
        [input.userId, OPERATIONAL_HISTORY_RETENTION_MILLISECONDS],
      );
      const existingResult = await client.query<{
        request_hash: string;
        lease_expires_at: Date | string;
        active: boolean;
      }>(
        `SELECT request_hash, lease_expires_at,
                lease_expires_at > clock_timestamp() AS active
         FROM payment_effect_claims
         WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [input.userId, input.scope, input.key],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
        }
        if (existing.active) {
          return { acquired: false, leaseExpiresAt: iso(existing.lease_expires_at) };
        }
        const reclaimed = await client.query<{ lease_expires_at: Date | string }>(
          `WITH database_clock AS (SELECT clock_timestamp() AS now_at)
           UPDATE payment_effect_claims
           SET lease_token = $4,
               lease_expires_at = database_clock.now_at + ($6::timestamptz - $5::timestamptz),
               updated_at = database_clock.now_at
           FROM database_clock
           WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3
           RETURNING lease_expires_at`,
          [input.userId, input.scope, input.key, input.leaseToken, input.now, input.leaseExpiresAt],
        );
        const row = reclaimed.rows[0];
        if (!row) throw new AppError(503, "PAYMENT_EFFECT_CLAIM_RETRY", "支付请求占用状态发生变化，请重试", null, true);
        return { acquired: true, leaseExpiresAt: iso(row.lease_expires_at) };
      }
      const history = await client.query<{ claim_count: number | string }>(
        "SELECT count(*) AS claim_count FROM payment_effect_claims WHERE user_id = $1",
        [input.userId],
      );
      if (Number(history.rows[0]?.claim_count ?? 0) >= MAX_PAYMENT_EFFECT_CLAIMS_PER_USER) {
        throw new AppError(429, "PAYMENT_EFFECT_CLAIM_LIMIT_EXCEEDED", "支付请求占用历史已达到上限", {
          limit: MAX_PAYMENT_EFFECT_CLAIMS_PER_USER,
        });
      }
      const inserted = await client.query<{ lease_expires_at: Date | string }>(
        `INSERT INTO payment_effect_claims(
           user_id, scope, idempotency_key, request_hash,
           lease_token, lease_expires_at, created_at, updated_at
         )
         SELECT $1, $2, $3, $4, $5,
                database_clock.now_at + ($7::timestamptz - $6::timestamptz),
                database_clock.now_at, database_clock.now_at
         FROM (SELECT clock_timestamp() AS now_at) AS database_clock
         ON CONFLICT (user_id, scope, idempotency_key) DO NOTHING
         RETURNING lease_expires_at`,
        [
          input.userId,
          input.scope,
          input.key,
          input.requestHash,
          input.leaseToken,
          input.now,
          input.leaseExpiresAt,
        ],
      );
      const row = inserted.rows[0];
      if (row) return { acquired: true, leaseExpiresAt: iso(row.lease_expires_at) };
      const raced = await client.query<{
        request_hash: string;
        lease_expires_at: Date | string;
      }>(
        `SELECT request_hash, lease_expires_at FROM payment_effect_claims
         WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3`,
        [input.userId, input.scope, input.key],
      );
      const racedClaim = raced.rows[0];
      if (!racedClaim) {
        throw new AppError(503, "PAYMENT_EFFECT_CLAIM_RETRY", "支付请求占用状态发生变化，请重试", null, true);
      }
      if (racedClaim.request_hash !== input.requestHash) {
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
      }
      return { acquired: false, leaseExpiresAt: iso(racedClaim.lease_expires_at) };
    });
  }

  async renewPaymentEffectClaim(input: Parameters<AppStore["renewPaymentEffectClaim"]>[0]): Promise<boolean> {
    const result = await this.query(
      `WITH database_clock AS (SELECT clock_timestamp() AS now_at)
       UPDATE payment_effect_claims
       SET lease_expires_at = database_clock.now_at + ($6::timestamptz - $5::timestamptz),
           updated_at = database_clock.now_at
       FROM database_clock
       WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3
         AND lease_token = $4
         AND lease_expires_at > database_clock.now_at
       RETURNING user_id`,
      [input.userId, input.scope, input.key, input.leaseToken, input.now, input.leaseExpiresAt],
    );
    return result.rowCount === 1;
  }

  async releasePaymentEffectClaim(input: Parameters<AppStore["releasePaymentEffectClaim"]>[0]): Promise<boolean> {
    const result = await this.query(
      `WITH database_clock AS (SELECT clock_timestamp() AS now_at)
       UPDATE payment_effect_claims
       SET lease_expires_at = database_clock.now_at, updated_at = database_clock.now_at
       FROM database_clock
       WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3 AND lease_token = $4
       RETURNING user_id`,
      [input.userId, input.scope, input.key, input.leaseToken],
    );
    return result.rowCount === 1;
  }

  async completePaymentEffectClaim(input: Parameters<AppStore["completePaymentEffectClaim"]>[0]): Promise<boolean> {
    const result = await this.query(
      `DELETE FROM payment_effect_claims
       WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3 AND lease_token = $4`,
      [input.userId, input.scope, input.key, input.leaseToken],
    );
    return result.rowCount === 1;
  }
}
