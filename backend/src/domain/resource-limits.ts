export const MAX_GENERATION_CANDIDATES = 4;
export const MIN_GENERATION_CANDIDATE_ID_LENGTH = 1;
export const MAX_GENERATION_CANDIDATE_ID_LENGTH = 100;
export const MAX_ACTIVE_SESSIONS_PER_USER = 5;
export const MAX_GENERATION_CANDIDATE_CELLS_PER_USER = 2_000_000;
export const MAX_ACTIVE_ASSETS_PER_USER = 20;
export const MAX_ACTIVE_ASSET_BYTES_PER_USER = 100 * 1024 * 1024;
export const MAX_ASSET_HISTORY_PER_USER = 5_000;
export const MAX_PROJECT_COMPLETION_PHOTOS_PER_REVISION = 10;
export const MAX_ACTIVE_COMPLETION_PHOTOS_PER_USER = 200;
export const MAX_ACTIVE_COMPLETION_PHOTO_BYTES_PER_USER = 512 * 1024 * 1024;
export const MAX_ACTIVE_GENERATION_JOBS_PER_USER = 4;
export const MAX_ACTIVE_EXPORT_JOBS_PER_USER = 3;
export const ASSET_PUBLISH_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;
// Generic multipart uploads reserve their metadata and stable object key before
// writing bytes. Replays extend this lease so purge cannot finalize the key
// while a same-request writer is still in flight.
export const ASSET_UPLOAD_LEASE_MILLISECONDS = 15 * 60 * 1000;
// Remote object writes must finish comfortably before the durable lease ends.
export const ASSET_STORAGE_WRITE_TIMEOUT_MILLISECONDS = 5 * 60 * 1000;
// A completion upload writes its encrypted object outside the metadata
// transaction. Replays extend this durable lease so the generic pending-asset
// purge cannot tombstone the stable object key between get/put/publish.
export const COMPLETION_PHOTO_UPLOAD_LEASE_MILLISECONDS = 15 * 60 * 1000;
// Keep remote object writes comfortably inside the durable upload lease. The
// storage implementation must honor the AbortSignal so no writer can outlive
// the lease and recreate an object after purge has been finalized.
export const COMPLETION_PHOTO_STORAGE_WRITE_TIMEOUT_MILLISECONDS = 5 * 60 * 1000;
export const MAX_ACTIVE_PROJECTS_PER_USER = 100;
export const MAX_CUSTOM_PALETTES_PER_USER = 50;
export const MAX_CUSTOM_PALETTE_COLORS_PER_USER = 5_000;
export const MAX_PROJECT_REVISIONS = 500;
export const MAX_PROJECT_HISTORY_PER_USER = 500;
export const MAX_PROJECT_REVISION_CELLS_PER_USER = 2_000_000;
export const MAX_PENDING_PAYMENT_ORDERS_PER_USER = 5;
export const MAX_PAYMENT_ORDER_SLOT_HISTORY_PER_USER = 10_000;
export const MAX_PAYMENT_EFFECT_CLAIMS_PER_USER = 10_000;
export const MAX_UNPURGED_EXPORT_ARTIFACTS_PER_USER = 100;
export const MAX_UNPURGED_EXPORT_ARTIFACT_BYTES_PER_USER = 512 * 1024 * 1024;

// Terminal operational records are retained long enough for support and retries,
// while preventing an active account from growing these tables without bound.
export const OPERATIONAL_HISTORY_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;
export const MAX_GENERATION_HISTORY_PER_USER = 5_000;
export const MAX_EXPORT_HISTORY_PER_USER = 2_000;
export const MAX_IDEMPOTENCY_RECORDS_PER_USER = 10_000;
export const MAX_INVENTORY_BATCH_ITEMS = 100;
export const MAX_INVENTORY_TRANSACTIONS_PER_USER = 50_000;
export const AUTH_RATE_LIMIT_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1000;
export const AUTH_RATE_LIMIT_CLEANUP_BATCH_SIZE = 500;
export const PURGE_CLAIM_MILLISECONDS = 5 * 60 * 1000;
export const PURGE_RETRY_BASE_MILLISECONDS = 30 * 1000;
export const PURGE_RETRY_MAX_MILLISECONDS = 60 * 60 * 1000;
export const EXPORT_ARTIFACT_PUBLISH_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;

export const USER_RATE_LIMITS = {
  assetUpload: { action: "asset-upload", limit: 20, windowMilliseconds: 10 * 60 * 1000 },
  assetUploadAttempt: { action: "asset-upload-attempt", limit: 80, windowMilliseconds: 10 * 60 * 1000 },
  completionPhotoUpload: {
    action: "completion-photo-upload",
    limit: 30,
    windowMilliseconds: 60 * 60 * 1000,
  },
  completionPhotoUploadAttempt: {
    action: "completion-photo-upload-attempt",
    limit: 120,
    windowMilliseconds: 10 * 60 * 1000,
  },
  generationCreate: { action: "generation-create", limit: 60, windowMilliseconds: 60 * 60 * 1000 },
  generationCancel: { action: "generation-cancel", limit: 120, windowMilliseconds: 60 * 60 * 1000 },
  exportCreate: { action: "export-create", limit: 30, windowMilliseconds: 60 * 60 * 1000 },
  exportCancel: { action: "export-cancel", limit: 120, windowMilliseconds: 60 * 60 * 1000 },
  assetDelete: { action: "asset-delete", limit: 120, windowMilliseconds: 60 * 60 * 1000 },
  paymentCreate: { action: "payment-create", limit: 10, windowMilliseconds: 60 * 60 * 1000 },
  paymentRefresh: { action: "payment-refresh", limit: 60, windowMilliseconds: 60 * 60 * 1000 },
  webLoginConfirm: { action: "web-login-confirm", limit: 20, windowMilliseconds: 10 * 60 * 1000 },
  projectMutation: { action: "project-mutation", limit: 120, windowMilliseconds: 60 * 60 * 1000 },
  // Build mode can persist every few seconds. Keep it isolated from structural
  // project writes so a normal crafting session cannot exhaust the much lower
  // project-revision budget.
  buildProgressMutation: {
    action: "build-progress-mutation",
    limit: 1_800,
    windowMilliseconds: 60 * 60 * 1000,
  },
  projectDraftMutation: {
    action: "project-draft-mutation",
    limit: 1_800,
    windowMilliseconds: 60 * 60 * 1000,
  },
  creationDraftMutation: {
    action: "creation-draft-mutation",
    limit: 1_800,
    windowMilliseconds: 60 * 60 * 1000,
  },
  inventoryMutation: { action: "inventory-mutation", limit: 240, windowMilliseconds: 60 * 60 * 1000 },
  inventoryConsumption: {
    action: "inventory-consumption",
    limit: 120,
    windowMilliseconds: 60 * 60 * 1000,
  },
} as const;

/** Persistent limits keyed by a one-way hash of the effective client IP. */
export const ANONYMOUS_AUTH_RATE_LIMITS = {
  wechatSession: {
    action: "wechat-session",
    limit: 30,
    windowMilliseconds: 10 * 60 * 1000,
  },
} as const;

