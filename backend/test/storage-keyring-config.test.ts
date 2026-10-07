import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";

const DEVELOPMENT_KEY = "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=";
const OLD_KEY = Buffer.alloc(32, 0x31).toString("base64");
const NEW_KEY = Buffer.alloc(32, 0x32).toString("base64");

describe("private object encryption keyring configuration", () => {
  it("keeps the single-key environment backward compatible", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      ASSET_ENCRYPTION_KEY_BASE64: OLD_KEY,
    }, "export-worker");
    assert.equal(config.assetEncryptionKeyBase64, OLD_KEY);
    assert.equal(config.assetEncryptionActiveKeyId, "default");
    assert.equal(config.assetEncryptionLegacyKeyId, "default");
    assert.deepEqual(config.assetEncryptionReadKeysBase64, {});
  });

  it("loads an active key plus explicitly bound read-only and PDAE1 keys", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      ASSET_ENCRYPTION_KEY_BASE64: NEW_KEY,
      ASSET_ENCRYPTION_ACTIVE_KEY_ID: "2026-10",
      ASSET_ENCRYPTION_READ_KEYS_JSON: JSON.stringify({ "2026-01": OLD_KEY }),
      ASSET_ENCRYPTION_LEGACY_KEY_ID: "2026-01",
    }, "export-worker");
    assert.equal(config.assetEncryptionActiveKeyId, "2026-10");
    assert.equal(config.assetEncryptionLegacyKeyId, "2026-01");
    assert.deepEqual(config.assetEncryptionReadKeysBase64, { "2026-01": OLD_KEY });
  });

  it("rejects ambiguous, malformed, duplicate, and unresolved keyring entries", () => {
    const base = {
      NODE_ENV: "development",
      ASSET_ENCRYPTION_KEY_BASE64: NEW_KEY,
      ASSET_ENCRYPTION_ACTIVE_KEY_ID: "key-new",
    };
    assert.throws(
      () => loadConfig({ ...base, ASSET_ENCRYPTION_READ_KEYS_JSON: "[]" }, "export-worker"),
      /JSON 对象/,
    );
    assert.throws(
      () => loadConfig({ ...base, ASSET_ENCRYPTION_READ_KEYS_JSON: "not-json" }, "export-worker"),
      /JSON 对象/,
    );
    assert.throws(
      () => loadConfig({
        ...base,
        ASSET_ENCRYPTION_READ_KEYS_JSON: JSON.stringify({ "bad key": OLD_KEY }),
        ASSET_ENCRYPTION_LEGACY_KEY_ID: "bad key",
      }, "export-worker"),
      /key ID/,
    );
    assert.throws(
      () => loadConfig({
        ...base,
        ASSET_ENCRYPTION_READ_KEYS_JSON: JSON.stringify({ "key-old": "not-base64" }),
        ASSET_ENCRYPTION_LEGACY_KEY_ID: "key-old",
      }, "export-worker"),
      /Base64/,
    );
    assert.throws(
      () => loadConfig({
        ...base,
        ASSET_ENCRYPTION_READ_KEYS_JSON: JSON.stringify({ "key-new": OLD_KEY }),
        ASSET_ENCRYPTION_LEGACY_KEY_ID: "key-new",
      }, "export-worker"),
      /不能同时出现/,
    );
    assert.throws(
      () => loadConfig({
        ...base,
        ASSET_ENCRYPTION_READ_KEYS_JSON: JSON.stringify({ "key-alias": NEW_KEY }),
        ASSET_ENCRYPTION_LEGACY_KEY_ID: "key-alias",
      }, "export-worker"),
      /重复使用同一密钥材料/,
    );
    assert.throws(
      () => loadConfig({
        ...base,
        ASSET_ENCRYPTION_READ_KEYS_JSON: JSON.stringify({ "key-old": OLD_KEY }),
      }, "export-worker"),
      /必须显式设置 ASSET_ENCRYPTION_LEGACY_KEY_ID/,
    );
    assert.throws(
      () => loadConfig({
        ...base,
        ASSET_ENCRYPTION_READ_KEYS_JSON: JSON.stringify({ "key-old": OLD_KEY }),
        ASSET_ENCRYPTION_LEGACY_KEY_ID: "missing",
      }, "export-worker"),
      /必须指向/,
    );
    assert.throws(
      () => loadConfig({ ...base, ASSET_ENCRYPTION_ACTIVE_KEY_ID: "bad key id" }, "export-worker"),
      /ASSET_ENCRYPTION_ACTIVE_KEY_ID/,
    );
    assert.throws(
      () => loadConfig({
        ...base,
        ASSET_ENCRYPTION_READ_KEYS_JSON: JSON.stringify(Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`old-${index}`, OLD_KEY]),
        )),
        ASSET_ENCRYPTION_LEGACY_KEY_ID: "old-0",
      }, "export-worker"),
      /最多允许 32/,
    );
  });

  it("rejects the development key anywhere in a production keyring", () => {
    assert.throws(
      () => loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://pindou:secret@localhost:5432/pindou",
        DATABASE_SSL: "false",
        ASSET_STORAGE_PROVIDER: "s3",
        ASSET_S3_BUCKET: "private-assets",
        ASSET_S3_REGION: "us-east-1",
        ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
        ASSET_ENCRYPTION_ACTIVE_KEY_ID: "key-new",
        ASSET_ENCRYPTION_READ_KEYS_JSON: JSON.stringify({ "key-old": DEVELOPMENT_KEY }),
        ASSET_ENCRYPTION_LEGACY_KEY_ID: "key-old",
      }, "export-worker"),
      /keyring 禁止包含开发默认密钥/,
    );
  });

  it("does not parse storage keyring settings for migration and seed roles", () => {
    for (const role of ["migration", "seed"] as const) {
      const config = loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://pindou:secret@localhost:5432/pindou",
        DATABASE_SSL: "false",
        ASSET_ENCRYPTION_KEY_BASE64: "invalid",
        ASSET_ENCRYPTION_ACTIVE_KEY_ID: "bad key id",
        ASSET_ENCRYPTION_READ_KEYS_JSON: "invalid-json",
        ASSET_ENCRYPTION_LEGACY_KEY_ID: "missing",
      }, role);
      assert.equal(config.nodeEnv, "production");
    }
  });
});
