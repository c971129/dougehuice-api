export type IsoDateTime = string;

export interface User {
  id: string;
  displayName: string;
  createdAt: IsoDateTime;
}

export interface AuthSession {
  user: User;
  expiresAt: IsoDateTime;
  /** True only when this session was created with a newly inserted users row. */
  createdNewUser: boolean;
}

export type PaletteColorFinish =
  | "solid"
  | "pearlescent"
  | "thermochromic"
  | "translucent"
  | "transparent"
  | "glow-in-the-dark"
  | "photochromic"
  | "special";

export interface PaletteSource {
  name: string;
  url: string;
  revision: string;
  license: string;
}

export interface PaletteColor {
  code: string;
  name: string;
  hex: string;
  finish?: PaletteColorFinish;
  unitPriceCents: number;
  /** Disabled colors remain readable in historical revisions but cannot be selected for new mappings. */
  available: boolean;
}

export interface Palette {
  id: string;
  name: string;
  brand: string;
  /** Brand-owned product line. It is part of color identity, never a display-only label. */
  series?: string;
  material?: string;
  /** Physical center-to-center bead pitch used for size estimates. */
  beadSizeMm: number;
  /** True only after provenance and color values have been authoritatively verified. */
  verified: boolean;
  version: number;
  ownerUserId?: string | null;
  /** Retired palettes are readable only for migration/historical integrity. */
  retired?: boolean;
  source?: PaletteSource;
  colors: PaletteColor[];
}

export interface PatternGrid {
  encoding: "palette-code-v1";
  width: number;
  height: number;
  cells: Array<string | null>;
}

export type ProjectMode = "normal" | "pixel" | "portrait" | "couple";
export type ProjectLifecycleStatus = "draft" | "generating" | "editable" | "exported";
export type ProjectBackgroundMode = "white" | "transparent" | "solid";
export type ProjectDeviceSource = "mini-program" | "web" | "api" | "unknown";

