import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { parse, resolve } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";

const DEVELOPMENT_KEY = "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=";
const PRODUCTION_DATABASE_CONFIG = {
  DATABASE_URL: "postgresql://pindou:secret@localhost:5432/pindou",
  DATABASE_SSL: "false",
};
const PRODUCTION_GENERATION_CONFIG = {
  GENERATION_PROVIDER_URL: "https://generation.example.test/v1/generate",
  GENERATION_PROVIDER_API_KEY: "production-generation-provider-secret",
  GENERATION_PROVIDER_TIMEOUT_MS: "120000",
};
const PRODUCTION_S3_STORAGE_CONFIG = {
  ASSET_STORAGE_PROVIDER: "s3",
  ASSET_S3_BUCKET: "private-assets",
  ASSET_S3_REGION: "us-east-1",
};
const PRODUCTION_ASSET_CONSENT_CONFIG = {
  ASSET_CONSENT_PROCESSOR: "Pindou production processor test fixture",
  ASSET_CONSENT_PURPOSE_TEXT: "将用户提供的图片处理为拼豆图纸",
  ASSET_CONSENT_RETENTION_TEXT: "AI 素材最长保留 23 小时，之后进入清理流程",
};
const PRODUCTION_WECHAT_CONFIG = {
  TRUSTED_PROXIES: "127.0.0.1/32,10.0.0.0/8",
  WECHAT_APP_ID: "wx1234567890abcdef",
  WECHAT_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WECHAT_PAY_MCH_ID: "1900000001",
  WECHAT_PAY_MERCHANT_CERT_SERIAL: "0123456789ABCDEF",
  WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: "C:/secrets/apiclient_key.pem",
  WECHAT_PAY_VERIFIER_SERIAL: "PUB_KEY_ID_3000000001",
  WECHAT_PAY_VERIFIER_PUBLIC_KEY_PATH: "C:/secrets/wechatpay_public_key.pem",
  WECHAT_PAY_API_V3_KEY: "0123456789abcdef0123456789abcdef",
  WECHAT_PAY_NOTIFY_URL: "https://api.example.test/api/v1/wechat-pay/notifications",
};

