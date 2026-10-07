import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { copyDefaultGenerationOptions } from "../src/domain/generation-options.js";
import type { Palette } from "../src/domain/models.js";
import {
  ANONYMOUS_AUTH_RATE_LIMITS,
  MAX_CUSTOM_PALETTE_COLORS_PER_USER,
  MAX_CUSTOM_PALETTES_PER_USER,
} from "../src/domain/resource-limits.js";
import { AppError } from "../src/errors.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import type { WechatMiniProgramAuthProvider } from "../src/wechat/mini-program-auth.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused",
  databaseSsl: false,
  devAuthEnabled: true,
  corsOrigins: ["http://localhost:5173"],
  sessionTtlDays: 30,
  devStartingCredits: 20,
  assetStorageRoot: join(tmpdir(), "pindou-auth-palette-hardening-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
  customPalettesEnabled: true,
};

async function login(app: Awaited<ReturnType<typeof buildApp>>, displayName: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/dev-session",
    payload: { displayName },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().token as string;
}

function palette(id: string, colorCount: number): Palette {
  return {
    id,
    name: id,
    brand: "测试",
    beadSizeMm: 5,
    verified: false,
    version: 1,
    colors: Array.from({ length: colorCount }, (_, index) => ({
      code: `C${String(index).padStart(3, "0")}`,
      name: `颜色 ${index}`,
      hex: "#123456",
      unitPriceCents: 1,
      available: true,
    })),
  };
}

