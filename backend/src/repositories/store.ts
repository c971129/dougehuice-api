import type {
  AssetConsentEvent,
  AssetConsentPolicySnapshot,
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
  PaymentOrderRecord,
  PaymentReconciliationClaim,
  PaymentReconciliationJob,
  PaymentReconciliationTradeState,
  PatternGrid,
  ProjectDetail,
  ProjectBackgroundMode,
  ProjectBuildStatus,
  ProjectCompletionPhotoRecord,
  ProjectCompletionPhotoUploadReservation,
  ProjectDraft,
  ProjectDeviceSource,
  ProjectLifecycleStatus,
  ProjectListItem,
  ProjectMode,
  ProjectRevisionMetadata,
  ProjectInventoryConsumption,
  ProjectStatusStats,
  ProjectSummary,
  InviteAcceptResult,
  InviteSummary,
  UserInviteCode,
} from "../domain/models.js";

export interface CreateProjectInput {
  name: string;
  paletteId: string;
  grid: PatternGrid;
  mode?: ProjectMode;
  lifecycleStatus?: ProjectLifecycleStatus;
  sourceAssetId?: string | null;
  previewAssetId?: string | null;
  backgroundMode?: ProjectBackgroundMode;
  backgroundColor?: string | null;
  tags?: string[];
  deviceSource?: ProjectDeviceSource;
}

export interface PaletteMigrationAuditInput {
  entityType: "project_revision";
  entityId: string;
  oldPaletteId: string;
  oldColorCode: string;
  oldHex: string;
  newPaletteId: string;
  newColorCode: string;
  newHex: string;
  deltaE2000: number;
  reliable: boolean;
  migrationVersion: string;
}

export interface CopyProjectInput {
  userId: string;
  projectId: string;
  revision?: number;
  name?: string;
  deviceSource?: ProjectDeviceSource;
}

export interface ListProjectsInput {
  userId: string;
  limit: number;
  offset: number;
  q?: string;
  status?: ProjectBuildStatus;
  mode?: ProjectMode;
  lifecycleStatus?: ProjectLifecycleStatus;
  tag?: string;
}

export interface UpdateProjectMetadataInput {
  userId: string;
  projectId: string;
  baseRevision: number;
  baseMetadataRevision: number;
  mode?: ProjectMode;
  lifecycleStatus?: ProjectLifecycleStatus;
  sourceAssetId?: string | null;
  previewAssetId?: string | null;
  backgroundMode?: ProjectBackgroundMode;
  backgroundColor?: string | null;
  tags?: string[];
  deviceSource?: ProjectDeviceSource;
}

export interface InventoryBatchEntry {
  paletteId: string;
  colorCode: string;
  baseRevision: number;
  quantity?: number;
  delta?: number;
  /** Omitted in delta mode to retain the current location. */
  location?: string | null;
}

export interface CreateAssetInput {
  id: string;
  userId: string;
  purpose: AssetPurpose;
  consentVersion: string | null;
  sha256: string;
  mimeType: AssetMimeType;
  sizeBytes: number;
  width: number;
  height: number;
  storageKey: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface SaveCreationDraftInput {
  userId: string;
  draftId: string | null;
  baseDraftRevision: number;
  name: string;
  kind: GenerationKind;
  setupStep: 1 | 2 | 3;
  paletteId: string;
  sourceAssetId: string | null;
  width: number;
  height: number;
  options: GenerationOptions;
  grid: PatternGrid | null;
}

export interface IdempotentOperationResult<T> {
  statusCode: number;
  body: T;
}

export interface IdempotentExecutionResult<T> extends IdempotentOperationResult<T> {
  replayed: boolean;
}

export interface PaymentEffectClaimResult {
  acquired: boolean;
  leaseExpiresAt: string;
}

export interface PaymentEffectFence {
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
  leaseToken: string;
}

export interface PaymentOrderSlotReservation {
  attemptNo: number;
  outTradeNo: string;
  expiresAt: string;
  expired: boolean;
  created: boolean;
  state: "reserved" | "creating" | "created" | "closed";
  recoveryCiphertext: string | null;
  providerReferenceSha256: string | null;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMilliseconds: number;
}

export interface ExportJobStats {
  /** All export jobs still retained for the user, regardless of status. */
  total: number;
  succeeded: number;
}

export interface AppStore {
  ready(): Promise<void>;
  close(): Promise<void>;

