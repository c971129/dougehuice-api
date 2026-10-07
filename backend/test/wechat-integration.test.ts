import assert from "node:assert/strict";
import {
  createCipheriv,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import type {
  PaymentObservation,
  PaymentProvider,
  WechatPayNotification,
} from "../src/payments/provider.js";
import { WechatPayV3Provider } from "../src/payments/wechat-pay-v3-provider.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { hashToken } from "../src/auth.js";
import {
  createConfiguredWechatAuthProvider,
  WechatMiniProgramAuthClient,
  type WechatMiniProgramAuthProvider,
} from "../src/wechat/mini-program-auth.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused",
  databaseSsl: false,
  devAuthEnabled: true,
  corsOrigins: ["http://localhost:5173"],
  sessionTtlDays: 30,
  devStartingCredits: 20,
  assetStorageRoot: join(tmpdir(), "pindou-wechat-test-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXkhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

const fixedNow = Date.parse("2026-10-04T12:00:00.000Z");
const fixedTimestamp = Math.floor(fixedNow / 1_000).toString();

function signedHeaders(body: string, privateKey: KeyObject, serial = "PUB_KEY_ID_3000000001"): Headers {
  const nonce = "signed-response-nonce";
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${fixedTimestamp}\n${nonce}\n${body}\n`),
    privateKey,
  ).toString("base64");
  return new Headers({
    "content-type": "application/json",
    "wechatpay-serial": serial,
    "wechatpay-signature": signature,
    "wechatpay-timestamp": fixedTimestamp,
    "wechatpay-nonce": nonce,
  });
}

function encryptedNotificationResource(apiV3Key: string, plaintext: string): {
  algorithm: "AEAD_AES_256_GCM";
  ciphertext: string;
  associated_data: string;
  nonce: string;
} {
  const nonce = "0123456789ab";
  const associatedData = "transaction";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString("base64");
  return { algorithm: "AEAD_AES_256_GCM", ciphertext, associated_data: associatedData, nonce };
}

function authorizationFields(value: string): Record<string, string> {
  return Object.fromEntries([...value.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]));
}

describe("WeChat Mini Program production adapters", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("exchanges wx.login codes through code2Session and maps rejected codes safely", async () => {
    const requestedUrls: URL[] = [];
    const client = new WechatMiniProgramAuthClient({
      appId: "wx1234567890abcdef",
      appSecret: "private-app-secret",
      fetchImpl: async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
        requestedUrls.push(url);
        if (url.searchParams.get("js_code") === "rejected-code") {
          return new Response(JSON.stringify({ errcode: 40029, errmsg: "invalid code" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          openid: "openid-from-code-session",
          session_key: "server-only-session-key",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.deepEqual(await client.exchangeCode("valid-code"), {
      openId: "openid-from-code-session",
      unionId: null,
    });
    assert.equal(requestedUrls[0]?.searchParams.get("appid"), "wx1234567890abcdef");
    assert.equal(requestedUrls[0]?.searchParams.get("secret"), "private-app-secret");
    assert.equal(requestedUrls[0]?.searchParams.get("grant_type"), "authorization_code");
    await assert.rejects(
      client.exchangeCode("rejected-code"),
      (error: unknown) => error instanceof AppError
        && error.code === "WECHAT_CODE_REJECTED"
        && JSON.stringify(error.details).includes("private-app-secret") === false,
    );
  });

  it("creates one stable local account through the unchanged WeChat session API without exposing codes", async () => {
    const store = new MemoryStore();
    const provider = createConfiguredWechatAuthProvider(config);
    assert.ok(provider);
    assert.equal(provider.kind, "development");
    const app = await buildApp({ config, store, wechatAuthProvider: provider, logger: false });
    apps.push(app);
    await app.ready();

    const firstCode = "local-wx-login-code-alpha";
    const secondCode = "local-wx-login-code-beta";
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat-session",
      payload: { code: firstCode, displayName: "本地微信联调用户" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat-session",
      payload: { code: secondCode, displayName: "不应覆盖" },
    });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(first.json().user.id, second.json().user.id);
    assert.equal(first.json().credits.balance, config.devStartingCredits);
    assert.equal(second.json().credits.balance, config.devStartingCredits);
    assert.equal(first.body.includes(firstCode), false);
    assert.equal(first.body.includes(secondCode), false);
    const storedOpenId = await store.getWechatOpenId(first.json().user.id);
    assert.ok(storedOpenId);
    assert.equal(storedOpenId.includes(firstCode), false);
    assert.equal(storedOpenId.includes(secondCode), false);
    const ledger = await store.listCreditLedger(first.json().user.id, 20);
    assert.deepEqual(ledger.map((entry) => ({
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
    })), [{
      delta: config.devStartingCredits,
      balanceAfter: config.devStartingCredits,
      reason: "dev_welcome_credit",
    }]);

    const whitespace = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat-session",
      payload: { code: "   " },
    });
    assert.equal(whitespace.statusCode, 400, whitespace.body);
    assert.equal(whitespace.json().error.code, "WECHAT_CODE_INVALID");
  });

  it("reuses the same private user for repeated code exchanges without exposing the openid", async () => {
    const authProvider: WechatMiniProgramAuthProvider = {
      kind: "wechat-code2session",
      async exchangeCode(code) {
        assert.match(code, /^code-/);
        return { openId: "openid-private-0001", unionId: null };
      },
    };
    const store = new MemoryStore();
    const app = await buildApp({ config, store, wechatAuthProvider: authProvider, logger: false });
    apps.push(app);
    await app.ready();

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat-session",
      payload: { code: "code-first", displayName: "微信测试用户" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat-session",
      payload: { code: "code-second", displayName: "不应覆盖既有名称" },
    });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(first.json().user.id, second.json().user.id);
    assert.equal(second.json().user.displayName, "微信测试用户");
    assert.equal(first.json().credits.balance, 0);
    assert.equal("openId" in first.json().user, false);
    assert.notEqual(first.json().token, second.json().token);
    assert.equal(await store.getWechatOpenId(first.json().user.id), "openid-private-0001");
    assert.ok(await store.resolveSession(hashToken(second.json().token)));
  });

  it("coalesces concurrent wx.login code exchange while issuing separate sessions", async () => {
    let exchangeCount = 0;
    let signalExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => { signalExchangeStarted = resolve; });
    let releaseExchange!: () => void;
    const exchangeGate = new Promise<void>((resolve) => { releaseExchange = resolve; });
    const authProvider: WechatMiniProgramAuthProvider = {
      kind: "wechat-code2session",
      async exchangeCode(code) {
        assert.equal(code, "same-wx-login-code");
        exchangeCount += 1;
        signalExchangeStarted();
        await exchangeGate;
        return { openId: "openid-single-flight", unionId: null };
      },
    };
    const store = new MemoryStore();
    const app = await buildApp({ config, store, wechatAuthProvider: authProvider, logger: false });
    apps.push(app);
    await app.ready();

    const firstPending = app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat-session",
      payload: { code: "same-wx-login-code", displayName: "并发登录一" },
    });
    const secondPending = app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat-session",
      payload: { code: "same-wx-login-code", displayName: "并发登录二" },
    });
    await exchangeStarted;
    await new Promise((resolve) => setImmediate(resolve));
    const observedExchangeCount = exchangeCount;
    releaseExchange();

    const [first, second] = await Promise.all([firstPending, secondPending]);
    assert.equal(observedExchangeCount, 1);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(first.json().user.id, second.json().user.id);
    assert.notEqual(first.json().token, second.json().token);
    assert.equal((await store.listCreditLedger(first.json().user.id, 20)).length, 0);
  });

  it("signs JSAPI create/query requests, verifies responses, and decrypts signed notifications", async () => {
    const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const nextPlatform = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const apiV3Key = "0123456789abcdef0123456789abcdef";
    const requestBodies: string[] = [];
    let nonceCounter = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const body = typeof init?.body === "string" ? init.body : "";
      const requestHeaders = new Headers(init?.headers);
      const authorization = requestHeaders.get("authorization") ?? "";
      const fields = authorizationFields(authorization);
      const canonicalUrl = `${url.pathname}${url.search}`;
      assert.equal(fields.mchid, "1900000001");
      assert.equal(fields.serial_no, "MERCHANT-CERT-SERIAL");
      assert.equal(requestHeaders.get("wechatpay-serial"), "PUB_KEY_ID_3000000001");
      assert.ok(verify(
        "RSA-SHA256",
        Buffer.from(`${init?.method}\n${canonicalUrl}\n${fields.timestamp}\n${fields.nonce_str}\n${body}\n`),
        merchant.publicKey,
        Buffer.from(fields.signature!, "base64"),
      ));
      if (url.pathname.endsWith("/jsapi")) {
        requestBodies.push(body);
        const responseBody = JSON.stringify({ prepay_id: "wx-prepay-0001" });
        return new Response(responseBody, { status: 200, headers: signedHeaders(responseBody, platform.privateKey) });
      }
      if (url.pathname.endsWith("/close")) {
        assert.deepEqual(JSON.parse(body), { mchid: "1900000001" });
        return new Response(null, {
          status: 204,
          headers: signedHeaders("", nextPlatform.privateKey, "PUB_KEY_ID_3000000002"),
        });
      }
      assert.equal(url.searchParams.get("mchid"), "1900000001");
      const responseBody = JSON.stringify({
        appid: "wx1234567890abcdef",
        mchid: "1900000001",
        out_trade_no: "PD000000000000000000000000000001",
        attach: "00000000-0000-4000-8000-000000000701",
        amount: { total: 600, currency: "CNY" },
        transaction_id: "420000000000000000000000000001",
        trade_state: "SUCCESS",
        success_time: "2026-10-04T19:59:00+08:00",
      });
      return new Response(responseBody, {
        status: 200,
        headers: signedHeaders(responseBody, nextPlatform.privateKey, "PUB_KEY_ID_3000000002"),
      });
    };
    const provider = new WechatPayV3Provider({
      appId: "wx1234567890abcdef",
      merchantId: "1900000001",
      merchantCertificateSerial: "MERCHANT-CERT-SERIAL",
      merchantPrivateKeyPem: merchant.privateKey.export({ type: "pkcs8", format: "pem" }),
      verifierSerial: "PUB_KEY_ID_3000000001",
      verifierPublicKeyPem: platform.publicKey.export({ type: "spki", format: "pem" }),
      additionalVerifierPublicKeys: {
        PUB_KEY_ID_3000000002: nextPlatform.publicKey.export({ type: "spki", format: "pem" }),
      },
      apiV3Key,
      notifyUrl: "https://api.example.test/api/v1/wechat-pay/notifications",
      fetchImpl,
      now: () => fixedNow,
      nonce: () => `nonce-${++nonceCounter}`,
    });

    const created = await provider.createOrder({
      orderId: "00000000-0000-4000-8000-000000000701",
      outTradeNo: "PD000000000000000000000000000001",
      userId: "00000000-0000-4000-8000-000000000702",
      payerOpenId: "openid-private-0001",
      product: {
        id: "ai-5",
        version: 1,
        name: "5 次",
        description: "轻量体验包",
        creditAmount: 5,
        amountCents: 600,
        currency: "CNY",
        enabled: true,
      },
      expiresAt: "2026-10-04T12:10:00.000Z",
    });
    const createBody = JSON.parse(requestBodies[0]!) as Record<string, unknown>;
    assert.equal((createBody.payer as Record<string, unknown>).openid, "openid-private-0001");
    assert.equal((createBody.amount as Record<string, unknown>).total, 600);
    assert.equal(createBody.attach, "00000000-0000-4000-8000-000000000701");
    assert.equal(created.providerReference, "wx-prepay-0001");
    assert.ok(created.recoveryCiphertext.startsWith("PDP1."));
    assert.equal(created.recoveryCiphertext.includes("wx-prepay-0001"), false);
    const recovered = await provider.recoverOrderSession({
      orderId: "00000000-0000-4000-8000-000000000701",
      outTradeNo: "PD000000000000000000000000000001",
      amountCents: 600,
      currency: "CNY",
      recoveryCiphertext: created.recoveryCiphertext,
    });
    assert.equal(recovered.providerReference, created.providerReference);
    assert.equal(recovered.paymentParams.package, "prepay_id=wx-prepay-0001");
    assert.ok(verify(
      "RSA-SHA256",
      Buffer.from(`wx1234567890abcdef\n${created.paymentParams.timeStamp}\n${created.paymentParams.nonceStr}\n${created.paymentParams.package}\n`),
      merchant.publicKey,
      Buffer.from(created.paymentParams.paySign, "base64"),
    ));

    const observation = await provider.queryOrder({
      id: "00000000-0000-4000-8000-000000000701",
      userId: "00000000-0000-4000-8000-000000000702",
      productId: "ai-5",
      productVersion: 1,
      productName: "5 次",
      creditAmount: 5,
      amountCents: 600,
      currency: "CNY",
      outTradeNo: "PD000000000000000000000000000001",
      status: "pending",
      providerReference: "wx-prepay-0001",
      providerTradeState: "NOTPAY",
      providerTransactionId: null,
      paymentExpiresAt: "2026-10-04T12:10:00.000Z",
      paidAt: null,
      closedAt: null,
      lastReconciledAt: null,
      lateSuccessAt: null,
      createdAt: "2026-10-04T12:00:00.000Z",
      updatedAt: "2026-10-04T12:00:00.000Z",
    });
    assert.deepEqual(observation, {
      tradeState: "SUCCESS",
      providerTransactionId: "420000000000000000000000000001",
      paidAt: "2026-10-04T11:59:00.000Z",
    });
    await provider.closeOrder({
      orderId: "00000000-0000-4000-8000-000000000701",
      outTradeNo: "PD000000000000000000000000000001",
      amountCents: 600,
      currency: "CNY",
    });

    const transaction = {
      appid: "wx1234567890abcdef",
      mchid: "1900000001",
      out_trade_no: "PD000000000000000000000000000001",
      trade_type: "JSAPI",
      attach: "00000000-0000-4000-8000-000000000701",
      transaction_id: "420000000000000000000000000001",
      trade_state: "SUCCESS",
      success_time: "2026-10-04T19:59:00+08:00",
      amount: { total: 600, currency: "CNY" },
    };
    const decrypted = JSON.stringify(transaction);
    const envelope = JSON.stringify({
      id: "EV-20261004-0001",
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      resource: encryptedNotificationResource(apiV3Key, decrypted),
    });
    const notificationNonce = "callback-header-nonce";
    const notificationSignatureFor = (rawBody: string): string => sign(
      "RSA-SHA256",
      Buffer.from(`${fixedTimestamp}\n${notificationNonce}\n${rawBody}\n`),
      platform.privateKey,
    ).toString("base64");
    const parseSignedNotification = (rawBody: string) => provider.parseNotification({
      rawBody,
      serial: "PUB_KEY_ID_3000000001",
      signature: notificationSignatureFor(rawBody),
      timestamp: fixedTimestamp,
      nonce: notificationNonce,
    });
    const notificationSignature = notificationSignatureFor(envelope);
    const notification = await provider.parseNotification({
      rawBody: envelope,
      serial: "PUB_KEY_ID_3000000001",
      signature: notificationSignature,
      timestamp: fixedTimestamp,
      nonce: notificationNonce,
    });
    assert.deepEqual(notification, {
      notificationId: "EV-20261004-0001",
      serial: "PUB_KEY_ID_3000000001",
      appId: "wx1234567890abcdef",
      merchantId: "1900000001",
      outTradeNo: "PD000000000000000000000000000001",
      attach: "00000000-0000-4000-8000-000000000701",
      providerTransactionId: "420000000000000000000000000001",
      tradeState: "SUCCESS",
      paidAt: "2026-10-04T11:59:00.000Z",
      amountCents: 600,
      currency: "CNY",
    });
    await assert.rejects(
      provider.parseNotification({
        rawBody: `${envelope} `,
        serial: "PUB_KEY_ID_3000000001",
        signature: notificationSignature,
        timestamp: fixedTimestamp,
        nonce: notificationNonce,
      }),
      (error: unknown) => error instanceof AppError
        && error.statusCode === 401
        && error.code === "WECHAT_PAY_SIGNATURE_INVALID",
    );

    const wrongResourceTypeEnvelope = JSON.stringify({
      id: "EV-20261004-0002",
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "plaintext",
      resource: encryptedNotificationResource(apiV3Key, decrypted),
    });
    await assert.rejects(
      parseSignedNotification(wrongResourceTypeEnvelope),
      (error: unknown) => error instanceof AppError && error.code === "WECHAT_PAY_NOTIFICATION_INVALID",
    );
    const wrongTradeTypeEnvelope = JSON.stringify({
      id: "EV-20261004-0003",
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      resource: encryptedNotificationResource(apiV3Key, JSON.stringify({ ...transaction, trade_type: "NATIVE" })),
    });
    await assert.rejects(
      parseSignedNotification(wrongTradeTypeEnvelope),
      (error: unknown) => error instanceof AppError && error.code === "WECHAT_PAY_NOTIFICATION_INVALID",
    );

    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "绑定校验用户",
      tokenHash: hashToken("signed-attach-mismatch-token-that-is-long-enough"),
      expiresAt: "2026-11-04T12:00:00.000Z",
      startingCredits: 0,
    });
    const product = await store.getCreditProduct("ai-9", 1);
    assert.ok(product);
    await store.createPaymentOrder({
      id: "00000000-0000-4000-8000-000000000701",
      userId: session.user.id,
      product,
      outTradeNo: transaction.out_trade_no,
      providerReference: "wx-prepay-0001",
      paymentExpiresAt: "2026-10-04T12:10:00.000Z",
      now: "2026-10-04T12:00:00.000Z",
    });
    const app = await buildApp({ config, store, paymentProvider: provider, logger: false });
    apps.push(app);
    await app.ready();
    const wrongAttachEnvelope = JSON.stringify({
      id: "EV-20261004-0004",
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      resource: encryptedNotificationResource(apiV3Key, JSON.stringify({
        ...transaction,
        attach: "00000000-0000-4000-8000-000000000799",
      })),
    });
    const wrongAttachResponse = await app.inject({
      method: "POST",
      url: "/api/v1/wechat-pay/notifications",
      headers: {
        "content-type": "application/json",
        "wechatpay-serial": "PUB_KEY_ID_3000000001",
        "wechatpay-signature": notificationSignatureFor(wrongAttachEnvelope),
        "wechatpay-timestamp": fixedTimestamp,
        "wechatpay-nonce": notificationNonce,
      },
      payload: wrongAttachEnvelope,
    });
    assert.equal(wrongAttachResponse.statusCode, 409, wrongAttachResponse.body);
    assert.equal(wrongAttachResponse.json().code, "FAIL");
    assert.equal((await store.getCreditAccount(session.user.id)).balance, 0);
  });

  it("wraps untrusted outbound API responses as retryable service failures without changing notification errors", async () => {
    const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const responseBody = JSON.stringify({ prepay_id: "wx-untrusted-prepay" });
    const cases = [
      { name: "unknown serial", verificationCode: "WECHAT_PAY_UNKNOWN_SERIAL", mutate(headers: Headers) {
        headers.set("wechatpay-serial", "PUB_KEY_ID_UNKNOWN");
      } },
      { name: "bad signature", verificationCode: "WECHAT_PAY_SIGNATURE_INVALID", mutate(headers: Headers) {
        headers.set("wechatpay-signature", "invalid-signature");
      } },
      { name: "stale timestamp", verificationCode: "WECHAT_PAY_STALE_SIGNATURE", mutate(headers: Headers) {
        headers.set("wechatpay-timestamp", String(Number(fixedTimestamp) - 301));
      } },
      { name: "signature probe", verificationCode: "WECHAT_PAY_SIGNATURE_PROBE", mutate(headers: Headers) {
        headers.set("wechatpay-signature", "WECHATPAY/SIGNTEST/probe");
      } },
    ];
    for (const testCase of cases) {
      const provider = new WechatPayV3Provider({
        appId: "wx1234567890abcdef",
        merchantId: "1900000001",
        merchantCertificateSerial: "MERCHANT-CERT-SERIAL",
        merchantPrivateKeyPem: merchant.privateKey.export({ type: "pkcs8", format: "pem" }),
        verifierSerial: "PUB_KEY_ID_3000000001",
        verifierPublicKeyPem: platform.publicKey.export({ type: "spki", format: "pem" }),
        apiV3Key: "0123456789abcdef0123456789abcdef",
        notifyUrl: "https://api.example.test/api/v1/wechat-pay/notifications",
        fetchImpl: async (_input, init) => {
          assert.equal(new Headers(init?.headers).get("wechatpay-serial"), "PUB_KEY_ID_3000000001");
          const headers = signedHeaders(responseBody, platform.privateKey);
          testCase.mutate(headers);
          return new Response(responseBody, { status: 200, headers });
        },
        now: () => fixedNow,
        nonce: () => "untrusted-response-nonce",
      });
      await assert.rejects(provider.createOrder({
        orderId: "00000000-0000-4000-8000-000000000731",
        outTradeNo: "PD000000000000000000000000000731",
        userId: "00000000-0000-4000-8000-000000000732",
        payerOpenId: "openid-private-0731",
        product: {
          id: "ai-5",
          version: 1,
          name: "5 次",
          description: "轻量体验包",
          creditAmount: 5,
          amountCents: 600,
          currency: "CNY",
          enabled: true,
        },
        expiresAt: "2026-10-04T12:10:00.000Z",
      }), (error: unknown) => {
        assert.ok(error instanceof AppError, testCase.name);
        assert.equal(error.statusCode, 503, testCase.name);
        assert.equal(error.code, "WECHAT_PAY_RESPONSE_UNVERIFIED", testCase.name);
        assert.equal(error.retryable, true, testCase.name);
        assert.deepEqual(error.details, { verificationCode: testCase.verificationCode, providerStatus: 200 });
        assert.equal(JSON.stringify(error).includes(responseBody), false);
        return true;
      });
    }
  });

  it("accepts a late signed SUCCESS after local close exactly once and rejects changed duplicate bodies", async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "通知测试用户",
      tokenHash: hashToken("notification-test-token-that-is-long-enough"),
      expiresAt: "2026-11-04T12:00:00.000Z",
      startingCredits: 0,
    });
    const product = await store.getCreditProduct("ai-9", 1);
    assert.ok(product);
    const order = await store.createPaymentOrder({
      id: "00000000-0000-4000-8000-000000000711",
      userId: session.user.id,
      product,
      outTradeNo: "PD000000000000000000000000000711",
      providerReference: "wx-prepay-notification-711",
      paymentExpiresAt: "2026-10-04T12:10:00.000Z",
      now: "2026-10-04T12:00:00.000Z",
    });
    await store.applyPaymentObservation({
      orderId: order.id,
      userId: order.userId,
      providerTradeState: "CLOSED",
      observedAt: "2026-10-04T12:00:30.000Z",
    });
    const observedRawBodies: string[] = [];
    const notification: WechatPayNotification = {
      notificationId: "EV-20261004-0711",
      serial: "PUB_KEY_ID_3000000001",
      appId: "wx1234567890abcdef",
      merchantId: "1900000001",
      outTradeNo: order.outTradeNo,
      attach: order.id,
      providerTransactionId: "420000000000000000000000000711",
      tradeState: "SUCCESS",
      paidAt: "2026-10-04T12:01:00.000Z",
      amountCents: order.amountCents,
      currency: "CNY",
    };
    const paymentProvider: PaymentProvider = {
      kind: "wechat-v3",
      async createOrder() {
        throw new Error("not used");
      },
      async queryOrder(): Promise<PaymentObservation> {
        return { tradeState: "NOTPAY", providerTransactionId: null, paidAt: null };
      },
      async parseNotification(input) {
        observedRawBodies.push(input.rawBody);
        return notification;
      },
    };
    const app = await buildApp({ config, store, paymentProvider, logger: false });
    apps.push(app);
    await app.ready();
    const headers = {
      "content-type": "application/json",
      "wechatpay-serial": notification.serial,
      "wechatpay-signature": "test-signature",
      "wechatpay-timestamp": fixedTimestamp,
      "wechatpay-nonce": "test-nonce",
    };
    const raw = '{"id":"EV-20261004-0711","resource":{"ciphertext":"opaque"}}';
    const first = await app.inject({ method: "POST", url: "/api/v1/wechat-pay/notifications", headers, payload: raw });
    const replay = await app.inject({ method: "POST", url: "/api/v1/wechat-pay/notifications", headers, payload: raw });
    assert.equal(first.statusCode, 204, first.body);
    assert.equal(replay.statusCode, 204, replay.body);
    assert.deepEqual(observedRawBodies, [raw, raw]);
    const account = await store.getCreditAccount(session.user.id);
    assert.equal(account.balance, product.creditAmount);
    const lateOrder = await store.getPaymentOrder(session.user.id, order.id);
    assert.equal(lateOrder?.status, "succeeded");
    assert.equal(lateOrder?.closedAt, "2026-10-04T12:00:30.000Z");
    assert.ok(lateOrder?.lateSuccessAt);
    const ledger = await store.listCreditLedger(session.user.id, 20);
    assert.equal(ledger.filter((entry) => entry.reason === "payment_credit").length, 1);

    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/wechat-pay/notifications",
      headers,
      payload: `${raw} `,
    });
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(changed.json().code, "FAIL");
  });
});