describe("security-sensitive configuration", () => {
  it("parses bounded WeChat verifier overlap keys and rejects duplicate serials", () => {
    const configured = loadConfig({
      NODE_ENV: "development",
      ...PRODUCTION_WECHAT_CONFIG,
      WECHAT_PAY_ADDITIONAL_VERIFIERS: "PUB_KEY_ID_OLD=C:/secrets/old.pem,PUB_KEY_ID_NEXT=C:/secrets/next.pem",
    }, "api");
    assert.deepEqual(configured.wechatPayAdditionalVerifierPublicKeyPaths, {
      PUB_KEY_ID_OLD: "C:/secrets/old.pem",
      PUB_KEY_ID_NEXT: "C:/secrets/next.pem",
    });
    assert.throws(() => loadConfig({
      NODE_ENV: "development",
      ...PRODUCTION_WECHAT_CONFIG,
      WECHAT_PAY_ADDITIONAL_VERIFIERS: "PUB_KEY_ID_OLD=C:/secrets/old.pem,PUB_KEY_ID_OLD=C:/secrets/other.pem",
    }, "api"), /重复 serial/);
    assert.throws(() => loadConfig({
      NODE_ENV: "development",
      ...PRODUCTION_WECHAT_CONFIG,
      WECHAT_PAY_ADDITIONAL_VERIFIERS: "PUB_KEY_ID_3000000001=C:/secrets/duplicate-primary.pem",
    }, "api"), /不能重复 primary/);
    assert.throws(() => loadConfig({
      NODE_ENV: "development",
      ...PRODUCTION_WECHAT_CONFIG,
      WECHAT_PAY_ADDITIONAL_VERIFIERS: Array.from(
        { length: 9 },
        (_, index) => `PUB_KEY_ID_${index}=C:/secrets/key-${index}.pem`,
      ).join(","),
    }, "api"), /最多允许 8/);
  });

  it("requires an explicit recognized NODE_ENV", () => {
    assert.throws(() => loadConfig({}), /NODE_ENV/);
    assert.throws(() => loadConfig({ NODE_ENV: "staging" }), /NODE_ENV/);
  });

  it("allows the local Vite workbench origin on 5174 by default", () => {
    const development = loadConfig({ NODE_ENV: "development" });
    assert.deepEqual(development.corsOrigins, [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://127.0.0.1:5174",
      "http://localhost:5174",
    ]);
  });

  it("keeps development auth off by default and limits it to loopback", () => {
    const disabled = loadConfig({ NODE_ENV: "development" });
    assert.equal(disabled.devAuthEnabled, false);
    assert.equal(disabled.assetDefaultTtlHours, 23);
    assert.equal(disabled.assetConsentVersion, "privacy-v1");
    assert.equal(disabled.assetConsentProcessor, "development-placeholder-processor");
    assert.match(disabled.assetConsentPurposeText ?? "", /^development-placeholder:/);
    assert.match(disabled.assetConsentRetentionText ?? "", /^development-placeholder:.*23/);
    assert.equal(disabled.assetPurgeBatchSize, 500);
    assert.equal(disabled.assetPurgeMaxBatches, 100);
    assert.equal(disabled.customPalettesEnabled, true);
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", HOST: "0.0.0.0", DEV_AUTH_ENABLED: "true" }),
      /loopback/,
    );
    const local = loadConfig({ NODE_ENV: "development", HOST: "127.0.0.1", DEV_AUTH_ENABLED: "true" });
    assert.equal(local.devAuthEnabled, true);
    const proxied = loadConfig({ NODE_ENV: "development", TRUSTED_PROXIES: "127.0.0.1/32,::1/128" });
    assert.deepEqual(proxied.trustedProxies, ["127.0.0.1/32", "::1/128"]);
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", TRUSTED_PROXIES: "127.0.0.1/99" }),
      /CIDR/,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", TRUSTED_PROXIES: "0.0.0.0/0" }),
      /CIDR/,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", TRUSTED_PROXIES: "::/0" }),
      /CIDR/,
    );
  });

  it("allows incomplete WeChat login credentials only behind the local development auth gate", () => {
    const localFallback = loadConfig({
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      DEV_AUTH_ENABLED: "true",
      WECHAT_APP_ID: "wx76416adc3763ff72",
    }, "api");
    assert.equal(localFallback.wechatAppId, "wx76416adc3763ff72");
    assert.equal(localFallback.wechatAppSecret, undefined);

    assert.throws(() => loadConfig({
      NODE_ENV: "development",
      WECHAT_APP_ID: "wx76416adc3763ff72",
    }, "api"), /WECHAT_APP_SECRET/);

    const realLogin = loadConfig({
      NODE_ENV: "development",
      DEV_AUTH_ENABLED: "true",
      WECHAT_APP_ID: "wx76416adc3763ff72",
      WECHAT_APP_SECRET: "development-real-wechat-secret",
    }, "api");
    assert.equal(realLogin.wechatAppSecret, "development-real-wechat-secret");

    const productionBase = {
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      ...PRODUCTION_DATABASE_CONFIG,
      ...PRODUCTION_S3_STORAGE_CONFIG,
      ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
      INTERNAL_WORKER_KEY: "production-worker-key-that-is-at-least-32-chars",
      ...PRODUCTION_ASSET_CONSENT_CONFIG,
      ...PRODUCTION_WECHAT_CONFIG,
    };
    assert.throws(() => loadConfig({
      ...productionBase,
      DEV_AUTH_ENABLED: "true",
    }, "api"), /生产环境禁止启用 DEV_AUTH_ENABLED/);
    assert.throws(() => loadConfig({
      ...productionBase,
      DEV_AUTH_ENABLED: "false",
      WECHAT_APP_SECRET: undefined,
    }, "api"), /WECHAT_APP_SECRET/);
  });

  it("rejects non-canonical and development encryption keys in production", () => {
    const productionBase = {
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      ...PRODUCTION_S3_STORAGE_CONFIG,
      DEV_AUTH_ENABLED: "false",
      INTERNAL_WORKER_KEY: "production-worker-key-that-is-at-least-32-chars",
      ...PRODUCTION_GENERATION_CONFIG,
      ...PRODUCTION_ASSET_CONSENT_CONFIG,
      ...PRODUCTION_WECHAT_CONFIG,
    };
    assert.throws(
      () => loadConfig({ ...productionBase, ASSET_ENCRYPTION_KEY_BASE64: `${DEVELOPMENT_KEY}!` }),
      /Base64/,
    );
    assert.throws(
      () => loadConfig({ ...productionBase, ASSET_ENCRYPTION_KEY_BASE64: DEVELOPMENT_KEY }),
      /生产环境必须配置独立/,
    );
    const secure = loadConfig({
      ...productionBase,
      HOST: "0.0.0.0",
      ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
    });
    assert.equal(secure.nodeEnv, "production");
    assert.equal(secure.customPalettesEnabled, false);
    assert.equal(secure.generationProviderUrl, PRODUCTION_GENERATION_CONFIG.GENERATION_PROVIDER_URL);
    assert.equal(secure.generationProviderTimeoutMilliseconds, 120_000);
    assert.throws(
      () => loadConfig({ ...productionBase, TRUSTED_PROXIES: undefined, ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64") }),
      /TRUSTED_PROXIES/,
    );
  });

  it("bounds retention and validates the server-owned consent version", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", ASSET_DEFAULT_TTL_HOURS: "24" }),
      /1 和 23/,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", ASSET_CONSENT_VERSION: "privacy version with spaces" }),
      /ASSET_CONSENT_VERSION/,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", ASSET_CONSENT_PROCESSOR: "invalid\nprocessor" }),
      /ASSET_CONSENT_PROCESSOR/,
    );
    assert.throws(() => loadConfig({
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      ...PRODUCTION_S3_STORAGE_CONFIG,
      ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
      INTERNAL_WORKER_KEY: "production-worker-key-that-is-at-least-32-chars",
      ...PRODUCTION_WECHAT_CONFIG,
    }, "api"), /ASSET_CONSENT_PROCESSOR/);
    assert.throws(() => loadConfig({
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      ...PRODUCTION_S3_STORAGE_CONFIG,
      ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
      INTERNAL_WORKER_KEY: "production-worker-key-that-is-at-least-32-chars",
      ...PRODUCTION_WECHAT_CONFIG,
      ...PRODUCTION_ASSET_CONSENT_CONFIG,
      ASSET_CONSENT_PROCESSOR: "development-placeholder-processor",
    }, "api"), /ASSET_CONSENT_PROCESSOR/);
    const configured = loadConfig({
      NODE_ENV: "development",
      ASSET_DEFAULT_TTL_HOURS: "22",
      ASSET_CONSENT_VERSION: "privacy-v2.1",
      ASSET_PURGE_BATCH_SIZE: "250",
      ASSET_PURGE_MAX_BATCHES: "20",
    });
    assert.equal(configured.assetDefaultTtlHours, 22);
    assert.equal(configured.assetConsentVersion, "privacy-v2.1");
    assert.equal(configured.assetPurgeBatchSize, 250);
    assert.equal(configured.assetPurgeMaxBatches, 20);
  });

  it("strictly parses integer settings and enforces their ranges", () => {
    const configured = loadConfig({
      NODE_ENV: "development",
      PORT: "65535",
      SESSION_TTL_DAYS: "365",
      DEV_STARTING_CREDITS: "10000",
      DATABASE_POOL_MAX: "24",
      DATABASE_IDLE_TIMEOUT_MS: "45000",
      DATABASE_CONNECTION_TIMEOUT_MS: "4000",
      DATABASE_STATEMENT_TIMEOUT_MS: "25000",
      DATABASE_LOCK_TIMEOUT_MS: "3000",
      DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: "12000",
      EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY: "12",
      EXPORT_DOWNLOAD_PER_USER_CONCURRENCY: "3",
      EXPORT_DOWNLOAD_READ_TIMEOUT_MS: "45000",
      EXPORT_DOWNLOAD_WRITE_TIMEOUT_MS: "90000",
    });
    assert.equal(configured.port, 65_535);
    assert.equal(configured.sessionTtlDays, 365);
    assert.equal(configured.devStartingCredits, 10_000);
    assert.equal(configured.databasePoolMax, 24);
    assert.equal(configured.databaseIdleTimeoutMilliseconds, 45_000);
    assert.equal(configured.databaseConnectionTimeoutMilliseconds, 4_000);
    assert.equal(configured.databaseStatementTimeoutMilliseconds, 25_000);
    assert.equal(configured.databaseLockTimeoutMilliseconds, 3_000);
    assert.equal(configured.databaseIdleTransactionTimeoutMilliseconds, 12_000);
    assert.equal(configured.exportDownloadGlobalConcurrency, 12);
    assert.equal(configured.exportDownloadPerUserConcurrency, 3);
    assert.equal(configured.exportDownloadReadTimeoutMilliseconds, 45_000);
    assert.equal(configured.exportDownloadWriteTimeoutMilliseconds, 90_000);

    const apiDefaults = loadConfig({ NODE_ENV: "development" }, "api");
    assert.equal(apiDefaults.databaseStatementTimeoutMilliseconds, 30_000);
    assert.equal(apiDefaults.databaseLockTimeoutMilliseconds, 5_000);
    assert.equal(apiDefaults.databaseIdleTransactionTimeoutMilliseconds, 15_000);
    assert.equal(apiDefaults.exportDownloadGlobalConcurrency, 4);
    assert.equal(apiDefaults.exportDownloadPerUserConcurrency, 2);
    assert.equal(apiDefaults.exportDownloadReadTimeoutMilliseconds, 60_000);
    assert.equal(apiDefaults.exportDownloadWriteTimeoutMilliseconds, 120_000);
    const migrationDefaults = loadConfig({ NODE_ENV: "development" }, "migration");
    assert.equal(migrationDefaults.databaseStatementTimeoutMilliseconds, 600_000);
    assert.equal(migrationDefaults.databaseLockTimeoutMilliseconds, 30_000);
    assert.equal(migrationDefaults.databaseIdleTransactionTimeoutMilliseconds, 60_000);

    for (const environment of [
      { PORT: "0" },
      { PORT: "65536" },
      { PORT: "12junk" },
      { SESSION_TTL_DAYS: "0" },
      { SESSION_TTL_DAYS: "366" },
      { SESSION_TTL_DAYS: "30days" },
      { DEV_STARTING_CREDITS: "-1" },
      { DEV_STARTING_CREDITS: "10001" },
      { DEV_STARTING_CREDITS: "20credits" },
      { GENERATION_PROVIDER_TIMEOUT_MS: "999" },
      { GENERATION_PROVIDER_TIMEOUT_MS: "600001" },
      { GENERATION_PROVIDER_TIMEOUT_MS: "12seconds" },
      { DATABASE_POOL_MAX: "0" },
      { DATABASE_POOL_MAX: "101" },
      { DATABASE_IDLE_TIMEOUT_MS: "999" },
      { DATABASE_CONNECTION_TIMEOUT_MS: "99" },
      { DATABASE_STATEMENT_TIMEOUT_MS: "999" },
      { DATABASE_LOCK_TIMEOUT_MS: "99" },
      { DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: "999" },
      { EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY: "0" },
      { EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY: "65" },
      { EXPORT_DOWNLOAD_PER_USER_CONCURRENCY: "0" },
      { EXPORT_DOWNLOAD_READ_TIMEOUT_MS: "999" },
      { EXPORT_DOWNLOAD_READ_TIMEOUT_MS: "300001" },
      { EXPORT_DOWNLOAD_WRITE_TIMEOUT_MS: "999" },
      { EXPORT_DOWNLOAD_WRITE_TIMEOUT_MS: "600001" },
    ]) {
      assert.throws(() => loadConfig({ NODE_ENV: "development", ...environment }));
    }
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", ASSET_PURGE_BATCH_SIZE: "12junk" }),
      /ASSET_PURGE_BATCH_SIZE 必须是十进制整数/,
    );
    assert.throws(
      () => loadConfig({
        NODE_ENV: "development",
        EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY: "2",
        EXPORT_DOWNLOAD_PER_USER_CONCURRENCY: "3",
      }),
      /全局下载并发上限/,
    );

    const workerIgnoresApiOnlyDownloadSettings = loadConfig({
      NODE_ENV: "development",
      EXPORT_DOWNLOAD_GLOBAL_CONCURRENCY: "not-an-integer",
      EXPORT_DOWNLOAD_PER_USER_CONCURRENCY: "not-an-integer",
      EXPORT_DOWNLOAD_READ_TIMEOUT_MS: "not-an-integer",
      EXPORT_DOWNLOAD_WRITE_TIMEOUT_MS: "not-an-integer",
    }, "export-worker");
    assert.equal(workerIgnoresApiOnlyDownloadSettings.exportDownloadGlobalConcurrency, 4);
    assert.equal(workerIgnoresApiOnlyDownloadSettings.exportDownloadPerUserConcurrency, 2);
    assert.equal(workerIgnoresApiOnlyDownloadSettings.exportDownloadReadTimeoutMilliseconds, 60_000);
    assert.equal(workerIgnoresApiOnlyDownloadSettings.exportDownloadWriteTimeoutMilliseconds, 120_000);
  });

  it("requires TLS for a remote production PostgreSQL connection", () => {
    const productionBase = {
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      ...PRODUCTION_S3_STORAGE_CONFIG,
      DEV_AUTH_ENABLED: "false",
      INTERNAL_WORKER_KEY: "production-worker-key-that-is-at-least-32-chars",
      ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
      ...PRODUCTION_GENERATION_CONFIG,
      ...PRODUCTION_ASSET_CONSENT_CONFIG,
      ...PRODUCTION_WECHAT_CONFIG,
    };
    const remoteDatabaseUrl = "postgres://pindou:secret@db.internal:5432/pindou";

    assert.throws(
      () => loadConfig({ ...productionBase, DATABASE_URL: remoteDatabaseUrl, DATABASE_SSL: "false" }),
      /必须启用 DATABASE_SSL/,
    );
    const secured = loadConfig({ ...productionBase, DATABASE_URL: remoteDatabaseUrl, DATABASE_SSL: "true" });
    assert.equal(secured.databaseSsl, true);
    const passwordless = loadConfig({
      ...productionBase,
      DATABASE_URL: "postgresql://pindou@db.internal:5432/pindou",
      DATABASE_SSL: "true",
    });
    assert.equal(passwordless.databaseUrl, "postgresql://pindou@db.internal:5432/pindou");

    const local = loadConfig({
      ...productionBase,
      DATABASE_URL: "postgresql://pindou:secret@localhost:5432/pindou",
      DATABASE_SSL: "false",
    });
    assert.equal(local.databaseSsl, false);
    for (const unsafeDatabaseUrl of [
      "postgresql://pindou:secret@127.0.0.1:5432/pindou?host=db.internal",
      "postgresql://pindou:secret@127.0.0.1:5432/pindou?database=production",
      "postgresql://pindou:secret@127.0.0.1:5432/pindou#host=db.internal",
    ]) {
      assert.throws(
        () => loadConfig({ ...productionBase, DATABASE_URL: unsafeDatabaseUrl, DATABASE_SSL: "false" }),
        /不得包含 (?:query 参数|URL fragment)/,
      );
    }
    for (const incompleteDatabaseUrl of [
      "postgresql:///pindou",
      "postgresql://db.internal:5432/pindou",
      "postgresql://pindou@db.internal/pindou",
      "postgresql://pindou@db.internal:5432",
      "postgresql://pindou@db.internal:5432/first/second",
      "postgresql://pindou@db.internal:5432/first%2Fsecond",
    ]) {
      assert.throws(
        () => loadConfig({
          ...productionBase,
          DATABASE_URL: incompleteDatabaseUrl,
          DATABASE_SSL: "true",
          PGPORT: "6543",
        }),
        /必须(?:显式包含数据库 (?:host|user)|显式包含 1-65535 的数据库 port|在 path 中显式指定唯一数据库名)/,
      );
    }
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", DATABASE_URL: "https://db.internal/pindou" }),
      /postgres:\/\/ 或 postgresql:\/\//,
    );
  });

  it("allows the explicitly acknowledged local Docker release bridge only for the exact host", () => {
    const bridge = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://pindou:secret@host.docker.internal:54329/pindou_test_release",
      DATABASE_SSL: "false",
    };
    assert.throws(
      () => loadConfig(bridge, "migration"),
      /PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED.*true/,
    );
    assert.throws(
      () => loadConfig({
        ...bridge,
        PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED: "TRUE",
      }, "migration"),
      /PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED.*true/,
    );
    assert.doesNotThrow(() => loadConfig({
      ...bridge,
      PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED: "true",
    }, "migration"));
    assert.doesNotThrow(() => loadConfig({
      ...bridge,
      PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED: "true",
    }, "seed"));
    const acknowledgedBridge = {
      ...bridge,
      PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED: "true",
    };
    const storage = {
      ...PRODUCTION_S3_STORAGE_CONFIG,
      ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
    };
    assert.doesNotThrow(() => loadConfig({
      ...acknowledgedBridge,
      ...storage,
      ...PRODUCTION_ASSET_CONSENT_CONFIG,
      ...PRODUCTION_WECHAT_CONFIG,
      INTERNAL_WORKER_KEY: "production-worker-key-that-is-at-least-32-chars",
    }, "api"));
    assert.doesNotThrow(() => loadConfig({
      ...acknowledgedBridge,
      ...storage,
      ...PRODUCTION_GENERATION_CONFIG,
    }, "generation-worker"));
    assert.doesNotThrow(() => loadConfig({
      ...acknowledgedBridge,
      ...storage,
    }, "export-worker"));
    assert.doesNotThrow(() => loadConfig({
      ...acknowledgedBridge,
      ...PRODUCTION_WECHAT_CONFIG,
    }, "payment-reconciliation-worker"));
    assert.throws(
      () => loadConfig({
        ...bridge,
        DATABASE_URL: "postgresql://pindou:secret@db.internal:5432/pindou_test_release",
        PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED: "true",
      }, "migration"),
      /必须启用 DATABASE_SSL/,
    );
    assert.throws(
      () => loadConfig({
        ...bridge,
        DATABASE_URL: "postgresql://pindou:secret@host.docker.internal:54329/pindou",
        PINDOU_RELEASE_LOCAL_DOCKER_BRIDGE_ACKNOWLEDGED: "true",
      }, "migration"),
      /必须启用 DATABASE_SSL/,
    );
  });

  it("requires a complete HTTPS Generation Provider configuration in production", () => {
    const productionBase = {
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      ...PRODUCTION_S3_STORAGE_CONFIG,
      DEV_AUTH_ENABLED: "false",
      INTERNAL_WORKER_KEY: "production-worker-key-that-is-at-least-32-chars",
      ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
      ...PRODUCTION_ASSET_CONSENT_CONFIG,
      ...PRODUCTION_WECHAT_CONFIG,
    };
    assert.throws(() => loadConfig(productionBase), /Generation Provider/);
    assert.throws(() => loadConfig({
      ...productionBase,
      GENERATION_PROVIDER_URL: PRODUCTION_GENERATION_CONFIG.GENERATION_PROVIDER_URL,
    }), /配置不完整/);
    assert.throws(() => loadConfig({
      ...productionBase,
      ...PRODUCTION_GENERATION_CONFIG,
      GENERATION_PROVIDER_URL: "http://generation.example.test/v1/generate",
    }), /HTTPS/);
    assert.throws(() => loadConfig({
      NODE_ENV: "development",
      GENERATION_PROVIDER_URL: "https://generation.example.test/v1/generate",
      GENERATION_PROVIDER_API_KEY: "test-secret",
    }), /GENERATION_PROVIDER_TIMEOUT_MS/);

    const configured = loadConfig({
      ...productionBase,
      ...PRODUCTION_GENERATION_CONFIG,
    });
    assert.equal(configured.generationProviderApiKey, PRODUCTION_GENERATION_CONFIG.GENERATION_PROVIDER_API_KEY);
    assert.equal(configured.generationProviderTimeoutMilliseconds, 120_000);

    const development = loadConfig({ NODE_ENV: "development" });
    assert.equal(development.generationProviderUrl, undefined);
    assert.equal(development.generationProviderApiKey, undefined);
    assert.equal(development.generationProviderTimeoutMilliseconds, 120_000);

    const localGateway = loadConfig({
      NODE_ENV: "development",
      GENERATION_PROVIDER_URL: "http://127.0.0.1:9999/generate",
      GENERATION_PROVIDER_API_KEY: "local-integration-secret",
      GENERATION_PROVIDER_TIMEOUT_MS: "30000",
    });
    assert.equal(localGateway.generationProviderUrl, "http://127.0.0.1:9999/generate");
    assert.equal(localGateway.generationProviderTimeoutMilliseconds, 30_000);
    const ark = loadConfig({
      NODE_ENV: "development",
      ARK_API_KEY: "ark-secret",
      ARK_IMAGE_MODEL: "doubao-seedream-5-0-flash-260915",
      GENERATION_PROVIDER_TIMEOUT_MS: "30000",
    }, "dev-memory");
    assert.equal(ark.arkApiKey, "ark-secret");
    assert.equal(ark.arkImageModel, "doubao-seedream-5-0-flash-260915");
    assert.equal(ark.generationProviderTimeoutMilliseconds, 30_000);
    assert.throws(() => loadConfig({
      NODE_ENV: "development",
      ARK_IMAGE_MODEL: "doubao-seedream-5-0-flash-260915",
    }, "dev-memory"), /ARK_API_KEY/);
    assert.throws(() => loadConfig({
      NODE_ENV: "development",
      ARK_API_KEY: "ark-secret",
      GENERATION_PROVIDER_URL: "http://127.0.0.1:9999/generate",
      GENERATION_PROVIDER_API_KEY: "external-secret",
      GENERATION_PROVIDER_TIMEOUT_MS: "30000",
    }, "dev-memory"), /不能同时配置/);
  });

  it("isolates production secret validation by runtime role while keeping each role fail-closed", () => {
    const assetKey = randomBytes(32).toString("base64");
    const api = loadConfig({
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      ...PRODUCTION_S3_STORAGE_CONFIG,
      ASSET_ENCRYPTION_KEY_BASE64: assetKey,
      INTERNAL_WORKER_KEY: "production-worker-key-that-is-at-least-32-chars",
      ...PRODUCTION_ASSET_CONSENT_CONFIG,
      ...PRODUCTION_WECHAT_CONFIG,
      // API does not execute generation jobs; unrelated malformed settings are ignored.
      GENERATION_PROVIDER_URL: "not-a-url",
      GENERATION_PROVIDER_TIMEOUT_MS: "not-an-integer",
    }, "api");
    assert.equal(api.wechatAppId, PRODUCTION_WECHAT_CONFIG.WECHAT_APP_ID);
    assert.equal(api.generationProviderUrl, undefined);

    const generationWorker = loadConfig({
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      ...PRODUCTION_S3_STORAGE_CONFIG,
      ASSET_ENCRYPTION_KEY_BASE64: assetKey,
      ...PRODUCTION_GENERATION_CONFIG,
      // Worker never handles login/payment or internal HTTP routes.
      WECHAT_APP_ID: "partial-and-irrelevant",
      INTERNAL_WORKER_KEY: "short-and-irrelevant",
    }, "generation-worker");
    assert.equal(generationWorker.generationProviderUrl, PRODUCTION_GENERATION_CONFIG.GENERATION_PROVIDER_URL);
    assert.equal(generationWorker.wechatAppId, undefined);

    const arkWorker = loadConfig({
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      ...PRODUCTION_S3_STORAGE_CONFIG,
      ASSET_ENCRYPTION_KEY_BASE64: assetKey,
      ARK_API_KEY: "production-ark-secret",
      ARK_IMAGE_MODEL: "doubao-seedream-5-0-pro-260628",
      GENERATION_PROVIDER_TIMEOUT_MS: "120000",
    }, "generation-worker");
    assert.equal(arkWorker.arkApiKey, "production-ark-secret");
    assert.equal(arkWorker.generationProviderUrl, undefined);

    for (const role of ["export-worker", "asset-purge", "export-purge"] as const) {
      const config = loadConfig({
        NODE_ENV: "production",
        ...PRODUCTION_DATABASE_CONFIG,
        ...PRODUCTION_S3_STORAGE_CONFIG,
        ASSET_ENCRYPTION_KEY_BASE64: assetKey,
        WECHAT_APP_ID: "partial-and-irrelevant",
        GENERATION_PROVIDER_TIMEOUT_MS: "not-an-integer",
        INTERNAL_WORKER_KEY: "short-and-irrelevant",
      }, role);
      assert.equal(config.nodeEnv, "production");
      assert.equal(config.wechatAppId, undefined);
      assert.equal(config.generationProviderUrl, undefined);
    }

    for (const role of ["migration", "seed"] as const) {
      assert.doesNotThrow(() => loadConfig({
        NODE_ENV: "production",
        ...PRODUCTION_DATABASE_CONFIG,
        ASSET_ENCRYPTION_KEY_BASE64: "not-base64-and-irrelevant",
        ASSET_STORAGE_PROVIDER: "   ",
        ASSET_STORAGE_ROOT: "relative-and-irrelevant",
        ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED: "not-a-boolean-and-irrelevant",
        WECHAT_APP_ID: "partial-and-irrelevant",
        GENERATION_PROVIDER_TIMEOUT_MS: "not-an-integer",
      }, role));
    }

    assert.throws(() => loadConfig({
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      TRUSTED_PROXIES: "127.0.0.1/32",
      ...PRODUCTION_S3_STORAGE_CONFIG,
      ASSET_ENCRYPTION_KEY_BASE64: assetKey,
      INTERNAL_WORKER_KEY: "production-worker-key-that-is-at-least-32-chars",
      ...PRODUCTION_ASSET_CONSENT_CONFIG,
    }, "api"), /微信小程序登录和微信支付/);
    assert.throws(() => loadConfig({
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      ...PRODUCTION_S3_STORAGE_CONFIG,
      ASSET_ENCRYPTION_KEY_BASE64: assetKey,
    }, "generation-worker"), /Generation Provider/);
    assert.throws(() => loadConfig({
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      ...PRODUCTION_S3_STORAGE_CONFIG,
    }, "export-worker"), /ASSET_ENCRYPTION_KEY_BASE64/);
  });

  it("requires an explicit storage provider for every production storage role", () => {
    for (const role of [
      "all",
      "api",
      "generation-worker",
      "export-worker",
      "asset-purge",
      "export-purge",
    ] as const) {
      assert.throws(
        () => loadConfig({ NODE_ENV: "production", ...PRODUCTION_DATABASE_CONFIG }, role),
        /ASSET_STORAGE_PROVIDER/,
      );
      assert.throws(
        () => loadConfig({
          NODE_ENV: "production",
          ...PRODUCTION_DATABASE_CONFIG,
          ASSET_STORAGE_PROVIDER: "   ",
        }, role),
        /ASSET_STORAGE_PROVIDER/,
      );
    }
  });

  it("requires an acknowledged absolute non-root path for production local storage", () => {
    const localStorageRoot = resolve(tmpdir(), "pindou-private-assets");
    const currentFileSystemRoot = parse(localStorageRoot).root;
    const foreignPlatformRoot = process.platform === "win32"
      ? "/var/lib/pindou/private-assets"
      : "C:\\pindou\\private-assets";
    const localBase = {
      NODE_ENV: "production",
      ...PRODUCTION_DATABASE_CONFIG,
      ASSET_STORAGE_PROVIDER: "local",
      ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
    };
    assert.throws(
      () => loadConfig(localBase, "export-worker"),
      /ASSET_STORAGE_ROOT/,
    );
    assert.throws(
      () => loadConfig({ ...localBase, ASSET_STORAGE_ROOT: "   " }, "export-worker"),
      /ASSET_STORAGE_ROOT/,
    );
    assert.throws(
      () => loadConfig({ ...localBase, ASSET_STORAGE_ROOT: "relative/private-assets" }, "export-worker"),
      /\u7edd\u5bf9\u8def\u5f84/,
    );
    assert.throws(
      () => loadConfig({ ...localBase, ASSET_STORAGE_ROOT: currentFileSystemRoot }, "export-worker"),
      /\u6839\u76ee\u5f55/,
    );
    assert.throws(
      () => loadConfig({ ...localBase, ASSET_STORAGE_ROOT: foreignPlatformRoot }, "export-worker"),
      /\u5f53\u524d\u8fd0\u884c\u5e73\u53f0/,
    );
    for (const acknowledgement of [undefined, "false"] as const) {
      assert.throws(
        () => loadConfig({
          ...localBase,
          ASSET_STORAGE_ROOT: localStorageRoot,
          ...(acknowledgement === undefined
            ? {}
            : { ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED: acknowledgement }),
        }, "export-worker"),
        /ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED=true/,
      );
    }
    for (const acknowledgement of ["", "TRUE", "yes", "1"] as const) {
      assert.throws(
        () => loadConfig({
          ...localBase,
          ASSET_STORAGE_ROOT: localStorageRoot,
          ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED: acknowledgement,
        }, "export-worker"),
        /\u4e25\u683c\u8bbe\u4e3a true \u6216 false/,
      );
    }

    const accepted = loadConfig({
      ...localBase,
      ASSET_STORAGE_ROOT: localStorageRoot,
      ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED: "true",
    }, "export-worker");
    assert.equal(accepted.assetStorageProvider, "local");
    assert.equal(accepted.assetStorageRoot, localStorageRoot);
    assert.equal(accepted.assetLocalStorageProductionAcknowledged, true);
  });

  it("requires an explicit non-empty DATABASE_URL for every production database role", () => {
    for (const role of [
      "all",
      "api",
      "generation-worker",
      "export-worker",
      "payment-reconciliation-worker",
      "asset-purge",
      "export-purge",
      "migration",
      "seed",
    ] as const) {
      assert.throws(
        () => loadConfig({ NODE_ENV: "production" }, role),
        /必须显式配置非空 DATABASE_URL/,
      );
      assert.throws(
        () => loadConfig({ NODE_ENV: "production", DATABASE_URL: "   " }, role),
        /必须显式配置非空 DATABASE_URL/,
      );
    }
  });
});
