import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute, normalize, parse, resolve } from "node:path";

import {
  DEFAULT_EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY,
  DEFAULT_EXPORT_DOWNLOAD_PER_USER_CONCURRENCY,
  DEFAULT_EXPORT_DOWNLOAD_READ_TIMEOUT_MILLISECONDS,
  DEFAULT_EXPORT_DOWNLOAD_WRITE_TIMEOUT_MILLISECONDS,
} from "./exports/download-concurrency.js";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  databasePoolMax?: number;
  databaseIdleTimeoutMilliseconds?: number;
  databaseConnectionTimeoutMilliseconds?: number;
  databaseStatementTimeoutMilliseconds?: number;
  databaseLockTimeoutMilliseconds?: number;
  databaseIdleTransactionTimeoutMilliseconds?: number;
  exportDownloadGlobalConcurrency?: number;
  exportDownloadPerUserConcurrency?: number;
  exportDownloadReadTimeoutMilliseconds?: number;
  exportDownloadWriteTimeoutMilliseconds?: number;
  devAuthEnabled: boolean;
  corsOrigins: string[];
  /** Explicit IP/CIDR allowlist used by Fastify when accepting forwarding headers. */
  trustedProxies?: string[];
  /** Production rollout gate; keep disabled until every pre-0028 API node is drained. */
  customPalettesEnabled?: boolean;
  sessionTtlDays: number;
  devStartingCredits: number;
  assetStorageProvider?: "local" | "s3" | "cloudbase-pg";
  assetStorageRoot: string;
  /** Explicit production acknowledgement that local storage is a single-instance persistent-volume risk. */
  assetLocalStorageProductionAcknowledged?: boolean;
  assetEncryptionKeyBase64: string;
  /** Identifier embedded in new PDAE2 objects; the existing key remains the active write key. */
  assetEncryptionActiveKeyId?: string;
  /** Historical PDAE2 decryption keys keyed by their immutable key IDs. */
  assetEncryptionReadKeysBase64?: Readonly<Record<string, string>>;
  /** Key ID used exclusively to decrypt pre-key-ID PDAE1 objects. */
  assetEncryptionLegacyKeyId?: string;
  assetS3Bucket?: string;
  assetS3Region?: string;
  assetS3Endpoint?: string;
  assetS3Prefix?: string;
  assetS3ForcePathStyle?: boolean;
  assetS3AccessKeyId?: string;
  assetS3SecretAccessKey?: string;
  assetS3SessionToken?: string;
  assetCloudbaseEnvId?: string;
  assetCloudbaseBucketId?: string;
  assetCloudbaseServiceRoleApiKey?: string;
  assetMaxBytes: number;
  assetDefaultTtlHours: number;
  assetConsentVersion: string;
  assetConsentProcessor?: string;
  assetConsentPurposeText?: string;
  assetConsentRetentionText?: string;
  assetPurgeBatchSize: number;
  assetPurgeMaxBatches: number;
  internalWorkerKey: string;
  generationProviderUrl?: string;
  generationProviderApiKey?: string;
  generationProviderTimeoutMilliseconds?: number;
  arkApiKey?: string;
  arkImageModel?: string;
  arkVisionModel?: string;
  paymentReconciliationLeaseMilliseconds?: number;
  paymentReconciliationPollMilliseconds?: number;
  paymentReconciliationIdleMilliseconds?: number;
  wechatAppId?: string;
  wechatAppSecret?: string;
  wechatPayMerchantId?: string;
  wechatPayMerchantCertificateSerial?: string;
  wechatPayMerchantPrivateKeyPath?: string;
  wechatPayVerifierSerial?: string;
  wechatPayVerifierPublicKeyPath?: string;
  /** Additional trusted platform serial -> public-key path entries for overlap rotation. */
  wechatPayAdditionalVerifierPublicKeyPaths?: Readonly<Record<string, string>>;
  wechatPayApiV3Key?: string;
  wechatPayNotifyUrl?: string;
}

/**
 * Runtime roles intentionally validate only the secrets and knobs consumed by
 * that process. `all` preserves the strict aggregate contract for callers that
 * do not select a role (including configuration audits and tests).
 */
export type ConfigRole =
  | "all"
  | "api"
  | "generation-worker"
  | "export-worker"
  | "payment-reconciliation-worker"
  | "asset-purge"
  | "export-purge"
  | "migration"
  | "seed"
  | "dev-memory";

const DEVELOPMENT_ASSET_KEY = "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=";
const DEVELOPMENT_WORKER_KEY = "pindou-dev-only-worker-key-change-me";
const DEVELOPMENT_ASSET_CONSENT_PROCESSOR = "development-placeholder-processor";
const DEVELOPMENT_ASSET_CONSENT_PURPOSE = "development-placeholder: AI 素材仅用于本地拼豆图纸生成测试";
const DEFAULT_ASSET_ENCRYPTION_KEY_ID = "default";
const MAX_ASSET_ENCRYPTION_READ_KEYS = 32;
const MAX_WECHAT_ADDITIONAL_VERIFIERS = 8;

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function readStrictBoolean(name: string, value: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} 必须严格设为 true 或 false`);
  }
  return value === "true";
}

function readInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} 必须是十进制整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} 超出安全整数范围`);
  }
  return parsed;
}

function decodeEncryptionKey(value: string, name = "ASSET_ENCRYPTION_KEY_BASE64"): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${name} 必须使用规范 Base64 编码`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${name} 必须是 32 字节密钥的 Base64 编码`);
  }
  return decoded;
}

