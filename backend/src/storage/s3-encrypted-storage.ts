import { createHash, randomBytes } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

import {
  StorageDependencyUnavailableError,
  StorageObjectCorruptedError,
  type StorageObjectContext,
  type StorageProvider,
} from "./storage-provider.js";
import {
  assertStorageKey,
  createStorageEncryptionKeyring,
  decryptStorageObject,
  encryptStorageObject,
  type StorageEncryptionKeyConfig,
  type StorageEncryptionKeyring,
} from "./encrypted-object.js";

export interface S3EncryptedStorageOptions extends StorageEncryptionKeyConfig {
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) return undefined;
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : undefined;
}

function errorText(error: unknown, field: "Key" | "Resource"): string | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function isObjectNotFound(error: unknown, bucket: string, objectKey: string): boolean {
  if (errorStatus(error) !== 404) return false;
  const name = errorName(error);
  if (name === "NoSuchKey") return true;
  if (name !== "NotFound") return false;

  const missingKey = errorText(error, "Key");
  if (missingKey !== undefined) return missingKey === objectKey;
  const resource = errorText(error, "Resource");
  return resource === `/${bucket}/${objectKey}` || resource === `/${objectKey}`;
}

function existingObjectError(): Error & { code: "EEXIST" } {
  return Object.assign(new Error("私有存储键已存在"), { code: "EEXIST" as const });
}

/**
 * Private S3/MinIO storage. Bytes are encrypted before leaving this process;
 * the opaque database storage key is hashed again before it becomes an object
 * coordinate, and the owner/asset pair is authenticated as AES-GCM AAD.
 */
export class S3EncryptedStorage implements StorageProvider {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly keyring: StorageEncryptionKeyring;
  private readonly client: S3Client;

  constructor(input: S3EncryptedStorageOptions) {
    this.bucket = input.bucket;
    this.prefix = input.prefix.replace(/^\/+|\/+$/g, "");
    this.keyring = createStorageEncryptionKeyring(input);

    const clientConfig: S3ClientConfig = {
      region: input.region,
      forcePathStyle: input.forcePathStyle ?? false,
    };
    if (input.endpoint) clientConfig.endpoint = input.endpoint;
    if (input.accessKeyId && input.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
      };
    }
    this.client = new S3Client(clientConfig);
  }

  async ready(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async close(): Promise<void> {
    this.client.destroy();
  }

  async put(
    contents: Buffer,
    context: StorageObjectContext,
    requestedStorageKey = randomBytes(24).toString("base64url"),
    signal?: AbortSignal,
  ): Promise<{ storageKey: string }> {
    assertStorageKey(requestedStorageKey);
    const payload = encryptStorageObject(contents, this.keyring, requestedStorageKey, context);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(requestedStorageKey),
        Body: payload,
        ContentType: "application/octet-stream",
        CacheControl: "private, no-store",
        IfNoneMatch: "*",
        Metadata: { "pindou-format": "pdae2" },
      }), signal ? { abortSignal: signal } : undefined);
    } catch (error) {
      if (errorStatus(error) === 412 || errorName(error) === "PreconditionFailed") {
        throw existingObjectError();
      }
      if (signal?.aborted) throw error;
      throw new StorageDependencyUnavailableError(error);
    }
    return { storageKey: requestedStorageKey };
  }

  async get(storageKey: string, context: StorageObjectContext, signal?: AbortSignal): Promise<Buffer | null> {
    signal?.throwIfAborted();
    assertStorageKey(storageKey);
    const objectKey = this.objectKey(storageKey);
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }), signal ? { abortSignal: signal } : undefined);
      if (!response.Body) throw new Error("私有存储对象正文缺失");
      const payload = Buffer.from(await response.Body.transformToByteArray());
      signal?.throwIfAborted();
      const contents = decryptStorageObject(payload, this.keyring, storageKey, context);
      signal?.throwIfAborted();
      return contents;
    } catch (error) {
      if (isObjectNotFound(error, this.bucket, objectKey)) return null;
      if (signal?.aborted
        || error instanceof StorageObjectCorruptedError
        || error instanceof StorageDependencyUnavailableError) throw error;
      throw new StorageDependencyUnavailableError(error);
    }
  }

  async delete(storageKey: string): Promise<void> {
    assertStorageKey(storageKey);
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(storageKey),
      }));
    } catch (error) {
      throw new StorageDependencyUnavailableError(error);
    }
  }

  private objectKey(storageKey: string): string {
    const digest = createHash("sha256").update(storageKey).digest("hex");
    const suffix = `${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}.pdae`;
    return this.prefix ? `${this.prefix}/${suffix}` : suffix;
  }
}