  createDevSession(input: {
    displayName: string;
    tokenHash: string;
    expiresAt: string;
    startingCredits: number;
  }): Promise<AuthSession>;
  createWechatSession(input: {
    openId: string;
    displayName: string;
    tokenHash: string;
    expiresAt: string;
    /** Only supplied by the explicitly gated local-development WeChat provider. */
    developmentStartingCredits?: number;
  }): Promise<AuthSession>;
  resolveSession(tokenHash: string): Promise<AuthSession | null>;
  revokeSession(tokenHash: string): Promise<boolean>;
  getWechatOpenId(userId: string): Promise<string | null>;
  createWebLoginChallenge(input: {
    /** SHA-256 of the polling-only credential sent as X-Web-Login-Token. */
    tokenHash: string;
    /** SHA-256 of the independent Bearer credential returned only at creation time. */
    sessionTokenHash: string;
    code: string;
    expiresAt: string;
  }): Promise<void>;
  getWebLoginChallenge(tokenHash: string): Promise<{ status: "pending" | "approved" | "expired"; expiresAt: string } | null>;
  confirmWebLoginChallenge(input: {
    code: string;
    userId: string;
    sessionExpiresAt: string;
    /**
     * Local prototype compatibility only. The route must leave this false
     * unless DEV_AUTH_ENABLED is gated to a non-production loopback server.
     */
    createPollTokenSession: boolean;
  }): Promise<boolean>;

  getCreationDraft(userId: string): Promise<CreationDraft | null>;
  saveCreationDraft(input: SaveCreationDraftInput): Promise<CreationDraft>;
  commitCreationDraft(input: {
    userId: string;
    draftId: string;
    draftRevision: number;
  }): Promise<ProjectDetail>;
  discardCreationDraft(input: {
    userId: string;
    draftId: string;
    draftRevision: number;
  }): Promise<boolean>;

  createAsset(input: CreateAssetInput): Promise<AssetRecord>;
  reserveAssetUpload(input: {
    userId: string;
    scope: string;
    idempotencyKey: string;
    requestHash: string;
    uploadLeaseToken: string;
    uploadLeaseAcquiredAt: string;
    asset: CreateAssetInput;
  }): Promise<AssetUploadReservation>;
  publishAssetUpload(input: {
    userId: string;
    scope: string;
    idempotencyKey: string;
    assetId: string;
    uploadLeaseToken: string;
    readyAt: string;
    consentPolicy: AssetConsentPolicySnapshot;
  }): Promise<AssetRecord>;
  listAssetConsentEvents(input: {
    userId: string;
    limit: number;
    offset: number;
  }): Promise<AssetConsentEvent[]>;
  markAssetReady(userId: string, assetId: string, readyAt: string): Promise<AssetRecord | null>;
  getAsset(userId: string, assetId: string): Promise<AssetRecord | null>;
  listAssets(input: {
    userId: string;
    purpose?: AssetPurpose;
    purposes?: AssetPurpose[];
    includeDeleted: boolean;
    now: string;
    limit: number;
    offset?: number;
  }): Promise<AssetRecord[]>;
  markAssetDeleted(userId: string, assetId: string, deletedAt: string): Promise<AssetRecord | null>;
  listAssetsForPurge(now: string, limit: number): Promise<AssetRecord[]>;
  claimAssetForPurge(userId: string, assetId: string, now: string): Promise<AssetRecord | null>;
  recordAssetPurgeFailure(assetId: string, failedAt: string): Promise<void>;
  markAssetPurged(assetId: string, purgedAt: string): Promise<void>;