function validateEncryptionKeyId(name: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${name} 必须是 1 至 64 位 ASCII 字母、数字、点、下划线或连字符，且首位为字母或数字`);
  }
}

function readEncryptionReadKeys(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("ASSET_ENCRYPTION_READ_KEYS_JSON 必须是 JSON 对象");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ASSET_ENCRYPTION_READ_KEYS_JSON 必须是 JSON 对象");
  }
  const entries = Object.entries(parsed);
  if (entries.length > MAX_ASSET_ENCRYPTION_READ_KEYS) {
    throw new Error(`ASSET_ENCRYPTION_READ_KEYS_JSON 最多允许 ${MAX_ASSET_ENCRYPTION_READ_KEYS} 把只读密钥`);
  }
  const result: Record<string, string> = {};
  for (const [keyId, keyBase64] of entries) {
    validateEncryptionKeyId("ASSET_ENCRYPTION_READ_KEYS_JSON 的 key ID", keyId);
    if (typeof keyBase64 !== "string") {
      throw new Error(`ASSET_ENCRYPTION_READ_KEYS_JSON.${keyId} 必须是 Base64 字符串`);
    }
    decodeEncryptionKey(keyBase64, `ASSET_ENCRYPTION_READ_KEYS_JSON.${keyId}`);
    result[keyId] = keyBase64;
  }
  return result;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost";
}

/**
 * Single fail-closed gate for conveniences that mint development credentials.
 * Callers must not treat NODE_ENV=test alone as authorization.
 */
export function isLocalDevelopmentAuthAllowed(
  config: Pick<AppConfig, "nodeEnv" | "host" | "devAuthEnabled">,
): boolean {
  return config.nodeEnv !== "production"
    && config.devAuthEnabled
    && isLoopbackHost(config.host.trim());
}

function assertExplicitPostgresTarget(parsed: URL): void {
  if (!parsed.hostname) {
    throw new Error("生产环境的 DATABASE_URL 必须显式包含数据库 host");
  }
  if (!parsed.username) {
    throw new Error("生产环境的 DATABASE_URL 必须显式包含数据库 user");
  }
  if (!parsed.port || !/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535) {
    throw new Error("生产环境的 DATABASE_URL 必须显式包含 1-65535 的数据库 port");
  }
  if (!/^\/[^/]+$/.test(parsed.pathname)) {
    throw new Error("生产环境的 DATABASE_URL 必须在 path 中显式指定唯一数据库名");
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("生产环境的 DATABASE_URL 包含无效编码的数据库名");
  }
  if (!databaseName || databaseName.includes("/") || databaseName.includes("\0")) {
    throw new Error("生产环境的 DATABASE_URL 必须在 path 中显式指定唯一数据库名");
  }
}

function isLocalPostgresUrl(value: string, requireExplicitTarget = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL 必须是有效的 PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL 必须使用 postgres:// 或 postgresql:// 协议");
  }
  if (parsed.hash) {
    throw new Error("DATABASE_URL 不得包含 URL fragment");
  }
  if (parsed.search) {
    throw new Error("DATABASE_URL 不得包含 query 参数；TLS 请仅使用 DATABASE_SSL 配置");
  }
  if (requireExplicitTarget) assertExplicitPostgresTarget(parsed);

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostname) return isLoopbackHost(hostname);

  // PostgreSQL 的无主机 URL 会使用本机 Unix socket。禁止 query 参数，
  // 避免 node-postgres 用 host/database 等参数覆盖 URL authority/path。
  return true;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function validateWechatVerifierSerial(name: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${name} 必须是 1 至 128 位 ASCII 字母、数字、下划线或连字符`);
  }
}

function readWechatAdditionalVerifiers(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined || !value.trim()) return {};
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > MAX_WECHAT_ADDITIONAL_VERIFIERS) {
    throw new Error(`WECHAT_PAY_ADDITIONAL_VERIFIERS 最多允许 ${MAX_WECHAT_ADDITIONAL_VERIFIERS} 个验签公钥`);
  }
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const serial = separator > 0 ? entry.slice(0, separator).trim() : "";
    const publicKeyPath = separator > 0 ? entry.slice(separator + 1).trim() : "";
    validateWechatVerifierSerial("WECHAT_PAY_ADDITIONAL_VERIFIERS 的 serial", serial);
    if (!publicKeyPath || publicKeyPath.length > 2_048 || /[\u0000-\u001f\u007f]/.test(publicKeyPath)) {
      throw new Error(`WECHAT_PAY_ADDITIONAL_VERIFIERS.${serial} 必须是有效的公钥文件路径`);
    }
    if (Object.hasOwn(result, serial)) {
      throw new Error(`WECHAT_PAY_ADDITIONAL_VERIFIERS 包含重复 serial：${serial}`);
    }
    result[serial] = publicKeyPath;
  }
  return result;
}

function optionalPolicyText(name: string, value: string | undefined, maximumLength: number): string | undefined {
  const normalized = optionalText(value);
  if (normalized !== undefined
    && (normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized))) {
    throw new Error(`${name} 必须是不超过 ${maximumLength} 个且不含控制字符的文本`);
  }
  return normalized;
}

function readTrustedProxies(value: string | undefined): string[] {
  if (value === undefined || !value.trim()) return [];
  const proxies = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (new Set(proxies).size !== proxies.length) {
    throw new Error("TRUSTED_PROXIES 不能包含重复地址");
  }
  for (const proxy of proxies) {
    const slash = proxy.lastIndexOf("/");
    const address = slash === -1 ? proxy : proxy.slice(0, slash);
    const version = isIP(address);
    if (version === 0) throw new Error("TRUSTED_PROXIES 只能包含 IP 或 CIDR");
    if (slash !== -1) {
      const prefix = proxy.slice(slash + 1);
      const maximum = version === 4 ? 32 : 128;
      if (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > maximum) {
        throw new Error("TRUSTED_PROXIES 包含无效 CIDR 前缀");
      }
    }
  }
  return proxies;
}

function validateWechatConfiguration(input: {
  nodeEnv: AppConfig["nodeEnv"];
  devAuthEnabled: boolean;
  appId?: string;
  appSecret?: string;
  merchantId?: string;
  merchantCertificateSerial?: string;
  merchantPrivateKeyPath?: string;
  verifierSerial?: string;
  verifierPublicKeyPath?: string;
  additionalVerifierPublicKeyPaths?: Readonly<Record<string, string>>;
  apiV3Key?: string;
  notifyUrl?: string;
}): void {
  const authEntries = [
    ["WECHAT_APP_ID", input.appId],
    ["WECHAT_APP_SECRET", input.appSecret],
  ] as const;
  const paymentEntries = [
    ["WECHAT_APP_ID", input.appId],
    ["WECHAT_PAY_MCH_ID", input.merchantId],
    ["WECHAT_PAY_MERCHANT_CERT_SERIAL", input.merchantCertificateSerial],
    ["WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH", input.merchantPrivateKeyPath],
    ["WECHAT_PAY_VERIFIER_SERIAL", input.verifierSerial],
    ["WECHAT_PAY_VERIFIER_PUBLIC_KEY_PATH", input.verifierPublicKeyPath],
    ["WECHAT_PAY_API_V3_KEY", input.apiV3Key],
    ["WECHAT_PAY_NOTIFY_URL", input.notifyUrl],
  ] as const;
  const paymentSpecificEntries = paymentEntries.slice(1);
  const configuredAuth = authEntries.filter(([, value]) => value !== undefined);
  const configuredPayment = paymentEntries.filter(([, value]) => value !== undefined);
  const configuredPaymentSpecific = paymentSpecificEntries.filter(([, value]) => value !== undefined);
  const additionalVerifierEntries = Object.entries(input.additionalVerifierPublicKeyPaths ?? {});
  const localDevelopmentFallbackEnabled = input.nodeEnv !== "production" && input.devAuthEnabled;

  if (configuredAuth.length > 0
    && configuredAuth.length !== authEntries.length
    && !localDevelopmentFallbackEnabled) {
    const missing = authEntries.filter(([, value]) => value === undefined).map(([name]) => name);
    throw new Error(`微信小程序登录配置不完整，缺少：${missing.join(", ")}`);
  }
  if ((configuredPaymentSpecific.length > 0 || additionalVerifierEntries.length > 0)
    && configuredPayment.length !== paymentEntries.length) {
    const missing = paymentEntries.filter(([, value]) => value === undefined).map(([name]) => name);
    throw new Error(`微信支付配置不完整，缺少：${missing.join(", ")}`);
  }
  if (input.nodeEnv === "production"
    && (configuredAuth.length !== authEntries.length || configuredPayment.length !== paymentEntries.length)) {
    throw new Error("生产环境必须配置微信小程序登录和微信支付参数");
  }
  if (configuredPaymentSpecific.length === 0 && additionalVerifierEntries.length === 0) return;
  validateWechatVerifierSerial("WECHAT_PAY_VERIFIER_SERIAL", input.verifierSerial ?? "");
  if (additionalVerifierEntries.some(([serial]) => serial === input.verifierSerial)) {
    throw new Error("WECHAT_PAY_ADDITIONAL_VERIFIERS 不能重复 primary verifier serial");
  }
  if (Buffer.byteLength(input.apiV3Key ?? "", "utf8") !== 32) {
    throw new Error("WECHAT_PAY_API_V3_KEY 必须恰好为 32 字节");
  }
  let notifyUrl: URL;
  try {
    notifyUrl = new URL(input.notifyUrl ?? "");
  } catch {
    throw new Error("WECHAT_PAY_NOTIFY_URL 必须是有效的 HTTPS URL");
  }
  if (notifyUrl.protocol !== "https:" || notifyUrl.search || notifyUrl.hash) {
    throw new Error("WECHAT_PAY_NOTIFY_URL 必须是无查询串和片段的 HTTPS URL");
  }
}

