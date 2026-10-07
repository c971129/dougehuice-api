import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { StorageObjectContext } from "./storage-provider.js";
import {
  StorageEncryptionKeyUnavailableError,
  StorageObjectCorruptedError,
} from "./storage-provider.js";

const LEGACY_MAGIC = Buffer.from("PDAE1", "ascii");
const KEYED_MAGIC = Buffer.from("PDAE2", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_ID_BYTES = 64;
const MAX_READ_KEYS = 32;
const DEFAULT_ACTIVE_KEY_ID = "default";

export interface StorageEncryptionKeyConfig {
  /** Existing single-key deployments may omit this and keep the stable `default` ID. */
  activeKeyId?: string;
  keyBase64: string;
  /** Read-only keys used by PDAE2 objects written before a rotation. */
  readKeysBase64?: Readonly<Record<string, string>>;
  /** Key used for pre-key-ID PDAE1 objects. Defaults to the active key for compatibility. */
  legacyKeyId?: string;
}

export interface StorageEncryptionKeyring {
  activeKeyId: string;
  legacyKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export function isStorageEncryptionKeyId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
    && Buffer.byteLength(value, "ascii") <= MAX_KEY_ID_BYTES;
}

export function decodeStorageEncryptionKey(keyBase64: string, label = "素材加密密钥"): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(keyBase64)) {
    throw new Error(`${label} 必须使用规范 Base64 编码`);
  }
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32 || key.toString("base64") !== keyBase64) {
    throw new Error(`${label} 必须为 32 字节`);
  }
  return key;
}

export function createStorageEncryptionKeyring(input: StorageEncryptionKeyConfig): StorageEncryptionKeyring {
  const activeKeyId = input.activeKeyId ?? DEFAULT_ACTIVE_KEY_ID;
  if (!isStorageEncryptionKeyId(activeKeyId)) {
    throw new Error("素材加密 active key ID 格式无效");
  }
  const readKeyEntries = Object.entries(input.readKeysBase64 ?? {});
  if (readKeyEntries.length > MAX_READ_KEYS) {
    throw new Error(`素材加密 keyring 最多允许 ${MAX_READ_KEYS} 把只读密钥`);
  }
  if (readKeyEntries.length > 0 && input.legacyKeyId === undefined) {
    throw new Error("配置只读密钥时必须显式绑定 PDAE1 legacy key ID");
  }
  const keys = new Map<string, Buffer>();
  const keyMaterialIds = new Map<string, string>();
  keys.set(activeKeyId, decodeStorageEncryptionKey(input.keyBase64, `素材加密密钥 ${activeKeyId}`));
  keyMaterialIds.set(input.keyBase64, activeKeyId);
  for (const [keyId, keyBase64] of readKeyEntries) {
    if (!isStorageEncryptionKeyId(keyId)) {
      throw new Error("素材加密 read key ID 格式无效");
    }
    if (keys.has(keyId)) {
      throw new Error(`素材加密 key ID ${keyId} 重复`);
    }
    const existingKeyId = keyMaterialIds.get(keyBase64);
    if (existingKeyId) {
      throw new Error(`素材加密 key ID ${keyId} 与 ${existingKeyId} 重复使用同一密钥材料`);
    }
    keys.set(keyId, decodeStorageEncryptionKey(keyBase64, `素材加密密钥 ${keyId}`));
    keyMaterialIds.set(keyBase64, keyId);
  }
  const legacyKeyId = input.legacyKeyId ?? activeKeyId;
  if (!isStorageEncryptionKeyId(legacyKeyId) || !keys.has(legacyKeyId)) {
    throw new Error("PDAE1 legacy key ID 未配置在素材加密 keyring 中");
  }
  return { activeKeyId, legacyKeyId, keys };
}

export function assertStorageKey(storageKey: string): void {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(storageKey)) {
    throw new Error("私有存储键格式无效");
  }
}

