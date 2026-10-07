import { randomUUID } from "node:crypto";

import { AppError } from "../errors.js";
import { assertAssetConsentPolicySnapshot } from "../domain/asset-consent.js";
import { resolveBuildNavigationCursor } from "../domain/build-progress.js";
import { BUILTIN_CREDIT_PRODUCTS } from "../domain/credit-products.js";
import {
  copyDefaultGenerationOptions,
  deserializeGenerationOptions,
  generationOptionsEqual,
} from "../domain/generation-options.js";
import { assertGenerationCandidatesStructure, generationOutputSlots } from "../domain/generation-candidates.js";
import { BUILTIN_PALETTES, isPaletteSelectable } from "../domain/palettes.js";
import {
  INITIAL_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS,
  PAYMENT_RECONCILIATION_REPAIR_LIMIT,
  assertPaymentReconciliationDelayMilliseconds,
  assertPaymentReconciliationError,
} from "../domain/payment-reconciliation.js";
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
import {
  ASSET_PUBLISH_TIMEOUT_MILLISECONDS,
  ASSET_UPLOAD_LEASE_MILLISECONDS,
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
import { resolveInMemoryWorkerLeaseWindow } from "../domain/worker-lease.js";
import type {
  AssetConsentEvent,
  AssetRecord,
  AssetUploadReservation,
  AuthSession,
  BuildProgress,
  CreationDraft,
  CreditAccount,
  CreditLedgerEntry,
  CreditProduct,
  ExportArtifactRecord,
  ExportArtifactPurgeRecord,
  ExportJobRecord,
  PaymentOrderRecord,
  PaymentReconciliationJob,
  GenerationJob,
  GenerationCandidateOutputSlot,
  IdempotencyRecord,
  InventoryItem,
  InventoryMutationResult,
  InventoryOperation,
  InventoryTransaction,
  Palette,
  ProjectDetail,
  ProjectCompletionPhotoRecord,
  ProjectCompletionPhotoUploadReservation,
  ProjectDraft,
  ProjectListItem,
  ProjectInventoryConsumption,
  ProjectRevision,
  ProjectStatusStats,
  ProjectSummary,
  User,
} from "../domain/models.js";
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

interface ProjectRecord {
  summary: ProjectSummary;
  revisions: ProjectRevision[];
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function restoreMapSnapshot<K, V>(target: Map<K, V>): () => void {
  const snapshot = new Map([...target].map(([key, value]) => [key, copy(value)]));
  return () => {
    target.clear();
    for (const [key, value] of snapshot) target.set(key, value);
  };
}

const ACTIVE_GENERATION_STATUSES = new Set<GenerationJob["status"]>([
  "queued",
  "retry_wait",
  "preprocessing",
  "generating",
  "mapping_colors",
  "finalizing",
]);

export class MemoryStore implements AppStore {
  private readonly users = new Map<string, User>();
  private readonly wechatOpenIds = new Map<string, string>();
  private readonly wechatOpenIdByUser = new Map<string, string>();
  private readonly sessions = new Map<string, {
    userId: string;
    expiresAt: string;
    createdAt: string;
    createdNewUser: boolean;
  }>();
  private readonly webLoginChallenges = new Map<string, {
    code: string;
    sessionTokenHash: string;
    status: "pending" | "approved";
    userId: string | null;
    expiresAt: string;
  }>();
  private readonly palettes = new Map<string, Palette>(BUILTIN_PALETTES.map((palette) => [
    palette.id,
    copy({ ...palette, ownerUserId: null }),
  ]));
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly creationDrafts = new Map<string, CreationDraft>();
  private readonly projectDrafts = new Map<string, ProjectDraft>();
  private readonly deletedProjects = new Set<string>();
  private readonly progress = new Map<string, BuildProgress>();
  private readonly credits = new Map<string, CreditAccount>();
  private readonly ledger = new Map<string, CreditLedgerEntry[]>();
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly creditProducts = new Map(BUILTIN_CREDIT_PRODUCTS.map((product) => [`${product.id}:${product.version}`, copy(product)]));
  private readonly paymentOrders = new Map<string, PaymentOrderRecord>();
  private readonly paymentReconciliationJobs = new Map<string, PaymentReconciliationJob>();
  private readonly paymentOrderSlots = new Map<string, {
    userId: string;
    outTradeNo: string;
    expiresAt: string;
    attemptNo: number;
  }>();
  private readonly paymentOrderAttempts = new Map<string, {
    orderId: string;
    userId: string;
    outTradeNo: string;
    expiresAt: string;
    attemptNo: number;
    state: PaymentOrderSlotReservation["state"];
    recoveryCiphertext: string | null;
    providerReferenceSha256: string | null;
    createdAt: string;
    updatedAt: string;
  }>();
  private readonly paymentEvents = new Map<string, {
    orderId: string;
    outTradeNo: string;
    providerTransactionId: string;
    source: "fake" | "wechat-query" | "wechat-notify";
    rawBodySha256: string | null;
  }>();
  private readonly exportJobs = new Map<string, ExportJobRecord>();
  private readonly pendingExportArtifacts = new Map<string, {
    artifact: ExportArtifactRecord;
    userId: string;
    abandonedAt: string | null;
  }>();
  private readonly purgedExportArtifacts = new Set<string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly idempotencyLocks = new Map<string, Promise<void>>();
  private readonly paymentEffectLocks = new Map<string, Promise<void>>();
  private readonly paymentEffectClaims = new Map<string, {
    requestHash: string;
    leaseToken: string;
    leaseExpiresAt: string;
    createdAt: string;
    updatedAt: string;
  }>();
  private readonly assets = new Map<string, AssetRecord>();
  /** Keyed by asset id; entries are append-only audit snapshots. */
  private readonly assetConsentEvents = new Map<string, AssetConsentEvent>();
  private readonly assetUploads = new Map<string, {
    requestHash: string;
    assetId: string;
    uploadLeaseToken: string;
    uploadLeaseExpiresAt: string;
  }>();
  private readonly assetUploadLocks = new Map<string, Promise<void>>();
  private readonly completionPhotos = new Map<string, Omit<ProjectCompletionPhotoRecord, "asset">>();
  private readonly completionPhotoUploads = new Map<string, {
    requestHash: string;
    photoId: string;
    assetId: string;
    uploadLeaseToken: string;
    uploadLeaseExpiresAt: string;
  }>();
  private readonly completionPhotoUploadLocks = new Map<string, Promise<void>>();
  private readonly assetPurgeState = new Map<string, { attemptCount: number; availableAt: string }>();
  private readonly inventory = new Map<string, InventoryItem>();
  private readonly inventoryOperations = new Map<string, InventoryOperation>();
  private readonly inventoryTransactions: InventoryTransaction[] = [];
  private readonly inventoryOperationReferences = new Set<string>();
  private readonly inventoryConsumptions = new Map<string, { operationId: string; consumedAt: string }>();
  private readonly exportArtifactPurgeState = new Map<string, { attemptCount: number; availableAt: string }>();
  private readonly rateLimits = new Map<string, { windowStartedAt: string; requestCount: number }>();
  private readonly authRateLimits = new Map<string, { windowStartedAt: string; requestCount: number }>();
  private readonly userInviteCodes = new Map<string, import("../domain/models.js").UserInviteCode>();
  private readonly inviteCodeIndex = new Map<string, string>();
  private readonly inviteBindings = new Map<string, import("../domain/models.js").InviteBinding>();
  private readonly inviteRewardEntitlements = new Map<string, import("../domain/models.js").InviteRewardEntitlement>();
  private readonly paletteColorMigrationAudits: PaletteMigrationAuditInput[] = [];


  async ready(): Promise<void> {}
  async close(): Promise<void> {}

  private paymentEffectClaimKey(input: Pick<PaymentEffectFence, "userId" | "scope" | "key">): string {
    return `${input.userId}:${input.scope}:${input.key}`;
  }

  private async withPaymentEffectLock<T>(
    input: Pick<PaymentEffectFence, "userId" | "scope" | "key">,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockKey = this.paymentEffectClaimKey(input);
    const previous = this.paymentEffectLocks.get(lockKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.paymentEffectLocks.set(lockKey, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.paymentEffectLocks.get(lockKey) === tail) this.paymentEffectLocks.delete(lockKey);
    }
  }

  private assertActivePaymentEffectFence(fence: PaymentEffectFence): void {
    const claim = this.paymentEffectClaims.get(this.paymentEffectClaimKey(fence));
    if (!claim
      || claim.requestHash !== fence.requestHash
      || claim.leaseToken !== fence.leaseToken
      || Date.parse(claim.leaseExpiresAt) <= Date.now()) {
      throw new AppError(503, "PAYMENT_EFFECT_LEASE_LOST", "支付请求处理租约已失效，请重试", null, true);
    }
  }

  private completePaymentReconciliationJob(
    orderId: string,
    tradeState: PaymentReconciliationJob["lastObservedTradeState"],
    now: string,
  ): void {
    const job = this.paymentReconciliationJobs.get(orderId);
    if (!job) return;
    job.state = "completed";
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.lastObservedTradeState = tradeState;
    job.lastErrorCode = null;
    job.lastErrorMessage = null;
    job.completedAt ??= now;
    job.updatedAt = now;
  }

  private isAvailableProjectAsset(
    userId: string,
    assetId: string,
    purpose: AssetRecord["purpose"],
    now = Date.now(),
  ): boolean {
    const asset = this.assets.get(assetId);
    return asset?.userId === userId
      && asset.purpose === purpose
      && asset.readyAt !== null
      && asset.deletedAt === null
      && asset.purgedAt === null
      && (asset.expiresAt === null || Date.parse(asset.expiresAt) > now);
  }

  private requireAvailableProjectAsset(
    userId: string,
    assetId: string | null | undefined,
    purpose: AssetRecord["purpose"],
    field: "source" | "preview",
  ): void {
    if (assetId == null) return;
    if (!this.isAvailableProjectAsset(userId, assetId, purpose)) {
      const code = field === "source" ? "PROJECT_SOURCE_ASSET_NOT_FOUND" : "PROJECT_PREVIEW_ASSET_NOT_FOUND";
      const label = field === "source" ? "原始素材" : "预览素材";
      throw new AppError(404, code, `作品引用的${label}不存在、未就绪或已失效`);
    }
  }

  async createDevSession(input: {
    displayName: string;
    tokenHash: string;
    expiresAt: string;
    startingCredits: number;
  }): Promise<AuthSession> {
    const now = new Date().toISOString();
    const user: User = { id: randomUUID(), displayName: input.displayName, createdAt: now };
    this.users.set(user.id, user);
    this.sessions.set(input.tokenHash, {
      userId: user.id,
      expiresAt: input.expiresAt,
      createdAt: now,
      createdNewUser: true,
    });
    const account: CreditAccount = { userId: user.id, balance: input.startingCredits, updatedAt: now };
    this.credits.set(user.id, account);
    this.ledger.set(user.id, [{
      id: randomUUID(),
      userId: user.id,
      delta: input.startingCredits,
      balanceAfter: input.startingCredits,
      reason: "dev_welcome_credit",
      referenceId: null,
      createdAt: now,
    }]);
    return copy({ user, expiresAt: input.expiresAt, createdNewUser: true });
  }

  async createWechatSession(input: Parameters<AppStore["createWechatSession"]>[0]): Promise<AuthSession> {
    let userId = this.wechatOpenIds.get(input.openId);
    let user = userId ? this.users.get(userId) : undefined;
    let createdNewUser = false;
    if (!user) {
      const now = new Date().toISOString();
      const startingCredits = input.developmentStartingCredits ?? 0;
      user = { id: randomUUID(), displayName: input.displayName, createdAt: now };
      userId = user.id;
      createdNewUser = true;
      this.users.set(user.id, user);
      this.wechatOpenIds.set(input.openId, user.id);
      this.wechatOpenIdByUser.set(user.id, input.openId);
      this.credits.set(user.id, { userId: user.id, balance: startingCredits, updatedAt: now });
      this.ledger.set(user.id, startingCredits > 0 ? [{
        id: randomUUID(),
        userId: user.id,
        delta: startingCredits,
        balanceAfter: startingCredits,
        reason: "dev_welcome_credit",
        referenceId: null,
        createdAt: now,
      }] : []);
    }
    const now = new Date().toISOString();
    for (const [tokenHash, session] of this.sessions) {
      if (session.userId === user.id && Date.parse(session.expiresAt) <= Date.parse(now)) {
        this.sessions.delete(tokenHash);
      }
    }
    this.sessions.set(input.tokenHash, {
      userId: user.id,
      expiresAt: input.expiresAt,
      createdAt: now,
      createdNewUser,
    });
    const activeSessions = [...this.sessions.entries()]
      .filter(([, session]) => session.userId === user.id && Date.parse(session.expiresAt) > Date.parse(now))
      .sort(([leftToken, left], [rightToken, right]) =>
        Number(rightToken === input.tokenHash) - Number(leftToken === input.tokenHash)
        || right.createdAt.localeCompare(left.createdAt)
        || rightToken.localeCompare(leftToken));
    for (const [tokenHash] of activeSessions.slice(MAX_ACTIVE_SESSIONS_PER_USER)) {
      this.sessions.delete(tokenHash);
    }
    return copy({ user, expiresAt: input.expiresAt, createdNewUser });
  }

  async resolveSession(tokenHash: string): Promise<AuthSession | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
    const user = this.users.get(session.userId);
    return user
      ? copy({ user, expiresAt: session.expiresAt, createdNewUser: Boolean(session.createdNewUser) })
      : null;
  }

  async revokeSession(tokenHash: string): Promise<boolean> {
    return this.sessions.delete(tokenHash);
  }

  async getWechatOpenId(userId: string): Promise<string | null> {
    return this.wechatOpenIdByUser.get(userId) ?? null;
  }

  async createWebLoginChallenge(input: Parameters<AppStore["createWebLoginChallenge"]>[0]): Promise<void> {
    for (const [tokenHash, item] of this.webLoginChallenges.entries()) {
      if (Date.parse(item.expiresAt) <= Date.now()) this.webLoginChallenges.delete(tokenHash);
    }
    const collision = input.tokenHash === input.sessionTokenHash
      || this.webLoginChallenges.has(input.tokenHash)
      || [...this.webLoginChallenges.values()].some((item) =>
        (item.code === input.code || item.sessionTokenHash === input.sessionTokenHash)
        && Date.parse(item.expiresAt) > Date.now());
    if (collision) {
      throw new AppError(409, "WEB_LOGIN_CODE_COLLISION", "登录码冲突，请重试");
    }
    this.webLoginChallenges.set(input.tokenHash, {
      code: input.code,
      sessionTokenHash: input.sessionTokenHash,
      status: "pending",
      userId: null,
      expiresAt: input.expiresAt,
    });
  }

  async getWebLoginChallenge(tokenHash: string): Promise<{ status: "pending" | "approved" | "expired"; expiresAt: string } | null> {
    const challenge = this.webLoginChallenges.get(tokenHash);
    if (!challenge) return null;
    return { status: Date.parse(challenge.expiresAt) <= Date.now() ? "expired" : challenge.status, expiresAt: challenge.expiresAt };
  }

  async confirmWebLoginChallenge(input: Parameters<AppStore["confirmWebLoginChallenge"]>[0]): Promise<boolean> {
    if (!this.users.has(input.userId)) return false;
    const entry = [...this.webLoginChallenges.entries()].find(([, item]) => item.code === input.code && item.status === "pending" && Date.parse(item.expiresAt) > Date.now());
    if (!entry) return false;
    const [tokenHash, challenge] = entry;
    challenge.status = "approved";
    challenge.userId = input.userId;
    const now = new Date().toISOString();
    for (const [existingToken, session] of this.sessions) {
      if (session.userId === input.userId && Date.parse(session.expiresAt) <= Date.parse(now)) {
        this.sessions.delete(existingToken);
      }
    }
    this.sessions.set(challenge.sessionTokenHash, {
      userId: input.userId,
      expiresAt: input.sessionExpiresAt,
      createdAt: now,
      createdNewUser: false,
    });
    if (input.createPollTokenSession) {
      this.sessions.set(tokenHash, {
        userId: input.userId,
        expiresAt: input.sessionExpiresAt,
        createdAt: now,
        createdNewUser: false,
      });
    }
    const newTokenPriority = new Map<string, number>([
      [challenge.sessionTokenHash, 2],
      ...(input.createPollTokenSession ? [[tokenHash, 1] as const] : []),
    ]);
    const activeSessions = [...this.sessions.entries()]
      .filter(([, session]) => session.userId === input.userId && Date.parse(session.expiresAt) > Date.now())
      .sort(([leftToken, left], [rightToken, right]) =>
        (newTokenPriority.get(rightToken) ?? 0) - (newTokenPriority.get(leftToken) ?? 0)
        || right.createdAt.localeCompare(left.createdAt)
        || rightToken.localeCompare(leftToken));
    for (const [oldToken] of activeSessions.slice(MAX_ACTIVE_SESSIONS_PER_USER)) this.sessions.delete(oldToken);
    return true;
  }

  async getCreationDraft(userId: string): Promise<CreationDraft | null> {
    const draft = this.creationDrafts.get(userId);
    return draft ? copy(draft) : null;
  }

  async saveCreationDraft(input: SaveCreationDraftInput): Promise<CreationDraft> {
    this.requireSelectablePalette(input.paletteId, input.userId);
    const existing = this.creationDrafts.get(input.userId);
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
        currentDraftRevision: existing.draftRevision,
      });
    } else if (input.baseDraftRevision !== existing.draftRevision) {
      throw new AppError(409, "CREATION_DRAFT_REVISION_CONFLICT", "创建草稿已在其他设备更新", {
        currentDraftId: existing.id,
        currentDraftRevision: existing.draftRevision,
      });
    }
    if (input.sourceAssetId !== null) {
      if (!this.isAvailableProjectAsset(input.userId, input.sourceAssetId, "ai-source")) {
        throw new AppError(404, "CREATION_DRAFT_SOURCE_ASSET_NOT_FOUND", "创建草稿引用的原始素材不存在");
      }
    }
    const now = new Date().toISOString();
    const draft: CreationDraft = {
      id: existing?.id ?? randomUUID(),
      draftRevision: (existing?.draftRevision ?? 0) + 1,
      name: input.name,
      kind: input.kind,
      setupStep: input.setupStep,
      paletteId: input.paletteId,
      sourceAssetId: input.sourceAssetId,
      width: input.width,
      height: input.height,
      options: deserializeGenerationOptions(input.options),
      grid: input.grid ? copy(input.grid) : null,
      updatedAt: now,
    };
    this.creationDrafts.set(input.userId, draft);
    return copy(draft);
  }

  async commitCreationDraft(
    input: Parameters<AppStore["commitCreationDraft"]>[0],
  ): Promise<ProjectDetail> {
    const draft = this.creationDrafts.get(input.userId);
    if (!draft) throw new AppError(404, "CREATION_DRAFT_NOT_FOUND", "创建草稿不存在");
    if (draft.id !== input.draftId) {
      throw new AppError(409, "CREATION_DRAFT_ID_CONFLICT", "另一个创建流程已替换当前草稿", {
        currentDraftId: draft.id,
        currentDraftRevision: draft.draftRevision,
      });
    }
    if (draft.draftRevision !== input.draftRevision) {
      throw new AppError(409, "CREATION_DRAFT_REVISION_CONFLICT", "创建草稿已在其他设备更新", {
        currentDraftId: draft.id,
        currentDraftRevision: draft.draftRevision,
      });
    }
    if (!draft.grid) {
      throw new AppError(409, "CREATION_DRAFT_NOT_READY", "创建草稿尚未生成可提交的图纸");
    }
    const project = this.createProjectNow(input.userId, {
      name: draft.name,
      paletteId: draft.paletteId,
      grid: draft.grid,
      mode: draft.kind,
      lifecycleStatus: "editable",
      sourceAssetId: draft.sourceAssetId
        && this.isAvailableProjectAsset(input.userId, draft.sourceAssetId, "ai-source")
        ? draft.sourceAssetId
        : null,
      previewAssetId: null,
      backgroundMode: draft.options.transparentBackground ? "transparent" : "white",
      backgroundColor: null,
    });
    this.creationDrafts.delete(input.userId);
    return project;
  }

  async discardCreationDraft(
    input: Parameters<AppStore["discardCreationDraft"]>[0],
  ): Promise<boolean> {
    const draft = this.creationDrafts.get(input.userId);
    if (!draft) return false;
    if (draft.id !== input.draftId) {
      throw new AppError(409, "CREATION_DRAFT_ID_CONFLICT", "另一个创建流程已替换当前草稿", {
        currentDraftId: draft.id,
        currentDraftRevision: draft.draftRevision,
      });
    }
    if (draft.draftRevision !== input.draftRevision) {
      throw new AppError(409, "CREATION_DRAFT_REVISION_CONFLICT", "创建草稿已在其他设备更新", {
        currentDraftId: draft.id,
        currentDraftRevision: draft.draftRevision,
      });
    }
    this.creationDrafts.delete(input.userId);
    return true;
  }

  async createAsset(input: CreateAssetInput): Promise<AssetRecord> {
    const completionAsset = input.purpose === "project-completion";
    if (completionAsset
      ? input.consentVersion !== null || input.expiresAt !== null
      : input.consentVersion === null || input.expiresAt === null) {
      throw new AppError(400, "ASSET_LIFECYCLE_INVALID", "素材用途与隐私同意、保留期限不匹配");
    }
    const historyCutoff = Date.parse(input.createdAt) - OPERATIONAL_HISTORY_RETENTION_MILLISECONDS;
    for (const [assetId, asset] of this.assets) {
      if (asset.userId !== input.userId || asset.purgedAt === null
        || Date.parse(asset.purgedAt) >= historyCutoff) continue;
      const referenced = [...this.jobs.values()].some((job) => job.sourceAssetId === assetId);
      if (!referenced) {
        this.assets.delete(assetId);
        for (const [photoId, photo] of this.completionPhotos) {
          if (photo.assetId === assetId) this.completionPhotos.delete(photoId);
        }
        for (const [reservationKey, reservation] of this.completionPhotoUploads) {
          if (reservation.assetId === assetId) this.completionPhotoUploads.delete(reservationKey);
        }
        for (const [reservationKey, reservation] of this.assetUploads) {
          if (reservation.assetId === assetId) this.assetUploads.delete(reservationKey);
        }
      }
    }
    const historyCount = [...this.assets.values()].filter((asset) => asset.userId === input.userId).length;
    if (historyCount >= MAX_ASSET_HISTORY_PER_USER) {
      throw new AppError(429, "ASSET_HISTORY_LIMIT_EXCEEDED", "素材历史记录已达到上限", {
        limit: MAX_ASSET_HISTORY_PER_USER,
        retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
      });
    }
    const activeAssets = [...this.assets.values()].filter((asset) =>
      asset.userId === input.userId
      && asset.purgedAt === null
      && (completionAsset
        ? asset.purpose === "project-completion"
        : asset.purpose !== "project-completion"));
    const activeBytes = activeAssets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
    const maxAssetCount = completionAsset
      ? MAX_ACTIVE_COMPLETION_PHOTOS_PER_USER
      : MAX_ACTIVE_ASSETS_PER_USER;
    const maxTotalBytes = completionAsset
      ? MAX_ACTIVE_COMPLETION_PHOTO_BYTES_PER_USER
      : MAX_ACTIVE_ASSET_BYTES_PER_USER;
    if (activeAssets.length >= maxAssetCount || activeBytes + input.sizeBytes > maxTotalBytes) {
      throw new AppError(429, completionAsset ? "COMPLETION_PHOTO_STORAGE_LIMIT_EXCEEDED" : "ASSET_QUOTA_EXCEEDED", completionAsset
        ? "完工照片私有空间已达到上限"
        : "私有素材空间已达到上限", {
        maxAssetCount,
        maxTotalBytes,
      });
    }
    const asset: AssetRecord = {
      ...input,
      readyAt: null,
      deletedAt: null,
      purgedAt: null,
    };
    this.assets.set(asset.id, copy(asset));
    return copy(asset);
  }

  async markAssetReady(userId: string, assetId: string, readyAt: string): Promise<AssetRecord | null> {
    const asset = this.assets.get(assetId);
    if (!asset || asset.userId !== userId || asset.deletedAt !== null || asset.purgedAt !== null
      || (asset.expiresAt !== null && Date.parse(asset.expiresAt) <= Date.parse(readyAt))) return null;
    asset.readyAt ??= readyAt;
    return copy(asset);
  }

  async reserveAssetUpload(
    input: Parameters<AppStore["reserveAssetUpload"]>[0],
  ): Promise<AssetUploadReservation> {
    const acquiredAtMillis = Date.parse(input.uploadLeaseAcquiredAt);
    if (input.asset.userId !== input.userId || input.asset.purpose === "project-completion"
      || input.asset.consentVersion === null || input.asset.expiresAt === null
      || input.scope.length < 1 || input.scope.length > 100
      || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128
      || !/^[0-9a-f]{64}$/.test(input.requestHash)
      || !input.uploadLeaseToken || !Number.isFinite(acquiredAtMillis)) {
      throw new AppError(400, "ASSET_UPLOAD_RESERVATION_INVALID", "素材上传预约参数无效");
    }
    const requestedLeaseExpiresAt = new Date(
      acquiredAtMillis + ASSET_UPLOAD_LEASE_MILLISECONDS,
    ).toISOString();
    const previous = this.assetUploadLocks.get(input.userId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.assetUploadLocks.set(input.userId, tail);
    await previous;
    try {
      const reservationKey = JSON.stringify([input.userId, input.scope, input.idempotencyKey]);
      const existing = this.assetUploads.get(reservationKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
        }
        const asset = this.assets.get(existing.assetId);
        if (!asset || asset.userId !== input.userId || asset.deletedAt !== null || asset.purgedAt !== null
          || (asset.expiresAt !== null && Date.parse(asset.expiresAt) <= acquiredAtMillis)) {
          throw new AppError(410, "ASSET_UPLOAD_UNAVAILABLE", "该素材上传已删除或超时，请使用新的幂等键重试");
        }
        if (asset.readyAt === null) {
          const existingLeaseIsActive = Date.parse(existing.uploadLeaseExpiresAt) > acquiredAtMillis;
          if (!existingLeaseIsActive) existing.uploadLeaseToken = input.uploadLeaseToken;
          if (Date.parse(requestedLeaseExpiresAt) > Date.parse(existing.uploadLeaseExpiresAt)) {
            existing.uploadLeaseExpiresAt = requestedLeaseExpiresAt;
          }
          const purgeState = this.assetPurgeState.get(asset.id) ?? {
            attemptCount: 0,
            availableAt: asset.createdAt,
          };
          if (Date.parse(existing.uploadLeaseExpiresAt) > Date.parse(purgeState.availableAt)) {
            this.assetPurgeState.set(asset.id, {
              ...purgeState,
              availableAt: existing.uploadLeaseExpiresAt,
            });
          }
        }
        return {
          asset: copy(asset),
          replayed: true,
          uploadLeaseToken: existing.uploadLeaseToken,
          uploadLeaseExpiresAt: existing.uploadLeaseExpiresAt,
        };
      }

      const rateLimitKey = `${input.userId}:${USER_RATE_LIMITS.assetUpload.action}`;
      const currentRateLimit = this.rateLimits.get(rateLimitKey);
      const previousRateLimit = currentRateLimit ? { ...currentRateLimit } : undefined;
      const rateLimit = await this.consumeUserRateLimit({
        userId: input.userId,
        ...USER_RATE_LIMITS.assetUpload,
        now: input.uploadLeaseAcquiredAt,
      });
      if (!rateLimit.allowed) {
        throw new AppError(429, "USER_RATE_LIMITED", "请求过于频繁，请稍后重试", {
          retryAfterMilliseconds: rateLimit.retryAfterMilliseconds,
        });
      }
      let asset: AssetRecord;
      try {
        asset = await this.createAsset(input.asset);
      } catch (error) {
        if (previousRateLimit) this.rateLimits.set(rateLimitKey, { ...previousRateLimit });
        else this.rateLimits.delete(rateLimitKey);
        throw error;
      }
      this.assetUploads.set(reservationKey, {
        requestHash: input.requestHash,
        assetId: asset.id,
        uploadLeaseToken: input.uploadLeaseToken,
        uploadLeaseExpiresAt: requestedLeaseExpiresAt,
      });
      this.assetPurgeState.set(asset.id, {
        attemptCount: 0,
        availableAt: requestedLeaseExpiresAt,
      });
      return {
        asset,
        replayed: false,
        uploadLeaseToken: input.uploadLeaseToken,
        uploadLeaseExpiresAt: requestedLeaseExpiresAt,
      };
    } finally {
      release();
      if (this.assetUploadLocks.get(input.userId) === tail) this.assetUploadLocks.delete(input.userId);
    }
  }

  async publishAssetUpload(
    input: Parameters<AppStore["publishAssetUpload"]>[0],
  ): Promise<AssetRecord> {
    const previous = this.assetUploadLocks.get(input.userId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.assetUploadLocks.set(input.userId, tail);
    await previous;
    try {
      const reservationKey = JSON.stringify([input.userId, input.scope, input.idempotencyKey]);
      const reservation = this.assetUploads.get(reservationKey);
      const asset = reservation ? this.assets.get(reservation.assetId) : undefined;
      if (!reservation || reservation.assetId !== input.assetId || !asset || asset.userId !== input.userId
        || asset.deletedAt !== null || asset.purgedAt !== null
        || (asset.expiresAt !== null && Date.parse(asset.expiresAt) <= Date.parse(input.readyAt))) {
        throw new AppError(410, "ASSET_UPLOAD_UNAVAILABLE", "素材上传已删除或超时");
      }
      if (reservation.uploadLeaseToken !== input.uploadLeaseToken) {
        throw new AppError(409, "ASSET_UPLOAD_LEASE_LOST", "素材上传租约已过期或被接管，请重试", undefined, true);
      }
      if (asset.readyAt === null && Date.parse(reservation.uploadLeaseExpiresAt) <= Date.parse(input.readyAt)) {
        throw new AppError(409, "ASSET_UPLOAD_LEASE_LOST", "素材上传租约已过期或被接管，请重试", undefined, true);
      }
      if (asset.purpose === "project-completion" || asset.consentVersion === null) {
        throw new AppError(500, "ASSET_CONSENT_EVENT_INVALID", "AI 素材同意审计数据无效");
      }
      assertAssetConsentPolicySnapshot(asset.consentVersion, input.consentPolicy);
      const consentEvent: AssetConsentEvent = {
        id: randomUUID(),
        userId: asset.userId,
        assetId: asset.id,
        consentVersion: asset.consentVersion,
        assetPurpose: asset.purpose,
        ...input.consentPolicy,
        source: "asset-upload",
        occurredAt: asset.createdAt,
        recordedAt: asset.readyAt ?? input.readyAt,
      };
      const existingEvent = this.assetConsentEvents.get(asset.id);
      if (existingEvent) {
        const sameSnapshot = existingEvent.userId === consentEvent.userId
          && existingEvent.consentVersion === consentEvent.consentVersion
          && existingEvent.assetPurpose === consentEvent.assetPurpose
          && existingEvent.policySha256 === consentEvent.policySha256
          && existingEvent.processor === consentEvent.processor
          && existingEvent.processingPurpose === consentEvent.processingPurpose
          && existingEvent.retention === consentEvent.retention;
        if (!sameSnapshot) {
          throw new AppError(409, "ASSET_CONSENT_EVENT_CONFLICT", "素材已绑定不同的同意政策快照");
        }
        return copy(asset);
      }
      // No await occurs between the two mutations: MemoryStore exposes the
      // same publish-or-neither behavior as the PostgreSQL transaction.
      asset.readyAt ??= input.readyAt;
      this.assetConsentEvents.set(asset.id, consentEvent);
      return copy(asset);
    } finally {
      release();
      if (this.assetUploadLocks.get(input.userId) === tail) this.assetUploadLocks.delete(input.userId);
    }
  }

  async listAssetConsentEvents(
    input: Parameters<AppStore["listAssetConsentEvents"]>[0],
  ): Promise<AssetConsentEvent[]> {
    return copy([...this.assetConsentEvents.values()]
      .filter((event) => event.userId === input.userId)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id))
      .slice(input.offset, input.offset + input.limit));
  }

  async getAsset(userId: string, assetId: string): Promise<AssetRecord | null> {
    const asset = this.assets.get(assetId);
    return asset?.userId === userId ? copy(asset) : null;
  }

  async listAssets(input: Parameters<AppStore["listAssets"]>[0]): Promise<AssetRecord[]> {
    const nowMillis = Date.parse(input.now);
    return copy([...this.assets.values()]
      .filter((asset) => asset.userId === input.userId)
      .filter((asset) => input.purpose === undefined || asset.purpose === input.purpose)
      .filter((asset) => input.purposes === undefined || input.purposes.includes(asset.purpose))
      .filter((asset) => asset.readyAt !== null
        ? input.includeDeleted || (asset.deletedAt === null && asset.purgedAt === null
          && (asset.expiresAt === null || Date.parse(asset.expiresAt) > nowMillis))
        : input.includeDeleted && asset.deletedAt !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(input.offset ?? 0, (input.offset ?? 0) + input.limit));
  }

  async markAssetDeleted(userId: string, assetId: string, deletedAt: string): Promise<AssetRecord | null> {
    const asset = this.assets.get(assetId);
    if (!asset || asset.userId !== userId) return null;
    asset.deletedAt ??= deletedAt;
    for (const photo of this.completionPhotos.values()) {
      if (photo.assetId === assetId) photo.deletedAt ??= deletedAt;
    }
    for (const record of this.projects.values()) {
      if (record.summary.userId !== userId) continue;
      let changed = false;
      if (record.summary.sourceAssetId === assetId) {
        record.summary.sourceAssetId = null;
        changed = true;
      }
      if (record.summary.previewAssetId === assetId) {
        record.summary.previewAssetId = null;
        changed = true;
      }
      if (changed) {
        record.summary.metadataRevision += 1;
        record.summary.updatedAt = deletedAt;
      }
    }
    for (const job of this.jobs.values()) {
      const cancelable = [
        "queued",
        "retry_wait",
        "preprocessing",
        "generating",
        "mapping_colors",
        "finalizing",
      ].includes(job.status);
      if (job.userId !== userId || job.sourceAssetId !== assetId || !cancelable) continue;
      job.status = "canceled";
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.updatedAt = deletedAt;
      job.canceledAt = deletedAt;
      this.releaseGenerationCredits(job, deletedAt);
    }
    return copy(asset);
  }

  async listAssetsForPurge(now: string, limit: number): Promise<AssetRecord[]> {
    const nowMillis = Date.parse(now);
    const stalePendingBefore = nowMillis - ASSET_PUBLISH_TIMEOUT_MILLISECONDS;
    const purgePriority = (asset: AssetRecord): [number, string] => {
      if (asset.deletedAt !== null) return [0, asset.deletedAt];
      if (asset.readyAt === null && Date.parse(asset.createdAt) <= stalePendingBefore) {
        return [1, asset.createdAt];
      }
      return [2, asset.expiresAt ?? asset.createdAt];
    };
    return copy([...this.assets.values()]
      .filter((asset) => Date.parse(this.assetPurgeState.get(asset.id)?.availableAt ?? asset.createdAt) <= nowMillis)
      .filter((asset) => !this.hasActiveAssetUploadLease(asset.id, nowMillis))
      .filter((asset) => asset.purgedAt === null && (
        asset.deletedAt !== null
        || (asset.expiresAt !== null && Date.parse(asset.expiresAt) <= nowMillis)
        || (asset.readyAt === null && Date.parse(asset.createdAt) <= stalePendingBefore)
      ))
      .sort((left, right) => {
        const [leftPriority, leftAt] = purgePriority(left);
        const [rightPriority, rightAt] = purgePriority(right);
        return leftPriority - rightPriority || leftAt.localeCompare(rightAt) || left.id.localeCompare(right.id);
      })
      .slice(0, limit));
  }

  async claimAssetForPurge(userId: string, assetId: string, now: string): Promise<AssetRecord | null> {
    const asset = this.assets.get(assetId);
    const nowMillis = Date.parse(now);
    const stalePendingBefore = nowMillis - ASSET_PUBLISH_TIMEOUT_MILLISECONDS;
    const purgeState = asset ? this.assetPurgeState.get(asset.id) : undefined;
    const eligible = asset?.userId === userId && asset.purgedAt === null
      && !this.hasActiveAssetUploadLease(assetId, nowMillis) && (
      asset.deletedAt !== null
      || (asset.expiresAt !== null && Date.parse(asset.expiresAt) <= nowMillis)
      || (asset.readyAt === null && Date.parse(asset.createdAt) <= stalePendingBefore)
    ) && Date.parse(purgeState?.availableAt ?? asset.createdAt) <= nowMillis;
    if (!eligible) return null;
    const deleted = await this.markAssetDeleted(userId, assetId, now);
    if (deleted) {
      this.assetPurgeState.set(assetId, {
        attemptCount: purgeState?.attemptCount ?? 0,
        availableAt: new Date(nowMillis + PURGE_CLAIM_MILLISECONDS).toISOString(),
      });
    }
    return deleted;
  }

  async recordAssetPurgeFailure(assetId: string, failedAt: string): Promise<void> {
    const asset = this.assets.get(assetId);
    if (!asset) return;
    // A late upload may recreate an object after another worker observed the
    // key as absent and marked it purged. A failed cleanup makes object state
    // uncertain again, so reopen the tombstone for a tracked retry.
    asset.deletedAt ??= failedAt;
    asset.purgedAt = null;
    const current = this.assetPurgeState.get(assetId) ?? { attemptCount: 0, availableAt: failedAt };
    const retryDelay = Math.min(
      PURGE_RETRY_MAX_MILLISECONDS,
      PURGE_RETRY_BASE_MILLISECONDS * (2 ** Math.min(current.attemptCount, 16)),
    );
    this.assetPurgeState.set(assetId, {
      attemptCount: current.attemptCount + 1,
      availableAt: new Date(Date.parse(failedAt) + retryDelay).toISOString(),
    });
  }

  async markAssetPurged(assetId: string, purgedAt: string): Promise<void> {
    const asset = this.assets.get(assetId);
    if (!asset) return;
    if (this.hasActiveAssetUploadLease(assetId, Date.parse(purgedAt))) return;
    asset.deletedAt ??= purgedAt;
    asset.purgedAt ??= purgedAt;
    for (const photo of this.completionPhotos.values()) {
      if (photo.assetId === assetId) photo.deletedAt ??= purgedAt;
    }
    for (const record of this.projects.values()) {
      if (record.summary.userId !== asset.userId) continue;
      let changed = false;
      if (record.summary.sourceAssetId === assetId) {
        record.summary.sourceAssetId = null;
        changed = true;
      }
      if (record.summary.previewAssetId === assetId) {
        record.summary.previewAssetId = null;
        changed = true;
      }
      if (changed) {
        record.summary.metadataRevision += 1;
        record.summary.updatedAt = purgedAt;
      }
    }
    this.assetPurgeState.delete(assetId);
  }

  async listPalettes(userId: string): Promise<Palette[]> {
    const builtinOrder = new Map(BUILTIN_PALETTES.map((palette, index) => [palette.id, index]));
    return copy([...this.palettes.values()]
      .filter((palette) =>
        (!palette.ownerUserId || palette.ownerUserId === userId) && palette.retired !== true)
      .sort((left, right) => {
        const leftOrder = builtinOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = builtinOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.id.localeCompare(right.id);
      }));
  }

  async getPalette(paletteId: string, userId: string): Promise<Palette | null> {
    const palette = this.palettes.get(paletteId);
    return palette && (!palette.ownerUserId || palette.ownerUserId === userId) ? copy(palette) : null;
  }

  private requireSelectablePalette(
    paletteId: string,
    userId: string,
    notFoundCode: "PALETTE_NOT_FOUND" | "PALETTE_COLOR_NOT_FOUND" = "PALETTE_NOT_FOUND",
  ): Palette {
    const palette = this.palettes.get(paletteId);
    if (!palette || (palette.ownerUserId && palette.ownerUserId !== userId)) {
      throw new AppError(
        404,
        notFoundCode,
        notFoundCode === "PALETTE_COLOR_NOT_FOUND" ? "色卡或色号不存在" : "色卡不存在",
      );
    }
    if (!isPaletteSelectable(palette)) {
      throw new AppError(409, "PALETTE_RETIRED", "该色卡已停用，请先迁移到当前可用的 MARD 非官方参考色卡");
    }
    return palette;
  }

  async createPalette(userId: string, palette: Palette): Promise<Palette> {
    return this.createPaletteNow(userId, palette);
  }

  private createPaletteNow(userId: string, palette: Palette): Palette {
    if (this.palettes.has(palette.id)) throw new AppError(409, "PALETTE_EXISTS", "色卡标识已存在");
    const ownedPalettes = [...this.palettes.values()].filter((candidate) => candidate.ownerUserId === userId);
    if (ownedPalettes.length >= MAX_CUSTOM_PALETTES_PER_USER) {
      throw new AppError(429, "CUSTOM_PALETTE_LIMIT_EXCEEDED", "自定义色卡数量已达到上限", {
        limit: MAX_CUSTOM_PALETTES_PER_USER,
      });
    }
    const ownedColorCount = ownedPalettes.reduce((sum, candidate) => sum + candidate.colors.length, 0);
    if (ownedColorCount + palette.colors.length > MAX_CUSTOM_PALETTE_COLORS_PER_USER) {
      throw new AppError(429, "CUSTOM_PALETTE_COLOR_LIMIT_EXCEEDED", "自定义色卡颜色总数已达到上限", {
        limit: MAX_CUSTOM_PALETTE_COLORS_PER_USER,
      });
    }
    const owned: Palette = {
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
    this.palettes.set(owned.id, copy(owned));
    return copy(owned);
  }

  async createProject(userId: string, input: CreateProjectInput): Promise<ProjectDetail> {
    return this.createProjectNow(userId, input);
  }

  private createProjectNow(userId: string, input: CreateProjectInput): ProjectDetail {
    this.requireSelectablePalette(input.paletteId, userId);
    const now = new Date().toISOString();
    const historyCutoff = Date.parse(now) - OPERATIONAL_HISTORY_RETENTION_MILLISECONDS;
    for (const [projectId, record] of this.projects) {
      if (record.summary.userId !== userId
        || !this.deletedProjects.has(projectId)
        || Date.parse(record.summary.updatedAt) >= historyCutoff) continue;
      const hasRetainedExport = [...this.exportJobs.values()].some((job) =>
        job.projectId === projectId && (
          ["queued", "running", "retry_wait"].includes(job.status)
          || (job.artifact !== null && !this.purgedExportArtifacts.has(job.artifact.id))
          || [...this.pendingExportArtifacts.values()].some((pending) =>
            pending.artifact.jobId === job.id && !this.purgedExportArtifacts.has(pending.artifact.id))
        ));
      if (hasRetainedExport) continue;
      this.projects.delete(projectId);
      this.deletedProjects.delete(projectId);
      this.projectDrafts.delete(projectId);
      this.progress.delete(projectId);
      const removedPhotoIds = new Set<string>();
      for (const [photoId, photo] of this.completionPhotos) {
        if (photo.projectId !== projectId) continue;
        const asset = this.assets.get(photo.assetId);
        if (asset) asset.deletedAt ??= now;
        removedPhotoIds.add(photoId);
        this.completionPhotos.delete(photoId);
      }
      for (const [reservationKey, reservation] of this.completionPhotoUploads) {
        if (removedPhotoIds.has(reservation.photoId)) this.completionPhotoUploads.delete(reservationKey);
      }
      for (const generationJob of this.jobs.values()) {
        for (const candidate of generationJob.candidates) {
          if (candidate.acceptedProjectId === projectId) delete candidate.acceptedProjectId;
        }
      }
      for (const [jobId, job] of this.exportJobs) {
        if (job.projectId === projectId) this.exportJobs.delete(jobId);
      }
    }
    const activeProjectCount = [...this.projects.values()].filter((record) =>
      record.summary.userId === userId && !this.deletedProjects.has(record.summary.id)).length;
    if (activeProjectCount >= MAX_ACTIVE_PROJECTS_PER_USER) {
      throw new AppError(429, "PROJECT_LIMIT_EXCEEDED", "活动作品数量已达到上限", {
        limit: MAX_ACTIVE_PROJECTS_PER_USER,
      });
    }
    const historyProjects = [...this.projects.values()].filter((record) => record.summary.userId === userId);
    if (historyProjects.length >= MAX_PROJECT_HISTORY_PER_USER) {
      throw new AppError(429, "PROJECT_HISTORY_LIMIT_EXCEEDED", "作品历史记录已达到上限", {
        limit: MAX_PROJECT_HISTORY_PER_USER,
        retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
      });
    }
    const retainedCells = historyProjects.reduce((sum, record) => sum + record.revisions.reduce(
      (revisionSum, revision) => revisionSum + revision.grid.cells.length,
      0,
    ), 0);
    if (retainedCells + input.grid.cells.length > MAX_PROJECT_REVISION_CELLS_PER_USER) {
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
    this.requireAvailableProjectAsset(userId, input.sourceAssetId, "ai-source", "source");
    this.requireAvailableProjectAsset(userId, input.previewAssetId, "ai-intermediate", "preview");
    const background = normalizeProjectBackground(
      input.backgroundMode ?? "white",
      input.backgroundColor ?? null,
    );
    const id = randomUUID();
    const summary: ProjectSummary = {
      id,
      userId,
      name: input.name,
      mode,
      lifecycleStatus,
      metadataRevision: 1,
      tags,
      deviceSource,
      sourceAssetId: input.sourceAssetId ?? null,
      previewAssetId: input.previewAssetId ?? null,
      paletteId: input.paletteId,
      ...background,
      currentRevision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const revision: ProjectRevision = {
      projectId: id,
      revision: 1,
      paletteId: input.paletteId,
      grid: copy(input.grid),
      deviceSource,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(id, { summary, revisions: [revision] });
    return copy({
      ...summary,
      grid: revision.grid,
      revisionDeviceSource: revision.deviceSource,
      revisionUpdatedAt: revision.updatedAt,
    });
  }

  async copyProject(input: Parameters<AppStore["copyProject"]>[0]): Promise<ProjectDetail | null> {
    const source = await this.getProject(input.userId, input.projectId, input.revision);
    if (!source) return null;
    let sourceAssetId = source.sourceAssetId
      && this.isAvailableProjectAsset(input.userId, source.sourceAssetId, "ai-source")
      ? source.sourceAssetId
      : null;
    let previewAssetId = source.previewAssetId
      && this.isAvailableProjectAsset(input.userId, source.previewAssetId, "ai-intermediate")
      ? source.previewAssetId
      : null;

    for (;;) {
      try {
        const copied = this.createProjectNow(input.userId, {
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
  }

  private projectListItem(record: ProjectRecord): ProjectListItem {
    const revision = record.revisions.find((item) => item.revision === record.summary.currentRevision);
    if (!revision) throw new AppError(500, "PROJECT_REVISION_CORRUPTED", "项目当前版本不存在");
    const beadCount = revision.grid.cells.filter((color) => color !== null).length;
    const colorCount = new Set(revision.grid.cells.filter((color): color is string => color !== null)).size;
    const progress = this.progress.get(record.summary.id);
    const progressStarted = progress?.projectRevision === record.summary.currentRevision;
    const completedBeadCount = progressStarted
      ? new Set(progress!.completedIndices.filter((index) => revision.grid.cells[index] !== null)).size
      : 0;
    const status = beadCount > 0 && completedBeadCount >= beadCount
      ? "completed" as const
      : progressStarted ? "in_progress" as const : "draft" as const;
    return {
      ...record.summary,
      width: revision.grid.width,
      height: revision.grid.height,
      colorCount,
      beadCount,
      completedBeadCount,
      status,
      hasDraft: this.projectDrafts.get(record.summary.id)?.baseProjectRevision === record.summary.currentRevision,
    };
  }

  async listProjects(input: ListProjectsInput): Promise<ProjectListItem[]> {
    const query = input.q === undefined ? undefined : normalizeProjectSearch(input.q).toLocaleLowerCase("zh-CN");
    const tag = input.tag === undefined ? undefined : normalizeProjectTagFilter(input.tag).toLocaleLowerCase("zh-CN");
    return copy([...this.projects.values()]
      .filter((record) => record.summary.userId === input.userId && !this.deletedProjects.has(record.summary.id))
      .map((record) => this.projectListItem(record))
      .filter((project) => (query === undefined || project.name.toLocaleLowerCase("zh-CN").includes(query))
        && (input.status === undefined || project.status === input.status)
        && (input.mode === undefined || project.mode === input.mode)
        && (input.lifecycleStatus === undefined || project.lifecycleStatus === input.lifecycleStatus)
        && (tag === undefined || project.tags.some((candidate) => candidate.toLocaleLowerCase("zh-CN") === tag)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(input.offset, input.offset + input.limit));
  }

  async getProjectStatusStats(userId: string): Promise<ProjectStatusStats> {
    const stats: ProjectStatusStats = { total: 0, draft: 0, inProgress: 0, completed: 0 };
    for (const record of this.projects.values()) {
      if (record.summary.userId !== userId || this.deletedProjects.has(record.summary.id)) continue;
      const project = this.projectListItem(record);
      stats.total += 1;
      if (project.status === "draft") stats.draft += 1;
      else if (project.status === "in_progress") stats.inProgress += 1;
      else stats.completed += 1;
    }
    return stats;
  }

  async getProject(userId: string, projectId: string, revision?: number): Promise<ProjectDetail | null> {
    const record = this.projects.get(projectId);
    if (!record || record.summary.userId !== userId || this.deletedProjects.has(projectId)) return null;
    const targetRevision = revision ?? record.summary.currentRevision;
    const snapshot = record.revisions.find((item) => item.revision === targetRevision);
    return snapshot ? copy({
      ...record.summary,
      paletteId: snapshot.paletteId,
      currentRevision: targetRevision,
      grid: snapshot.grid,
      revisionDeviceSource: snapshot.deviceSource,
      revisionUpdatedAt: snapshot.updatedAt,
    }) : null;
  }

  async getProjectForExport(
    input: Parameters<AppStore["getProjectForExport"]>[0],
  ): Promise<ProjectDetail | null> {
    const record = this.projects.get(input.projectId);
    if (!record || record.summary.userId !== input.userId) return null;
    const snapshot = record.revisions.find((item) => item.revision === input.projectRevision);
    return snapshot
      ? copy({
        ...record.summary,
        paletteId: snapshot.paletteId,
        currentRevision: input.projectRevision,
        grid: snapshot.grid,
        revisionDeviceSource: snapshot.deviceSource,
        revisionUpdatedAt: snapshot.updatedAt,
      })
      : null;
  }

  async updateProjectGrid(input: {
    userId: string;
    projectId: string;
    baseRevision: number;
    name?: string;
    paletteId?: string;
    grid: ProjectDetail["grid"];
    deviceSource?: ProjectDetail["deviceSource"];
    migrationAudit?: readonly PaletteMigrationAuditInput[];
  }): Promise<ProjectDetail> {
    const record = this.projects.get(input.projectId);
    if (!record || record.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    }
    if (record.summary.currentRevision !== input.baseRevision) {
      throw new AppError(409, "PROJECT_REVISION_CONFLICT", "项目已在其他设备更新", {
        currentRevision: record.summary.currentRevision,
      });
    }
    // Keep the optimistic-lock check and palette validation in one synchronous
    // turn so two MemoryStore writers cannot both append from the same base.
    const nextPaletteId = input.paletteId ?? record.summary.paletteId;
    this.requireSelectablePalette(nextPaletteId, input.userId);
    if (record.summary.currentRevision >= MAX_PROJECT_REVISIONS) {
      throw new AppError(429, "PROJECT_REVISION_LIMIT_EXCEEDED", "作品版本数量已达到上限", {
        limit: MAX_PROJECT_REVISIONS,
      });
    }
    const retainedCells = [...this.projects.values()]
      .filter((candidate) => candidate.summary.userId === input.userId)
      .reduce((sum, candidate) => sum + candidate.revisions.reduce(
        (revisionSum, revision) => revisionSum + revision.grid.cells.length,
        0,
      ), 0);
    if (retainedCells + input.grid.cells.length > MAX_PROJECT_REVISION_CELLS_PER_USER) {
      throw new AppError(429, "PROJECT_STORAGE_LIMIT_EXCEEDED", "作品图纸历史占用已达到上限", {
        limitCells: MAX_PROJECT_REVISION_CELLS_PER_USER,
      });
    }
    const now = new Date().toISOString();
    const deviceSource = input.deviceSource ?? "unknown";
    assertProjectDeviceSource(deviceSource);
    const nextRevision = record.summary.currentRevision + 1;
    record.revisions.push({
      projectId: input.projectId,
      revision: nextRevision,
      paletteId: nextPaletteId,
      grid: copy(input.grid),
      deviceSource,
      createdAt: now,
      updatedAt: now,
    });
    record.summary = {
      ...record.summary,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.paletteId === undefined ? {} : { paletteId: input.paletteId }),
      lifecycleStatus: "editable",
      metadataRevision: record.summary.metadataRevision + 1,
      previewAssetId: null,
      deviceSource,
      currentRevision: nextRevision,
      updatedAt: now,
    };
    if (input.migrationAudit) {
      this.paletteColorMigrationAudits.push(...input.migrationAudit.map((entry) => copy(entry)));
    }
    this.projectDrafts.delete(input.projectId);
    return copy({
      ...record.summary,
      grid: input.grid,
      revisionDeviceSource: deviceSource,
      revisionUpdatedAt: now,
    });
  }

  async remapProjectPalette(input: Parameters<AppStore["remapProjectPalette"]>[0]): Promise<ProjectDetail> {
    return this.updateProjectGrid(input);
  }

  async updateProjectMetadata(input: UpdateProjectMetadataInput): Promise<ProjectDetail> {
    const record = this.projects.get(input.projectId);
    if (!record || record.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    }
    if (record.summary.currentRevision !== input.baseRevision) {
      throw new AppError(409, "PROJECT_REVISION_CONFLICT", "项目已在其他设备更新", {
        currentRevision: record.summary.currentRevision,
      });
    }
    if (record.summary.metadataRevision !== input.baseMetadataRevision) {
      throw new AppError(409, "PROJECT_METADATA_REVISION_CONFLICT", "作品元数据已在其他设备更新", {
        currentMetadataRevision: record.summary.metadataRevision,
      });
    }
    if (this.projectDrafts.get(input.projectId)?.baseProjectRevision === record.summary.currentRevision) {
      throw new AppError(409, "PROJECT_DRAFT_UNCOMMITTED", "请先提交或丢弃编辑草稿再发布");
    }
    const revision = record.revisions.find((item) => item.revision === record.summary.currentRevision);
    if (!revision) throw new AppError(500, "PROJECT_REVISION_CORRUPTED", "项目当前版本不存在");
    this.requireSelectablePalette(revision.paletteId, input.userId);
    const mode = input.mode ?? record.summary.mode;
    const lifecycleStatus = input.lifecycleStatus ?? record.summary.lifecycleStatus;
    const deviceSource = input.deviceSource ?? "unknown";
    assertProjectMode(mode);
    assertProjectLifecycleStatus(lifecycleStatus);
    assertProjectDeviceSource(deviceSource);
    const tags = input.tags === undefined ? record.summary.tags : normalizeProjectTags(input.tags);
    const sourceAssetId = input.sourceAssetId === undefined
      ? record.summary.sourceAssetId
      : input.sourceAssetId;
    const previewAssetId = input.previewAssetId === undefined
      ? record.summary.previewAssetId
      : input.previewAssetId;
    this.requireAvailableProjectAsset(input.userId, sourceAssetId, "ai-source", "source");
    this.requireAvailableProjectAsset(input.userId, previewAssetId, "ai-intermediate", "preview");

    const backgroundMode = input.backgroundMode ?? record.summary.backgroundMode;
    const backgroundColor = input.backgroundColor !== undefined
      ? input.backgroundColor
      : input.backgroundMode !== undefined && input.backgroundMode !== record.summary.backgroundMode
        ? null
        : record.summary.backgroundColor;
    const background = normalizeProjectBackground(backgroundMode, backgroundColor);
    const now = new Date().toISOString();
    record.summary = {
      ...record.summary,
      mode,
      lifecycleStatus,
      metadataRevision: record.summary.metadataRevision + 1,
      tags,
      deviceSource,
      sourceAssetId,
      previewAssetId,
      ...background,
      updatedAt: now,
    };
    return copy({
      ...record.summary,
      grid: revision.grid,
      revisionDeviceSource: revision.deviceSource,
      revisionUpdatedAt: revision.updatedAt,
    });
  }

  async listProjectRevisions(
    input: Parameters<AppStore["listProjectRevisions"]>[0],
  ): ReturnType<AppStore["listProjectRevisions"]> {
    const record = this.projects.get(input.projectId);
    if (!record || record.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) return [];
    return copy(record.revisions
      .slice()
      .sort((left, right) => right.revision - left.revision)
      .slice(input.offset, input.offset + input.limit)
      .map((revision) => ({
        projectId: revision.projectId,
        revision: revision.revision,
        paletteId: revision.paletteId,
        width: revision.grid.width,
        height: revision.grid.height,
        deviceSource: revision.deviceSource,
        createdAt: revision.createdAt,
        updatedAt: revision.updatedAt,
      })));
  }

  async restoreProjectRevision(
    input: Parameters<AppStore["restoreProjectRevision"]>[0],
  ): ReturnType<AppStore["restoreProjectRevision"]> {
    const record = this.projects.get(input.projectId);
    if (!record || record.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "项目或指定版本不存在");
    }
    if (record.summary.currentRevision !== input.baseRevision) {
      throw new AppError(409, "PROJECT_REVISION_CONFLICT", "项目已在其他设备更新", {
        currentRevision: record.summary.currentRevision,
      });
    }
    const target = record.revisions.find((revision) => revision.revision === input.revision);
    if (!target) throw new AppError(404, "PROJECT_REVISION_NOT_FOUND", "指定历史版本不存在");
    return this.updateProjectGrid({
      userId: input.userId,
      projectId: input.projectId,
      baseRevision: input.baseRevision,
      paletteId: target.paletteId,
      grid: copy(target.grid),
      ...(input.deviceSource === undefined ? {} : { deviceSource: input.deviceSource }),
    });
  }

  async deleteProject(userId: string, projectId: string): Promise<boolean> {
    const record = this.projects.get(projectId);
    if (!record || record.summary.userId !== userId || this.deletedProjects.has(projectId)) return false;
    this.deletedProjects.add(projectId);
    this.projectDrafts.delete(projectId);
    const deletedAt = new Date().toISOString();
    record.summary.updatedAt = deletedAt;
    for (const photo of this.completionPhotos.values()) {
      if (photo.userId !== userId || photo.projectId !== projectId) continue;
      photo.deletedAt ??= deletedAt;
      const asset = this.assets.get(photo.assetId);
      if (asset) asset.deletedAt ??= deletedAt;
    }
    return true;
  }

  async getProjectDraft(userId: string, projectId: string): Promise<ProjectDraft | null> {
    const record = this.projects.get(projectId);
    if (!record || record.summary.userId !== userId || this.deletedProjects.has(projectId)) return null;
    const draft = this.projectDrafts.get(projectId);
    return draft?.baseProjectRevision === record.summary.currentRevision ? copy(draft) : null;
  }

  async saveProjectDraft(input: Parameters<AppStore["saveProjectDraft"]>[0]): Promise<ProjectDraft> {
    const record = this.projects.get(input.projectId);
    if (!record || record.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    }
    if (record.summary.currentRevision !== input.baseProjectRevision) {
      throw new AppError(409, "PROJECT_DRAFT_BASE_REVISION_MISMATCH", "草稿基于的图纸版本已过期", {
        currentProjectRevision: record.summary.currentRevision,
      });
    }
    this.requireSelectablePalette(record.summary.paletteId, input.userId);
    const existing = this.projectDrafts.get(input.projectId);
    const effectiveDraftRevision = existing?.baseProjectRevision === input.baseProjectRevision
      ? existing.draftRevision
      : 0;
    if (effectiveDraftRevision !== input.baseDraftRevision) {
      throw new AppError(409, "PROJECT_DRAFT_REVISION_CONFLICT", "草稿已在其他设备更新", {
        currentDraftRevision: effectiveDraftRevision,
      });
    }
    const now = new Date().toISOString();
    const draft: ProjectDraft = {
      projectId: input.projectId,
      baseProjectRevision: input.baseProjectRevision,
      draftRevision: effectiveDraftRevision + 1,
      name: input.name ?? existing?.name ?? record.summary.name,
      grid: copy(input.grid),
      updatedAt: now,
    };
    this.projectDrafts.set(input.projectId, draft);
    record.summary.updatedAt = now;
    return copy(draft);
  }

  async commitProjectDraft(input: Parameters<AppStore["commitProjectDraft"]>[0]): Promise<ProjectDetail> {
    const record = this.projects.get(input.projectId);
    if (!record || record.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    }
    if (record.summary.currentRevision !== input.baseProjectRevision) {
      throw new AppError(409, "PROJECT_DRAFT_BASE_REVISION_MISMATCH", "草稿基于的图纸版本已过期", {
        currentProjectRevision: record.summary.currentRevision,
      });
    }
    this.requireSelectablePalette(record.summary.paletteId, input.userId);
    const draft = this.projectDrafts.get(input.projectId);
    if (!draft || draft.baseProjectRevision !== input.baseProjectRevision) {
      throw new AppError(404, "PROJECT_DRAFT_NOT_FOUND", "项目草稿不存在");
    }
    if (draft.draftRevision !== input.draftRevision) {
      throw new AppError(409, "PROJECT_DRAFT_REVISION_CONFLICT", "草稿已在其他设备更新", {
        currentDraftRevision: draft.draftRevision,
      });
    }
    if (record.summary.currentRevision >= MAX_PROJECT_REVISIONS) {
      throw new AppError(429, "PROJECT_REVISION_LIMIT_EXCEEDED", "作品版本数量已达到上限", {
        limit: MAX_PROJECT_REVISIONS,
      });
    }
    const retainedCells = [...this.projects.values()]
      .filter((candidate) => candidate.summary.userId === input.userId)
      .reduce((sum, candidate) => sum + candidate.revisions.reduce(
        (revisionSum, revision) => revisionSum + revision.grid.cells.length,
        0,
      ), 0);
    if (retainedCells + draft.grid.cells.length > MAX_PROJECT_REVISION_CELLS_PER_USER) {
      throw new AppError(429, "PROJECT_STORAGE_LIMIT_EXCEEDED", "作品图纸历史占用已达到上限", {
        limitCells: MAX_PROJECT_REVISION_CELLS_PER_USER,
      });
    }
    const now = new Date().toISOString();
    const deviceSource = input.deviceSource ?? "unknown";
    assertProjectDeviceSource(deviceSource);
    const nextRevision = record.summary.currentRevision + 1;
    record.revisions.push({
      projectId: input.projectId,
      revision: nextRevision,
      paletteId: record.summary.paletteId,
      grid: copy(draft.grid),
      deviceSource,
      createdAt: now,
      updatedAt: now,
    });
    record.summary = {
      ...record.summary,
      name: draft.name,
      lifecycleStatus: "editable",
      metadataRevision: record.summary.metadataRevision + 1,
      previewAssetId: null,
      deviceSource,
      currentRevision: nextRevision,
      updatedAt: now,
    };
    this.projectDrafts.delete(input.projectId);
    return copy({
      ...record.summary,
      grid: draft.grid,
      revisionDeviceSource: deviceSource,
      revisionUpdatedAt: now,
    });
  }

  async discardProjectDraft(input: Parameters<AppStore["discardProjectDraft"]>[0]): Promise<boolean> {
    const record = this.projects.get(input.projectId);
    if (!record || record.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) return false;
    if (record.summary.currentRevision !== input.baseProjectRevision) {
      throw new AppError(409, "PROJECT_DRAFT_BASE_REVISION_MISMATCH", "草稿基于的图纸版本已过期", {
        currentProjectRevision: record.summary.currentRevision,
      });
    }
    const draft = this.projectDrafts.get(input.projectId);
    if (!draft) return false;
    if (draft.draftRevision !== input.draftRevision) {
      throw new AppError(409, "PROJECT_DRAFT_REVISION_CONFLICT", "草稿已在其他设备更新", {
        currentDraftRevision: draft.draftRevision,
      });
    }
    this.projectDrafts.delete(input.projectId);
    return true;
  }

  async getBuildProgress(userId: string, projectId: string): Promise<BuildProgress | null> {
    const record = this.projects.get(projectId);
    if (!record || record.summary.userId !== userId || this.deletedProjects.has(projectId)) return null;
    const progress = this.progress.get(projectId);
    if (progress && progress.projectRevision !== record.summary.currentRevision) {
      throw new AppError(409, "BUILD_PROGRESS_REVISION_MISMATCH", "制作进度对应的图纸版本已过期", {
        progressProjectRevision: progress.projectRevision,
        currentProjectRevision: record.summary.currentRevision,
      });
    }
    return progress ? copy(progress) : {
      projectId,
      projectRevision: record.summary.currentRevision,
      progressRevision: 0,
      mode: "color",
      navigationCursor: null,
      completedIndices: [],
      elapsedTime: 0,
      startedAt: null,
      completedAt: null,
      updatedAt: record.summary.updatedAt,
    };
  }

  async saveBuildProgress(input: Parameters<AppStore["saveBuildProgress"]>[0]): Promise<BuildProgress> {
    const record = this.projects.get(input.projectId);
    if (!record || record.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    }
    if (record.summary.currentRevision !== input.projectRevision) {
      throw new AppError(409, "BUILD_PROGRESS_REVISION_MISMATCH", "制作进度对应的图纸版本已过期", {
        currentProjectRevision: record.summary.currentRevision,
      });
    }
    const existing = this.progress.get(input.projectId);
    const current = existing?.projectRevision === input.projectRevision ? existing : undefined;
    const effectiveRevision = current?.progressRevision ?? 0;
    if (effectiveRevision !== input.baseProgressRevision) {
      throw new AppError(409, "BUILD_PROGRESS_REVISION_CONFLICT", "制作进度已在其他设备更新", {
        currentProgressRevision: effectiveRevision,
      });
    }
    const revision = record.revisions.find((item) => item.revision === input.projectRevision);
    if (!revision) throw new AppError(404, "PROJECT_REVISION_NOT_FOUND", "项目版本不存在");
    const { grid } = revision;
    const palette = this.requireSelectablePalette(revision.paletteId, input.userId);
    if (input.completedIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= grid.cells.length)) {
      throw new AppError(400, "INVALID_COMPLETED_INDICES", "完成位置超出图纸范围");
    }
    if (input.completedIndices.some((index) => grid.cells[index] === null)) {
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
    if (current && input.elapsedTime !== undefined && input.elapsedTime < current.elapsedTime) {
      throw new AppError(409, "BUILD_PROGRESS_ELAPSED_TIME_REGRESSION", "累计制作时长不能减少", {
        currentElapsedTime: current.elapsedTime,
      });
    }
    const completedIndices = [...new Set(input.completedIndices)].sort((a, b) => a - b);
    const drawableCellCount = grid.cells.reduce((count, cell) => count + (cell === null ? 0 : 1), 0);
    const isCompleted = drawableCellCount > 0 && completedIndices.length === drawableCellCount;
    const now = new Date().toISOString();
    const mode = input.mode ?? current?.mode ?? "color";
    const navigationCursor = resolveBuildNavigationCursor({
      mode,
      previousMode: current?.mode,
      previousCursor: current?.navigationCursor,
      cursorProvided: Object.prototype.hasOwnProperty.call(input, "navigationCursor"),
      requestedCursor: input.navigationCursor,
      grid,
      paletteColorCodes: new Set(palette.colors.map((color) => color.code)),
    });
    const next: BuildProgress = {
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      progressRevision: effectiveRevision + 1,
      mode,
      navigationCursor,
      completedIndices,
      elapsedTime: input.elapsedTime ?? current?.elapsedTime ?? 0,
      startedAt: current?.startedAt ?? now,
      completedAt: isCompleted ? current?.completedAt ?? now : null,
      updatedAt: now,
    };
    this.progress.set(input.projectId, next);
    // A build-progress save is user activity even though it does not create a
    // new immutable pattern revision. Keep project ordering and save feedback
    // aligned with the latest persisted action.
    record.summary.updatedAt = next.updatedAt;
    return copy(next);
  }

  private completionPhotoRecord(
    photo: Omit<ProjectCompletionPhotoRecord, "asset">,
  ): ProjectCompletionPhotoRecord | null {
    const asset = this.assets.get(photo.assetId);
    return asset ? copy({ ...photo, asset }) : null;
  }

  private hasActiveCompletionPhotoUploadLease(assetId: string, nowMillis: number): boolean {
    return [...this.completionPhotoUploads.values()].some((reservation) =>
      reservation.assetId === assetId
      && Date.parse(reservation.uploadLeaseExpiresAt) > nowMillis);
  }

  private hasActiveAssetUploadLease(assetId: string, nowMillis: number): boolean {
    return [...this.assetUploads.values()].some((reservation) =>
      reservation.assetId === assetId
      && Date.parse(reservation.uploadLeaseExpiresAt) > nowMillis)
      || this.hasActiveCompletionPhotoUploadLease(assetId, nowMillis);
  }

  async reserveProjectCompletionPhotoUpload(
    input: Parameters<AppStore["reserveProjectCompletionPhotoUpload"]>[0],
  ): Promise<ProjectCompletionPhotoUploadReservation> {
    const uploadLeaseAcquiredAtMillis = Date.parse(input.uploadLeaseAcquiredAt);
    if (input.asset.userId !== input.userId || input.asset.purpose !== "project-completion"
      || input.asset.consentVersion !== null || input.asset.expiresAt !== null
      || !input.uploadLeaseToken
      || !Number.isFinite(uploadLeaseAcquiredAtMillis)) {
      throw new AppError(400, "COMPLETION_PHOTO_ASSET_INVALID", "完工照片素材元数据无效");
    }
    const uploadLeaseExpiresAt = new Date(
      uploadLeaseAcquiredAtMillis + COMPLETION_PHOTO_UPLOAD_LEASE_MILLISECONDS,
    ).toISOString();
    const lockKey = input.userId;
    const previous = this.completionPhotoUploadLocks.get(lockKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.completionPhotoUploadLocks.set(lockKey, tail);
    await previous;
    try {
      const reservationKey = `${input.userId}:${input.projectId}:${input.idempotencyKey}`;
      const existing = this.completionPhotoUploads.get(reservationKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
        }
        const photo = this.completionPhotos.get(existing.photoId);
        const record = photo ? this.completionPhotoRecord(photo) : null;
        if (!record) throw new AppError(500, "COMPLETION_PHOTO_UPLOAD_CORRUPTED", "完工照片上传预约已损坏");
        if (this.deletedProjects.has(input.projectId) || record.deletedAt !== null
          || record.asset.deletedAt !== null || record.asset.purgedAt !== null) {
          throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "该完工照片上传已删除或超时，请使用新的幂等键重试");
        }
        if (record.asset.readyAt === null) {
          const project = this.projects.get(record.projectId);
          const revision = project?.revisions.find((item) => item.revision === record.projectRevision);
          if (!revision) {
            throw new AppError(409, "PROJECT_COMPLETION_STATE_CHANGED", "作品版本或制作进度已变化，无法续约完工照片上传");
          }
          this.requireSelectablePalette(revision.paletteId, input.userId);
          const existingLeaseIsActive = Date.parse(existing.uploadLeaseExpiresAt)
            > Date.parse(input.uploadLeaseAcquiredAt);
          if (!existingLeaseIsActive) existing.uploadLeaseToken = input.uploadLeaseToken;
          if (!existingLeaseIsActive
            || Date.parse(uploadLeaseExpiresAt) > Date.parse(existing.uploadLeaseExpiresAt)) {
            existing.uploadLeaseExpiresAt = uploadLeaseExpiresAt;
          }
          const purgeState = this.assetPurgeState.get(record.asset.id) ?? {
            attemptCount: 0,
            availableAt: record.asset.createdAt,
          };
          if (Date.parse(existing.uploadLeaseExpiresAt) > Date.parse(purgeState.availableAt)) {
            this.assetPurgeState.set(record.asset.id, {
              ...purgeState,
              availableAt: existing.uploadLeaseExpiresAt,
            });
          }
        }
        return {
          photo: record,
          replayed: true,
          uploadLeaseToken: existing.uploadLeaseToken,
          uploadLeaseExpiresAt: existing.uploadLeaseExpiresAt,
        };
      }

      const project = this.projects.get(input.projectId);
      if (!project || project.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) {
        throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
      }
      if (project.summary.currentRevision !== input.projectRevision) {
        throw new AppError(409, "PROJECT_COMPLETION_REVISION_MISMATCH", "完工照片只能绑定作品当前版本", {
          currentProjectRevision: project.summary.currentRevision,
        });
      }
      const revision = project.revisions.find((item) => item.revision === input.projectRevision);
      if (!revision) throw new AppError(404, "PROJECT_REVISION_NOT_FOUND", "项目版本不存在");
      this.requireSelectablePalette(revision.paletteId, input.userId);
      const progress = this.progress.get(input.projectId);
      const drawableCellCount = revision.grid.cells.reduce(
        (count, cell) => count + (cell === null ? 0 : 1),
        0,
      );
      const completedCount = progress?.projectRevision === input.projectRevision
        ? new Set(progress.completedIndices).size
        : 0;
      if (drawableCellCount === 0 || completedCount !== drawableCellCount || !progress?.completedAt) {
        throw new AppError(409, "PROJECT_BUILD_NOT_COMPLETED", "完成全部非空拼豆格后才能上传完工照片", {
          completedBeadCount: completedCount,
          beadCount: drawableCellCount,
        });
      }
      const activeCount = [...this.completionPhotos.values()].filter((photo) => {
        if (photo.projectId !== input.projectId || photo.projectRevision !== input.projectRevision
          || photo.deletedAt !== null) return false;
        const candidate = this.assets.get(photo.assetId);
        return candidate?.deletedAt === null && candidate?.purgedAt === null;
      }).length;
      if (activeCount >= MAX_PROJECT_COMPLETION_PHOTOS_PER_REVISION) {
        throw new AppError(429, "COMPLETION_PHOTO_LIMIT_EXCEEDED", "当前作品版本的完工照片已达到上限", {
          limit: MAX_PROJECT_COMPLETION_PHOTOS_PER_REVISION,
        });
      }
      const rateLimit = await this.consumeUserRateLimit({
        userId: input.userId,
        ...USER_RATE_LIMITS.completionPhotoUpload,
        now: input.asset.createdAt,
      });
      if (!rateLimit.allowed) {
        throw new AppError(429, "USER_RATE_LIMITED", "请求过于频繁，请稍后重试", {
          retryAfterMilliseconds: rateLimit.retryAfterMilliseconds,
        });
      }
      const asset = await this.createAsset(input.asset);
      const photo: Omit<ProjectCompletionPhotoRecord, "asset"> = {
        id: input.photoId,
        userId: input.userId,
        projectId: input.projectId,
        projectRevision: input.projectRevision,
        assetId: asset.id,
        createdAt: input.asset.createdAt,
        deletedAt: null,
      };
      this.completionPhotos.set(photo.id, photo);
      this.completionPhotoUploads.set(reservationKey, {
        requestHash: input.requestHash,
        photoId: photo.id,
        assetId: asset.id,
        uploadLeaseToken: input.uploadLeaseToken,
        uploadLeaseExpiresAt,
      });
      this.assetPurgeState.set(asset.id, {
        attemptCount: 0,
        availableAt: uploadLeaseExpiresAt,
      });
      return {
        photo: copy({ ...photo, asset }),
        replayed: false,
        uploadLeaseToken: input.uploadLeaseToken,
        uploadLeaseExpiresAt,
      };
    } finally {
      release();
      if (this.completionPhotoUploadLocks.get(lockKey) === tail) this.completionPhotoUploadLocks.delete(lockKey);
    }
  }

  async publishProjectCompletionPhoto(
    input: Parameters<AppStore["publishProjectCompletionPhoto"]>[0],
  ): Promise<ProjectCompletionPhotoRecord> {
    const photo = this.completionPhotos.get(input.photoId);
    if (!photo || photo.userId !== input.userId || photo.projectId !== input.projectId
      || photo.assetId !== input.assetId) {
      throw new AppError(404, "COMPLETION_PHOTO_NOT_FOUND", "完工照片不存在");
    }
    const existingAsset = this.assets.get(input.assetId);
    if (photo.deletedAt !== null || existingAsset?.deletedAt !== null || existingAsset?.purgedAt !== null) {
      throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "完工照片上传已删除或超时");
    }
    const reservation = [...this.completionPhotoUploads.values()].find((candidate) =>
      candidate.photoId === input.photoId && candidate.assetId === input.assetId);
    if (!reservation) {
      throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "完工照片上传预约已删除或超时");
    }
    if (reservation.uploadLeaseToken !== input.uploadLeaseToken) {
      throw new AppError(409, "COMPLETION_PHOTO_UPLOAD_LEASE_LOST", "完工照片上传租约已被接管，请重试", undefined, true);
    }
    if (existingAsset?.readyAt != null) return copy({ ...photo, asset: existingAsset });
    if (Date.parse(reservation.uploadLeaseExpiresAt) <= Date.parse(input.readyAt)) {
      throw new AppError(409, "COMPLETION_PHOTO_UPLOAD_LEASE_LOST", "完工照片上传租约已被接管，请重试", undefined, true);
    }
    const project = this.projects.get(input.projectId);
    const revision = project?.revisions.find((item) => item.revision === photo.projectRevision);
    if (!revision) {
      throw new AppError(409, "PROJECT_COMPLETION_STATE_CHANGED", "作品版本或制作进度已变化，完工照片未发布", {
        currentProjectRevision: project?.summary.currentRevision ?? null,
        photoProjectRevision: photo.projectRevision,
      });
    }
    this.requireSelectablePalette(revision.paletteId, input.userId);
    const progress = this.progress.get(input.projectId);
    const beadCount = revision?.grid.cells.reduce((count, cell) => count + (cell === null ? 0 : 1), 0) ?? 0;
    const completedBeadCount = progress?.projectRevision === photo.projectRevision
      ? new Set(progress.completedIndices).size
      : 0;
    const stillCompleted = project?.summary.userId === input.userId
      && !this.deletedProjects.has(input.projectId)
      && project.summary.currentRevision === photo.projectRevision
      && beadCount > 0
      && completedBeadCount === beadCount
      && Boolean(progress?.completedAt);
    if (!stillCompleted) {
      photo.deletedAt ??= input.readyAt;
      const staleAsset = existingAsset;
      if (staleAsset) staleAsset.deletedAt ??= input.readyAt;
      throw new AppError(409, "PROJECT_COMPLETION_STATE_CHANGED", "作品版本或制作进度已变化，完工照片未发布", {
        currentProjectRevision: project?.summary.currentRevision ?? null,
        photoProjectRevision: photo.projectRevision,
      });
    }
    const asset = await this.markAssetReady(input.userId, input.assetId, input.readyAt);
    if (!asset || asset.purpose !== "project-completion") {
      throw new AppError(410, "COMPLETION_PHOTO_UPLOAD_UNAVAILABLE", "完工照片上传已删除或超时");
    }
    return copy({ ...photo, asset });
  }

  async listProjectCompletionPhotos(
    input: Parameters<AppStore["listProjectCompletionPhotos"]>[0],
  ): Promise<ProjectCompletionPhotoRecord[]> {
    const project = this.projects.get(input.projectId);
    if (!project || project.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) return [];
    const nowMillis = Date.parse(input.now);
    return [...this.completionPhotos.values()]
      .filter((photo) => photo.userId === input.userId && photo.projectId === input.projectId
        && photo.projectRevision === input.projectRevision && photo.deletedAt === null)
      .map((photo) => this.completionPhotoRecord(photo))
      .filter((photo): photo is ProjectCompletionPhotoRecord => photo !== null
        && photo.asset.readyAt !== null && photo.asset.deletedAt === null && photo.asset.purgedAt === null
        && (photo.asset.expiresAt === null || Date.parse(photo.asset.expiresAt) > nowMillis))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(input.offset, input.offset + input.limit)
      .map(copy);
  }

  async getProjectCompletionPhoto(
    input: Parameters<AppStore["getProjectCompletionPhoto"]>[0],
  ): Promise<ProjectCompletionPhotoRecord | null> {
    const project = this.projects.get(input.projectId);
    if (!project || project.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) return null;
    const photo = this.completionPhotos.get(input.photoId);
    if (!photo || photo.userId !== input.userId || photo.projectId !== input.projectId) return null;
    const record = this.completionPhotoRecord(photo);
    if (!record) return null;
    if (input.includeDeleted) return record;
    if (photo.deletedAt !== null || record.asset.readyAt === null || record.asset.deletedAt !== null
      || record.asset.purgedAt !== null
      || (record.asset.expiresAt !== null && Date.parse(record.asset.expiresAt) <= Date.parse(input.now))) return null;
    return record;
  }

  async deleteProjectCompletionPhoto(
    input: Parameters<AppStore["deleteProjectCompletionPhoto"]>[0],
  ): Promise<ProjectCompletionPhotoRecord | null> {
    const project = this.projects.get(input.projectId);
    if (!project || project.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) return null;
    const photo = this.completionPhotos.get(input.photoId);
    if (!photo || photo.userId !== input.userId || photo.projectId !== input.projectId) return null;
    photo.deletedAt ??= input.deletedAt;
    const asset = this.assets.get(photo.assetId);
    if (!asset) return null;
    asset.deletedAt ??= input.deletedAt;
    return copy({ ...photo, asset });
  }

  async getCreditAccount(userId: string): Promise<CreditAccount> {
    const account = this.credits.get(userId);
    if (!account) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
    return copy(account);
  }

  async listCreditLedger(userId: string, limit: number, offset = 0): Promise<CreditLedgerEntry[]> {
    return copy((this.ledger.get(userId) ?? []).slice().reverse().slice(offset, offset + limit));
  }

  private releaseGenerationCredits(job: GenerationJob, now: string): void {
    if (job.cost <= 0) return;
    const entries = this.ledger.get(job.userId) ?? [];
    if (entries.some((entry) => entry.reason === "generation_released" && entry.referenceId === job.id)) return;
    const account = this.credits.get(job.userId);
    if (!account) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
    account.balance += job.cost;
    account.updatedAt = now;
    entries.push({
      id: randomUUID(),
      userId: job.userId,
      delta: job.cost,
      balanceAfter: account.balance,
      reason: "generation_released",
      referenceId: job.id,
      createdAt: now,
    });
    this.ledger.set(job.userId, entries);
  }

  async createGenerationJob(input: Parameters<AppStore["createGenerationJob"]>[0]): Promise<GenerationJob> {
    this.requireSelectablePalette(input.paletteId, input.userId);
    const account = this.credits.get(input.userId);
    if (!account) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
    const options = input.options
      ? deserializeGenerationOptions(input.options)
      : copyDefaultGenerationOptions();
    if (input.parentJobId) {
      const parent = this.jobs.get(input.parentJobId);
      if (!parent || parent.userId !== input.userId) {
        throw new AppError(404, "GENERATION_JOB_NOT_FOUND", "原生成任务不存在");
      }
      if (parent.status !== "completed") {
        throw new AppError(409, "GENERATION_REDRAW_NOT_READY", "只有已生成且尚未采用的任务可以换一批", {
          status: parent.status,
        });
      }
      if ((parent.kind !== "portrait" && parent.kind !== "couple") || input.cost !== 1) {
        throw new AppError(409, "GENERATION_REDRAW_UNSUPPORTED", "换一批仅支持 AI 任务且固定扣 1 次");
      }
      if (input.kind !== parent.kind || input.paletteId !== parent.paletteId
        || input.sourceAssetId !== parent.sourceAssetId
        || input.width !== parent.width || input.height !== parent.height
        || !generationOptionsEqual(options, parent.options)) {
        throw new AppError(500, "GENERATION_REDRAW_INPUT_MISMATCH", "换一批任务没有完整复用原任务参数");
      }
    }
    if (input.sourceAssetId) {
      const asset = this.assets.get(input.sourceAssetId);
      if (!asset || asset.userId !== input.userId || asset.purpose !== "ai-source") {
        throw new AppError(404, "GENERATION_SOURCE_ASSET_NOT_FOUND", "AI 原始素材不存在");
      }
      if (asset.readyAt === null || asset.deletedAt || asset.purgedAt
        || asset.expiresAt === null || Date.parse(asset.expiresAt) <= Date.parse(input.now)) {
        throw new AppError(410, "GENERATION_SOURCE_ASSET_UNAVAILABLE", "AI 原始素材已删除或过期");
      }
    }
    const historyCutoff = Date.parse(input.now) - OPERATIONAL_HISTORY_RETENTION_MILLISECONDS;
    const expiredJobIds = new Set([...this.jobs.values()]
      .filter((job) => job.userId === input.userId
        && !ACTIVE_GENERATION_STATUSES.has(job.status)
        && job.id !== input.parentJobId
        && Date.parse(job.updatedAt) < historyCutoff)
      .map((job) => job.id));
    if (expiredJobIds.size > 0) {
      for (const job of this.jobs.values()) {
        if (job.parentJobId && expiredJobIds.has(job.parentJobId)) job.parentJobId = null;
      }
      for (const jobId of expiredJobIds) this.jobs.delete(jobId);
    }
    const activeJobCount = [...this.jobs.values()].filter((job) =>
      job.userId === input.userId && ACTIVE_GENERATION_STATUSES.has(job.status)).length;
    if (activeJobCount >= MAX_ACTIVE_GENERATION_JOBS_PER_USER) {
      throw new AppError(429, "GENERATION_ACTIVE_LIMIT_EXCEEDED", "同时处理的生成任务已达到上限", {
        limit: MAX_ACTIVE_GENERATION_JOBS_PER_USER,
      });
    }
    const historyCount = [...this.jobs.values()].filter((job) => job.userId === input.userId).length;
    if (historyCount >= MAX_GENERATION_HISTORY_PER_USER) {
      throw new AppError(429, "GENERATION_HISTORY_LIMIT_EXCEEDED", "生成历史记录已达到上限", {
        limit: MAX_GENERATION_HISTORY_PER_USER,
        retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
      });
    }
    if (account.balance < input.cost) {
      throw new AppError(402, "INSUFFICIENT_CREDITS", "可用次数不足", { balance: account.balance, required: input.cost });
    }
    if (input.cost > 0) {
      account.balance -= input.cost;
      account.updatedAt = input.now;
      (this.ledger.get(input.userId) ?? []).push({
        id: randomUUID(),
        userId: input.userId,
        delta: -input.cost,
        balanceAfter: account.balance,
        reason: "generation_reserved",
        referenceId: input.jobId,
        createdAt: input.now,
      });
    }
    const job: GenerationJob = {
      id: input.jobId,
      userId: input.userId,
      parentJobId: input.parentJobId ?? null,
      kind: input.kind,
      status: "queued",
      paletteId: input.paletteId,
      sourceAssetId: input.sourceAssetId,
      options: copy(options),
      cost: input.cost,
      seed: input.seed,
      width: input.width,
      height: input.height,
      progress: 0,
      attemptCount: 0,
      maxAttempts: 3,
      availableAt: input.now,
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
      canceledAt: null,
      acceptedCandidateId: null,
      candidates: [],
    };
    this.jobs.set(job.id, job);
    return copy(job);
  }

  async getGenerationJob(userId: string, jobId: string): Promise<GenerationJob | null> {
    const job = this.jobs.get(jobId);
    return job?.userId === userId ? copy(job) : null;
  }

  async listGenerationJobs(input: Parameters<AppStore["listGenerationJobs"]>[0]): Promise<GenerationJob[]> {
    const statusFilter = input.statuses ? new Set(input.statuses) : null;
    return copy([...this.jobs.values()]
      .filter((job) => job.userId === input.userId && (!statusFilter || statusFilter.has(job.status)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(input.offset ?? 0, (input.offset ?? 0) + input.limit));
  }

  async countActiveGenerationJobs(userId: string): Promise<number> {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.userId === userId && ACTIVE_GENERATION_STATUSES.has(job.status)) count += 1;
    }
    return count;
  }

  async claimNextGenerationJob(input: Parameters<AppStore["claimNextGenerationJob"]>[0]): Promise<GenerationJob | null> {
    const leaseWindow = resolveInMemoryWorkerLeaseWindow(input);
    for (const job of this.jobs.values()) {
      const active = ["preprocessing", "generating", "mapping_colors", "finalizing"].includes(job.status);
      if (!active || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > leaseWindow.nowMilliseconds) continue;
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.errorCode = "GENERATION_LEASE_EXPIRED";
      job.errorMessage = "生成 worker 租约已过期";
      job.updatedAt = leaseWindow.now;
      if (job.attemptCount >= job.maxAttempts) {
        job.status = "failed";
        this.releaseGenerationCredits(job, leaseWindow.now);
      } else {
        job.status = "retry_wait";
        job.availableAt = leaseWindow.now;
      }
    }
    const next = [...this.jobs.values()]
      .filter((job) => (job.status === "queued" || job.status === "retry_wait")
        && Date.parse(job.availableAt) <= leaseWindow.nowMilliseconds)
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt)
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))[0];
    if (!next) return null;
    next.status = "preprocessing";
    next.progress = Math.max(next.progress, 5);
    next.attemptCount += 1;
    next.leaseToken = input.leaseToken;
    next.leaseExpiresAt = leaseWindow.leaseExpiresAt;
    next.errorCode = null;
    next.errorMessage = null;
    next.updatedAt = leaseWindow.now;
    return copy(next);
  }

  async renewGenerationJobLease(input: Parameters<AppStore["renewGenerationJobLease"]>[0]): Promise<boolean> {
    const leaseWindow = resolveInMemoryWorkerLeaseWindow(input);
    const job = this.jobs.get(input.jobId);
    const active = job && ["preprocessing", "generating", "mapping_colors", "finalizing"].includes(job.status);
    if (!job || !active || job.leaseToken !== input.leaseToken || !job.leaseExpiresAt
      || Date.parse(job.leaseExpiresAt) <= leaseWindow.nowMilliseconds) return false;
    job.leaseExpiresAt = leaseWindow.leaseExpiresAt;
    job.updatedAt = leaseWindow.now;
    return true;
  }

  async advanceGenerationJob(input: Parameters<AppStore["advanceGenerationJob"]>[0]): Promise<GenerationJob> {
    const job = this.jobs.get(input.jobId);
    const active = job && ["preprocessing", "generating", "mapping_colors", "finalizing"].includes(job.status);
    if (!job || !active || job.leaseToken !== input.leaseToken) {
      throw new AppError(409, "GENERATION_LEASE_LOST", "生成任务租约已失效");
    }
    if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.parse(input.now)) {
      throw new AppError(503, "GENERATION_LEASE_EXPIRED", "生成任务租约已过期");
    }
    job.status = input.status;
    job.progress = Math.max(job.progress, input.progress);
    job.updatedAt = input.now;
    return copy(job);
  }

  async completeGenerationJob(input: Parameters<AppStore["completeGenerationJob"]>[0]): Promise<GenerationJob> {
    const job = this.jobs.get(input.jobId);
    const active = job && ["preprocessing", "generating", "mapping_colors", "finalizing"].includes(job.status);
    if (!job || !active || job.leaseToken !== input.leaseToken) {
      throw new AppError(409, "GENERATION_LEASE_LOST", "生成任务租约已失效");
    }
    if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.parse(input.now)) {
      throw new AppError(503, "GENERATION_LEASE_EXPIRED", "生成任务租约已过期");
    }
    this.requireSelectablePalette(job.paletteId, job.userId);
    const candidateCells = assertGenerationCandidatesStructure({
      jobId: job.id,
      kind: job.kind,
      options: job.options,
      width: job.width,
      height: job.height,
      candidates: input.candidates,
    });
    const retainedCandidateCells = [...this.jobs.values()]
      .filter((candidateJob) => candidateJob.userId === job.userId)
      .reduce((sum, candidateJob) => sum + candidateJob.candidates.reduce(
        (jobSum, candidate) => jobSum + candidate.grid.width * candidate.grid.height,
        0,
      ), 0);
    if (retainedCandidateCells + candidateCells > MAX_GENERATION_CANDIDATE_CELLS_PER_USER) {
      throw new AppError(429, "GENERATION_CANDIDATE_CELLS_LIMIT_EXCEEDED", "生成候选历史占用空间已达到上限", {
        limitCells: MAX_GENERATION_CANDIDATE_CELLS_PER_USER,
      });
    }
    job.status = "completed";
    job.progress = 100;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.errorCode = null;
    job.errorMessage = null;
    job.updatedAt = input.now;
    job.completedAt = input.now;
    job.candidates = copy(input.candidates);
    if (job.cost > 0) {
      const account = this.credits.get(job.userId);
      if (!account) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
      const entries = this.ledger.get(job.userId) ?? [];
      if (!entries.some((entry) => entry.reason === "generation_settled" && entry.referenceId === job.id)) {
        entries.push({
          id: randomUUID(),
          userId: job.userId,
          delta: 0,
          balanceAfter: account.balance,
          reason: "generation_settled",
          referenceId: job.id,
          createdAt: input.now,
        });
        this.ledger.set(job.userId, entries);
      }
    }
    return copy(job);
  }

  async failGenerationJob(input: Parameters<AppStore["failGenerationJob"]>[0]): Promise<GenerationJob> {
    const job = this.jobs.get(input.jobId);
    const active = job && ["preprocessing", "generating", "mapping_colors", "finalizing"].includes(job.status);
    if (!job || !active || job.leaseToken !== input.leaseToken) {
      throw new AppError(409, "GENERATION_LEASE_LOST", "生成任务租约已失效");
    }
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.errorCode = input.code;
    job.errorMessage = input.message;
    job.updatedAt = input.now;
    if (input.retryable && job.attemptCount < job.maxAttempts) {
      job.status = "retry_wait";
      job.availableAt = input.availableAt;
    } else {
      job.status = "failed";
      this.releaseGenerationCredits(job, input.now);
    }
    return copy(job);
  }

  async cancelGenerationJob(userId: string, jobId: string, now: string): Promise<GenerationJob> {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) throw new AppError(404, "GENERATION_JOB_NOT_FOUND", "生成任务不存在");
    if (job.status === "canceled") return copy(job);
    if (["completed", "accepted", "failed"].includes(job.status)) {
      throw new AppError(409, "GENERATION_NOT_CANCELABLE", "生成任务当前状态不能取消", { status: job.status });
    }
    job.status = "canceled";
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = now;
    job.canceledAt = now;
    this.releaseGenerationCredits(job, now);
    return copy(job);
  }

  async acceptGenerationCandidate(input: Parameters<AppStore["acceptGenerationCandidate"]>[0]): Promise<{ job: GenerationJob; project: ProjectDetail }> {
    const job = this.jobs.get(input.jobId);
    if (!job || job.userId !== input.userId) throw new AppError(404, "GENERATION_JOB_NOT_FOUND", "生成任务不存在");
    if (job.status !== "completed" && job.status !== "accepted") {
      throw new AppError(409, "GENERATION_NOT_READY", "生成任务尚未完成", { status: job.status });
    }
    const candidate = job.candidates.find((item) => item.id === input.candidateId);
    if (!candidate) throw new AppError(404, "GENERATION_CANDIDATE_NOT_FOUND", "生成候选不存在");
    const variantOutputs = job.candidates.filter((item) => item.variantOrdinal === candidate.variantOrdinal);
    if (candidate.outputSlot !== "combined" || variantOutputs.length !== 1) {
      throw new AppError(
        409,
        "GENERATION_CANDIDATE_REQUIRES_VARIANT_ACCEPT",
        "多输出生成方案必须通过方案采用接口原子创建全部项目",
      );
    }
    if (job.acceptedCandidateId) {
      throw new AppError(409, "GENERATION_ALREADY_ACCEPTED", "该任务已有采用的候选方案");
    }
    if (job.status !== "completed") {
      throw new AppError(409, "GENERATION_NOT_READY", "生成任务尚未完成", { status: job.status });
    }
    if (candidate.acceptedAt) {
      throw new AppError(409, "GENERATION_CANDIDATE_ALREADY_ACCEPTED", "该候选已采用为项目", {
        projectId: candidate.acceptedProjectId,
      });
    }
    const palette = this.palettes.get(job.paletteId);
    if (!palette || (palette.ownerUserId && palette.ownerUserId !== input.userId)) {
      throw new AppError(500, "PALETTE_NOT_FOUND", "生成任务色卡不存在");
    }
    const project = this.createProjectNow(input.userId, {
      name: input.projectName,
      paletteId: job.paletteId,
      grid: candidate.grid,
      mode: job.kind,
      lifecycleStatus: "editable",
      sourceAssetId: job.sourceAssetId
        && this.isAvailableProjectAsset(input.userId, job.sourceAssetId, "ai-source")
        ? job.sourceAssetId
        : null,
      previewAssetId: null,
      backgroundMode: job.options.transparentBackground ? "transparent" : "white",
      backgroundColor: null,
    });
    candidate.acceptedProjectId = project.id;
    candidate.acceptedAt = project.updatedAt;
    job.status = "accepted";
    job.acceptedCandidateId ??= candidate.id;
    job.updatedAt = project.updatedAt;
    return copy({ job, project });
  }

  async acceptGenerationVariant(
    input: Parameters<AppStore["acceptGenerationVariant"]>[0],
  ): ReturnType<AppStore["acceptGenerationVariant"]> {
    const job = this.jobs.get(input.jobId);
    if (!job || job.userId !== input.userId) {
      throw new AppError(404, "GENERATION_JOB_NOT_FOUND", "生成任务不存在");
    }
    if (job.status !== "completed" || job.acceptedCandidateId !== null) {
      throw new AppError(409, "GENERATION_VARIANT_ALREADY_ACCEPTED", "该生成任务已有采用结果");
    }
    const expectedSlots = generationOutputSlots(job.kind, job.options);
    const variant = job.candidates
      .filter((candidate) => candidate.variantOrdinal === input.variantOrdinal)
      .sort((left, right) => left.ordinal - right.ordinal);
    if (variant.length === 0) {
      throw new AppError(404, "GENERATION_VARIANT_NOT_FOUND", "生成方案不存在");
    }
    if (variant.length !== expectedSlots.length
      || expectedSlots.some((slot) => !variant.some((candidate) => candidate.outputSlot === slot))) {
      throw new AppError(409, "GENERATION_VARIANT_OUTPUTS_INVALID", "生成方案输出不完整");
    }
    if (variant.some((candidate) => candidate.acceptedAt !== undefined)) {
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

    // Preflight aggregate project quotas so a two-output plan cannot leave one
    // project behind if the second output would exceed a limit.
    const userProjects = [...this.projects.values()]
      .filter((record) => record.summary.userId === input.userId);
    const activeCount = userProjects.filter((record) => !this.deletedProjects.has(record.summary.id)).length;
    if (activeCount + variant.length > MAX_ACTIVE_PROJECTS_PER_USER) {
      throw new AppError(429, "PROJECT_LIMIT_EXCEEDED", "活动作品数量已达到上限", {
        limit: MAX_ACTIVE_PROJECTS_PER_USER,
      });
    }
    if (userProjects.length + variant.length > MAX_PROJECT_HISTORY_PER_USER) {
      throw new AppError(429, "PROJECT_HISTORY_LIMIT_EXCEEDED", "作品历史记录已达到上限", {
        limit: MAX_PROJECT_HISTORY_PER_USER,
        retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
      });
    }
    const retainedCells = userProjects.reduce((sum, record) => sum + record.revisions.reduce(
      (revisionSum, revision) => revisionSum + revision.grid.cells.length,
      0,
    ), 0);
    const newCells = variant.reduce((sum, candidate) => sum + candidate.grid.cells.length, 0);
    if (retainedCells + newCells > MAX_PROJECT_REVISION_CELLS_PER_USER) {
      throw new AppError(429, "PROJECT_STORAGE_LIMIT_EXCEEDED", "作品图纸历史占用已达到上限", {
        limitCells: MAX_PROJECT_REVISION_CELLS_PER_USER,
      });
    }
    const palette = this.palettes.get(job.paletteId);
    if (!palette || (palette.ownerUserId && palette.ownerUserId !== input.userId)) {
      throw new AppError(500, "PALETTE_NOT_FOUND", "生成任务色卡不存在");
    }

    const acceptedAt = new Date().toISOString();
    const previousStatus = job.status;
    const previousAcceptedCandidateId = job.acceptedCandidateId;
    const previousUpdatedAt = job.updatedAt;
    for (const candidate of variant) candidate.acceptedAt = acceptedAt;
    job.status = "accepted";
    job.acceptedCandidateId = variant[0]!.id;
    job.updatedAt = acceptedAt;
    const createdProjectIds: string[] = [];
    try {
      const outputs = [] as Awaited<ReturnType<AppStore["acceptGenerationVariant"]>>["outputs"];
      for (const candidate of variant) {
        const project = this.createProjectNow(input.userId, {
          name: requestedNames.get(candidate.outputSlot)!,
          paletteId: job.paletteId,
          grid: candidate.grid,
          mode: job.kind,
          lifecycleStatus: "editable",
          sourceAssetId: job.sourceAssetId
            && this.isAvailableProjectAsset(input.userId, job.sourceAssetId, "ai-source")
            ? job.sourceAssetId
            : null,
          previewAssetId: null,
          backgroundMode: job.options.transparentBackground ? "transparent" : "white",
          backgroundColor: null,
        });
        createdProjectIds.push(project.id);
        candidate.acceptedProjectId = project.id;
        outputs.push({ candidateId: candidate.id, outputSlot: candidate.outputSlot, project });
      }
      return copy({ job, variantOrdinal: input.variantOrdinal, outputs });
    } catch (error) {
      for (const projectId of createdProjectIds) {
        this.projects.delete(projectId);
        this.deletedProjects.delete(projectId);
        this.projectDrafts.delete(projectId);
        this.progress.delete(projectId);
      }
      for (const candidate of variant) {
        delete candidate.acceptedAt;
        delete candidate.acceptedProjectId;
      }
      job.status = previousStatus;
      job.acceptedCandidateId = previousAcceptedCandidateId;
      job.updatedAt = previousUpdatedAt;
      throw error;
    }
  }

  async executeIdempotent<T>(
    input: { userId: string; scope: string; key: string; requestHash: string },
    operation: (transactionStore: AppStore) => Promise<IdempotentOperationResult<T>>,
  ): Promise<IdempotentExecutionResult<T>> {
    const recordKey = `${input.userId}:${input.scope}:${input.key}`;
    const lockKey = input.userId;
    const previous = this.idempotencyLocks.get(lockKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.idempotencyLocks.set(lockKey, tail);
    await previous;
    try {
      const cutoff = Date.now() - OPERATIONAL_HISTORY_RETENTION_MILLISECONDS;
      for (const [key, record] of this.idempotency) {
        if (key.startsWith(`${input.userId}:`)
          && !key.startsWith(`${input.userId}:payment-orders:create:`)
          && Date.parse(record.createdAt) < cutoff) {
          this.idempotency.delete(key);
        }
      }
      const existing = this.idempotency.get(recordKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
        }
        return {
          statusCode: existing.statusCode,
          body: copy(existing.body) as T,
          replayed: true,
        };
      }
      const recordCount = [...this.idempotency.keys()].filter((key) =>
        key.startsWith(`${input.userId}:`)
        && !key.startsWith(`${input.userId}:payment-orders:create:`)).length;
      if (recordCount >= MAX_IDEMPOTENCY_RECORDS_PER_USER) {
        throw new AppError(429, "IDEMPOTENCY_HISTORY_LIMIT_EXCEEDED", "幂等请求历史记录已达到上限", {
          limit: MAX_IDEMPOTENCY_RECORDS_PER_USER,
          retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
        });
      }
      const result = await operation(this);
      this.idempotency.set(recordKey, copy({
        requestHash: input.requestHash,
        statusCode: result.statusCode,
        body: result.body,
        createdAt: new Date().toISOString(),
      }));
      return { ...copy(result), replayed: false };
    } finally {
      release();
      if (this.idempotencyLocks.get(lockKey) === tail) this.idempotencyLocks.delete(lockKey);
    }
  }

  async executePaymentEffectIdempotent<T>(
    input: PaymentEffectFence,
    operation: (transactionStore: AppStore) => Promise<IdempotentOperationResult<T>>,
  ): Promise<IdempotentExecutionResult<T>> {
    return this.withPaymentEffectLock(input, async () => {
      this.assertActivePaymentEffectFence(input);
      const restorers = [
        restoreMapSnapshot(this.idempotency),
        restoreMapSnapshot(this.credits),
        restoreMapSnapshot(this.ledger),
        restoreMapSnapshot(this.paymentOrders),
        restoreMapSnapshot(this.paymentReconciliationJobs),
        restoreMapSnapshot(this.paymentOrderSlots),
        restoreMapSnapshot(this.paymentOrderAttempts),
        restoreMapSnapshot(this.paymentEvents),
      ];
      try {
        const result = await this.executeIdempotent(input, operation);
        // Match the PostgreSQL final CAS: an operation whose ownership expired
        // during its local commit must leave no business or idempotency writes.
        this.assertActivePaymentEffectFence(input);
        this.paymentEffectClaims.delete(this.paymentEffectClaimKey(input));
        return result;
      } catch (error) {
        for (const restore of restorers.reverse()) restore();
        throw error;
      }
    });
  }

  async getIdempotent<T>(input: {
    userId: string;
    scope: string;
    key: string;
    requestHash: string;
  }): Promise<IdempotentExecutionResult<T> | null> {
    const recordKey = `${input.userId}:${input.scope}:${input.key}`;
    const existing = this.idempotency.get(recordKey);
    if (!existing) return null;
    if (input.scope !== "payment-orders:create"
      && Date.parse(existing.createdAt) < Date.now() - OPERATIONAL_HISTORY_RETENTION_MILLISECONDS) {
      this.idempotency.delete(recordKey);
      return null;
    }
    if (existing.requestHash !== input.requestHash) {
      throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
    }
    return {
      statusCode: existing.statusCode,
      body: copy(existing.body) as T,
      replayed: true,
    };
  }

  async claimPaymentEffect(input: Parameters<AppStore["claimPaymentEffect"]>[0]): Promise<PaymentEffectClaimResult> {
    return this.withPaymentEffectLock(input, async () => {
      const retentionCutoff = Date.parse(input.now) - OPERATIONAL_HISTORY_RETENTION_MILLISECONDS;
      for (const [key, claim] of this.paymentEffectClaims) {
        if (key.startsWith(`${input.userId}:`)
          && Date.parse(claim.leaseExpiresAt) <= Date.parse(input.now)
          && Date.parse(claim.updatedAt) < retentionCutoff) {
          this.paymentEffectClaims.delete(key);
        }
      }
      const claimKey = this.paymentEffectClaimKey(input);
      const existing = this.paymentEffectClaims.get(claimKey);
      if (existing && existing.requestHash !== input.requestHash) {
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该 Idempotency-Key 已用于不同请求");
      }
      if (existing && Date.parse(existing.leaseExpiresAt) > Date.parse(input.now)) {
        return { acquired: false, leaseExpiresAt: existing.leaseExpiresAt };
      }
      if (!existing) {
        const claimCount = [...this.paymentEffectClaims.keys()].filter((key) =>
          key.startsWith(`${input.userId}:`)).length;
        if (claimCount >= MAX_PAYMENT_EFFECT_CLAIMS_PER_USER) {
          throw new AppError(429, "PAYMENT_EFFECT_CLAIM_LIMIT_EXCEEDED", "支付请求占用历史已达到上限", {
            limit: MAX_PAYMENT_EFFECT_CLAIMS_PER_USER,
          });
        }
      }
      this.paymentEffectClaims.set(claimKey, {
        requestHash: input.requestHash,
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
        createdAt: input.now,
        updatedAt: input.now,
      });
      return { acquired: true, leaseExpiresAt: input.leaseExpiresAt };
    });
  }

  async renewPaymentEffectClaim(input: Parameters<AppStore["renewPaymentEffectClaim"]>[0]): Promise<boolean> {
    return this.withPaymentEffectLock(input, async () => {
      const existing = this.paymentEffectClaims.get(this.paymentEffectClaimKey(input));
      if (!existing || existing.leaseToken !== input.leaseToken
        || Date.parse(existing.leaseExpiresAt) <= Date.parse(input.now)) return false;
      existing.leaseExpiresAt = input.leaseExpiresAt;
      existing.updatedAt = input.now;
      return true;
    });
  }

  async releasePaymentEffectClaim(input: Parameters<AppStore["releasePaymentEffectClaim"]>[0]): Promise<boolean> {
    return this.withPaymentEffectLock(input, async () => {
      const existing = this.paymentEffectClaims.get(this.paymentEffectClaimKey(input));
      if (!existing || existing.leaseToken !== input.leaseToken) return false;
      existing.leaseExpiresAt = input.releasedAt;
      existing.updatedAt = input.releasedAt;
      return true;
    });
  }

  async completePaymentEffectClaim(input: Parameters<AppStore["completePaymentEffectClaim"]>[0]): Promise<boolean> {
    return this.withPaymentEffectLock(input, async () => {
      const claimKey = this.paymentEffectClaimKey(input);
      const existing = this.paymentEffectClaims.get(claimKey);
      if (!existing || existing.leaseToken !== input.leaseToken) return false;
      this.paymentEffectClaims.delete(claimKey);
      return true;
    });
  }

  async createExportJob(input: Parameters<AppStore["createExportJob"]>[0]): Promise<ExportJobRecord> {
    const record = this.projects.get(input.projectId);
    const revision = record?.summary.userId === input.userId && !this.deletedProjects.has(input.projectId)
      ? record.revisions.find((candidate) => candidate.revision === input.projectRevision)
      : undefined;
    if (!revision) throw new AppError(404, "PROJECT_REVISION_NOT_FOUND", "项目或指定版本不存在");
    this.requireSelectablePalette(revision.paletteId, input.userId);
    const historyCutoff = Date.parse(input.now) - OPERATIONAL_HISTORY_RETENTION_MILLISECONDS;
    for (const [jobId, job] of this.exportJobs) {
      const artifactCanBeForgotten = job.artifact === null || this.purgedExportArtifacts.has(job.artifact.id);
      const hasPendingArtifact = [...this.pendingExportArtifacts.values()].some((pending) =>
        pending.artifact.jobId === job.id && !this.purgedExportArtifacts.has(pending.artifact.id));
      if (job.userId === input.userId
        && ["succeeded", "failed", "canceled"].includes(job.status)
        && Date.parse(job.updatedAt) < historyCutoff
        && artifactCanBeForgotten
        && !hasPendingArtifact) {
        this.exportJobs.delete(jobId);
        if (job.artifact) this.purgedExportArtifacts.delete(job.artifact.id);
      }
    }
    const activeJobCount = [...this.exportJobs.values()].filter((job) =>
      job.userId === input.userId && ["queued", "running", "retry_wait"].includes(job.status)).length;
    if (activeJobCount >= MAX_ACTIVE_EXPORT_JOBS_PER_USER) {
      throw new AppError(429, "EXPORT_ACTIVE_LIMIT_EXCEEDED", "同时处理的导出任务已达到上限", {
        limit: MAX_ACTIVE_EXPORT_JOBS_PER_USER,
      });
    }
    const historyCount = [...this.exportJobs.values()].filter((job) => job.userId === input.userId).length;
    if (historyCount >= MAX_EXPORT_HISTORY_PER_USER) {
      throw new AppError(429, "EXPORT_HISTORY_LIMIT_EXCEEDED", "导出历史记录已达到上限", {
        limit: MAX_EXPORT_HISTORY_PER_USER,
        retentionDays: OPERATIONAL_HISTORY_RETENTION_MILLISECONDS / 86_400_000,
      });
    }
    const job: ExportJobRecord = {
      id: input.id,
      userId: input.userId,
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      format: input.format,
      fileName: input.fileName,
      options: copy(input.options),
      status: "queued",
      progress: 0,
      attemptCount: 0,
      maxAttempts: 3,
      availableAt: input.now,
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: input.now,
      updatedAt: input.now,
      finishedAt: null,
      artifact: null,
    };
    this.exportJobs.set(job.id, copy(job));
    return copy(job);
  }

  async listExportJobs(userId: string, limit: number, offset = 0): Promise<ExportJobRecord[]> {
    return copy([...this.exportJobs.values()]
      .filter((job) => job.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(offset, offset + limit));
  }

  async getExportJobStats(userId: string): Promise<ExportJobStats> {
    let total = 0;
    let succeeded = 0;
    for (const job of this.exportJobs.values()) {
      if (job.userId !== userId) continue;
      total += 1;
      if (job.status === "succeeded") succeeded += 1;
    }
    return { total, succeeded };
  }

  async getExportJob(userId: string, exportJobId: string): Promise<ExportJobRecord | null> {
    const job = this.exportJobs.get(exportJobId);
    return job?.userId === userId ? copy(job) : null;
  }

  async claimNextExportJob(input: Parameters<AppStore["claimNextExportJob"]>[0]): Promise<ExportJobRecord | null> {
    const leaseWindow = resolveInMemoryWorkerLeaseWindow(input);
    for (const job of this.exportJobs.values()) {
      if (job.status === "running" && job.leaseExpiresAt
        && Date.parse(job.leaseExpiresAt) <= leaseWindow.nowMilliseconds) {
        job.status = job.attemptCount >= job.maxAttempts ? "failed" : "retry_wait";
        job.availableAt = leaseWindow.now;
        job.leaseToken = null;
        job.leaseExpiresAt = null;
        job.errorCode = "EXPORT_LEASE_EXPIRED";
        job.errorMessage = "导出 worker 租约已过期";
        job.updatedAt = leaseWindow.now;
        if (job.status === "failed") job.finishedAt = leaseWindow.now;
      }
    }
    const next = [...this.exportJobs.values()]
      .filter((job) => (job.status === "queued" || job.status === "retry_wait")
        && Date.parse(job.availableAt) <= leaseWindow.nowMilliseconds)
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt) || left.createdAt.localeCompare(right.createdAt))[0];
    if (!next) return null;
    next.status = "running";
    next.progress = Math.max(next.progress, 5);
    next.attemptCount += 1;
    next.leaseToken = input.leaseToken;
    next.leaseExpiresAt = leaseWindow.leaseExpiresAt;
    next.errorCode = null;
    next.errorMessage = null;
    next.updatedAt = leaseWindow.now;
    return copy(next);
  }

  async renewExportJobLease(input: Parameters<AppStore["renewExportJobLease"]>[0]): Promise<boolean> {
    const leaseWindow = resolveInMemoryWorkerLeaseWindow(input);
    const job = this.exportJobs.get(input.jobId);
    if (!job || job.status !== "running" || job.leaseToken !== input.leaseToken || !job.leaseExpiresAt
      || Date.parse(job.leaseExpiresAt) <= leaseWindow.nowMilliseconds) return false;
    job.leaseExpiresAt = leaseWindow.leaseExpiresAt;
    job.updatedAt = leaseWindow.now;
    return true;
  }

  async prepareExportArtifact(input: Parameters<AppStore["prepareExportArtifact"]>[0]): Promise<void> {
    const job = this.exportJobs.get(input.jobId);
    if (!job || job.status !== "running" || job.leaseToken !== input.leaseToken
      || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.parse(input.now)) {
      throw new AppError(409, "EXPORT_LEASE_LOST", "导出任务租约已失效");
    }
    if (input.artifact.jobId !== input.jobId) {
      throw new AppError(500, "EXPORT_ARTIFACT_MISMATCH", "导出制品与任务不匹配");
    }
    const existing = this.pendingExportArtifacts.get(input.artifact.id);
    if (existing) {
      if (existing.userId !== job.userId
        || JSON.stringify(existing.artifact) !== JSON.stringify(input.artifact)) {
        throw new AppError(409, "EXPORT_ARTIFACT_IDENTITY_CONFLICT", "导出制品身份冲突");
      }
      if (existing.abandonedAt) {
        throw new AppError(409, "EXPORT_ARTIFACT_ABANDONED", "导出制品发布窗口已关闭");
      }
      return;
    }
    const storageKeyInUse = [...this.pendingExportArtifacts.values()].some((pending) =>
      pending.artifact.storageKey === input.artifact.storageKey)
      || [...this.exportJobs.values()].some((candidate) =>
        candidate.artifact?.storageKey === input.artifact.storageKey);
    if (storageKeyInUse) {
      throw new AppError(409, "EXPORT_ARTIFACT_IDENTITY_CONFLICT", "导出制品存储键冲突");
    }
    const unpurgedArtifacts = [
      ...[...this.pendingExportArtifacts.values()]
        .filter((pending) => pending.userId === job.userId
          && !this.purgedExportArtifacts.has(pending.artifact.id))
        .map((pending) => pending.artifact),
      ...[...this.exportJobs.values()]
        .filter((candidate) => candidate.userId === job.userId
          && candidate.artifact
          && !this.purgedExportArtifacts.has(candidate.artifact.id))
        .map((candidate) => candidate.artifact!),
    ];
    const retainedBytes = unpurgedArtifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
    if (unpurgedArtifacts.length >= MAX_UNPURGED_EXPORT_ARTIFACTS_PER_USER
      || retainedBytes + input.artifact.sizeBytes > MAX_UNPURGED_EXPORT_ARTIFACT_BYTES_PER_USER) {
      throw new AppError(429, "EXPORT_ARTIFACT_STORAGE_LIMIT_EXCEEDED", "导出制品存储空间已达到上限", {
        maxArtifacts: MAX_UNPURGED_EXPORT_ARTIFACTS_PER_USER,
        maxBytes: MAX_UNPURGED_EXPORT_ARTIFACT_BYTES_PER_USER,
      });
    }
    this.pendingExportArtifacts.set(input.artifact.id, {
      artifact: copy(input.artifact),
      userId: job.userId,
      abandonedAt: null,
    });
  }

  async completeExportJob(input: Parameters<AppStore["completeExportJob"]>[0]): Promise<ExportJobRecord> {
    const job = this.exportJobs.get(input.jobId);
    if (!job || job.status !== "running" || job.leaseToken !== input.leaseToken
      || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.parse(input.now)) {
      throw new AppError(409, "EXPORT_LEASE_LOST", "导出任务租约已失效");
    }
    const pending = this.pendingExportArtifacts.get(input.artifact.id);
    if (!pending || pending.userId !== job.userId
      || pending.abandonedAt !== null
      || pending.artifact.jobId !== input.jobId
      || pending.artifact.storageKey !== input.artifact.storageKey
      || pending.artifact.sha256 !== input.artifact.sha256) {
      throw new AppError(409, "EXPORT_ARTIFACT_NOT_PREPARED", "导出制品尚未登记");
    }
    job.status = "succeeded";
    job.progress = 100;
    job.artifact = copy(input.artifact);
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.errorCode = null;
    job.errorMessage = null;
    job.updatedAt = input.now;
    job.finishedAt = input.now;
    this.pendingExportArtifacts.delete(input.artifact.id);
    const project = this.projects.get(job.projectId);
    if (project && !this.deletedProjects.has(job.projectId)
      && project.summary.currentRevision === job.projectRevision) {
      project.summary.lifecycleStatus = "exported";
      project.summary.metadataRevision += 1;
      project.summary.updatedAt = input.now;
    }
    return copy(job);
  }

  async failExportJob(input: Parameters<AppStore["failExportJob"]>[0]): Promise<ExportJobRecord> {
    const job = this.exportJobs.get(input.jobId);
    if (!job || job.status !== "running" || job.leaseToken !== input.leaseToken) {
      throw new AppError(409, "EXPORT_LEASE_LOST", "导出任务租约已失效");
    }
    const shouldRetry = input.retryable && job.attemptCount < job.maxAttempts;
    job.status = shouldRetry ? "retry_wait" : "failed";
    job.availableAt = input.availableAt;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.errorCode = input.code;
    job.errorMessage = input.message.slice(0, 500);
    job.updatedAt = input.now;
    job.finishedAt = shouldRetry ? null : input.now;
    return copy(job);
  }

  async cancelExportJob(userId: string, exportJobId: string, now: string): Promise<ExportJobRecord> {
    const job = this.exportJobs.get(exportJobId);
    if (!job || job.userId !== userId) throw new AppError(404, "EXPORT_JOB_NOT_FOUND", "导出任务不存在");
    if (job.status === "succeeded") throw new AppError(409, "EXPORT_ALREADY_FINISHED", "已完成的导出不能取消");
    if (job.status === "failed" || job.status === "canceled") return copy(job);
    job.status = "canceled";
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = now;
    job.finishedAt = now;
    return copy(job);
  }

  async listExportArtifactsForPurge(now: string, limit: number): Promise<ExportArtifactPurgeRecord[]> {
    const nowMillis = Date.parse(now);
    const stalePendingBefore = nowMillis - EXPORT_ARTIFACT_PUBLISH_TIMEOUT_MILLISECONDS;
    const pending = [...this.pendingExportArtifacts.values()]
      .filter(({ artifact }) => !this.purgedExportArtifacts.has(artifact.id)
        && Date.parse(artifact.createdAt) <= stalePendingBefore
        && Date.parse(this.exportArtifactPurgeState.get(artifact.id)?.availableAt
          ?? artifact.createdAt) <= nowMillis)
      .map(({ artifact, userId }) => ({ ...artifact, userId, priority: 0 }));
    const ready = [...this.exportJobs.values()]
      .flatMap((job) => job.artifact && !this.purgedExportArtifacts.has(job.artifact.id)
        && Date.parse(job.artifact.expiresAt) <= nowMillis
        && Date.parse(this.exportArtifactPurgeState.get(job.artifact.id)?.availableAt
          ?? job.artifact.createdAt) <= nowMillis
        ? [{ ...job.artifact, userId: job.userId, priority: 1 }]
        : []);
    return copy([...pending, ...ready]
      .sort((left, right) => left.priority - right.priority
        || (left.priority === 0 ? left.createdAt.localeCompare(right.createdAt) : left.expiresAt.localeCompare(right.expiresAt))
        || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(({ priority: _priority, ...artifact }) => artifact));
  }

  async claimExportArtifactForPurge(
    artifactId: string,
    now: string,
  ): Promise<ExportArtifactPurgeRecord | null> {
    const nowMillis = Date.parse(now);
    const stalePendingBefore = nowMillis - EXPORT_ARTIFACT_PUBLISH_TIMEOUT_MILLISECONDS;
    const pending = this.pendingExportArtifacts.get(artifactId);
    if (pending && !this.purgedExportArtifacts.has(artifactId)
      && Date.parse(pending.artifact.createdAt) <= stalePendingBefore) {
      const purgeState = this.exportArtifactPurgeState.get(artifactId);
      if (Date.parse(purgeState?.availableAt ?? pending.artifact.createdAt) > nowMillis) return null;
      this.exportArtifactPurgeState.set(artifactId, {
        attemptCount: purgeState?.attemptCount ?? 0,
        availableAt: new Date(nowMillis + PURGE_CLAIM_MILLISECONDS).toISOString(),
      });
      pending.abandonedAt ??= now;
      return copy({ ...pending.artifact, userId: pending.userId });
    }
    const job = [...this.exportJobs.values()].find((candidate) => candidate.artifact?.id === artifactId);
    const artifact = job?.artifact;
    if (!job || !artifact || this.purgedExportArtifacts.has(artifactId)
      || Date.parse(artifact.expiresAt) > nowMillis) return null;
    const purgeState = this.exportArtifactPurgeState.get(artifactId);
    if (Date.parse(purgeState?.availableAt ?? artifact.createdAt) > nowMillis) return null;
    this.exportArtifactPurgeState.set(artifactId, {
      attemptCount: purgeState?.attemptCount ?? 0,
      availableAt: new Date(nowMillis + PURGE_CLAIM_MILLISECONDS).toISOString(),
    });
    return copy({ ...artifact, userId: job.userId });
  }

  async recordExportArtifactPurgeFailure(artifactId: string, failedAt: string): Promise<void> {
    const job = [...this.exportJobs.values()].find((candidate) => candidate.artifact?.id === artifactId);
    if ((!job?.artifact && !this.pendingExportArtifacts.has(artifactId))
      || this.purgedExportArtifacts.has(artifactId)) return;
    const current = this.exportArtifactPurgeState.get(artifactId) ?? { attemptCount: 0, availableAt: failedAt };
    const retryDelay = Math.min(
      PURGE_RETRY_MAX_MILLISECONDS,
      PURGE_RETRY_BASE_MILLISECONDS * (2 ** Math.min(current.attemptCount, 16)),
    );
    this.exportArtifactPurgeState.set(artifactId, {
      attemptCount: current.attemptCount + 1,
      availableAt: new Date(Date.parse(failedAt) + retryDelay).toISOString(),
    });
  }

  async markExportArtifactPurged(artifactId: string, _purgedAt: string): Promise<void> {
    this.purgedExportArtifacts.add(artifactId);
    this.pendingExportArtifacts.delete(artifactId);
    this.exportArtifactPurgeState.delete(artifactId);
  }

  async listCreditProducts(): Promise<CreditProduct[]> {
    return copy([...this.creditProducts.values()].filter((product) => product.enabled));
  }

  async getCreditProduct(productId: string, version: number): Promise<CreditProduct | null> {
    const product = this.creditProducts.get(`${productId}:${version}`);
    return product?.enabled ? copy(product) : null;
  }

  async reservePaymentOrderSlot(
    input: Parameters<AppStore["reservePaymentOrderSlot"]>[0],
  ): ReturnType<AppStore["reservePaymentOrderSlot"]> {
    return this.withPaymentEffectLock(input.effectFence, async () => {
      const restoreSlots = restoreMapSnapshot(this.paymentOrderSlots);
      const restoreAttempts = restoreMapSnapshot(this.paymentOrderAttempts);
      const finish = (reservation: PaymentOrderSlotReservation): PaymentOrderSlotReservation => {
        this.assertActivePaymentEffectFence(input.effectFence);
        return reservation;
      };
      try {
        this.assertActivePaymentEffectFence(input.effectFence);
        const nowMillis = Date.parse(input.now);
        const persistedOrder = [...this.paymentOrders.values()].find((order) =>
          order.id === input.orderId || order.outTradeNo === input.outTradeNo);
        if (persistedOrder) {
          if (persistedOrder.id !== input.orderId
            || persistedOrder.userId !== input.userId
            || persistedOrder.outTradeNo !== input.outTradeNo) {
            throw new AppError(409, "PAYMENT_ORDER_IDENTITY_CONFLICT", "支付订单身份已被其他请求占用");
          }
          const latestAttempt = [...this.paymentOrderAttempts.values()]
            .filter((attempt) => attempt.orderId === persistedOrder.id)
            .sort((left, right) => right.attemptNo - left.attemptNo)[0];
          return finish({
            attemptNo: latestAttempt?.attemptNo ?? 1,
            outTradeNo: persistedOrder.outTradeNo,
            expiresAt: persistedOrder.paymentExpiresAt,
            expired: Date.parse(persistedOrder.paymentExpiresAt) <= nowMillis,
            created: false,
            state: latestAttempt?.state ?? "created",
            recoveryCiphertext: latestAttempt?.recoveryCiphertext ?? null,
            providerReferenceSha256: latestAttempt?.providerReferenceSha256 ?? null,
          });
        }
        const existing = this.paymentOrderSlots.get(input.orderId);
        if (existing) {
          if (existing.userId !== input.userId) {
            throw new AppError(409, "PAYMENT_ORDER_IDENTITY_CONFLICT", "支付订单身份已被其他请求占用");
          }
          const attempt = this.paymentOrderAttempts.get(`${input.orderId}:${existing.attemptNo}`);
          if (!attempt) throw new AppError(500, "PAYMENT_RECOVERY_STATE_INVALID", "支付恢复记录不完整");
          return finish({
            attemptNo: attempt.attemptNo,
            outTradeNo: attempt.outTradeNo,
            expiresAt: existing.expiresAt,
            expired: Date.parse(existing.expiresAt) <= nowMillis,
            created: false,
            state: attempt.state,
            recoveryCiphertext: attempt.recoveryCiphertext,
            providerReferenceSha256: attempt.providerReferenceSha256,
          });
        }
        const duplicateTrade = [...this.paymentOrderAttempts.values()].find((attempt) =>
          attempt.outTradeNo === input.outTradeNo);
        if (duplicateTrade) {
          throw new AppError(409, "PAYMENT_ORDER_IDENTITY_CONFLICT", "支付交易号已被其他请求占用");
        }
        const pendingOrders = [...this.paymentOrders.values()].filter((order) =>
          order.userId === input.userId
          && order.status === "pending"
          && Date.parse(order.paymentExpiresAt) > nowMillis).length;
        const reservedSlots = [...this.paymentOrderSlots.values()].filter((slot) =>
          slot.userId === input.userId && Date.parse(slot.expiresAt) > nowMillis).length;
        if (pendingOrders + reservedSlots >= MAX_PENDING_PAYMENT_ORDERS_PER_USER) {
          throw new AppError(429, "PAYMENT_PENDING_LIMIT_EXCEEDED", "待支付订单数量已达到上限", {
            limit: MAX_PENDING_PAYMENT_ORDERS_PER_USER,
          });
        }
        const slotHistoryCount = [...this.paymentOrderAttempts.values()].filter((attempt) =>
          attempt.userId === input.userId).length;
        if (slotHistoryCount >= MAX_PAYMENT_ORDER_SLOT_HISTORY_PER_USER) {
          throw new AppError(429, "PAYMENT_ORDER_SLOT_HISTORY_LIMIT_EXCEEDED", "支付订单尝试历史已达到上限", {
            limit: MAX_PAYMENT_ORDER_SLOT_HISTORY_PER_USER,
          });
        }
        this.paymentOrderSlots.set(input.orderId, {
          userId: input.userId,
          outTradeNo: input.outTradeNo,
          expiresAt: input.expiresAt,
          attemptNo: 1,
        });
        this.paymentOrderAttempts.set(`${input.orderId}:1`, {
          orderId: input.orderId,
          userId: input.userId,
          outTradeNo: input.outTradeNo,
          expiresAt: input.expiresAt,
          attemptNo: 1,
          state: "reserved",
          recoveryCiphertext: null,
          providerReferenceSha256: null,
          createdAt: input.now,
          updatedAt: input.now,
        });
        return finish({
          attemptNo: 1,
          outTradeNo: input.outTradeNo,
          expiresAt: input.expiresAt,
          expired: Date.parse(input.expiresAt) <= nowMillis,
          created: true,
          state: "reserved",
          recoveryCiphertext: null,
          providerReferenceSha256: null,
        });
      } catch (error) {
        restoreAttempts();
        restoreSlots();
        throw error;
      }
    });
  }

  async releasePaymentOrderSlot(
    input: Parameters<AppStore["releasePaymentOrderSlot"]>[0],
  ): ReturnType<AppStore["releasePaymentOrderSlot"]> {
    return this.withPaymentEffectLock(input.effectFence, async () => {
      this.assertActivePaymentEffectFence(input.effectFence);
      const existing = this.paymentOrderSlots.get(input.orderId);
      if (!existing || existing.userId !== input.userId) return false;
      this.paymentOrderSlots.delete(input.orderId);
      const attempt = this.paymentOrderAttempts.get(`${input.orderId}:${existing.attemptNo}`);
      if (attempt?.state === "reserved") {
        this.paymentOrderAttempts.delete(`${input.orderId}:${existing.attemptNo}`);
      }
      return true;
    });
  }

  async getPaymentOrderRecoveryAttempt(
    userId: string,
    orderId: string,
  ): Promise<PaymentOrderSlotReservation | null> {
    const attempts = [...this.paymentOrderAttempts.values()]
      .filter((attempt) => attempt.orderId === orderId && attempt.userId === userId)
      .sort((left, right) => right.attemptNo - left.attemptNo);
    const attempt = attempts[0];
    if (!attempt) return null;
    return copy({
      attemptNo: attempt.attemptNo,
      outTradeNo: attempt.outTradeNo,
      expiresAt: attempt.expiresAt,
      expired: Date.parse(attempt.expiresAt) <= Date.now(),
      created: false,
      state: attempt.state,
      recoveryCiphertext: attempt.recoveryCiphertext,
      providerReferenceSha256: attempt.providerReferenceSha256,
    });
  }

  async beginPaymentOrderProviderAttempt(
    input: Parameters<AppStore["beginPaymentOrderProviderAttempt"]>[0],
  ): ReturnType<AppStore["beginPaymentOrderProviderAttempt"]> {
    return this.withPaymentEffectLock(input.effectFence, async () => {
      this.assertActivePaymentEffectFence(input.effectFence);
      const slot = this.paymentOrderSlots.get(input.orderId);
      const attempt = slot ? this.paymentOrderAttempts.get(`${input.orderId}:${slot.attemptNo}`) : undefined;
      if (!slot || !attempt || slot.userId !== input.userId || attempt.outTradeNo !== input.outTradeNo) {
        throw new AppError(409, "PAYMENT_RECOVERY_STATE_CHANGED", "支付恢复状态已变化，请重试", null, true);
      }
      if (attempt.state === "reserved") {
        attempt.state = "creating";
        attempt.updatedAt = input.startedAt;
      }
      return copy({
        attemptNo: attempt.attemptNo,
        outTradeNo: attempt.outTradeNo,
        expiresAt: attempt.expiresAt,
        expired: Date.parse(attempt.expiresAt) <= Date.parse(input.startedAt),
        created: false,
        state: attempt.state,
        recoveryCiphertext: attempt.recoveryCiphertext,
        providerReferenceSha256: attempt.providerReferenceSha256,
      });
    });
  }

  async recordPaymentOrderProviderResult(
    input: Parameters<AppStore["recordPaymentOrderProviderResult"]>[0],
  ): ReturnType<AppStore["recordPaymentOrderProviderResult"]> {
    if (!/^[0-9a-f]{64}$/.test(input.providerReferenceSha256)
      || input.recoveryCiphertext.length < 16 || input.recoveryCiphertext.length > 2048) {
      throw new AppError(400, "PAYMENT_RECOVERY_RESULT_INVALID", "支付恢复结果无效");
    }
    return this.withPaymentEffectLock(input.effectFence, async () => {
      this.assertActivePaymentEffectFence(input.effectFence);
      const slot = this.paymentOrderSlots.get(input.orderId);
      const attempt = slot ? this.paymentOrderAttempts.get(`${input.orderId}:${slot.attemptNo}`) : undefined;
      if (!slot || !attempt || slot.userId !== input.userId || attempt.outTradeNo !== input.outTradeNo) {
        throw new AppError(409, "PAYMENT_RECOVERY_STATE_CHANGED", "支付恢复状态已变化，请重试", null, true);
      }
      if (attempt.recoveryCiphertext !== null
        && (attempt.recoveryCiphertext !== input.recoveryCiphertext
          || attempt.providerReferenceSha256 !== input.providerReferenceSha256)) {
        throw new AppError(409, "PAYMENT_RECOVERY_RESULT_CONFLICT", "支付恢复结果发生冲突");
      }
      attempt.state = "created";
      attempt.recoveryCiphertext = input.recoveryCiphertext;
      attempt.providerReferenceSha256 = input.providerReferenceSha256;
      attempt.updatedAt = input.recordedAt;
      return copy({
        attemptNo: attempt.attemptNo,
        outTradeNo: attempt.outTradeNo,
        expiresAt: attempt.expiresAt,
        expired: Date.parse(attempt.expiresAt) <= Date.parse(input.recordedAt),
        created: false,
        state: attempt.state,
        recoveryCiphertext: attempt.recoveryCiphertext,
        providerReferenceSha256: attempt.providerReferenceSha256,
      });
    });
  }

  async rotatePaymentOrderProviderAttempt(
    input: Parameters<AppStore["rotatePaymentOrderProviderAttempt"]>[0],
  ): ReturnType<AppStore["rotatePaymentOrderProviderAttempt"]> {
    return this.withPaymentEffectLock(input.effectFence, async () => {
      this.assertActivePaymentEffectFence(input.effectFence);
      const slot = this.paymentOrderSlots.get(input.orderId);
      const previous = slot ? this.paymentOrderAttempts.get(`${input.orderId}:${slot.attemptNo}`) : undefined;
      if (!slot || !previous || slot.userId !== input.userId || previous.outTradeNo !== input.previousOutTradeNo) {
        throw new AppError(409, "PAYMENT_RECOVERY_STATE_CHANGED", "支付恢复状态已变化，请重试", null, true);
      }
      if ([...this.paymentOrderAttempts.values()].some((attempt) => attempt.outTradeNo === input.nextOutTradeNo)) {
        throw new AppError(409, "PAYMENT_ORDER_IDENTITY_CONFLICT", "支付交易号已被其他请求占用");
      }
      const historyCount = [...this.paymentOrderAttempts.values()].filter((attempt) =>
        attempt.userId === input.userId).length;
      if (historyCount >= MAX_PAYMENT_ORDER_SLOT_HISTORY_PER_USER) {
        throw new AppError(429, "PAYMENT_ORDER_SLOT_HISTORY_LIMIT_EXCEEDED", "支付订单尝试历史已达到上限", {
          limit: MAX_PAYMENT_ORDER_SLOT_HISTORY_PER_USER,
        });
      }
      previous.state = "closed";
      previous.updatedAt = input.rotatedAt;
      const attemptNo = previous.attemptNo + 1;
      const next = {
        orderId: input.orderId,
        userId: input.userId,
        outTradeNo: input.nextOutTradeNo,
        expiresAt: input.expiresAt,
        attemptNo,
        state: "reserved" as const,
        recoveryCiphertext: null,
        providerReferenceSha256: null,
        createdAt: input.rotatedAt,
        updatedAt: input.rotatedAt,
      };
      this.paymentOrderAttempts.set(`${input.orderId}:${attemptNo}`, next);
      this.paymentOrderSlots.set(input.orderId, {
        userId: input.userId,
        outTradeNo: input.nextOutTradeNo,
        expiresAt: input.expiresAt,
        attemptNo,
      });
      return copy({
        attemptNo,
        outTradeNo: input.nextOutTradeNo,
        expiresAt: input.expiresAt,
        expired: Date.parse(input.expiresAt) <= Date.parse(input.rotatedAt),
        created: true,
        state: "reserved",
        recoveryCiphertext: null,
        providerReferenceSha256: null,
      });
    });
  }

  async createPaymentOrder(input: Parameters<AppStore["createPaymentOrder"]>[0]): Promise<PaymentOrderRecord> {
    const authoritative = this.creditProducts.get(`${input.product.id}:${input.product.version}`);
    if (!authoritative?.enabled || JSON.stringify(authoritative) !== JSON.stringify(input.product)) {
      throw new AppError(409, "CREDIT_PRODUCT_CHANGED", "次数商品已更新，请刷新后重试");
    }
    const existingOrder = this.paymentOrders.get(input.id);
    if (existingOrder) {
      const sameIdentity = existingOrder.userId === input.userId
        && existingOrder.outTradeNo === input.outTradeNo
        && existingOrder.productId === authoritative.id
        && existingOrder.productVersion === authoritative.version;
      if (!sameIdentity) {
        throw new AppError(409, "PAYMENT_ORDER_IDENTITY_CONFLICT", "支付订单身份已被其他请求占用");
      }
      if (existingOrder.status === "pending" && !this.paymentReconciliationJobs.has(existingOrder.id)) {
        this.paymentReconciliationJobs.set(existingOrder.id, {
          orderId: existingOrder.id,
          state: "scheduled",
          availableAt: new Date(
            Date.parse(input.now) + INITIAL_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS,
          ).toISOString(),
          attemptCount: 0,
          leaseToken: null,
          leaseExpiresAt: null,
          lastObservedTradeState: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          completedAt: null,
          createdAt: input.now,
          updatedAt: input.now,
        });
      }
      this.paymentOrderSlots.delete(input.id);
      return copy(existingOrder);
    }
    if ([...this.paymentOrders.values()].some((order) => order.outTradeNo === input.outTradeNo)) {
      throw new AppError(409, "PAYMENT_ORDER_IDENTITY_CONFLICT", "支付交易号已被其他请求占用");
    }
    const pendingOrderCount = [...this.paymentOrders.values()].filter((order) =>
      order.userId === input.userId
      && order.status === "pending"
      && Date.parse(order.paymentExpiresAt) > Date.parse(input.now)).length;
    if (pendingOrderCount >= MAX_PENDING_PAYMENT_ORDERS_PER_USER) {
      throw new AppError(429, "PAYMENT_PENDING_LIMIT_EXCEEDED", "待支付订单数量已达到上限", {
        limit: MAX_PENDING_PAYMENT_ORDERS_PER_USER,
      });
    }
    const order: PaymentOrderRecord = {
      id: input.id,
      userId: input.userId,
      productId: authoritative.id,
      productVersion: authoritative.version,
      productName: authoritative.name,
      creditAmount: authoritative.creditAmount,
      amountCents: authoritative.amountCents,
      currency: authoritative.currency,
      outTradeNo: input.outTradeNo,
      status: "pending",
      providerReference: input.providerReference,
      providerTradeState: "NOTPAY",
      providerTransactionId: null,
      paymentExpiresAt: input.paymentExpiresAt,
      paidAt: null,
      closedAt: null,
      lastReconciledAt: null,
      lateSuccessAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.paymentOrders.set(order.id, copy(order));
    this.paymentReconciliationJobs.set(order.id, {
      orderId: order.id,
      state: "scheduled",
      availableAt: new Date(
        Date.parse(input.now) + INITIAL_PAYMENT_RECONCILIATION_DELAY_MILLISECONDS,
      ).toISOString(),
      attemptCount: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      lastObservedTradeState: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      completedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    this.paymentOrderSlots.delete(order.id);
    return copy(order);
  }

  async getPaymentOrder(userId: string, paymentOrderId: string): Promise<PaymentOrderRecord | null> {
    const order = this.paymentOrders.get(paymentOrderId);
    return order?.userId === userId ? copy(order) : null;
  }

  async getPaymentOrderByOutTradeNo(outTradeNo: string): Promise<PaymentOrderRecord | null> {
    let order = [...this.paymentOrders.values()].find((candidate) => candidate.outTradeNo === outTradeNo);
    if (!order) {
      const attempt = [...this.paymentOrderAttempts.values()].find((candidate) =>
        candidate.outTradeNo === outTradeNo);
      if (attempt) order = this.paymentOrders.get(attempt.orderId);
    }
    return order ? copy(order) : null;
  }

  async applyPaymentObservation(
    input: Parameters<AppStore["applyPaymentObservation"]>[0],
  ): Promise<PaymentOrderRecord> {
    const order = this.paymentOrders.get(input.orderId);
    if (!order || order.userId !== input.userId) {
      throw new AppError(404, "PAYMENT_ORDER_NOT_FOUND", "支付订单不存在");
    }
    let reconciliationJob: PaymentReconciliationJob | undefined;
    const reconciliationError = assertPaymentReconciliationError({
      ...(input.reconciliationErrorCode ? { code: input.reconciliationErrorCode } : {}),
      ...(input.reconciliationErrorMessage ? { message: input.reconciliationErrorMessage } : {}),
    });
    if (input.reconciliationLeaseToken) {
      reconciliationJob = this.paymentReconciliationJobs.get(input.orderId);
      const observedAt = Date.parse(input.observedAt);
      if (!reconciliationJob
        || reconciliationJob.state !== "running"
        || reconciliationJob.leaseToken !== input.reconciliationLeaseToken
        || !reconciliationJob.leaseExpiresAt
        || Date.parse(reconciliationJob.leaseExpiresAt) <= observedAt) {
        throw new AppError(409, "PAYMENT_RECONCILIATION_LEASE_LOST", "支付对账任务租约已失效", null, true);
      }
    }
    if (order.status !== "pending") return copy(order);
    order.providerTradeState = input.providerTradeState;
    order.lastReconciledAt = input.observedAt;
    order.updatedAt = input.observedAt;
    if (input.providerTradeState === "CLOSED") {
      order.status = "closed";
      order.closedAt ??= input.observedAt;
      this.completePaymentReconciliationJob(order.id, "CLOSED", input.observedAt);
    } else if (reconciliationJob) {
      const delayMilliseconds = assertPaymentReconciliationDelayMilliseconds(
        input.nextReconciliationDelayMilliseconds ?? Number.NaN,
      );
      reconciliationJob.state = "scheduled";
      reconciliationJob.availableAt = new Date(Date.parse(input.observedAt) + delayMilliseconds).toISOString();
      reconciliationJob.leaseToken = null;
      reconciliationJob.leaseExpiresAt = null;
      reconciliationJob.lastObservedTradeState = "NOTPAY";
      reconciliationJob.lastErrorCode = reconciliationError.code;
      reconciliationJob.lastErrorMessage = reconciliationError.message;
      reconciliationJob.updatedAt = input.observedAt;
    }
    return copy(order);
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
    const order = this.paymentOrders.get(input.orderId);
    if (!order) throw new AppError(404, "PAYMENT_ORDER_NOT_FOUND", "支付订单不存在");
    const observedIdentityMatches = order.outTradeNo === input.observedOutTradeNo
      || [...this.paymentOrderAttempts.values()].some((attempt) =>
        attempt.orderId === order.id && attempt.outTradeNo === input.observedOutTradeNo);
    if (!observedIdentityMatches) {
      throw new AppError(409, "PAYMENT_OUT_TRADE_NO_MISMATCH", "支付事件商户订单号不属于该订单");
    }
    const priorEvent = this.paymentEvents.get(input.eventKey);
    if (priorEvent) {
      if (priorEvent.orderId !== input.orderId
        || priorEvent.outTradeNo !== input.observedOutTradeNo
        || priorEvent.providerTransactionId !== input.providerTransactionId
        || priorEvent.rawBodySha256 !== (input.rawBodySha256 ?? null)) {
        throw new AppError(409, "PAYMENT_EVENT_CONFLICT", "支付事件标识对应了不同交易");
      }
      this.completePaymentReconciliationJob(order.id, "SUCCESS", input.observedAt);
      const replayAccount = this.credits.get(order.userId);
      if (!replayAccount) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
      return copy({ order, account: replayAccount, credited: false });
    }
    if (order.status === "succeeded") {
      if (order.providerTransactionId !== input.providerTransactionId) {
        throw new AppError(409, "PAYMENT_TRANSACTION_CONFLICT", "订单已由另一笔交易支付");
      }
      this.paymentEvents.set(input.eventKey, {
        orderId: order.id,
        outTradeNo: input.observedOutTradeNo,
        providerTransactionId: input.providerTransactionId,
        source: input.source,
        rawBodySha256: input.rawBodySha256 ?? null,
      });
      this.completePaymentReconciliationJob(order.id, "SUCCESS", input.observedAt);
      const account = this.credits.get(order.userId);
      if (!account) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
      return copy({ order, account, credited: false });
    }
    if (order.status !== "pending" && order.status !== "closed") {
      throw new AppError(409, "PAYMENT_ORDER_NOT_PAYABLE", "订单当前状态不能入账");
    }
    const transactionOwner = [...this.paymentOrders.values()].find((candidate) => candidate.providerTransactionId === input.providerTransactionId);
    if (transactionOwner && transactionOwner.id !== order.id) {
      throw new AppError(409, "PAYMENT_TRANSACTION_CONFLICT", "该支付交易已用于其他订单");
    }
    const account = this.credits.get(order.userId);
    if (!account) throw new AppError(404, "CREDIT_ACCOUNT_NOT_FOUND", "次数账户不存在");
    account.balance += order.creditAmount;
    account.updatedAt = input.observedAt;
    (this.ledger.get(order.userId) ?? []).push({
      id: randomUUID(),
      userId: order.userId,
      delta: order.creditAmount,
      balanceAfter: account.balance,
      reason: "payment_credit",
      referenceId: order.id,
      createdAt: input.observedAt,
    });
    const lateAfterClose = order.status === "closed";
    order.status = "succeeded";
    order.providerTradeState = input.providerTradeState;
    order.providerTransactionId = input.providerTransactionId;
    order.paidAt = input.paidAt;
    if (input.source !== "wechat-notify") order.lastReconciledAt = input.observedAt;
    if (lateAfterClose) order.lateSuccessAt ??= input.observedAt;
    order.updatedAt = input.observedAt;
    this.paymentEvents.set(input.eventKey, {
      orderId: order.id,
      outTradeNo: input.observedOutTradeNo,
      providerTransactionId: input.providerTransactionId,
      source: input.source,
      rawBodySha256: input.rawBodySha256 ?? null,
    });
    this.completePaymentReconciliationJob(order.id, "SUCCESS", input.observedAt);
    return copy({ order, account, credited: true });
  }

  async getPaymentReconciliationJob(orderId: string): Promise<PaymentReconciliationJob | null> {
    const job = this.paymentReconciliationJobs.get(orderId);
    return job ? copy(job) : null;
  }

  async claimNextPaymentReconciliation(
    input: Parameters<AppStore["claimNextPaymentReconciliation"]>[0],
  ): Promise<Awaited<ReturnType<AppStore["claimNextPaymentReconciliation"]>>> {
    const leaseWindow = resolveInMemoryWorkerLeaseWindow(input);
    const staleTerminalJobs = [...this.paymentReconciliationJobs.values()]
      .filter((job) => {
        const order = this.paymentOrders.get(job.orderId);
        return job.state !== "completed" && order !== undefined && order.status !== "pending";
      })
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)
        || left.orderId.localeCompare(right.orderId))
      .slice(0, PAYMENT_RECONCILIATION_REPAIR_LIMIT);
    for (const job of staleTerminalJobs) {
      const order = this.paymentOrders.get(job.orderId)!;
      const observedTradeState = order.status === "succeeded"
        ? "SUCCESS"
        : order.status === "closed"
          ? "CLOSED"
          : order.providerTradeState === "NOT_FOUND"
            || order.providerTradeState === "NOTPAY"
            || order.providerTradeState === "SUCCESS"
            || order.providerTradeState === "CLOSED"
            ? order.providerTradeState
            : job.lastObservedTradeState;
      this.completePaymentReconciliationJob(
        order.id,
        observedTradeState,
        leaseWindow.now,
      );
    }
    const eligible = [...this.paymentReconciliationJobs.values()]
      .filter((job) => {
        const order = this.paymentOrders.get(job.orderId);
        if (order?.status !== "pending" || job.state === "completed") return false;
        if (job.state === "scheduled") return Date.parse(job.availableAt) <= leaseWindow.nowMilliseconds;
        return Boolean(job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= leaseWindow.nowMilliseconds);
      })
      .sort((left, right) => {
        const leftAt = left.state === "running" ? left.leaseExpiresAt! : left.availableAt;
        const rightAt = right.state === "running" ? right.leaseExpiresAt! : right.availableAt;
        return leftAt.localeCompare(rightAt)
          || left.createdAt.localeCompare(right.createdAt)
          || left.orderId.localeCompare(right.orderId);
      });
    const job = eligible[0];
    if (!job) return null;
    const order = this.paymentOrders.get(job.orderId);
    if (!order) return null;
    job.state = "running";
    job.attemptCount += 1;
    job.leaseToken = input.leaseToken;
    job.leaseExpiresAt = leaseWindow.leaseExpiresAt;
    job.lastErrorCode = null;
    job.lastErrorMessage = null;
    job.completedAt = null;
    job.updatedAt = leaseWindow.now;
    return copy({ order, job, claimedAt: leaseWindow.now });
  }

  async renewPaymentReconciliationLease(
    input: Parameters<AppStore["renewPaymentReconciliationLease"]>[0],
  ): Promise<boolean> {
    const leaseWindow = resolveInMemoryWorkerLeaseWindow(input);
    const job = this.paymentReconciliationJobs.get(input.orderId);
    if (!job
      || job.state !== "running"
      || job.leaseToken !== input.leaseToken
      || !job.leaseExpiresAt
      || Date.parse(job.leaseExpiresAt) <= leaseWindow.nowMilliseconds) return false;
    job.leaseExpiresAt = leaseWindow.leaseExpiresAt;
    job.updatedAt = leaseWindow.now;
    return true;
  }

  async reschedulePaymentReconciliation(
    input: Parameters<AppStore["reschedulePaymentReconciliation"]>[0],
  ): Promise<boolean> {
    const delayMilliseconds = assertPaymentReconciliationDelayMilliseconds(input.delayMilliseconds);
    const error = assertPaymentReconciliationError({
      ...(input.errorCode ? { code: input.errorCode } : {}),
      ...(input.errorMessage ? { message: input.errorMessage } : {}),
    });
    const nowMilliseconds = input.now === undefined ? Date.now() : Date.parse(input.now);
    if (!Number.isFinite(nowMilliseconds)) {
      throw new AppError(500, "WORKER_LEASE_CLOCK_INVALID", "worker 租约时钟无效", undefined, false);
    }
    const now = new Date(nowMilliseconds).toISOString();
    const order = this.paymentOrders.get(input.orderId);
    const job = this.paymentReconciliationJobs.get(input.orderId);
    if (order?.status !== "pending"
      || !job
      || job.state !== "running"
      || job.leaseToken !== input.leaseToken
      || !job.leaseExpiresAt
      || Date.parse(job.leaseExpiresAt) <= nowMilliseconds) return false;
    job.state = "scheduled";
    job.availableAt = new Date(nowMilliseconds + delayMilliseconds).toISOString();
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.lastObservedTradeState = input.providerTradeState ?? job.lastObservedTradeState;
    job.lastErrorCode = error.code;
    job.lastErrorMessage = error.message;
    job.updatedAt = now;
    return true;
  }

  async listInventory(userId: string, paletteId?: string): Promise<InventoryItem[]> {
    return copy([...this.inventory.values()]
      .filter((item) => item.userId === userId && (paletteId === undefined || item.paletteId === paletteId))
      .sort((left, right) => left.paletteId.localeCompare(right.paletteId) || left.colorCode.localeCompare(right.colorCode)));
  }

  async getInventoryStats(userId: string): Promise<{ colorCount: number; beadCount: number }> {
    let colorCount = 0;
    let beadCount = 0;
    for (const item of this.inventory.values()) {
      if (item.userId !== userId || item.quantity <= 0) continue;
      colorCount += 1;
      beadCount += item.quantity;
    }
    if (!Number.isSafeInteger(colorCount) || !Number.isSafeInteger(beadCount)) {
      throw new AppError(500, "INVENTORY_AGGREGATE_OUT_OF_RANGE", "库存聚合结果超出安全整数范围");
    }
    return { colorCount, beadCount };
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
    const referenceKey = `${input.userId}:${input.idempotencyReference}`;
    if (this.inventoryOperationReferences.has(referenceKey)) {
      throw new AppError(409, "INVENTORY_REFERENCE_CONFLICT", "该库存流水引用已被使用");
    }
    const seen = new Set<string>();
    const prepared: Array<{
      key: string;
      before: InventoryItem | undefined;
      after: InventoryItem;
    }> = [];
    for (const entry of input.entries) {
      const rowKey = `${entry.paletteId}:${entry.colorCode}`;
      if (seen.has(rowKey)) {
        throw new AppError(400, "INVENTORY_BATCH_DUPLICATE_COLOR", "批量库存不能包含重复的色卡色号", {
          paletteId: entry.paletteId,
          colorCode: entry.colorCode,
        });
      }
      seen.add(rowKey);
      const palette = this.requireSelectablePalette(
        entry.paletteId,
        input.userId,
        "PALETTE_COLOR_NOT_FOUND",
      );
      const color = palette.colors.find((candidate) => candidate.code === entry.colorCode);
      if (!color) throw new AppError(404, "PALETTE_COLOR_NOT_FOUND", "色卡或色号不存在");
      if (!color.available) {
        throw new AppError(409, "PALETTE_COLOR_UNAVAILABLE", "色号当前不可用于库存操作", {
          paletteId: entry.paletteId,
          colorCode: entry.colorCode,
        });
      }
      if (!Number.isInteger(entry.baseRevision) || entry.baseRevision < 0) {
        throw new AppError(400, "INVENTORY_REVISION_INVALID", "库存基础版本必须是非负整数");
      }
      if (entry.location !== undefined
        && entry.location !== null
        && (entry.location.length < 1 || entry.location.length > 100 || !entry.location.trim())) {
        throw new AppError(400, "INVENTORY_LOCATION_REQUIRED", "存放位置必须是 1-100 字符的非空文本");
      }
      const key = `${input.userId}:${entry.paletteId}:${entry.colorCode}`;
      const before = this.inventory.get(key);
      const effectiveRevision = before?.revision ?? 0;
      if (effectiveRevision !== entry.baseRevision) {
        throw new AppError(409, "INVENTORY_REVISION_CONFLICT", "库存已在其他设备更新", {
          currentRevision: effectiveRevision,
        });
      }
      let quantity: number;
      let location: string | null;
      if (input.mode === "calibrate") {
        if (!Number.isInteger(entry.quantity)
          || entry.quantity === undefined
          || entry.quantity < 0
          || entry.quantity > 2_147_483_647
          || entry.delta !== undefined) {
          throw new AppError(400, "INVENTORY_CALIBRATION_INVALID", "校准模式必须提供有效的非负整数 quantity");
        }
        if (entry.location === undefined) {
          throw new AppError(400, "INVENTORY_LOCATION_REQUIRED", "校准模式必须明确提供存放位置或 null");
        }
        quantity = entry.quantity;
        location = entry.location;
      } else {
        if (!Number.isInteger(entry.delta)
          || entry.delta === undefined
          || entry.delta === 0
          || entry.delta < -2_147_483_647
          || entry.delta > 2_147_483_647
          || entry.quantity !== undefined) {
          throw new AppError(400, "INVENTORY_DELTA_INVALID", "增减模式必须提供有效的非零整数 delta");
        }
        quantity = (before?.quantity ?? 0) + entry.delta;
        if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 2_147_483_647) {
          throw new AppError(409, "INVENTORY_QUANTITY_OUT_OF_RANGE", "库存增减后数量不能为负数或超出上限", {
            paletteId: entry.paletteId,
            colorCode: entry.colorCode,
            currentQuantity: before?.quantity ?? 0,
          });
        }
        location = entry.location === undefined ? before?.location ?? null : entry.location;
      }
      prepared.push({
        key,
        before,
        after: {
          userId: input.userId,
          paletteId: entry.paletteId,
          colorCode: entry.colorCode,
          quantity,
          location,
          revision: effectiveRevision + 1,
          updatedAt: input.now,
        },
      });
    }
    const transactionCount = this.inventoryTransactions.reduce(
      (count, transaction) => count + (transaction.userId === input.userId ? 1 : 0),
      0,
    );
    if (transactionCount + prepared.length > MAX_INVENTORY_TRANSACTIONS_PER_USER) {
      throw new AppError(429, "INVENTORY_TRANSACTION_LIMIT_EXCEEDED", "库存流水记录已达到上限", {
        limit: MAX_INVENTORY_TRANSACTIONS_PER_USER,
      });
    }
    const operationId = randomUUID();
    const transactions = prepared.map(({ before, after }): InventoryTransaction => ({
      id: randomUUID(),
      operationId,
      userId: input.userId,
      type: input.mode === "calibrate" ? "calibration" : "manual_adjustment",
      paletteId: after.paletteId,
      colorCode: after.colorCode,
      quantityBefore: before?.quantity ?? 0,
      delta: after.quantity - (before?.quantity ?? 0),
      quantityAfter: after.quantity,
      locationBefore: before?.location ?? null,
      locationAfter: after.location,
      projectId: null,
      projectRevision: null,
      idempotencyReference: input.idempotencyReference,
      createdAt: input.now,
    }));
    for (const row of prepared) this.inventory.set(row.key, copy(row.after));
    this.inventoryOperations.set(operationId, {
      id: operationId,
      userId: input.userId,
      type: input.mode === "calibrate" ? "calibration" : "manual_adjustment",
      projectId: null,
      projectRevision: null,
      idempotencyReference: input.idempotencyReference,
      consumedAt: null,
      createdAt: input.now,
    });
    this.inventoryTransactions.push(...transactions.map(copy));
    this.inventoryOperationReferences.add(referenceKey);
    return copy({ operationId, items: prepared.map((row) => row.after), transactions });
  }

  async listInventoryOperations(
    input: Parameters<AppStore["listInventoryOperations"]>[0],
  ): Promise<InventoryOperation[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 101
      || !Number.isInteger(input.offset ?? 0) || (input.offset ?? 0) < 0) {
      throw new AppError(400, "INVENTORY_OPERATION_PAGE_INVALID", "库存操作分页参数无效");
    }
    return copy([...this.inventoryOperations.values()]
      .filter((operation) => operation.userId === input.userId
        && (input.projectId === undefined || operation.projectId === input.projectId)
        && (input.idempotencyReference === undefined
          || operation.idempotencyReference === input.idempotencyReference))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(input.offset ?? 0, (input.offset ?? 0) + input.limit));
  }

  async listInventoryTransactions(
    input: Parameters<AppStore["listInventoryTransactions"]>[0],
  ): Promise<InventoryTransaction[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 101
      || !Number.isInteger(input.offset ?? 0) || (input.offset ?? 0) < 0) {
      throw new AppError(400, "INVENTORY_TRANSACTION_PAGE_INVALID", "库存流水分页参数无效");
    }
    return copy(this.inventoryTransactions
      .filter((transaction) => transaction.userId === input.userId
        && (input.paletteId === undefined || transaction.paletteId === input.paletteId)
        && (input.projectId === undefined || transaction.projectId === input.projectId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(input.offset ?? 0, (input.offset ?? 0) + input.limit));
  }

  async consumeProjectInventory(
    input: Parameters<AppStore["consumeProjectInventory"]>[0],
  ): Promise<ProjectInventoryConsumption> {
    if (input.idempotencyReference.length < 1 || input.idempotencyReference.length > 256) {
      throw new AppError(400, "INVENTORY_REFERENCE_INVALID", "库存流水引用长度无效");
    }
    if (this.inventoryOperationReferences.has(`${input.userId}:${input.idempotencyReference}`)) {
      throw new AppError(409, "INVENTORY_REFERENCE_CONFLICT", "该库存流水引用已被使用");
    }
    const record = this.projects.get(input.projectId);
    if (!record || record.summary.userId !== input.userId || this.deletedProjects.has(input.projectId)) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "项目不存在");
    }
    if (record.summary.currentRevision !== input.projectRevision) {
      throw new AppError(409, "INVENTORY_CONSUMPTION_REVISION_MISMATCH", "只能扣减项目当前图纸版本的库存", {
        currentProjectRevision: record.summary.currentRevision,
      });
    }
    const revision = record.revisions.find((candidate) => candidate.revision === input.projectRevision);
    if (!revision) throw new AppError(404, "PROJECT_REVISION_NOT_FOUND", "项目版本不存在");
    this.requireSelectablePalette(revision.paletteId, input.userId);
    const consumptionKey = `${input.userId}:${input.projectId}:${input.projectRevision}`;
    const existingConsumption = this.inventoryConsumptions.get(consumptionKey);
    if (existingConsumption) {
      throw new AppError(409, "PROJECT_INVENTORY_ALREADY_CONSUMED", "该项目版本已确认扣减库存", {
        consumedAt: existingConsumption.consumedAt,
      });
    }
    const progress = this.progress.get(input.projectId);
    if (!progress
      || progress.projectRevision !== input.projectRevision
      || progress.completedAt === null) {
      throw new AppError(409, "PROJECT_BUILD_NOT_COMPLETED", "项目制作完成后才能确认扣减库存");
    }
    const required = new Map<string, number>();
    for (const colorCode of revision.grid.cells) {
      if (colorCode !== null) required.set(colorCode, (required.get(colorCode) ?? 0) + 1);
    }
    const prepared = [...required.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([colorCode, quantity]) => {
        const key = `${input.userId}:${record.summary.paletteId}:${colorCode}`;
        const before = this.inventory.get(key);
        return { key, colorCode, quantity, before };
      });
    const shortages = prepared
      .filter((line) => (line.before?.quantity ?? 0) < line.quantity)
      .map((line) => ({
        paletteId: record.summary.paletteId,
        colorCode: line.colorCode,
        requiredQuantity: line.quantity,
        availableQuantity: line.before?.quantity ?? 0,
      }));
    if (shortages.length > 0) {
      throw new AppError(409, "INVENTORY_INSUFFICIENT", "豆仓库存不足，未扣减任何色号", { shortages });
    }
    const transactionCount = this.inventoryTransactions.reduce(
      (count, transaction) => count + (transaction.userId === input.userId ? 1 : 0),
      0,
    );
    if (transactionCount + prepared.length > MAX_INVENTORY_TRANSACTIONS_PER_USER) {
      throw new AppError(429, "INVENTORY_TRANSACTION_LIMIT_EXCEEDED", "库存流水记录已达到上限", {
        limit: MAX_INVENTORY_TRANSACTIONS_PER_USER,
      });
    }
    const operationId = randomUUID();
    const items = prepared.map((line): InventoryItem => ({
      ...line.before!,
      quantity: line.before!.quantity - line.quantity,
      revision: line.before!.revision + 1,
      updatedAt: input.now,
    }));
    const transactions = prepared.map((line, index): InventoryTransaction => ({
      id: randomUUID(),
      operationId,
      userId: input.userId,
      type: "project_consumption",
      paletteId: record.summary.paletteId,
      colorCode: line.colorCode,
      quantityBefore: line.before!.quantity,
      delta: -line.quantity,
      quantityAfter: items[index]!.quantity,
      locationBefore: line.before!.location,
      locationAfter: line.before!.location,
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      idempotencyReference: input.idempotencyReference,
      createdAt: input.now,
    }));
    for (let index = 0; index < prepared.length; index += 1) {
      this.inventory.set(prepared[index]!.key, copy(items[index]!));
    }
    this.inventoryOperations.set(operationId, {
      id: operationId,
      userId: input.userId,
      type: "project_consumption",
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      idempotencyReference: input.idempotencyReference,
      consumedAt: input.now,
      createdAt: input.now,
    });
    this.inventoryTransactions.push(...transactions.map(copy));
    this.inventoryOperationReferences.add(`${input.userId}:${input.idempotencyReference}`);
    this.inventoryConsumptions.set(consumptionKey, { operationId, consumedAt: input.now });
    return copy({
      operationId,
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      consumedAt: input.now,
      items,
      transactions,
    });
  }

  async consumeUserRateLimit(input: Parameters<AppStore["consumeUserRateLimit"]>[0]): Promise<RateLimitResult> {
    const key = `${input.userId}:${input.action}`;
    const existing = this.rateLimits.get(key);
    const nowMillis = Date.parse(input.now);
    if (!existing || Date.parse(existing.windowStartedAt) + input.windowMilliseconds <= nowMillis) {
      this.rateLimits.set(key, { windowStartedAt: input.now, requestCount: 1 });
      return { allowed: true, remaining: input.limit - 1, retryAfterMilliseconds: input.windowMilliseconds };
    }
    const retryAfterMilliseconds = Math.max(
      1,
      Date.parse(existing.windowStartedAt) + input.windowMilliseconds - nowMillis,
    );
    if (existing.requestCount >= input.limit) {
      return { allowed: false, remaining: 0, retryAfterMilliseconds };
    }
    existing.requestCount += 1;
    return { allowed: true, remaining: input.limit - existing.requestCount, retryAfterMilliseconds };
  }

  async consumeAuthRateLimit(input: Parameters<AppStore["consumeAuthRateLimit"]>[0]): Promise<RateLimitResult> {
    const key = `${input.keyHash}:${input.action}`;
    const now = Date.parse(input.now);
    for (const [candidateKey, value] of this.authRateLimits) {
      if (Date.parse(value.windowStartedAt) + AUTH_RATE_LIMIT_RETENTION_MILLISECONDS <= now) {
        this.authRateLimits.delete(candidateKey);
      }
    }
    const existing = this.authRateLimits.get(key);
    if (!existing || Date.parse(existing.windowStartedAt) + input.windowMilliseconds <= now) {
      this.authRateLimits.set(key, { windowStartedAt: input.now, requestCount: 1 });
      return { allowed: true, remaining: input.limit - 1, retryAfterMilliseconds: input.windowMilliseconds };
    }
    const retryAfterMilliseconds = Math.max(1, Date.parse(existing.windowStartedAt) + input.windowMilliseconds - now);
    if (existing.requestCount >= input.limit) return { allowed: false, remaining: 0, retryAfterMilliseconds };
    existing.requestCount += 1;
    return { allowed: true, remaining: input.limit - existing.requestCount, retryAfterMilliseconds };
  }

  async ensureUserInviteCode(userId: string, now: string): Promise<import("../domain/models.js").UserInviteCode> {
    if (!this.users.has(userId)) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
    const existing = this.userInviteCodes.get(userId);
    if (existing) return copy(existing);
    const { generateInviteCode } = await import("../domain/invite.js");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = generateInviteCode();
      if (this.inviteCodeIndex.has(code)) continue;
      const record = { userId, code, createdAt: now };
      this.userInviteCodes.set(userId, record);
      this.inviteCodeIndex.set(code, userId);
      return copy(record);
    }
    throw new AppError(503, "INVITE_CODE_UNAVAILABLE", "邀请码暂时不可用，请重试", null, true);
  }

  async getInviteSummary(userId: string): Promise<import("../domain/models.js").InviteSummary> {
    const invite = await this.ensureUserInviteCode(userId, new Date().toISOString());
    const binding = this.inviteBindings.get(userId) ?? null;
    const entitlements = [...this.inviteRewardEntitlements.values()]
      .filter((entry) => entry.beneficiaryUserId === userId || entry.bindingInviteeUserId === userId)
      .map((entry) => copy(entry))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const { buildInviteSummary } = await import("../domain/invite.js");
    return buildInviteSummary({ invite, binding: binding ? copy(binding) : null, entitlements });
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
    const inviterUserId = this.inviteCodeIndex.get(code);
    if (!inviterUserId) throw new AppError(404, "INVITE_NOT_FOUND", "邀请码不存在");
    const existing = this.inviteBindings.get(input.inviteeUserId) ?? null;
    const mode = assertInviteAcceptAllowed({
      inviteeUserId: input.inviteeUserId,
      inviterUserId,
      existing,
      inviteCode: code,
    });
    let rewardApplied: import("../domain/models.js").InviteRewardApplied | null = null;
    if (mode === "create") {
      const inviteeWasNewUser = Boolean(input.inviteeWasNewUser);
      const delta = inviteRewardDeltaForInvitee(inviteeWasNewUser);
      this.inviteBindings.set(input.inviteeUserId, {
        inviteeUserId: input.inviteeUserId,
        inviterUserId,
        inviteCode: code,
        boundAt: input.now,
        inviteeWasNewUser,
      });
      const entitlementId = randomUUID();
      const ledgerId = randomUUID();
      const inviterAccount = this.credits.get(inviterUserId);
      if (!inviterAccount) throw new AppError(500, "CREDIT_ACCOUNT_MISSING", "邀请人次数账户不存在");
      inviterAccount.balance += delta;
      inviterAccount.updatedAt = input.now;
      const ledger = this.ledger.get(inviterUserId) ?? [];
      ledger.unshift({
        id: ledgerId,
        userId: inviterUserId,
        delta,
        balanceAfter: inviterAccount.balance,
        reason: INVITE_REWARD_LEDGER_REASON,
        referenceId: entitlementId,
        createdAt: input.now,
      });
      this.ledger.set(inviterUserId, ledger);
      this.inviteRewardEntitlements.set(entitlementId, {
        id: entitlementId,
        bindingInviteeUserId: input.inviteeUserId,
        beneficiaryUserId: inviterUserId,
        role: "inviter",
        status: "credited",
        creditLedgerId: ledgerId,
        createdAt: input.now,
        updatedAt: input.now,
      });
      rewardApplied = {
        beneficiaryRole: "inviter",
        delta,
        inviteeWasNewUser,
      };
    }
    return {
      inviteSummary: await this.getInviteSummary(input.inviteeUserId),
      rewardApplied,
    };
  }
}
