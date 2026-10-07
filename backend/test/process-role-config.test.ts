import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { it } from "node:test";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { PaymentProvider } from "../src/payments/provider.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { VolatileMemoryStorage } from "../src/storage/volatile-memory-storage.js";
import {
  createConfiguredWechatAuthProvider,
  DevelopmentWechatMiniProgramAuthProvider,
  WechatMiniProgramAuthClient,
  type WechatMiniProgramAuthProvider,
} from "../src/wechat/mini-program-auth.js";

const WORKER_KEY = "production-worker-key-that-is-at-least-32-chars";
const PRODUCTION_DATABASE_CONFIG = {
  DATABASE_URL: "postgresql://pindou:secret@localhost:5432/pindou",
  DATABASE_SSL: "false",
};
const PRODUCTION_S3_STORAGE_CONFIG = {
  ASSET_STORAGE_PROVIDER: "s3",
  ASSET_S3_BUCKET: "private-assets",
  ASSET_S3_REGION: "us-east-1",
};

it("selects real WeChat login first and otherwise gates the stable local provider", async () => {
  const localConfig = loadConfig({
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    DEV_AUTH_ENABLED: "true",
    WECHAT_APP_ID: "wx76416adc3763ff72",
  }, "dev-memory");
  const localProvider = createConfiguredWechatAuthProvider(localConfig);
  assert.ok(localProvider instanceof DevelopmentWechatMiniProgramAuthProvider);
  const firstCode = "temporary-code-alpha";
  const secondCode = "temporary-code-beta";
  const firstIdentity = await localProvider.exchangeCode(firstCode);
  const secondIdentity = await localProvider.exchangeCode(secondCode);
  assert.equal(firstIdentity.openId, secondIdentity.openId);
  assert.equal(firstIdentity.openId.includes(firstCode), false);
  assert.equal(firstIdentity.openId.includes(secondCode), false);
  await assert.rejects(localProvider.exchangeCode("   "), /微信登录凭证无效/);
  await assert.rejects(localProvider.exchangeCode("x".repeat(129)), /微信登录凭证无效/);

  const realConfig = loadConfig({
    NODE_ENV: "development",
    DEV_AUTH_ENABLED: "true",
    WECHAT_APP_ID: "wx1234567890abcdef",
    WECHAT_APP_SECRET: "development-real-wechat-secret",
  }, "api");
  assert.ok(createConfiguredWechatAuthProvider(realConfig) instanceof WechatMiniProgramAuthClient);

  const disabledConfig = loadConfig({ NODE_ENV: "development" }, "api");
  assert.equal(createConfiguredWechatAuthProvider(disabledConfig), undefined);
  await assert.rejects(buildApp({
    config: disabledConfig,
    store: new MemoryStore(),
    storage: new VolatileMemoryStorage(),
    wechatAuthProvider: new DevelopmentWechatMiniProgramAuthProvider(),
    logger: false,
  }), /DEV_AUTH_ENABLED/);
  assert.throws(() => createConfiguredWechatAuthProvider({
    nodeEnv: "production",
    host: "127.0.0.1",
    devAuthEnabled: true,
  }), /生产环境禁止/);
});

it("loads the standalone payment reconciliation role without HTTP or asset-storage secrets", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    ...PRODUCTION_DATABASE_CONFIG,
    WECHAT_APP_ID: "wx1234567890abcdef",
    WECHAT_APP_SECRET: "0123456789abcdef0123456789abcdef",
    WECHAT_PAY_MCH_ID: "1900000001",
    WECHAT_PAY_MERCHANT_CERT_SERIAL: "0123456789ABCDEF",
    WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: "C:/secrets/apiclient_key.pem",
    WECHAT_PAY_VERIFIER_SERIAL: "PUB_KEY_ID_3000000001",
    WECHAT_PAY_VERIFIER_PUBLIC_KEY_PATH: "C:/secrets/wechatpay_public_key.pem",
    WECHAT_PAY_API_V3_KEY: "0123456789abcdef0123456789abcdef",
    WECHAT_PAY_NOTIFY_URL: "https://api.example.test/api/v1/wechat-pay/notifications",
    PAYMENT_RECONCILIATION_LEASE_MS: "90000",
    PAYMENT_RECONCILIATION_POLL_MS: "45000",
    PAYMENT_RECONCILIATION_IDLE_MS: "500",
    ASSET_STORAGE_PROVIDER: "   ",
    ASSET_STORAGE_ROOT: "relative-and-irrelevant",
    ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED: "not-a-boolean-and-irrelevant",
  }, "payment-reconciliation-worker");
  assert.equal(config.paymentReconciliationLeaseMilliseconds, 90_000);
  assert.equal(config.paymentReconciliationPollMilliseconds, 45_000);
  assert.equal(config.paymentReconciliationIdleMilliseconds, 500);
  assert.equal(config.trustedProxies?.length ?? 0, 0);
});

it("starts the production API without loading an AI key and delegates generation to its worker", async () => {
  const config = loadConfig({
    NODE_ENV: "production",
    ...PRODUCTION_DATABASE_CONFIG,
    ...PRODUCTION_S3_STORAGE_CONFIG,
    TRUSTED_PROXIES: "127.0.0.1/32",
    ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
    ASSET_CONSENT_PROCESSOR: "Pindou production processor test fixture",
    ASSET_CONSENT_PURPOSE_TEXT: "将用户提供的图片处理为拼豆图纸",
    ASSET_CONSENT_RETENTION_TEXT: "AI 素材最长保留 23 小时，之后进入清理流程",
    INTERNAL_WORKER_KEY: WORKER_KEY,
    WECHAT_APP_ID: "wx1234567890abcdef",
    WECHAT_APP_SECRET: "0123456789abcdef0123456789abcdef",
    WECHAT_PAY_MCH_ID: "1900000001",
    WECHAT_PAY_MERCHANT_CERT_SERIAL: "0123456789ABCDEF",
    WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: "C:/secrets/apiclient_key.pem",
    WECHAT_PAY_VERIFIER_SERIAL: "PUB_KEY_ID_3000000001",
    WECHAT_PAY_VERIFIER_PUBLIC_KEY_PATH: "C:/secrets/wechatpay_public_key.pem",
    WECHAT_PAY_API_V3_KEY: "0123456789abcdef0123456789abcdef",
    WECHAT_PAY_NOTIFY_URL: "https://api.example.test/api/v1/wechat-pay/notifications",
  }, "api");
  const paymentProvider: PaymentProvider = {
    kind: "wechat-v3",
    async createOrder() {
      throw new Error("not exercised");
    },
    async queryOrder() {
      return { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null };
    },
  };
  const wechatAuthProvider: WechatMiniProgramAuthProvider = {
    kind: "wechat-code2session",
    async exchangeCode() {
      return { openId: "openid-test", unionId: null };
    },
  };
  await assert.rejects(buildApp({
    config,
    store: new MemoryStore(),
    storage: new VolatileMemoryStorage(),
    paymentProvider,
    wechatAuthProvider: new DevelopmentWechatMiniProgramAuthProvider(),
    logger: false,
  }), /生产环境必须配置真实微信/);
  const app = await buildApp({
    config,
    store: new MemoryStore(),
    storage: new VolatileMemoryStorage(),
    paymentProvider,
    wechatAuthProvider,
    logger: false,
  });
  try {
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/generation-jobs/process-next",
      headers: { "x-internal-worker-key": WORKER_KEY },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "GENERATION_PROVIDER_NOT_ATTACHED");
  } finally {
    await app.close();
  }
});