  listPalettes(userId: string): Promise<Palette[]>;
  getPalette(paletteId: string, userId: string): Promise<Palette | null>;
  createPalette(userId: string, palette: Palette): Promise<Palette>;

  createProject(userId: string, input: CreateProjectInput): Promise<ProjectDetail>;
  copyProject(input: CopyProjectInput): Promise<ProjectDetail | null>;
  listProjects(input: ListProjectsInput): Promise<ProjectListItem[]>;
  getProjectStatusStats(userId: string): Promise<ProjectStatusStats>;
  getProject(userId: string, projectId: string, revision?: number): Promise<ProjectDetail | null>;
  /** Internal worker read: keeps an already queued export usable after project soft deletion. */
  getProjectForExport(input: {
    userId: string;
    projectId: string;
    projectRevision: number;
  }): Promise<ProjectDetail | null>;
  updateProjectGrid(input: {
    userId: string;
    projectId: string;
    baseRevision: number;
    name?: string;
    /** Internal use for an atomic palette remap revision. */
    paletteId?: string;
    grid: PatternGrid;
    deviceSource?: ProjectDeviceSource;
    /** Internal audited migration evidence written atomically with the revision. */
    migrationAudit?: readonly PaletteMigrationAuditInput[];
  }): Promise<ProjectDetail>;
  remapProjectPalette(input: {
    userId: string;
    projectId: string;
    baseRevision: number;
    paletteId: string;
    grid: PatternGrid;
    deviceSource?: ProjectDeviceSource;
    migrationAudit?: readonly PaletteMigrationAuditInput[];
  }): Promise<ProjectDetail>;
  updateProjectMetadata(input: UpdateProjectMetadataInput): Promise<ProjectDetail>;
  listProjectRevisions(input: {
    userId: string;
    projectId: string;
    limit: number;
    offset: number;
  }): Promise<ProjectRevisionMetadata[]>;
  restoreProjectRevision(input: {
    userId: string;
    projectId: string;
    revision: number;
    baseRevision: number;
    deviceSource?: ProjectDeviceSource;
  }): Promise<ProjectDetail>;
  deleteProject(userId: string, projectId: string): Promise<boolean>;

  getProjectDraft(userId: string, projectId: string): Promise<ProjectDraft | null>;
  saveProjectDraft(input: {
    userId: string;
    projectId: string;
    baseProjectRevision: number;
    baseDraftRevision: number;
    name?: string;
    grid: PatternGrid;
  }): Promise<ProjectDraft>;
  commitProjectDraft(input: {
    userId: string;
    projectId: string;
    baseProjectRevision: number;
    draftRevision: number;
    deviceSource?: ProjectDeviceSource;
  }): Promise<ProjectDetail>;
  discardProjectDraft(input: {
    userId: string;
    projectId: string;
    baseProjectRevision: number;
    draftRevision: number;
  }): Promise<boolean>;

  getBuildProgress(userId: string, projectId: string): Promise<BuildProgress | null>;
  saveBuildProgress(input: {
    userId: string;
    projectId: string;
    projectRevision: number;
    baseProgressRevision: number;
    mode?: BuildProgress["mode"];
    navigationCursor?: BuildProgress["navigationCursor"];
    completedIndices: number[];
    elapsedTime?: number;
  }): Promise<BuildProgress>;

  reserveProjectCompletionPhotoUpload(input: {
    photoId: string;
    userId: string;
    projectId: string;
    projectRevision: number;
    idempotencyKey: string;
    requestHash: string;
    uploadLeaseToken: string;
    uploadLeaseAcquiredAt: string;
    asset: CreateAssetInput;
  }): Promise<ProjectCompletionPhotoUploadReservation>;
  publishProjectCompletionPhoto(input: {
    userId: string;
    projectId: string;
    photoId: string;
    assetId: string;
    uploadLeaseToken: string;
    readyAt: string;
  }): Promise<ProjectCompletionPhotoRecord>;
  listProjectCompletionPhotos(input: {
    userId: string;
    projectId: string;
    projectRevision: number;
    limit: number;
    offset: number;
    now: string;
  }): Promise<ProjectCompletionPhotoRecord[]>;
  getProjectCompletionPhoto(input: {
    userId: string;
    projectId: string;
    photoId: string;
    now: string;
    includeDeleted?: boolean;
  }): Promise<ProjectCompletionPhotoRecord | null>;
  deleteProjectCompletionPhoto(input: {
    userId: string;
    projectId: string;
    photoId: string;
    deletedAt: string;
  }): Promise<ProjectCompletionPhotoRecord | null>;

