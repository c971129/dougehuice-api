import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { LocalEncryptedStorage } from "../src/storage/local-encrypted-storage.js";
import {
  StorageEncryptionKeyUnavailableError,
  StorageObjectCorruptedError,
  type StorageObjectContext,
} from "../src/storage/storage-provider.js";

const OLD_KEY = Buffer.alloc(32, 0x31).toString("base64");
const NEW_KEY = Buffer.alloc(32, 0x32).toString("base64");
const LEGACY_MAGIC = Buffer.from("PDAE1", "ascii");

function localObjectPath(root: string, storageKey: string): string {
  const digest = createHash("sha256").update(storageKey).digest("hex");
  return join(root, digest.slice(0, 2), digest.slice(2, 4), `${digest}.pdae`);
}

function encryptLegacyObject(
  contents: Buffer,
  keyBase64: string,
  storageKey: string,
  context: StorageObjectContext,
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
  cipher.setAAD(Buffer.from(`PDAE1\0${storageKey}\0${context.ownerId}\0${context.assetId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(contents), cipher.final()]);
  return Buffer.concat([LEGACY_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

async function seedLocalObject(root: string, storageKey: string, payload: Buffer): Promise<string> {
  const path = localObjectPath(root, storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, payload);
  return path;
}

describe("private object encryption key rotation", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reads mixed PDAE1/PDAE2 objects and writes only with the active key ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "pindou-key-rotation-"));
    temporaryRoots.push(root);
    const context = { ownerId: "owner-rotation-0001", assetId: "asset-rotation-0001" };
    const legacyStorageKey = "legacy-storage-key-0001";
    const legacyPlaintext = Buffer.from("legacy private image bytes");
    await seedLocalObject(
      root,
      legacyStorageKey,
      encryptLegacyObject(legacyPlaintext, OLD_KEY, legacyStorageKey, context),
    );

    const rotated = new LocalEncryptedStorage({
      root,
      keyBase64: NEW_KEY,
      activeKeyId: "key-new",
      readKeysBase64: { "key-old": OLD_KEY },
      legacyKeyId: "key-old",
    });
    assert.deepEqual(await rotated.get(legacyStorageKey, context), legacyPlaintext);

    const newStorageKey = "active-storage-key-0001";
    const newPlaintext = Buffer.from("new private image bytes");
    await rotated.put(newPlaintext, context, newStorageKey);
    const newObjectPath = localObjectPath(root, newStorageKey);
    const payload = await readFile(newObjectPath);
    assert.equal(payload.subarray(0, 5).toString("ascii"), "PDAE2");
    const keyIdLength = payload[5] ?? 0;
    assert.equal(keyIdLength, "key-new".length);
    assert.equal(payload.subarray(6, 6 + keyIdLength).toString("ascii"), "key-new");
    assert.deepEqual(await rotated.get(newStorageKey, context), newPlaintext);

    const oldOnly = new LocalEncryptedStorage({ root, keyBase64: OLD_KEY, activeKeyId: "key-old" });
    await assert.rejects(oldOnly.get(newStorageKey, context), StorageEncryptionKeyUnavailableError);

    const substitutedKnownKeyIdPayload = Buffer.from(payload);
    Buffer.from("key-old", "ascii").copy(substitutedKnownKeyIdPayload, 6);
    await writeFile(newObjectPath, substitutedKnownKeyIdPayload);
    await assert.rejects(rotated.get(newStorageKey, context), StorageObjectCorruptedError);

    const unknownKeyIdPayload = Buffer.from(payload);
    Buffer.from("missing", "ascii").copy(unknownKeyIdPayload, 6);
    await writeFile(newObjectPath, unknownKeyIdPayload);
    await assert.rejects(rotated.get(newStorageKey, context), StorageEncryptionKeyUnavailableError);

    const nonCanonicalKeyIdPayload = Buffer.from(payload);
    nonCanonicalKeyIdPayload[6] = (nonCanonicalKeyIdPayload[6] ?? 0) | 0x80;
    await writeFile(newObjectPath, nonCanonicalKeyIdPayload);
    await assert.rejects(rotated.get(newStorageKey, context), StorageObjectCorruptedError);

    const tamperedPayload = Buffer.from(payload);
    const lastByte = tamperedPayload.length - 1;
    tamperedPayload[lastByte] = (tamperedPayload[lastByte] ?? 0) ^ 0xff;
    await writeFile(newObjectPath, tamperedPayload);
    await assert.rejects(rotated.get(newStorageKey, context), StorageObjectCorruptedError);
  });

  it("keeps the original single-key environment compatible with PDAE1", async () => {
    const root = await mkdtemp(join(tmpdir(), "pindou-legacy-key-"));
    temporaryRoots.push(root);
    const context = { ownerId: "owner-legacy-0001", assetId: "asset-legacy-0001" };
    const storageKey = "legacy-single-key-0001";
    const plaintext = Buffer.from("pre-rotation bytes");
    await seedLocalObject(root, storageKey, encryptLegacyObject(plaintext, OLD_KEY, storageKey, context));

    const storage = new LocalEncryptedStorage({ root, keyBase64: OLD_KEY });
    assert.deepEqual(await storage.get(storageKey, context), plaintext);
  });
});