function legacyAad(storageKey: string, context: StorageObjectContext): Buffer {
  return Buffer.from(`${LEGACY_MAGIC.toString("ascii")}\0${storageKey}\0${context.ownerId}\0${context.assetId}`, "utf8");
}

function keyedAad(keyId: string, storageKey: string, context: StorageObjectContext): Buffer {
  return Buffer.from(
    `${KEYED_MAGIC.toString("ascii")}\0${keyId}\0${storageKey}\0${context.ownerId}\0${context.assetId}`,
    "utf8",
  );
}

export function encryptStorageObject(
  contents: Buffer,
  keyring: StorageEncryptionKeyring,
  storageKey: string,
  context: StorageObjectContext,
): Buffer {
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new StorageEncryptionKeyUnavailableError();
  const keyId = Buffer.from(keyring.activeKeyId, "ascii");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(keyedAad(keyring.activeKeyId, storageKey, context));
  const ciphertext = Buffer.concat([cipher.update(contents), cipher.final()]);
  return Buffer.concat([
    KEYED_MAGIC,
    Buffer.from([keyId.length]),
    keyId,
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

export function decryptStorageObject(
  payload: Buffer,
  keyring: StorageEncryptionKeyring,
  storageKey: string,
  context: StorageObjectContext,
): Buffer {
  if (payload.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)) {
    const key = keyring.keys.get(keyring.legacyKeyId);
    if (!key) throw new StorageEncryptionKeyUnavailableError();
    return decryptAuthenticatedObject({
      payload,
      key,
      headerBytes: LEGACY_MAGIC.length,
      aad: legacyAad(storageKey, context),
    });
  }

  if (!payload.subarray(0, KEYED_MAGIC.length).equals(KEYED_MAGIC)) {
    throw new StorageObjectCorruptedError();
  }
  const keyIdLength = payload[KEYED_MAGIC.length] ?? 0;
  const keyIdStart = KEYED_MAGIC.length + 1;
  const headerBytes = keyIdStart + keyIdLength;
  if (keyIdLength < 1 || keyIdLength > MAX_KEY_ID_BYTES
    || payload.length < headerBytes + IV_BYTES + TAG_BYTES) {
    throw new StorageObjectCorruptedError();
  }
  const serializedKeyId = payload.subarray(keyIdStart, headerBytes);
  // Buffer's ASCII decoder clears the high bit. Reject non-canonical bytes
  // before decoding so two different serialized headers cannot authenticate as
  // the same key ID/AAD value.
  if (serializedKeyId.some((byte) => byte > 0x7f)) throw new StorageObjectCorruptedError();
  const keyId = serializedKeyId.toString("ascii");
  if (!isStorageEncryptionKeyId(keyId)
    || !Buffer.from(keyId, "ascii").equals(serializedKeyId)) {
    throw new StorageObjectCorruptedError();
  }
  const key = keyring.keys.get(keyId);
  if (!key) throw new StorageEncryptionKeyUnavailableError();
  return decryptAuthenticatedObject({
    payload,
    key,
    headerBytes,
    aad: keyedAad(keyId, storageKey, context),
  });
}

function decryptAuthenticatedObject(input: {
  payload: Buffer;
  key: Buffer;
  headerBytes: number;
  aad: Buffer;
}): Buffer {
  if (input.payload.length < input.headerBytes + IV_BYTES + TAG_BYTES) {
    throw new StorageObjectCorruptedError();
  }
  try {
    const ivStart = input.headerBytes;
    const tagStart = ivStart + IV_BYTES;
    const dataStart = tagStart + TAG_BYTES;
    const decipher = createDecipheriv("aes-256-gcm", input.key, input.payload.subarray(ivStart, tagStart));
    decipher.setAAD(input.aad);
    decipher.setAuthTag(input.payload.subarray(tagStart, dataStart));
    return Buffer.concat([decipher.update(input.payload.subarray(dataStart)), decipher.final()]);
  } catch {
    throw new StorageObjectCorruptedError();
  }
}
