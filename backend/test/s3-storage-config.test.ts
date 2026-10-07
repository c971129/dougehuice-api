import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";

describe("S3 private storage configuration", () => {
  it("defaults to local storage and requires a complete S3 target", () => {
    assert.equal(loadConfig({ NODE_ENV: "development" }).assetStorageProvider, "local");
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", ASSET_STORAGE_PROVIDER: "unknown" }),
      /local 或 s3/,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", ASSET_STORAGE_PROVIDER: "s3" }),
      /ASSET_S3_BUCKET.*ASSET_S3_REGION/,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", ASSET_S3_BUCKET: "unused-bucket" }),
      /ASSET_STORAGE_PROVIDER=local/,
    );
  });

  it("accepts AWS role credentials or one complete explicit credential set", () => {
    const roleCredentials = loadConfig({
      NODE_ENV: "development",
      ASSET_STORAGE_PROVIDER: "s3",
      ASSET_S3_BUCKET: "private-assets",
      ASSET_S3_REGION: "cn-north-1",
    });
    assert.equal(roleCredentials.assetS3Prefix, "pindou/private");
    assert.equal(roleCredentials.assetS3AccessKeyId, undefined);

    const explicit = loadConfig({
      NODE_ENV: "development",
      ASSET_STORAGE_PROVIDER: "s3",
      ASSET_S3_BUCKET: "private-assets",
      ASSET_S3_REGION: "us-east-1",
      ASSET_S3_ENDPOINT: "http://127.0.0.1:9000",
      ASSET_S3_PREFIX: "tenant/pindou-private",
      ASSET_S3_FORCE_PATH_STYLE: "true",
      ASSET_S3_ACCESS_KEY_ID: "minio-access",
      ASSET_S3_SECRET_ACCESS_KEY: "minio-secret-value",
      ASSET_S3_SESSION_TOKEN: "temporary-session-token",
    });
    assert.equal(explicit.assetS3Endpoint, "http://127.0.0.1:9000");
    assert.equal(explicit.assetS3ForcePathStyle, true);
    assert.equal(explicit.assetS3Prefix, "tenant/pindou-private");

    assert.throws(() => loadConfig({
      NODE_ENV: "development",
      ASSET_STORAGE_PROVIDER: "s3",
      ASSET_S3_BUCKET: "private-assets",
      ASSET_S3_REGION: "us-east-1",
      ASSET_S3_ACCESS_KEY_ID: "only-one-side",
    }), /必须同时配置或同时省略/);
  });

  it("rejects unsafe endpoints and prefixes, and requires HTTPS in production", () => {
    const common = {
      ASSET_STORAGE_PROVIDER: "s3",
      ASSET_S3_BUCKET: "private-assets",
      ASSET_S3_REGION: "us-east-1",
    };
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", ...common, ASSET_S3_ENDPOINT: "http://minio.internal:9000" }),
      /必须使用 HTTPS/,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", ...common, ASSET_S3_ENDPOINT: "https://key:secret@s3.example.test" }),
      /不能包含凭据/,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: "development", ...common, ASSET_S3_PREFIX: "private/../shared" }),
      /ASSET_S3_PREFIX/,
    );
    assert.throws(() => loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://pindou:secret@localhost:5432/pindou",
      DATABASE_SSL: "false",
      ...common,
      ASSET_S3_ENDPOINT: "http://127.0.0.1:9000",
      ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
    }, "export-worker"), /必须使用 HTTPS/);

    const production = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://pindou:secret@localhost:5432/pindou",
      DATABASE_SSL: "false",
      ...common,
      ASSET_S3_ENDPOINT: "https://s3.example.test",
      ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
    }, "export-worker");
    assert.equal(production.assetStorageProvider, "s3");
  });
});
