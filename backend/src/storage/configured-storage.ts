import type { AppConfig } from "../config.js";
import { CloudbaseEncryptedStorage } from "./cloudbase-storage.js";
import { LocalEncryptedStorage } from "./local-encrypted-storage.js";
import { S3EncryptedStorage } from "./s3-encrypted-storage.js";
import type { StorageProvider } from "./storage-provider.js";

export function createConfiguredStorageProvider(config: AppConfig): StorageProvider {
  const provider = config.assetStorageProvider ?? "local";
  if (provider === "local") {
    return new LocalEncryptedStorage({
      root: config.assetStorageRoot,
      keyBase64: config.assetEncryptionKeyBase64,
      ...(config.assetEncryptionActiveKeyId
        ? { activeKeyId: config.assetEncryptionActiveKeyId }
        : {}),
      ...(config.assetEncryptionReadKeysBase64
        ? { readKeysBase64: config.assetEncryptionReadKeysBase64 }
        : {}),
      ...(config.assetEncryptionLegacyKeyId
        ? { legacyKeyId: config.assetEncryptionLegacyKeyId }
        : {}),
    });
  }

  if (provider === "cloudbase-pg") {
    if (!config.assetCloudbaseEnvId || !config.assetCloudbaseBucketId || !config.assetCloudbaseServiceRoleApiKey) {
      throw new Error("CloudBase PG 私有对象存储配置不完整");
    }
    return new CloudbaseEncryptedStorage({
      envId: config.assetCloudbaseEnvId,
      bucketId: config.assetCloudbaseBucketId,
      serviceRoleApiKey: config.assetCloudbaseServiceRoleApiKey,
      keyBase64: config.assetEncryptionKeyBase64,
      ...(config.assetEncryptionActiveKeyId ? { activeKeyId: config.assetEncryptionActiveKeyId } : {}),
      ...(config.assetEncryptionReadKeysBase64 ? { readKeysBase64: config.assetEncryptionReadKeysBase64 } : {}),
      ...(config.assetEncryptionLegacyKeyId ? { legacyKeyId: config.assetEncryptionLegacyKeyId } : {}),
    });
  }

  if (provider !== "s3") throw new Error("不支持的私有对象存储 provider");

  if (!config.assetS3Bucket || !config.assetS3Region || config.assetS3Prefix === undefined) {
    // loadConfig normally prevents this. Keep the factory fail-closed for tests
    // and for callers that construct AppConfig directly.
    throw new Error("S3 私有对象存储配置不完整");
  }
  return new S3EncryptedStorage({
    bucket: config.assetS3Bucket,
    region: config.assetS3Region,
    prefix: config.assetS3Prefix,
    keyBase64: config.assetEncryptionKeyBase64,
    ...(config.assetEncryptionActiveKeyId
      ? { activeKeyId: config.assetEncryptionActiveKeyId }
      : {}),
    ...(config.assetEncryptionReadKeysBase64
      ? { readKeysBase64: config.assetEncryptionReadKeysBase64 }
      : {}),
    ...(config.assetEncryptionLegacyKeyId
      ? { legacyKeyId: config.assetEncryptionLegacyKeyId }
      : {}),
    forcePathStyle: config.assetS3ForcePathStyle ?? false,
    ...(config.assetS3Endpoint ? { endpoint: config.assetS3Endpoint } : {}),
    ...(config.assetS3AccessKeyId ? { accessKeyId: config.assetS3AccessKeyId } : {}),
    ...(config.assetS3SecretAccessKey ? { secretAccessKey: config.assetS3SecretAccessKey } : {}),
    ...(config.assetS3SessionToken ? { sessionToken: config.assetS3SessionToken } : {}),
  });
}