function validateGenerationProviderConfiguration(input: {
  nodeEnv: AppConfig["nodeEnv"];
  url?: string;
  apiKey?: string;
  timeoutConfigured: boolean;
  arkConfigured: boolean;
  arkApiKey?: string;
  arkImageModel?: string;
  arkVisionModel?: string;
}): void {
  const externalEntries = [
    ["GENERATION_PROVIDER_URL", input.url],
    ["GENERATION_PROVIDER_API_KEY", input.apiKey],
    ["GENERATION_PROVIDER_TIMEOUT_MS", input.timeoutConfigured ? "configured" : undefined],
  ] as const;
  const externalConfigured = externalEntries.filter(([, value]) => value !== undefined);
  const externalProviderConfigured = input.url !== undefined || input.apiKey !== undefined;
  const arkConfigured = input.arkConfigured;
  if (arkConfigured && externalProviderConfigured) {
    throw new Error("不能同时配置 Ark Provider 和外部 Generation Provider");
  }
  if (arkConfigured) {
    if (!input.arkApiKey || input.arkApiKey.length > 8_192) {
      throw new Error("ARK_API_KEY 必须是 1-8192 个字符");
    }
    if (!input.arkImageModel || input.arkImageModel.length > 256 || /[\u0000-\u001f\u007f]/.test(input.arkImageModel)) {
      throw new Error("ARK_IMAGE_MODEL 必须是不超过 256 个字符且不含控制字符的文本");
    }
    if (input.arkVisionModel !== undefined
      && (input.arkVisionModel.length > 256 || /[\u0000-\u001f\u007f]/.test(input.arkVisionModel))) {
      throw new Error("ARK_VISION_MODEL 必须是不超过 256 个字符且不含控制字符的文本");
    }
    return;
  }
  if (externalProviderConfigured && externalConfigured.length !== externalEntries.length) {
    const missing = externalEntries.filter(([, value]) => value === undefined).map(([name]) => name);
    throw new Error(`Generation Provider 配置不完整，缺少：${missing.join(", ")}`);
  }
  if (input.nodeEnv === "production" && externalConfigured.length !== externalEntries.length) {
    throw new Error("生产环境必须完整配置 Generation Provider 或 ARK_API_KEY");
  }
  if (!input.url) return;
  if (input.url.length > 2_048) {
    throw new Error("GENERATION_PROVIDER_URL 不能超过 2048 个字符");
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new Error("GENERATION_PROVIDER_URL 必须是有效的 HTTP(S) URL");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("GENERATION_PROVIDER_URL 不能包含用户凭据或片段");
  }
  const loopbackHttp = parsed.protocol === "http:" && isLoopbackHost(parsed.hostname.replace(/^\[|\]$/g, ""));
  if (parsed.protocol !== "https:" && (input.nodeEnv === "production" || !loopbackHttp)) {
    throw new Error("GENERATION_PROVIDER_URL 必须使用 HTTPS（本地开发 loopback 除外）");
  }
  if (!input.apiKey || input.apiKey.length > 8_192) {
    throw new Error("GENERATION_PROVIDER_API_KEY 必须是 1-8192 个字符");
  }
}