  getCreditAccount(userId: string): Promise<CreditAccount>;
  listCreditLedger(userId: string, limit: number, offset?: number): Promise<CreditLedgerEntry[]>;

  createGenerationJob(input: {
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
  }): Promise<GenerationJob>;
  getGenerationJob(userId: string, jobId: string): Promise<GenerationJob | null>;
  listGenerationJobs(input: {
    userId: string;
    statuses?: GenerationJob["status"][];
    limit: number;
    offset?: number;
  }): Promise<GenerationJob[]>;
  countActiveGenerationJobs(userId: string): Promise<number>;
  claimNextGenerationJob(input: {
    now?: string;
    leaseToken: string;
    leaseMilliseconds: number;
  }): Promise<GenerationJob | null>;
  renewGenerationJobLease(input: {
    jobId: string;
    leaseToken: string;
    now?: string;
    leaseMilliseconds: number;
  }): Promise<boolean>;
  advanceGenerationJob(input: {
    jobId: string;
    leaseToken: string;
    status: GenerationActiveStatus;
    progress: number;
    now: string;
  }): Promise<GenerationJob>;
  completeGenerationJob(input: {
    jobId: string;
    leaseToken: string;
    candidates: GenerationCandidate[];
    now: string;
  }): Promise<GenerationJob>;
  failGenerationJob(input: {
    jobId: string;
    leaseToken: string;
    code: string;
    message: string;
    retryable: boolean;
    availableAt: string;
    now: string;
  }): Promise<GenerationJob>;
  cancelGenerationJob(userId: string, jobId: string, now: string): Promise<GenerationJob>;
  acceptGenerationCandidate(input: {
    userId: string;
    jobId: string;
    candidateId: string;
    projectName: string;
  }): Promise<{ job: GenerationJob; project: ProjectDetail }>;
  acceptGenerationVariant(input: {
    userId: string;
    jobId: string;
    variantOrdinal: number;
    projects: Array<{
      outputSlot: GenerationCandidateOutputSlot;
      projectName: string;
    }>;
  }): Promise<{
    job: GenerationJob;
    variantOrdinal: number;
    outputs: Array<{
      candidateId: string;
      outputSlot: GenerationCandidateOutputSlot;
      project: ProjectDetail;
    }>;
  }>;