export interface ProjectSummary {
  id: string;
  userId: string;
  name: string;
  mode: ProjectMode;
  /**
   * Product lifecycle state. This is intentionally separate from
   * ProjectListItem.status, which remains the legacy build-progress summary.
   */
  lifecycleStatus: ProjectLifecycleStatus;
  /** Independent optimistic-lock token for product metadata writes. */
  metadataRevision: number;
  tags: string[];
  /** Last client class that changed project content or metadata; legacy/unspecified writes are honest `unknown`. */
  deviceSource: ProjectDeviceSource;
  sourceAssetId: string | null;
  previewAssetId: string | null;
  paletteId: string;
  backgroundMode: ProjectBackgroundMode;
  /** Present only when backgroundMode is "solid". */
  backgroundColor: string | null;
  currentRevision: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type ProjectBuildStatus = "draft" | "in_progress" | "completed";

export interface ProjectListItem extends ProjectSummary {
  width: number;
  height: number;
  colorCount: number;
  beadCount: number;
  completedBeadCount: number;
  status: ProjectBuildStatus;
  hasDraft: boolean;
}

export interface ProjectStatusStats {
  total: number;
  draft: number;
  inProgress: number;
  completed: number;
}

export interface ProjectRevision {
  projectId: string;
  revision: number;
  paletteId: string;
  grid: PatternGrid;
  deviceSource: ProjectDeviceSource;
  createdAt: IsoDateTime;
  /** Immutable revisions use the same value for createdAt and updatedAt. */
  updatedAt: IsoDateTime;
}

export interface ProjectRevisionMetadata {
  projectId: string;
  revision: number;
  paletteId: string;
  width: number;
  height: number;
  deviceSource: ProjectDeviceSource;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ProjectDetail extends ProjectSummary {
  grid: PatternGrid;
  revisionDeviceSource: ProjectDeviceSource;
  revisionUpdatedAt: IsoDateTime;
}

/**
 * A mutable, bounded working copy used for frequent editor autosaves.
 * Only an explicit commit creates a new immutable ProjectRevision.
 */
export interface ProjectDraft {
  projectId: string;
  baseProjectRevision: number;
  draftRevision: number;
  name: string;
  grid: PatternGrid;
  updatedAt: IsoDateTime;
}

/**
 * The single resumable creation flow owned by a user before a Project exists.
 * A ready grid may be promoted atomically into the first immutable project revision.
 */
export interface CreationDraft {
  id: string;
  draftRevision: number;
  name: string;
  kind: GenerationKind;
  setupStep: 1 | 2 | 3;
  paletteId: string;
  sourceAssetId: string | null;
  width: number;
  height: number;
  options: GenerationOptions;
  grid: PatternGrid | null;
  updatedAt: IsoDateTime;
}

export interface MaterialLine {
  colorCode: string;
  colorName: string;
  hex: string;
  quantity: number;
  subtotalCents: number;
}

export interface MaterialSummary {
  projectId: string;
  projectRevision: number;
  width: number;
  height: number;
  colorCount: number;
  beadCount: number;
  /** Smallest non-empty inclusive rectangle, or null for an empty grid. */
  occupiedBounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } | null;
  physicalSize: {
    unit: "mm";
    beadSizeMm: number;
    canvas: { widthMm: number; heightMm: number };
    occupied: { widthMm: number; heightMm: number } | null;
  };
  estimatedTotalCents: number;
  lines: MaterialLine[];
}

export type BuildMode = "color" | "region" | "row-column";

export type BuildNavigationCursor =
  | { kind: "color"; colorCode: string }
  | { kind: "region"; regionIndex: number }
  | { kind: "row-column"; axis: "row" | "column"; index: number };

export interface BuildProgress {
  projectId: string;
  projectRevision: number;
  progressRevision: number;
  mode: BuildMode;
  navigationCursor: BuildNavigationCursor | null;
  completedIndices: number[];
  /** Accumulated active build time, in whole seconds. */
  elapsedTime: number;
  /** Null only for the virtual, not-yet-started progress returned before the first save. */
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  updatedAt: IsoDateTime;
}

export interface CreditAccount {
  userId: string;
  balance: number;
  updatedAt: IsoDateTime;
}

export interface CreditLedgerEntry {
  id: string;
  userId: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  referenceId: string | null;
  createdAt: IsoDateTime;
}

/** Ledger reason for inviter rewards credited on invitee login-bind. */
export const INVITE_REWARD_LEDGER_REASON = "invite_reward" as const;
export const INVITE_REWARD_INVITER_CREDITS_NEW_USER = 3 as const;
export const INVITE_REWARD_INVITER_CREDITS_RETURNING_USER = 1 as const;
export const INVITE_REWARD_INVITEE_CREDITS = 0 as const;

export type InviteRewardRole = "inviter" | "invitee";
export type InviteRewardEntitlementStatus = "awaiting_external_proof" | "credited" | "rejected";

export interface UserInviteCode {
  userId: string;
  code: string;
  createdAt: IsoDateTime;
}

export interface InviteBinding {
  inviteeUserId: string;
  inviterUserId: string;
  inviteCode: string;
  boundAt: IsoDateTime;
  inviteeWasNewUser: boolean;
}

export interface InviteRewardEntitlement {
  id: string;
  bindingInviteeUserId: string;
  beneficiaryUserId: string;
  role: InviteRewardRole;
  status: InviteRewardEntitlementStatus;
  creditLedgerId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface InviteRewardApplied {
  beneficiaryRole: "inviter";
  delta: typeof INVITE_REWARD_INVITER_CREDITS_NEW_USER | typeof INVITE_REWARD_INVITER_CREDITS_RETURNING_USER;
  inviteeWasNewUser: boolean;
}

export interface InviteAcceptResult {
  inviteSummary: InviteSummary;
  rewardApplied: InviteRewardApplied | null;
}

export interface InviteSummary {
  invite: UserInviteCode;
  binding: InviteBinding | null;
  entitlements: InviteRewardEntitlement[];
  rewardPolicy: {
    creditAmountConfigured: true;
    shareProofRequired: false;
    ledgerReasonReserved: typeof INVITE_REWARD_LEDGER_REASON;
    awardsCredits: true;
    inviterCreditAmountNewUser: typeof INVITE_REWARD_INVITER_CREDITS_NEW_USER;
    inviterCreditAmountReturningUser: typeof INVITE_REWARD_INVITER_CREDITS_RETURNING_USER;
    inviteeCreditAmount: typeof INVITE_REWARD_INVITEE_CREDITS;
  };
}

export type GenerationKind = ProjectMode;
export type GenerationCropRatio = "free" | "original" | "1:1" | "4:3" | "3:4";
export type GenerationFigureStyle = "chibi-full" | "chibi-half" | "pixel-avatar";
export type GenerationCoupleLayout = "together" | "split" | "solo";

export interface GenerationCropOptions {
  ratio: GenerationCropRatio;
  freeRatio: number;
  rotation: 0 | 90 | 180 | 270;
  scale: number;
  offsetX: number;
  offsetY: number;
  flipX: boolean;
  flipY: boolean;
}

export interface GenerationOptions {
  crop: GenerationCropOptions;
  removeBackground: boolean;
  figureStyle: GenerationFigureStyle;
  coupleLayout: GenerationCoupleLayout;
  maxColors: number;
  transparentBackground: boolean;
  inventoryOnly: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  dither: boolean;
}

export type GenerationActiveStatus = "preprocessing" | "generating" | "mapping_colors" | "finalizing";
export type GenerationStatus =
  | "queued"
  | GenerationActiveStatus
  | "retry_wait"
  | "completed"
  | "accepted"
  | "failed"
  | "canceled";

export type GenerationCandidateSubject = 1 | 2;
export type GenerationCandidateOutputSlot =
  | "combined"
  | "left"
  | "right"
  | "subject-1"
  | "subject-2";

export interface GenerationCandidate {
  id: string;
  jobId: string;
  /** One-based alternative/方案 number. Multiple flat rows may belong to one variant. */
  variantOrdinal: number;
  /** Semantic output owned by this row within its variant. */
  outputSlot: GenerationCandidateOutputSlot;
  /** One-based position in the stable, flat provider/persistence representation. */
  ordinal: number;
  /** Legacy persistence projection for couple/solo; must agree with outputSlot. */
  subject?: GenerationCandidateSubject;
  /** The linked project may later be physically purged; acceptedAt remains immutable. */
  acceptedProjectId?: string;
  acceptedAt?: IsoDateTime;
  grid: PatternGrid;
  createdAt: IsoDateTime;
}

export interface GenerationJob {
  id: string;
  userId: string;
  parentJobId: string | null;
  kind: GenerationKind;
  status: GenerationStatus;
  paletteId: string;
  sourceAssetId: string | null;
  options: GenerationOptions;
  cost: number;
  seed: string;
  width: number;
  height: number;
  progress: number;
  attemptCount: number;
  maxAttempts: number;
  availableAt: IsoDateTime;
  leaseToken: string | null;
  leaseExpiresAt: IsoDateTime | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  canceledAt: IsoDateTime | null;
  acceptedCandidateId: string | null;
  candidates: GenerationCandidate[];
}

export interface IdempotencyRecord {
  requestHash: string;
  statusCode: number;
  body: unknown;
  createdAt: IsoDateTime;
}

export type AssetPurpose = "ai-source" | "ai-intermediate" | "project-completion";
export type AssetMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface AssetMetadata {
  id: string;
  userId: string;
  purpose: AssetPurpose;
  /** AI consent contract; null for non-AI, project-bound completion photos. */
  consentVersion: string | null;
  sha256: string;
  mimeType: AssetMimeType;
  sizeBytes: number;
  width: number;
  height: number;
  /** Null only for project-bound durable assets deleted with their project. */
  expiresAt: IsoDateTime | null;
  deletedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export interface AssetRecord extends AssetMetadata {
  storageKey: string;
  readyAt: IsoDateTime | null;
  purgedAt: IsoDateTime | null;
}

export interface AssetUploadReservation {
  asset: AssetRecord;
  replayed: boolean;
  /** Stable while a reservation lease is active; never exposed publicly. */
  uploadLeaseToken: string;
  uploadLeaseExpiresAt: IsoDateTime;
}

export type AssetConsentEventSource = "asset-upload" | "legacy-asset-backfill";

export interface AssetConsentPolicySnapshot {
  policySha256: string;
  processor: string;
  processingPurpose: string;
  retention: string;
}

/**
 * Immutable evidence that one AI asset was published under a specific consent
 * contract. assetId remains as an audit snapshot after ordinary asset-history
 * compaction removes the mutable asset row.
 */
export interface AssetConsentEvent extends AssetConsentPolicySnapshot {
  id: string;
  userId: string;
  assetId: string;
  consentVersion: string;
  assetPurpose: "ai-source" | "ai-intermediate";
  source: AssetConsentEventSource;
  occurredAt: IsoDateTime;
  recordedAt: IsoDateTime;
}

/**
 * A private finished-work photo is bound to the exact immutable pattern
 * revision that the user completed. The nested AssetRecord stays internal;
 * routes flatten only safe image metadata and never expose storageKey.
 */
export interface ProjectCompletionPhotoRecord {
  id: string;
  userId: string;
  projectId: string;
  projectRevision: number;
  assetId: string;
  createdAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
  asset: AssetRecord;
}

export interface ProjectCompletionPhotoUploadReservation {
  photo: ProjectCompletionPhotoRecord;
  replayed: boolean;
  /** Stable for one idempotency reservation; never exposed by public routes. */
  uploadLeaseToken: string;
  uploadLeaseExpiresAt: IsoDateTime;
}

export type ExportFormat = "png" | "pdf";
export type ExportJobStatus = "queued" | "running" | "retry_wait" | "succeeded" | "failed" | "canceled";

export interface ExportOptions {
  paper: "A4";
  orientation: "auto" | "portrait" | "landscape";
  showCodes: boolean;
  showGrid: boolean;
  transparentBackground: boolean;
}

export interface ExportArtifactRecord {
  id: string;
  jobId: string;
  storageKey: string;
  mimeType: "image/png" | "application/pdf";
  fileName: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: IsoDateTime;
  createdAt: IsoDateTime;
}

export interface ExportArtifactPurgeRecord extends ExportArtifactRecord {
  userId: string;
}

export interface ExportJobRecord {
  id: string;
  userId: string;
  projectId: string;
  projectRevision: number;
  format: ExportFormat;
  fileName: string;
  options: ExportOptions;
  status: ExportJobStatus;
  progress: number;
  attemptCount: number;
  maxAttempts: number;
  availableAt: IsoDateTime;
  leaseToken: string | null;
  leaseExpiresAt: IsoDateTime | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  artifact: ExportArtifactRecord | null;
}

export interface CreditProduct {
  id: string;
  version: number;
  name: string;
  description: string;
  creditAmount: number;
  amountCents: number;
  currency: "CNY";
  enabled: boolean;
}

export type PaymentOrderStatus = "pending" | "succeeded" | "failed" | "closed";

export interface PaymentOrderRecord {
  id: string;
  userId: string;
  productId: string;
  productVersion: number;
  productName: string;
  creditAmount: number;
  amountCents: number;
  currency: "CNY";
  outTradeNo: string;
  status: PaymentOrderStatus;
  providerReference: string;
  providerTradeState: string | null;
  providerTransactionId: string | null;
  paymentExpiresAt: IsoDateTime;
  paidAt: IsoDateTime | null;
  /** First provider-confirmed CLOSED observation; retained if a late verified SUCCESS later wins. */
  closedAt: IsoDateTime | null;
  /** Last successful provider query performed by refresh or the reconciliation worker. */
  lastReconciledAt: IsoDateTime | null;
  /** Set only when a verified SUCCESS corrects a previously closed local order. */
  lateSuccessAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type PaymentReconciliationState = "scheduled" | "running" | "completed";
export type PaymentReconciliationTradeState = "NOT_FOUND" | "NOTPAY" | "SUCCESS" | "CLOSED";

export interface PaymentReconciliationJob {
  orderId: string;
  state: PaymentReconciliationState;
  availableAt: IsoDateTime;
  attemptCount: number;
  leaseToken: string | null;
  leaseExpiresAt: IsoDateTime | null;
  lastObservedTradeState: PaymentReconciliationTradeState | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  completedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface PaymentReconciliationClaim {
  order: PaymentOrderRecord;
  job: PaymentReconciliationJob;
  /** Database-authoritative clock value used for expiry decisions. */
  claimedAt: IsoDateTime;
}

export interface InventoryItem {
  userId: string;
  paletteId: string;
  colorCode: string;
  quantity: number;
  location: string | null;
  revision: number;
  updatedAt: IsoDateTime;
}

export type InventoryTransactionType = "calibration" | "manual_adjustment" | "project_consumption";

export interface InventoryOperation {
  id: string;
  userId: string;
  type: InventoryTransactionType;
  projectId: string | null;
  projectRevision: number | null;
  idempotencyReference: string;
  /** Present only for the exactly-once project-consumption marker. */
  consumedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export interface InventoryTransaction {
  id: string;
  operationId: string;
  userId: string;
  type: InventoryTransactionType;
  paletteId: string;
  colorCode: string;
  quantityBefore: number;
  delta: number;
  quantityAfter: number;
  locationBefore: string | null;
  locationAfter: string | null;
  projectId: string | null;
  projectRevision: number | null;
  idempotencyReference: string;
  createdAt: IsoDateTime;
}

export interface InventoryMutationResult {
  operationId: string;
  items: InventoryItem[];
  transactions: InventoryTransaction[];
}

export interface ProjectInventoryConsumption extends InventoryMutationResult {
  projectId: string;
  projectRevision: number;
  consumedAt: IsoDateTime;
}