function validateAssetStorageConfiguration(input: {
  nodeEnv: AppConfig["nodeEnv"];
  provider: string;
  localRoot?: string;
  localProductionAcknowledged: boolean;
  bucket?: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  cloudbaseEnvId?: string;
  cloudbaseBucketId?: string;
  cloudbaseServiceRoleApiKey?: string;
}): void {
  if (input.provider !== "local" && input.provider !== "s3" && input.provider !== "cloudbase-pg") {
    throw new Error("ASSET_STORAGE_PROVIDER 必须是 local 或 s3，或 cloudbase-pg");
  }
  const s3Values = [
    input.bucket,
    input.region,
    input.endpoint,
    input.prefix,
    input.accessKeyId,
    input.secretAccessKey,
    input.sessionToken,
  ];
  const cloudbaseValues = [
    input.cloudbaseEnvId,
    input.cloudbaseBucketId,
    input.cloudbaseServiceRoleApiKey,
  ];
  if (input.provider === "local") {
    if (s3Values.some((value) => value !== undefined) || cloudbaseValues.some((value) => value !== undefined)) {
      throw new Error("ASSET_STORAGE_PROVIDER=local 时不能配置云端存储参数");
    }
    if (input.nodeEnv === "production") {
      if (!input.localRoot) {
        throw new Error("生产环境使用 local 存储时必须显式配置非空 ASSET_STORAGE_ROOT");
      }
      if (!isAbsolute(input.localRoot)) {
        throw new Error("生产环境的 ASSET_STORAGE_ROOT 必须是当前运行平台的绝对路径");
      }
      const normalizedRoot = normalize(input.localRoot);
      const fileSystemRoot = parse(normalizedRoot).root;
      if (normalizedRoot === fileSystemRoot) {
        throw new Error("生产环境的 ASSET_STORAGE_ROOT 不能是文件系统根目录");
      }
      if (parse(resolve(input.localRoot)).root !== fileSystemRoot) {
        throw new Error("生产环境的 ASSET_STORAGE_ROOT 必须是当前运行平台带完整根前缀的绝对路径");
      }
      if (!input.localProductionAcknowledged) {
        throw new Error(
          "生产环境使用 local 存储时必须显式设置 ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED=true",
        );
      }
    }
    return;
  }
  if (input.provider === "cloudbase-pg") {
    if (s3Values.some((value) => value !== undefined)) {
      throw new Error("ASSET_STORAGE_PROVIDER=cloudbase-pg 时不能配置 ASSET_S3_* 参数");
    }
    if (!input.cloudbaseEnvId || !input.cloudbaseBucketId || !input.cloudbaseServiceRoleApiKey) {
      throw new Error(
        "ASSET_STORAGE_PROVIDER=cloudbase-pg 时必须配置 ASSET_CLOUDBASE_ENV_ID、"
        + "ASSET_CLOUDBASE_BUCKET_ID 和 ASSET_CLOUDBASE_SERVICE_ROLE_API_KEY",
      );
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(input.cloudbaseEnvId)) {
      throw new Error("ASSET_CLOUDBASE_ENV_ID 必须是安全的 CloudBase 环境 ID");
    }
    return;
  }
  if (cloudbaseValues.some((value) => value !== undefined)) {
    throw new Error("ASSET_STORAGE_PROVIDER=s3 时不能配置 ASSET_CLOUDBASE_* 参数");
  }
  if (!input.bucket || !input.region || input.prefix === undefined) {
    throw new Error("ASSET_STORAGE_PROVIDER=s3 时必须配置 ASSET_S3_BUCKET、ASSET_S3_REGION 和 ASSET_S3_PREFIX");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) {
    throw new Error("ASSET_S3_BUCKET 必须是 3-63 字符的小写 S3 bucket 名称");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(input.region)) {
    throw new Error("ASSET_S3_REGION 格式无效");
  }
  if (input.prefix.length > 256
    || input.prefix.startsWith("/")
    || input.prefix.endsWith("/")
    || input.prefix.includes("//")
    || input.prefix.split("/").some((segment) => segment === "." || segment === "..")
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.prefix)) {
    throw new Error("ASSET_S3_PREFIX 必须是安全的非空对象前缀，且不能包含空路径、. 或 .. 段");
  }
  const hasAccessKey = input.accessKeyId !== undefined;
  const hasSecret = input.secretAccessKey !== undefined;
  if (hasAccessKey !== hasSecret) {
    throw new Error("ASSET_S3_ACCESS_KEY_ID 与 ASSET_S3_SECRET_ACCESS_KEY 必须同时配置或同时省略");
  }
  if (input.sessionToken && !hasAccessKey) {
    throw new Error("ASSET_S3_SESSION_TOKEN 需要同时配置显式 access key 与 secret key");
  }
  if (input.accessKeyId && (input.accessKeyId.length < 3 || input.accessKeyId.length > 128)) {
    throw new Error("ASSET_S3_ACCESS_KEY_ID 必须是 3-128 个字符");
  }
  if (input.secretAccessKey && (input.secretAccessKey.length < 8 || input.secretAccessKey.length > 256)) {
    throw new Error("ASSET_S3_SECRET_ACCESS_KEY 必须是 8-256 个字符");
  }
  if (input.endpoint) {
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint);
    } catch {
      throw new Error("ASSET_S3_ENDPOINT 必须是有效的 HTTP(S) URL");
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
      throw new Error("ASSET_S3_ENDPOINT 不能包含凭据、路径、查询串或片段");
    }
    const loopbackHttp = endpoint.protocol === "http:"
      && isLoopbackHost(endpoint.hostname.replace(/^\[|\]$/g, ""));
    if (endpoint.protocol !== "https:" && (input.nodeEnv === "production" || !loopbackHttp)) {
      throw new Error("ASSET_S3_ENDPOINT 必须使用 HTTPS（本地开发 loopback 除外）");
    }
  }
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  role: ConfigRole = "all",
): AppConfig {
  const nodeEnv = environment.NODE_ENV;
  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new Error("NODE_ENV 必须显式设为 development、test 或 production");
  }
  if (role === "dev-memory" && nodeEnv === "production") {
    throw new Error("内存联调服务禁止在生产环境启动");
  }

  const configuredDatabaseUrl = environment.DATABASE_URL?.trim();
  if (nodeEnv === "production" && !configuredDatabaseUrl) {
    throw new Error("生产环境必须显式配置非空 DATABASE_URL，禁止回退到本地开发数据库");
  }

  const servesHttp = role === "all" || role === "api" || role === "dev-memory";
  const usesStorage = role !== "migration" && role !== "seed" && role !== "payment-reconciliation-worker";
  const usesPurgeSettings = role === "all"
    || role === "asset-purge"
    || role === "export-purge"
    || role === "dev-memory";
  const usesGenerationProvider = role === "all" || role === "generation-worker" || role === "dev-memory";
  const usesPaymentReconciliation = role === "all"
    || role === "payment-reconciliation-worker"
    || role === "dev-memory";
  const usesWechat = role === "all"
    || role === "api"
    || role === "payment-reconciliation-worker"
    || role === "dev-memory";
  const usesInternalWorkerKey = servesHttp;

  const host = servesHttp ? environment.HOST ?? "127.0.0.1" : "127.0.0.1";
  const databaseUrl = configuredDatabaseUrl
    ?? "postgres://pindou:pindou_local_only@127.0.0.1:54329/pindou";
  const databaseSsl = readBoolean(environment.DATABASE_SSL, false);
  const localDatabase = isLocalPostgresUrl(databaseUrl, nodeEnv === "production");
  const parsedDatabaseUrl = new URL(databaseUrl);
  const databaseHostname = parsedDatabaseUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
  const localDockerReleaseBridge = nodeEnv === "production"
    && databaseHostname === "host.docker.internal"
    && /(?:^|[_-])(?:e2e|test)(?:[_-]|$)/i.test(databaseName);
  const localDockerReleaseBridgeAcknowledged = localDockerReleaseBridge
    && environment.PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED === "true";
  const databasePoolMax = readInteger("DATABASE_POOL_MAX", environment.DATABASE_POOL_MAX, 10);
  const databaseIdleTimeoutMilliseconds = readInteger(
    "DATABASE_IDLE_TIMEOUT_MS",
    environment.DATABASE_IDLE_TIMEOUT_MS,
    30_000,
  );
  const databaseConnectionTimeoutMilliseconds = readInteger(
    "DATABASE_CONNECTION_TIMEOUT_MS",
    environment.DATABASE_CONNECTION_TIMEOUT_MS,
    5_000,
  );
  const longRunningDatabaseRole = role === "migration" || role === "seed";
  const databaseStatementTimeoutMilliseconds = readInteger(
    "DATABASE_STATEMENT_TIMEOUT_MS",
    environment.DATABASE_STATEMENT_TIMEOUT_MS,
    longRunningDatabaseRole ? 600_000 : 30_000,
  );
  const databaseLockTimeoutMilliseconds = readInteger(
    "DATABASE_LOCK_TIMEOUT_MS",
    environment.DATABASE_LOCK_TIMEOUT_MS,
    longRunningDatabaseRole ? 30_000 : 5_000,
  );
  const databaseIdleTransactionTimeoutMilliseconds = readInteger(
    "DATABASE_IDLE_TRANSACTION_TIMEOUT_MS",
    environment.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
    longRunningDatabaseRole ? 60_000 : 15_000,
  );
  if (databasePoolMax < 1 || databasePoolMax > 100) {
    throw new Error("DATABASE_POOL_MAX 必须介于 1 和 100 之间");
  }
  if (databaseIdleTimeoutMilliseconds < 1_000 || databaseIdleTimeoutMilliseconds > 600_000) {
    throw new Error("DATABASE_IDLE_TIMEOUT_MS 必须介于 1000 和 600000 之间");
  }
  if (databaseConnectionTimeoutMilliseconds < 100 || databaseConnectionTimeoutMilliseconds > 60_000) {
    throw new Error("DATABASE_CONNECTION_TIMEOUT_MS 必须介于 100 和 60000 之间");
  }
  if (databaseStatementTimeoutMilliseconds < 1_000 || databaseStatementTimeoutMilliseconds > 900_000) {
    throw new Error("DATABASE_STATEMENT_TIMEOUT_MS 必须介于 1000 和 900000 之间");
  }
  if (databaseLockTimeoutMilliseconds < 100 || databaseLockTimeoutMilliseconds > 120_000) {
    throw new Error("DATABASE_LOCK_TIMEOUT_MS 必须介于 100 和 120000 之间");
  }
  if (databaseIdleTransactionTimeoutMilliseconds < 1_000
    || databaseIdleTransactionTimeoutMilliseconds > 600_000) {
    throw new Error("DATABASE_IDLE_TRANSACTION_TIMEOUT_MS 必须介于 1000 和 600000 之间");
  }
  const exportDownloadGlobalConcurrency = servesHttp
    ? readInteger(
      "EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY",
      environment.EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY,
      DEFAULT_EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY,
    )
    : DEFAULT_EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY;
  const exportDownloadPerUserConcurrency = servesHttp
    ? readInteger(
      "EXPORT_DOWNLOAD_PER_USER_CONCURRENCY",
      environment.EXPORT_DOWNLOAD_PER_USER_CONCURRENCY,
      DEFAULT_EXPORT_DOWNLOAD_PER_USER_CONCURRENCY,
    )
    : DEFAULT_EXPORT_DOWNLOAD_PER_USER_CONCURRENCY;
  const exportDownloadReadTimeoutMilliseconds = servesHttp
    ? readInteger(
      "EXPORT_DOWNLOAD_READ_TIMEOUT_MS",
      environment.EXPORT_DOWNLOAD_READ_TIMEOUT_MS,
      DEFAULT_EXPORT_DOWNLOAD_READ_TIMEOUT_MILLISECONDS,
    )
    : DEFAULT_EXPORT_DOWNLOAD_READ_TIMEOUT_MILLISECONDS;
  const exportDownloadWriteTimeoutMilliseconds = servesHttp
    ? readInteger(
      "EXPORT_DOWNLOAD_WRITE_TIMEOUT_MS",
      environment.EXPORT_DOWNLOAD_WRITE_TIMEOUT_MS,
      DEFAULT_EXPORT_DOWNLOAD_WRITE_TIMEOUT_MILLISECONDS,
    )
    : DEFAULT_EXPORT_DOWNLOAD_WRITE_TIMEOUT_MILLISECONDS;
  if (exportDownloadGlobalConcurrency < 1 || exportDownloadGlobalConcurrency > 64) {
    throw new Error("EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY 必须介于 1 和 64 之间");
  }
  if (exportDownloadPerUserConcurrency < 1
    || exportDownloadPerUserConcurrency > exportDownloadGlobalConcurrency) {
    throw new Error("EXPORT_DOWNLOAD_PER_USER_CONCURRENCY 必须介于 1 和全局下载并发上限之间");
  }
  if (exportDownloadReadTimeoutMilliseconds < 1_000
    || exportDownloadReadTimeoutMilliseconds > 300_000) {
    throw new Error("EXPORT_DOWNLOAD_READ_TIMEOUT_MS 必须介于 1000 和 300000 之间");
  }
  if (exportDownloadWriteTimeoutMilliseconds < 1_000
    || exportDownloadWriteTimeoutMilliseconds > 600_000) {
    throw new Error("EXPORT_DOWNLOAD_WRITE_TIMEOUT_MS 必须介于 1000 和 600000 之间");
  }
  const devAuthEnabled = servesHttp ? readBoolean(environment.DEV_AUTH_ENABLED, false) : false;
  const trustedProxies = servesHttp ? readTrustedProxies(environment.TRUSTED_PROXIES) : [];
  const customPalettesEnabled = servesHttp
    ? readBoolean(environment.CUSTOM_PALETTES_ENABLED, nodeEnv !== "production")
    : false;
  const assetEncryptionKeyBase64 = usesStorage
    ? environment.ASSET_ENCRYPTION_KEY_BASE64 ?? DEVELOPMENT_ASSET_KEY
    : DEVELOPMENT_ASSET_KEY;
  const assetEncryptionActiveKeyId = usesStorage
    ? environment.ASSET_ENCRYPTION_ACTIVE_KEY_ID ?? DEFAULT_ASSET_ENCRYPTION_KEY_ID
    : DEFAULT_ASSET_ENCRYPTION_KEY_ID;
  const assetEncryptionReadKeysBase64 = usesStorage
    ? readEncryptionReadKeys(environment.ASSET_ENCRYPTION_READ_KEYS_JSON)
    : {};
  const configuredLegacyKeyId = usesStorage
    ? environment.ASSET_ENCRYPTION_LEGACY_KEY_ID
    : undefined;
  const assetEncryptionLegacyKeyId = configuredLegacyKeyId ?? assetEncryptionActiveKeyId;
  if (usesStorage) {
    validateEncryptionKeyId("ASSET_ENCRYPTION_ACTIVE_KEY_ID", assetEncryptionActiveKeyId);
    if (Object.hasOwn(assetEncryptionReadKeysBase64, assetEncryptionActiveKeyId)) {
      throw new Error("ASSET_ENCRYPTION_ACTIVE_KEY_ID 不能同时出现在 ASSET_ENCRYPTION_READ_KEYS_JSON 中");
    }
    if (Object.keys(assetEncryptionReadKeysBase64).length > 0 && configuredLegacyKeyId === undefined) {
      throw new Error("配置历史读取密钥时必须显式设置 ASSET_ENCRYPTION_LEGACY_KEY_ID");
    }
    validateEncryptionKeyId("ASSET_ENCRYPTION_LEGACY_KEY_ID", assetEncryptionLegacyKeyId);
    if (assetEncryptionLegacyKeyId !== assetEncryptionActiveKeyId
      && !Object.hasOwn(assetEncryptionReadKeysBase64, assetEncryptionLegacyKeyId)) {
      throw new Error("ASSET_ENCRYPTION_LEGACY_KEY_ID 必须指向 active key 或一个只读历史 key");
    }
  }
  const configuredAssetStorageProvider = usesStorage
    ? optionalText(environment.ASSET_STORAGE_PROVIDER)
    : undefined;
  if (usesStorage && nodeEnv === "production" && !configuredAssetStorageProvider) {
    throw new Error("生产环境使用对象存储的角色必须显式配置非空 ASSET_STORAGE_PROVIDER");
  }
  const assetStorageProvider = configuredAssetStorageProvider ?? "local";
  const configuredAssetStorageRoot = usesStorage
    ? optionalText(environment.ASSET_STORAGE_ROOT)
    : undefined;
  const assetLocalStorageProductionAcknowledged = usesStorage
    && nodeEnv === "production"
    && assetStorageProvider === "local"
    && environment.ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED !== undefined
    ? readStrictBoolean(
      "ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED",
      environment.ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED,
    )
    : false;
  const assetS3Bucket = usesStorage ? optionalText(environment.ASSET_S3_BUCKET) : undefined;
  const assetS3Region = usesStorage ? optionalText(environment.ASSET_S3_REGION) : undefined;
  const assetS3Endpoint = usesStorage ? optionalText(environment.ASSET_S3_ENDPOINT) : undefined;
  const assetS3Prefix = usesStorage && assetStorageProvider === "s3"
    ? optionalText(environment.ASSET_S3_PREFIX) ?? "pindou/private"
    : undefined;
  const assetS3AccessKeyId = usesStorage ? optionalText(environment.ASSET_S3_ACCESS_KEY_ID) : undefined;
  const assetS3SecretAccessKey = usesStorage ? optionalText(environment.ASSET_S3_SECRET_ACCESS_KEY) : undefined;
  const assetS3SessionToken = usesStorage ? optionalText(environment.ASSET_S3_SESSION_TOKEN) : undefined;
  const assetCloudbaseEnvId = usesStorage ? optionalText(environment.ASSET_CLOUDBASE_ENV_ID) : undefined;
  const assetCloudbaseBucketId = usesStorage ? optionalText(environment.ASSET_CLOUDBASE_BUCKET_ID) : undefined;
  const assetCloudbaseServiceRoleApiKey = usesStorage
    ? optionalText(environment.ASSET_CLOUDBASE_SERVICE_ROLE_API_KEY)
    : undefined;
  if (usesStorage) {
    validateAssetStorageConfiguration({
      nodeEnv,
      provider: assetStorageProvider,
      ...(configuredAssetStorageRoot ? { localRoot: configuredAssetStorageRoot } : {}),
      localProductionAcknowledged: assetLocalStorageProductionAcknowledged,
      ...(assetS3Bucket ? { bucket: assetS3Bucket } : {}),
      ...(assetS3Region ? { region: assetS3Region } : {}),
      ...(assetS3Endpoint ? { endpoint: assetS3Endpoint } : {}),
      ...(assetS3Prefix !== undefined ? { prefix: assetS3Prefix } : {}),
      ...(assetS3AccessKeyId ? { accessKeyId: assetS3AccessKeyId } : {}),
      ...(assetS3SecretAccessKey ? { secretAccessKey: assetS3SecretAccessKey } : {}),
      ...(assetS3SessionToken ? { sessionToken: assetS3SessionToken } : {}),
      ...(assetCloudbaseEnvId ? { cloudbaseEnvId: assetCloudbaseEnvId } : {}),
      ...(assetCloudbaseBucketId ? { cloudbaseBucketId: assetCloudbaseBucketId } : {}),
      ...(assetCloudbaseServiceRoleApiKey ? { cloudbaseServiceRoleApiKey: assetCloudbaseServiceRoleApiKey } : {}),
    });
  }
  const internalWorkerKey = usesInternalWorkerKey
    ? environment.INTERNAL_WORKER_KEY ?? DEVELOPMENT_WORKER_KEY
    : DEVELOPMENT_WORKER_KEY;
  if (nodeEnv === "production" && devAuthEnabled) {
    throw new Error("生产环境禁止启用 DEV_AUTH_ENABLED");
  }
  if (nodeEnv === "production" && servesHttp && trustedProxies.length === 0) {
    throw new Error("生产 API 必须通过 TRUSTED_PROXIES 显式配置可信反向代理 IP/CIDR");
  }
  if (devAuthEnabled && !isLoopbackHost(host)) {
    throw new Error("只有绑定 loopback 地址时才能启用 DEV_AUTH_ENABLED");
  }
  if (localDockerReleaseBridge
    && !databaseSsl
    && !localDockerReleaseBridgeAcknowledged) {
    throw new Error(
      "本地 Docker 发布候选通过 host.docker.internal 使用无 TLS PostgreSQL 时，"
      + "PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED 必须严格设为 true",
    );
  }
  if (nodeEnv === "production"
    && !databaseSsl
    && !localDatabase
    && !localDockerReleaseBridgeAcknowledged) {
    throw new Error("生产环境连接远程 PostgreSQL 时必须启用 DATABASE_SSL");
  }
  if (usesStorage) {
    const decodedAssetKey = decodeEncryptionKey(assetEncryptionKeyBase64);
    const decodedDevelopmentKey = Buffer.from(DEVELOPMENT_ASSET_KEY, "base64");
    const keyMaterialIds = new Map<string, string>([
      [assetEncryptionKeyBase64, assetEncryptionActiveKeyId],
    ]);
    for (const [keyId, keyBase64] of Object.entries(assetEncryptionReadKeysBase64)) {
      const existingKeyId = keyMaterialIds.get(keyBase64);
      if (existingKeyId) {
        throw new Error(`素材加密 key ID ${keyId} 与 ${existingKeyId} 重复使用同一密钥材料`);
      }
      keyMaterialIds.set(keyBase64, keyId);
    }
    if (nodeEnv === "production" && timingSafeEqual(decodedAssetKey, decodedDevelopmentKey)) {
      throw new Error("生产环境必须配置独立的 ASSET_ENCRYPTION_KEY_BASE64");
    }
    if (nodeEnv === "production") {
      for (const [keyId, keyBase64] of Object.entries(assetEncryptionReadKeysBase64)) {
        if (timingSafeEqual(decodeEncryptionKey(
          keyBase64,
          `ASSET_ENCRYPTION_READ_KEYS_JSON.${keyId}`,
        ), decodedDevelopmentKey)) {
          throw new Error("生产环境素材加密 keyring 禁止包含开发默认密钥");
        }
      }
    }
  }
  if (usesInternalWorkerKey && nodeEnv === "production" && internalWorkerKey === DEVELOPMENT_WORKER_KEY) {
    throw new Error("生产环境必须配置独立的 INTERNAL_WORKER_KEY");
  }
  if (usesInternalWorkerKey && internalWorkerKey.length < 32) {
    throw new Error("INTERNAL_WORKER_KEY 至少需要 32 个字符");
  }
  const port = servesHttp ? readInteger("PORT", environment.PORT, 8787) : 8787;
  if (port < 1 || port > 65_535) {
    throw new Error("PORT 必须介于 1 和 65535 之间");
  }
  const sessionTtlDays = servesHttp ? readInteger("SESSION_TTL_DAYS", environment.SESSION_TTL_DAYS, 30) : 30;
  if (sessionTtlDays < 1 || sessionTtlDays > 365) {
    throw new Error("SESSION_TTL_DAYS 必须介于 1 和 365 之间");
  }
  const devStartingCredits = servesHttp
    ? readInteger("DEV_STARTING_CREDITS", environment.DEV_STARTING_CREDITS, 6)
    : 20;
  if (devStartingCredits < 0 || devStartingCredits > 10_000) {
    throw new Error("DEV_STARTING_CREDITS 必须介于 0 和 10000 之间");
  }
  const assetMaxBytes = servesHttp
    ? readInteger("ASSET_MAX_BYTES", environment.ASSET_MAX_BYTES, 10 * 1024 * 1024)
    : 10 * 1024 * 1024;
  if (assetMaxBytes < 1024 || assetMaxBytes > 50 * 1024 * 1024) {
    throw new Error("ASSET_MAX_BYTES 必须介于 1 KiB 和 50 MiB 之间");
  }
  const assetDefaultTtlHours = servesHttp
    ? readInteger("ASSET_DEFAULT_TTL_HOURS", environment.ASSET_DEFAULT_TTL_HOURS, 23)
    : 23;
  if (assetDefaultTtlHours < 1 || assetDefaultTtlHours > 23) {
    throw new Error("ASSET_DEFAULT_TTL_HOURS 必须介于 1 和 23 之间");
  }
  const assetConsentVersion = servesHttp ? environment.ASSET_CONSENT_VERSION ?? "privacy-v1" : "privacy-v1";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(assetConsentVersion)) {
    throw new Error("ASSET_CONSENT_VERSION 必须是 1-64 字符的服务端版本标识");
  }
  const configuredAssetConsentProcessor = servesHttp
    ? optionalPolicyText("ASSET_CONSENT_PROCESSOR", environment.ASSET_CONSENT_PROCESSOR, 500)
    : undefined;
  const configuredAssetConsentPurposeText = servesHttp
    ? optionalPolicyText("ASSET_CONSENT_PURPOSE_TEXT", environment.ASSET_CONSENT_PURPOSE_TEXT, 1_000)
    : undefined;
  const configuredAssetConsentRetentionText = servesHttp
    ? optionalPolicyText("ASSET_CONSENT_RETENTION_TEXT", environment.ASSET_CONSENT_RETENTION_TEXT, 1_000)
    : undefined;
  if (servesHttp && nodeEnv === "production"
    && (!configuredAssetConsentProcessor
      || !configuredAssetConsentPurposeText
      || !configuredAssetConsentRetentionText
      || configuredAssetConsentProcessor.startsWith("development-placeholder")
      || configuredAssetConsentPurposeText.startsWith("development-placeholder")
      || configuredAssetConsentRetentionText.startsWith("development-placeholder"))) {
    throw new Error(
      "生产环境必须配置真实的 ASSET_CONSENT_PROCESSOR、ASSET_CONSENT_PURPOSE_TEXT 和 ASSET_CONSENT_RETENTION_TEXT",
    );
  }
  const assetConsentProcessor = servesHttp
    ? configuredAssetConsentProcessor ?? DEVELOPMENT_ASSET_CONSENT_PROCESSOR
    : undefined;
  const assetConsentPurposeText = servesHttp
    ? configuredAssetConsentPurposeText ?? DEVELOPMENT_ASSET_CONSENT_PURPOSE
    : undefined;
  const assetConsentRetentionText = servesHttp
    ? configuredAssetConsentRetentionText
      ?? `development-placeholder: AI 素材默认在 ${assetDefaultTtlHours} 小时后到期`
    : undefined;
  const assetPurgeBatchSize = usesPurgeSettings
    ? readInteger("ASSET_PURGE_BATCH_SIZE", environment.ASSET_PURGE_BATCH_SIZE, 500)
    : 500;
  if (assetPurgeBatchSize < 1 || assetPurgeBatchSize > 1_000) {
    throw new Error("ASSET_PURGE_BATCH_SIZE 必须介于 1 和 1000 之间");
  }
  const assetPurgeMaxBatches = usesPurgeSettings
    ? readInteger("ASSET_PURGE_MAX_BATCHES", environment.ASSET_PURGE_MAX_BATCHES, 100)
    : 100;
  if (assetPurgeMaxBatches < 1 || assetPurgeMaxBatches > 1_000) {
    throw new Error("ASSET_PURGE_MAX_BATCHES 必须介于 1 和 1000 之间");
  }
  const generationProviderUrl = usesGenerationProvider
    ? optionalText(environment.GENERATION_PROVIDER_URL)
    : undefined;
  const generationProviderApiKey = usesGenerationProvider
    ? optionalText(environment.GENERATION_PROVIDER_API_KEY)
    : undefined;
  const generationProviderTimeoutMilliseconds = usesGenerationProvider
    ? readInteger("GENERATION_PROVIDER_TIMEOUT_MS", environment.GENERATION_PROVIDER_TIMEOUT_MS, 120_000)
    : 120_000;
  const arkApiKey = usesGenerationProvider ? optionalText(environment.ARK_API_KEY) : undefined;
  const arkConfigured = usesGenerationProvider
    && (environment.ARK_API_KEY !== undefined
      || environment.ARK_IMAGE_MODEL !== undefined
      || environment.ARK_VISION_MODEL !== undefined);
  const arkImageModel = usesGenerationProvider
    ? optionalText(environment.ARK_IMAGE_MODEL) ?? "doubao-seedream-5-0-pro-260628"
    : undefined;
  const arkVisionModel = usesGenerationProvider ? optionalText(environment.ARK_VISION_MODEL) : undefined;
  if (generationProviderTimeoutMilliseconds < 1_000 || generationProviderTimeoutMilliseconds > 600_000) {
    throw new Error("GENERATION_PROVIDER_TIMEOUT_MS 必须介于 1000 和 600000 之间");
  }
  const paymentReconciliationLeaseMilliseconds = usesPaymentReconciliation
    ? readInteger("PAYMENT_RECONCILIATION_LEASE_MS", environment.PAYMENT_RECONCILIATION_LEASE_MS, 60_000)
    : 60_000;
  if (paymentReconciliationLeaseMilliseconds < 1_000 || paymentReconciliationLeaseMilliseconds > 3_600_000) {
    throw new Error("PAYMENT_RECONCILIATION_LEASE_MS 必须介于 1000 和 3600000 之间");
  }
  const paymentReconciliationPollMilliseconds = usesPaymentReconciliation
    ? readInteger("PAYMENT_RECONCILIATION_POLL_MS", environment.PAYMENT_RECONCILIATION_POLL_MS, 60_000)
    : 60_000;
  if (paymentReconciliationPollMilliseconds < 1_000 || paymentReconciliationPollMilliseconds > 3_600_000) {
    throw new Error("PAYMENT_RECONCILIATION_POLL_MS 必须介于 1000 和 3600000 之间");
  }
  const paymentReconciliationIdleMilliseconds = usesPaymentReconciliation
    ? readInteger("PAYMENT_RECONCILIATION_IDLE_MS", environment.PAYMENT_RECONCILIATION_IDLE_MS, 750)
    : 750;
  if (paymentReconciliationIdleMilliseconds < 100 || paymentReconciliationIdleMilliseconds > 60_000) {
    throw new Error("PAYMENT_RECONCILIATION_IDLE_MS 必须介于 100 和 60000 之间");
  }
  if (usesGenerationProvider) {
    validateGenerationProviderConfiguration({
      nodeEnv,
      ...(generationProviderUrl ? { url: generationProviderUrl } : {}),
      ...(generationProviderApiKey ? { apiKey: generationProviderApiKey } : {}),
      timeoutConfigured: environment.GENERATION_PROVIDER_TIMEOUT_MS !== undefined,
      arkConfigured,
      ...(arkApiKey ? { arkApiKey, ...(arkImageModel ? { arkImageModel } : {}), ...(arkVisionModel ? { arkVisionModel } : {}) } : {}),
    });
  }
  const wechatAppId = usesWechat ? optionalText(environment.WECHAT_APP_ID) : undefined;
  const wechatAppSecret = usesWechat ? optionalText(environment.WECHAT_APP_SECRET) : undefined;
  const wechatPayMerchantId = usesWechat ? optionalText(environment.WECHAT_PAY_MCH_ID) : undefined;
  const wechatPayMerchantCertificateSerial = usesWechat
    ? optionalText(environment.WECHAT_PAY_MERCHANT_CERT_SERIAL)
    : undefined;
  const wechatPayMerchantPrivateKeyPath = usesWechat
    ? optionalText(environment.WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH)
    : undefined;
  const wechatPayVerifierSerial = usesWechat ? optionalText(environment.WECHAT_PAY_VERIFIER_SERIAL) : undefined;
  const wechatPayVerifierPublicKeyPath = usesWechat
    ? optionalText(environment.WECHAT_PAY_VERIFIER_PUBLIC_KEY_PATH)
    : undefined;
  const wechatPayAdditionalVerifierPublicKeyPaths = usesWechat
    ? readWechatAdditionalVerifiers(environment.WECHAT_PAY_ADDITIONAL_VERIFIERS)
    : {};
  const wechatPayApiV3Key = usesWechat ? optionalText(environment.WECHAT_PAY_API_V3_KEY) : undefined;
  const wechatPayNotifyUrl = usesWechat ? optionalText(environment.WECHAT_PAY_NOTIFY_URL) : undefined;
  if (usesWechat) {
    validateWechatConfiguration({
      nodeEnv,
      devAuthEnabled,
      ...(wechatAppId ? { appId: wechatAppId } : {}),
      ...(wechatAppSecret ? { appSecret: wechatAppSecret } : {}),
      ...(wechatPayMerchantId ? { merchantId: wechatPayMerchantId } : {}),
      ...(wechatPayMerchantCertificateSerial ? { merchantCertificateSerial: wechatPayMerchantCertificateSerial } : {}),
      ...(wechatPayMerchantPrivateKeyPath ? { merchantPrivateKeyPath: wechatPayMerchantPrivateKeyPath } : {}),
      ...(wechatPayVerifierSerial ? { verifierSerial: wechatPayVerifierSerial } : {}),
      ...(wechatPayVerifierPublicKeyPath ? { verifierPublicKeyPath: wechatPayVerifierPublicKeyPath } : {}),
      ...(Object.keys(wechatPayAdditionalVerifierPublicKeyPaths).length > 0
        ? { additionalVerifierPublicKeyPaths: wechatPayAdditionalVerifierPublicKeyPaths }
        : {}),
      ...(wechatPayApiV3Key ? { apiV3Key: wechatPayApiV3Key } : {}),
      ...(wechatPayNotifyUrl ? { notifyUrl: wechatPayNotifyUrl } : {}),
    });
  }
  return {
    nodeEnv,
    host,
    port,
    databaseUrl,
    databaseSsl,
    databasePoolMax,
    databaseIdleTimeoutMilliseconds,
    databaseConnectionTimeoutMilliseconds,
    databaseStatementTimeoutMilliseconds,
    databaseLockTimeoutMilliseconds,
    databaseIdleTransactionTimeoutMilliseconds,
    exportDownloadGlobalConcurrency,
    exportDownloadPerUserConcurrency,
    exportDownloadReadTimeoutMilliseconds,
    exportDownloadWriteTimeoutMilliseconds,
    devAuthEnabled,
    trustedProxies,
    customPalettesEnabled,
    corsOrigins: (servesHttp ? environment.CORS_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174" : "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    sessionTtlDays,
    devStartingCredits,
    assetStorageProvider: assetStorageProvider as "local" | "s3" | "cloudbase-pg",
    assetStorageRoot: configuredAssetStorageRoot ?? ".data/private-assets",
    assetLocalStorageProductionAcknowledged,
    assetEncryptionKeyBase64,
    assetEncryptionActiveKeyId,
    assetEncryptionReadKeysBase64,
    assetEncryptionLegacyKeyId,
    ...(assetS3Bucket ? { assetS3Bucket } : {}),
    ...(assetS3Region ? { assetS3Region } : {}),
    ...(assetS3Endpoint ? { assetS3Endpoint } : {}),
    ...(assetS3Prefix !== undefined ? { assetS3Prefix } : {}),
    assetS3ForcePathStyle: usesStorage ? readBoolean(environment.ASSET_S3_FORCE_PATH_STYLE, false) : false,
    ...(assetS3AccessKeyId ? { assetS3AccessKeyId } : {}),
    ...(assetS3SecretAccessKey ? { assetS3SecretAccessKey } : {}),
    ...(assetS3SessionToken ? { assetS3SessionToken } : {}),
    ...(assetCloudbaseEnvId ? { assetCloudbaseEnvId } : {}),
    ...(assetCloudbaseBucketId ? { assetCloudbaseBucketId } : {}),
    ...(assetCloudbaseServiceRoleApiKey ? { assetCloudbaseServiceRoleApiKey } : {}),
    assetMaxBytes,
    assetDefaultTtlHours,
    assetConsentVersion,
    ...(assetConsentProcessor ? { assetConsentProcessor } : {}),
    ...(assetConsentPurposeText ? { assetConsentPurposeText } : {}),
    ...(assetConsentRetentionText ? { assetConsentRetentionText } : {}),
    assetPurgeBatchSize,
    assetPurgeMaxBatches,
    internalWorkerKey,
    generationProviderTimeoutMilliseconds,
    paymentReconciliationLeaseMilliseconds,
    paymentReconciliationPollMilliseconds,
    paymentReconciliationIdleMilliseconds,
    ...(generationProviderUrl ? { generationProviderUrl } : {}),
    ...(generationProviderApiKey ? { generationProviderApiKey } : {}),
    ...(arkApiKey ? { arkApiKey } : {}),
    ...(arkApiKey && arkImageModel ? { arkImageModel } : {}),
    ...(arkApiKey && arkVisionModel ? { arkVisionModel } : {}),
    ...(wechatAppId ? { wechatAppId } : {}),
    ...(wechatAppSecret ? { wechatAppSecret } : {}),
    ...(wechatPayMerchantId ? { wechatPayMerchantId } : {}),
    ...(wechatPayMerchantCertificateSerial ? { wechatPayMerchantCertificateSerial } : {}),
    ...(wechatPayMerchantPrivateKeyPath ? { wechatPayMerchantPrivateKeyPath } : {}),
    ...(wechatPayVerifierSerial ? { wechatPayVerifierSerial } : {}),
    ...(wechatPayVerifierPublicKeyPath ? { wechatPayVerifierPublicKeyPath } : {}),
    ...(Object.keys(wechatPayAdditionalVerifierPublicKeyPaths).length > 0
      ? { wechatPayAdditionalVerifierPublicKeyPaths }
      : {}),
    ...(wechatPayApiV3Key ? { wechatPayApiV3Key } : {}),
    ...(wechatPayNotifyUrl ? { wechatPayNotifyUrl } : {}),
  };
}