describe("authentication and custom palette hardening", () => {
  it("revokes the current bearer session through the logout endpoint", async () => {
    const app = await buildApp({ config: baseConfig, store: new MemoryStore(), logger: false });
    try {
      await app.ready();
      const token = await login(app, "主动退出用户");
      const loggedOut = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/session",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(loggedOut.statusCode, 204, loggedOut.body);
      const after = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(after.statusCode, 401, after.body);
      assert.equal(after.json().error.code, "SESSION_EXPIRED");
    } finally {
      await app.close();
    }
  });

  it("retains an approved Web login challenge while another client creates a challenge", async () => {
    const app = await buildApp({ config: baseConfig, store: new MemoryStore(), logger: false });
    try {
      await app.ready();
      const userToken = await login(app, "扫码确认用户");
      const first = await app.inject({ method: "POST", url: "/api/v1/auth/web-login-challenges", payload: {} });
      assert.equal(first.statusCode, 201, first.body);
      const challenge = first.json() as { token: string; code: string };
      const confirmed = await app.inject({
        method: "POST",
        url: "/api/v1/auth/web-login-challenges/confirm",
        headers: { authorization: `Bearer ${userToken}` },
        payload: { code: challenge.code },
      });
      assert.equal(confirmed.statusCode, 200, confirmed.body);

      const second = await app.inject({ method: "POST", url: "/api/v1/auth/web-login-challenges", payload: {} });
      assert.equal(second.statusCode, 201, second.body);
      const polled = await app.inject({
        method: "GET",
        url: "/api/v1/auth/web-login-challenges/current",
        headers: { "x-web-login-token": challenge.token },
      });
      assert.equal(polled.statusCode, 200, polled.body);
      assert.equal(polled.json().status, "approved");
    } finally {
      await app.close();
    }
  });

  it("uses forwarding headers only from explicitly trusted proxies", async () => {
    const trusted = await buildApp({
      config: { ...baseConfig, trustedProxies: ["127.0.0.1/32"] },
      store: new MemoryStore(),
      logger: false,
    });
    try {
      await trusted.ready();
      for (let index = 0; index < 20; index += 1) {
        const response = await trusted.inject({
          method: "POST",
          url: "/api/v1/auth/web-login-challenges",
          remoteAddress: "127.0.0.1",
          headers: { "x-forwarded-for": "198.51.100.10" },
          payload: {},
        });
        assert.equal(response.statusCode, 201, response.body);
      }
      const saturated = await trusted.inject({
        method: "POST",
        url: "/api/v1/auth/web-login-challenges",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "198.51.100.10" },
        payload: {},
      });
      assert.equal(saturated.statusCode, 429, saturated.body);
      assert.match(String(saturated.headers["retry-after"]), /^\d+$/);
      const independent = await trusted.inject({
        method: "POST",
        url: "/api/v1/auth/web-login-challenges",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "198.51.100.11" },
        payload: {},
      });
      assert.equal(independent.statusCode, 201, independent.body);
    } finally {
      await trusted.close();
    }

    const untrusted = await buildApp({
      config: { ...baseConfig, trustedProxies: ["10.0.0.0/8"] },
      store: new MemoryStore(),
      logger: false,
    });
    try {
      await untrusted.ready();
      for (let index = 0; index < 20; index += 1) {
        const response = await untrusted.inject({
          method: "POST",
          url: "/api/v1/auth/web-login-challenges",
          remoteAddress: "127.0.0.1",
          headers: { "x-forwarded-for": `203.0.113.${index + 1}` },
          payload: {},
        });
        assert.equal(response.statusCode, 201, response.body);
      }
      const spoofed = await untrusted.inject({
        method: "POST",
        url: "/api/v1/auth/web-login-challenges",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.250" },
        payload: {},
      });
      assert.equal(spoofed.statusCode, 429, spoofed.body);
      assert.match(String(spoofed.headers["retry-after"]), /^\d+$/);
    } finally {
      await untrusted.close();
    }
  });

  it("rate-limits WeChat code exchange by the trusted effective IP before calling the provider", async () => {
    const store = new MemoryStore();
    const rule = ANONYMOUS_AUTH_RATE_LIMITS.wechatSession;
    const keyHash = createHash("sha256").update(`${rule.action}:127.0.0.1`).digest("hex");
    const now = new Date().toISOString();
    for (let index = 0; index < rule.limit; index += 1) {
      const consumed = await store.consumeAuthRateLimit({
        keyHash,
        action: rule.action,
        now,
        limit: rule.limit,
        windowMilliseconds: rule.windowMilliseconds,
      });
      assert.equal(consumed.allowed, true);
    }
    let providerCalls = 0;
    const wechatAuthProvider: WechatMiniProgramAuthProvider = {
      kind: "wechat-code2session",
      async exchangeCode() {
        providerCalls += 1;
        return { openId: "must-not-be-called", unionId: null };
      },
    };
    const app = await buildApp({
      config: { ...baseConfig, trustedProxies: ["10.0.0.0/8"] },
      store,
      wechatAuthProvider,
      logger: false,
    });
    try {
      await app.ready();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/wechat-session",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.99" },
        payload: { code: "spoofed-forwarding-code" },
      });
      assert.equal(response.statusCode, 429, response.body);
      assert.equal(response.json().error.code, "WECHAT_SESSION_RATE_LIMITED");
      assert.match(String(response.headers["retry-after"]), /^\d+$/);
      assert.equal(providerCalls, 0);
    } finally {
      await app.close();
    }
  });

  it("keeps private palette inventory tenant-scoped and validates normalized text", async () => {
    const app = await buildApp({ config: baseConfig, store: new MemoryStore(), logger: false });
    try {
      await app.ready();
      const ownerToken = await login(app, "私有色卡拥有者");
      const otherToken = await login(app, "私有色卡其他用户");
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/palettes",
        headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": "private-palette-create" },
        payload: {
          name: "  私有色卡  ",
          brand: "  自定义  ",
          beadSizeMm: 5,
          colors: [
            { code: " p01 ", name: " 粉色 ", hex: "#ff88aa" },
            { code: "P02", name: "蓝色", hex: "#88AAFF" },
          ],
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      const paletteId = created.json().palette.id as string;
      assert.equal(created.json().palette.colors[0].code, "P01");

      const hidden = await app.inject({
        method: "GET",
        url: "/api/v1/palettes",
        headers: { authorization: `Bearer ${otherToken}` },
      });
      assert.equal(hidden.statusCode, 200, hidden.body);
      assert.equal(hidden.json().palettes.some((item: { id: string }) => item.id === paletteId), false);

      const deniedSingle = await app.inject({
        method: "PUT",
        url: `/api/v1/inventory/${paletteId}/P01`,
        headers: { authorization: `Bearer ${otherToken}`, "idempotency-key": "private-inventory-single" },
        payload: { quantity: 1, location: null, baseRevision: 0 },
      });
      assert.equal(deniedSingle.statusCode, 404, deniedSingle.body);
      assert.equal(deniedSingle.json().error.code, "PALETTE_COLOR_NOT_FOUND");

      const deniedBatch = await app.inject({
        method: "POST",
        url: "/api/v1/inventory/batch",
        headers: { authorization: `Bearer ${otherToken}`, "idempotency-key": "private-inventory-batch" },
        payload: {
          mode: "calibrate",
          items: [{ paletteId, colorCode: "P01", quantity: 1, location: null, baseRevision: 0 }],
        },
      });
      assert.equal(deniedBatch.statusCode, 404, deniedBatch.body);
      assert.equal(deniedBatch.json().error.code, "PALETTE_COLOR_NOT_FOUND");

      const allowed = await app.inject({
        method: "PUT",
        url: `/api/v1/inventory/${paletteId}/P01`,
        headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": "private-inventory-owner" },
        payload: { quantity: 1, location: null, baseRevision: 0 },
      });
      assert.equal(allowed.statusCode, 201, allowed.body);

      const whitespace = await app.inject({
        method: "POST",
        url: "/api/v1/palettes",
        headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": "blank-palette-text" },
        payload: {
          name: "   ",
          brand: "品牌",
          beadSizeMm: 5,
          colors: [
            { code: "A", name: "颜色 A", hex: "#000000" },
            { code: "B", name: "颜色 B", hex: "#FFFFFF" },
          ],
        },
      });
      assert.equal(whitespace.statusCode, 400, whitespace.body);
      assert.equal(whitespace.json().error.code, "PALETTE_TEXT_REQUIRED");

      const overlong = await app.inject({
        method: "POST",
        url: "/api/v1/palettes",
        headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": "long-palette-code" },
        payload: {
          name: "长色号",
          brand: "品牌",
          beadSizeMm: 5,
          colors: [
            { code: "A".repeat(33), name: "颜色 A", hex: "#000000" },
            { code: "B", name: "颜色 B", hex: "#FFFFFF" },
          ],
        },
      });
      assert.equal(overlong.statusCode, 400, overlong.body);
      assert.equal(overlong.json().error.code, "VALIDATION_ERROR");
    } finally {
      await app.close();
    }
  });

  it("enforces durable custom palette count and color quotas", async () => {
    const store = new MemoryStore();
    const paletteOwner = "00000000-0000-4000-8000-000000003101";
    for (let index = 0; index < MAX_CUSTOM_PALETTES_PER_USER; index += 1) {
      await store.createPalette(paletteOwner, palette(`count-${index}`, 2));
    }
    await assert.rejects(
      store.createPalette(paletteOwner, palette("count-overflow", 2)),
      (error: unknown) => error instanceof AppError && error.code === "CUSTOM_PALETTE_LIMIT_EXCEEDED",
    );

    const colorOwner = "00000000-0000-4000-8000-000000003102";
    const fullBatches = Math.floor(MAX_CUSTOM_PALETTE_COLORS_PER_USER / 256);
    for (let index = 0; index < fullBatches; index += 1) {
      await store.createPalette(colorOwner, palette(`colors-${index}`, 256));
    }
    const remainder = MAX_CUSTOM_PALETTE_COLORS_PER_USER - fullBatches * 256;
    if (remainder > 0) await store.createPalette(colorOwner, palette("colors-remainder", remainder));
    await assert.rejects(
      store.createPalette(colorOwner, palette("colors-overflow", 2)),
      (error: unknown) => error instanceof AppError && error.code === "CUSTOM_PALETTE_COLOR_LIMIT_EXCEEDED",
    );
  });

  it("keeps direct MemoryStore draft, project, and generation writes tenant-scoped", async () => {
    const store = new MemoryStore();
    const owner = (await store.createDevSession({
      displayName: "仓储色卡拥有者",
      tokenHash: "1".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      startingCredits: 20,
    })).user;
    const other = (await store.createDevSession({
      displayName: "仓储色卡其他用户",
      tokenHash: "2".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      startingCredits: 20,
    })).user;
    const privatePalette = await store.createPalette(owner.id, palette("memory-private", 2));
    const invisible = (error: unknown) => error instanceof AppError && error.code === "PALETTE_NOT_FOUND";

    await assert.rejects(store.createProject(other.id, {
      name: "越权作品",
      paletteId: privatePalette.id,
      grid: { encoding: "palette-code-v1", width: 1, height: 1, cells: ["C000"] },
    }), invisible);
    await assert.rejects(store.saveCreationDraft({
      userId: other.id,
      draftId: null,
      baseDraftRevision: 0,
      name: "越权草稿",
      kind: "normal",
      setupStep: 1,
      paletteId: privatePalette.id,
      sourceAssetId: null,
      width: 1,
      height: 1,
      options: copyDefaultGenerationOptions(),
      grid: null,
    }), invisible);
    await assert.rejects(store.createGenerationJob({
      userId: other.id,
      jobId: "00000000-0000-4000-8000-000000003199",
      kind: "normal",
      paletteId: privatePalette.id,
      sourceAssetId: null,
      cost: 0,
      seed: "private-palette-probe",
      width: 1,
      height: 1,
      now: "2026-10-05T00:00:00.000Z",
    }), invisible);
  });

  it("keeps the production rollout gate fail-closed", async () => {
    const app = await buildApp({
      config: { ...baseConfig, customPalettesEnabled: false },
      store: new MemoryStore(),
      logger: false,
    });
    try {
      await app.ready();
      const token = await login(app, "灰度发布用户");
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/palettes",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": "disabled-palette" },
        payload: {
          name: "暂不可用",
          brand: "品牌",
          beadSizeMm: 5,
          colors: [
            { code: "A", name: "颜色 A", hex: "#000000" },
            { code: "B", name: "颜色 B", hex: "#FFFFFF" },
          ],
        },
      });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().error.code, "CUSTOM_PALETTES_DISABLED");
    } finally {
      await app.close();
    }
  });
});