  executeIdempotent<T>(
    input: { userId: string; scope: string; key: string; requestHash: string },
    operation: (transactionStore: AppStore) => Promise<IdempotentOperationResult<T>>,
  ): Promise<IdempotentExecutionResult<T>>;
  executePaymentEffectIdempotent<T>(
    input: PaymentEffectFence,
    operation: (transactionStore: AppStore) => Promise<IdempotentOperationResult<T>>,
  ): Promise<IdempotentExecutionResult<T>>;
  getIdempotent<T>(input: {
    userId: string;
    scope: string;
    key: string;
    requestHash: string;
  }): Promise<IdempotentExecutionResult<T> | null>;
  claimPaymentEffect(input: {
    userId: string;
    scope: string;
    key: string;
    requestHash: string;
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<PaymentEffectClaimResult>;
  renewPaymentEffectClaim(input: {
    userId: string;
    scope: string;
    key: string;
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<boolean>;
  releasePaymentEffectClaim(input: {
    userId: string;
    scope: string;
    key: string;
    leaseToken: string;
    releasedAt: string;
  }): Promise<boolean>;
  completePaymentEffectClaim(input: {
    userId: string;
    scope: string;
    key: string;
    leaseToken: string;
  }): Promise<boolean>;

  createExportJob(input: {
    id: string;
    userId: string;
    projectId: string;
    projectRevision: number;
    format: ExportFormat;
    fileName: string;
    options: ExportOptions;
    now: string;
  }): Promise<ExportJobRecord>;
  listExportJobs(userId: string, limit: number, offset?: number): Promise<ExportJobRecord[]>;
  getExportJobStats(userId: string): Promise<ExportJobStats>;
  getExportJob(userId: string, exportJobId: string): Promise<ExportJobRecord | null>;
  claimNextExportJob(input: {
    now?: string;
    leaseToken: string;
    leaseMilliseconds: number;
  }): Promise<ExportJobRecord | null>;
  renewExportJobLease(input: {
    jobId: string;
    leaseToken: string;
    now?: string;
    leaseMilliseconds: number;
  }): Promise<boolean>;
  prepareExportArtifact(input: {
    jobId: string;
    leaseToken: string;
    artifact: ExportArtifactRecord;
    now: string;
  }): Promise<void>;
  completeExportJob(input: {
    jobId: string;
    leaseToken: string;
    artifact: ExportArtifactRecord;
    now: string;
  }): Promise<ExportJobRecord>;
  failExportJob(input: {
    jobId: string;
    leaseToken: string;
    code: string;
    message: string;
    retryable: boolean;
    availableAt: string;
    now: string;
  }): Promise<ExportJobRecord>;
  cancelExportJob(userId: string, exportJobId: string, now: string): Promise<ExportJobRecord>;
  listExportArtifactsForPurge(now: string, limit: number): Promise<ExportArtifactPurgeRecord[]>;
  claimExportArtifactForPurge(artifactId: string, now: string): Promise<ExportArtifactPurgeRecord | null>;
  recordExportArtifactPurgeFailure(artifactId: string, failedAt: string): Promise<void>;
  markExportArtifactPurged(artifactId: string, purgedAt: string): Promise<void>;

  listCreditProducts(): Promise<CreditProduct[]>;
  getCreditProduct(productId: string, version: number): Promise<CreditProduct | null>;
  reservePaymentOrderSlot(input: {
    userId: string;
    orderId: string;
    outTradeNo: string;
    expiresAt: string;
    now: string;
    effectFence: PaymentEffectFence;
  }): Promise<PaymentOrderSlotReservation>;
  releasePaymentOrderSlot(input: {
    userId: string;
    orderId: string;
    effectFence: PaymentEffectFence;
  }): Promise<boolean>;
  getPaymentOrderRecoveryAttempt(userId: string, orderId: string): Promise<PaymentOrderSlotReservation | null>;
  beginPaymentOrderProviderAttempt(input: {
    userId: string;
    orderId: string;
    outTradeNo: string;
    startedAt: string;
    effectFence: PaymentEffectFence;
  }): Promise<PaymentOrderSlotReservation>;
  recordPaymentOrderProviderResult(input: {
    userId: string;
    orderId: string;
    outTradeNo: string;
    recoveryCiphertext: string;
    providerReferenceSha256: string;
    recordedAt: string;
    effectFence: PaymentEffectFence;
  }): Promise<PaymentOrderSlotReservation>;
  rotatePaymentOrderProviderAttempt(input: {
    userId: string;
    orderId: string;
    previousOutTradeNo: string;
    nextOutTradeNo: string;
    expiresAt: string;
    rotatedAt: string;
    effectFence: PaymentEffectFence;
  }): Promise<PaymentOrderSlotReservation>;
  createPaymentOrder(input: {
    id: string;
    userId: string;
    product: CreditProduct;
    outTradeNo: string;
    providerReference: string;
    paymentExpiresAt: string;
    now: string;
  }): Promise<PaymentOrderRecord>;
  getPaymentOrder(userId: string, paymentOrderId: string): Promise<PaymentOrderRecord | null>;
  getPaymentOrderByOutTradeNo(outTradeNo: string): Promise<PaymentOrderRecord | null>;
  applyPaymentObservation(input: {
    orderId: string;
    userId: string;
    providerTradeState: "NOTPAY" | "CLOSED";
    observedAt: string;
    /** Required for reconciliation-worker writes; refresh observations omit it. */
    reconciliationLeaseToken?: string;
    /** Used only with a fenced NOTPAY observation. */
    nextReconciliationDelayMilliseconds?: number;
    reconciliationErrorCode?: string;
    reconciliationErrorMessage?: string;
  }): Promise<PaymentOrderRecord>;
  applyPaymentSuccess(input: {
    orderId: string;
    observedOutTradeNo: string;
    eventKey: string;
    providerTransactionId: string;
    providerTradeState: "SUCCESS";
    paidAt: string;
    observedAt: string;
    source: "fake" | "wechat-query" | "wechat-notify";
    notificationId?: string;
    rawBodySha256?: string;
    wechatSerial?: string;
  }): Promise<{ order: PaymentOrderRecord; account: CreditAccount; credited: boolean }>;
  getPaymentReconciliationJob(orderId: string): Promise<PaymentReconciliationJob | null>;
  claimNextPaymentReconciliation(input: {
    leaseToken: string;
    leaseMilliseconds: number;
    /** Test-only clock override for MemoryStore; PostgreSQL always uses its own clock. */
    now?: string;
  }): Promise<PaymentReconciliationClaim | null>;
  renewPaymentReconciliationLease(input: {
    orderId: string;
    leaseToken: string;
    leaseMilliseconds: number;
    /** Test-only clock override for MemoryStore; PostgreSQL always uses its own clock. */
    now?: string;
  }): Promise<boolean>;
  reschedulePaymentReconciliation(input: {
    orderId: string;
    leaseToken: string;
    providerTradeState?: PaymentReconciliationTradeState;
    errorCode?: string;
    errorMessage?: string;
    delayMilliseconds: number;
    /** Test-only clock override for MemoryStore; PostgreSQL always uses its own clock. */
    now?: string;
  }): Promise<boolean>;

  listInventory(userId: string, paletteId?: string): Promise<InventoryItem[]>;
  getInventoryStats(userId: string): Promise<{ colorCount: number; beadCount: number }>;
  setInventoryItem(input: {
    userId: string;
    paletteId: string;
    colorCode: string;
    quantity: number;
    location: string | null;
    baseRevision: number;
    now: string;
    idempotencyReference?: string;
  }): Promise<InventoryItem>;
  applyInventoryBatch(input: {
    userId: string;
    mode: "calibrate" | "delta";
    entries: InventoryBatchEntry[];
    idempotencyReference: string;
    now: string;
  }): Promise<InventoryMutationResult>;
  listInventoryOperations(input: {
    userId: string;
    projectId?: string;
    idempotencyReference?: string;
    limit: number;
    offset?: number;
  }): Promise<InventoryOperation[]>;
  listInventoryTransactions(input: {
    userId: string;
    paletteId?: string;
    projectId?: string;
    limit: number;
    offset?: number;
  }): Promise<InventoryTransaction[]>;
  consumeProjectInventory(input: {
    userId: string;
    projectId: string;
    projectRevision: number;
    idempotencyReference: string;
    now: string;
  }): Promise<ProjectInventoryConsumption>;

  consumeUserRateLimit(input: {
    userId: string;
    action: string;
    now: string;
    limit: number;
    windowMilliseconds: number;
  }): Promise<RateLimitResult>;
  consumeAuthRateLimit(input: {
    keyHash: string;
    action: string;
    now: string;
    limit: number;
    windowMilliseconds: number;
  }): Promise<RateLimitResult>;

  ensureUserInviteCode(userId: string, now: string): Promise<UserInviteCode>;
  getInviteSummary(userId: string): Promise<InviteSummary>;
  acceptInviteCode(input: {
    inviteeUserId: string;
    code: string;
    now: string;
    /** From the accepting session; missing/false fails closed to returning-user +1. */
    inviteeWasNewUser: boolean;
  }): Promise<InviteAcceptResult>;
}
