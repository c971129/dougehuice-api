import { createHash, randomBytes } from "node:crypto";

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

const MAX_CLOUDBASE_OBJECT_BYTES = 100 * 1024 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;

export interface CloudbaseEncryptedStorageOptions extends StorageEncryptionKeyConfig {
  envId: string;
  bucketId: string;
  serviceRoleApiKey: string;
  fetch?: typeof fetch;
}

interface CloudbaseApiError {
  code?: unknown;
}

function objectAlreadyExistsError(): Error & { code: "EEXIST" } {
  return Object.assign(new Error("私有存储键已存在"), { code: "EEXIST" as const });
}

function encodedObjectName(objectName: string): string {
  return objectName.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function apiErrorCode(responseText: string): string | undefined {
  try {
    const parsed = JSON.parse(responseText) as CloudbaseApiError;
    return typeof parsed.code === "string" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

function timedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Private CloudBase PG Storage. Only authenticated, encrypted objects leave this process. */
export class CloudbaseEncryptedStorage implements StorageProvider {
  private readonly baseUrl: string;
  private readonly bucketId: string;
  private readonly serviceRoleApiKey: string;
  private readonly keyring: StorageEncryptionKeyring;
  private readonly request: typeof fetch;

  constructor(input: CloudbaseEncryptedStorageOptions) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(input.envId)) {
      throw new Error("CloudBase environment ID is invalid");
    }
    if (!input.bucketId || input.bucketId.length > 255 || !input.serviceRoleApiKey) {
      throw new Error("CloudBase PG storage configuration is incomplete");
    }
    this.baseUrl = `https://${input.envId}.api.intl.tcloudbasegateway.com`;
    this.bucketId = input.bucketId;
    this.serviceRoleApiKey = input.serviceRoleApiKey;
    this.keyring = createStorageEncryptionKeyring(input);
    this.request = input.fetch ?? fetch;
  }

  async ready(): Promise<void> {
    // Configuration is validated at startup; readiness must not probe or mutate CloudBase.
  }

  async put(
    contents: Buffer,
    context: StorageObjectContext,
    requestedStorageKey = randomBytes(24).toString("base64url"),
    signal?: AbortSignal,
  ): Promise<{ storageKey: string }> {
    assertStorageKey(requestedStorageKey);
    const payload = encryptStorageObject(contents, this.keyring, requestedStorageKey, context);
    if (payload.length > MAX_CLOUDBASE_OBJECT_BYTES) {
      throw new StorageDependencyUnavailableError(new Error("CloudBase object exceeds 100 MiB limit"));
    }
    const url = this.objectUrl(requestedStorageKey);
    let response: Response;
    const requestSignal = timedSignal(signal);
    try {
      response = await this.request(url, {
        method: "POST",
        headers: this.headers({ "content-type": "application/octet-stream" }),
        body: payload,
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new StorageDependencyUnavailableError(new Error("CloudBase Storage request failed", { cause: safeCause(error) }));
    }
    if (!response.ok) {
      const code = apiErrorCode(await safeResponseText(response));
      if (code === "OBJECT_ALREADY_EXIST") throw objectAlreadyExistsError();
      throw dependencyError(response.status, code);
    }
    return { storageKey: requestedStorageKey };
  }

  async get(storageKey: string, context: StorageObjectContext, signal?: AbortSignal): Promise<Buffer | null> {
    signal?.throwIfAborted();
    assertStorageKey(storageKey);
    let response: Response;
    const requestSignal = timedSignal(signal);
    try {
      response = await this.request(this.objectUrl(storageKey, true), {
        method: "GET",
        headers: this.headers(),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new StorageDependencyUnavailableError(new Error("CloudBase Storage request failed", { cause: safeCause(error) }));
    }
    if (!response.ok) {
      const code = apiErrorCode(await safeResponseText(response));
      if (code === "OBJECT_NOT_EXIST") return null;
      throw dependencyError(response.status, code);
    }

    const payload = await readBoundedBody(response, requestSignal);
    signal?.throwIfAborted();
    try {
      const contents = decryptStorageObject(payload, this.keyring, storageKey, context);
      signal?.throwIfAborted();
      return contents;
    } catch (error) {
      if (error instanceof StorageObjectCorruptedError || error instanceof StorageDependencyUnavailableError) throw error;
      throw new StorageObjectCorruptedError();
    }
  }

  async delete(storageKey: string): Promise<void> {
    assertStorageKey(storageKey);
    let response: Response;
    try {
      response = await this.request(this.objectUrl(storageKey), {
        method: "DELETE",
        headers: this.headers(),
        signal: timedSignal(),
      });
    } catch (error) {
      throw new StorageDependencyUnavailableError(new Error("CloudBase Storage request failed", { cause: safeCause(error) }));
    }
    if (!response.ok) {
      const code = apiErrorCode(await safeResponseText(response));
      if (code === "OBJECT_NOT_EXIST") return;
      throw dependencyError(response.status, code);
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.serviceRoleApiKey}`,
      accept: "application/json",
      ...extra,
    };
  }

  private objectUrl(storageKey: string, authenticatedDownload = false): string {
    const digest = createHash("sha256").update(storageKey).digest("hex");
    const objectName = `${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}.pdae`;
    const route = authenticatedDownload ? "/authenticated" : "";
    return `${this.baseUrl}/v1/storages/object${route}/${encodeURIComponent(this.bucketId)}/${encodedObjectName(objectName)}`;
  }
}

function safeCause(error: unknown): Error {
  return error instanceof Error ? new Error(error.name) : new Error("unknown request error");
}

function dependencyError(status: number, code?: string): StorageDependencyUnavailableError {
  const safeCode = code && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "UNKNOWN";
  return new StorageDependencyUnavailableError(new Error(`CloudBase Storage returned HTTP ${status} (${safeCode})`));
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (length <= 4_096) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = 4_096 - length;
        chunks.push(value.subarray(0, remaining));
        length += Math.min(value.byteLength, remaining);
        if (value.byteLength > remaining) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString("utf8");
  } catch {
    return "";
  }
}

async function readBoundedBody(response: Response, signal?: AbortSignal): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CLOUDBASE_OBJECT_BYTES) {
    throw new StorageDependencyUnavailableError(new Error("CloudBase object exceeds 100 MiB limit"));
  }
  if (!response.body) throw new StorageDependencyUnavailableError(new Error("CloudBase object body missing"));

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CLOUDBASE_OBJECT_BYTES) {
        await reader.cancel();
        throw new StorageDependencyUnavailableError(new Error("CloudBase object exceeds 100 MiB limit"));
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof StorageDependencyUnavailableError || signal?.aborted) throw error;
    throw new StorageDependencyUnavailableError(new Error("CloudBase object body read failed", { cause: safeCause(error) }));
  } finally {
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  return Buffer.concat(chunks, length);
}
