import { assertGenerationCandidatesStructure } from "../domain/generation-candidates.js";
import { assertValidGrid } from "../domain/grid.js";
import type {
  GenerationCandidate,
  GenerationCandidateOutputSlot,
  PatternGrid,
} from "../domain/models.js";
import {
  MAX_GENERATION_CANDIDATES,
  MAX_GENERATION_CANDIDATE_ID_LENGTH,
  MIN_GENERATION_CANDIDATE_ID_LENGTH,
} from "../domain/resource-limits.js";
import { AppError } from "../errors.js";
import type { GenerationProvider, GenerationProviderInput } from "./provider.js";

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const OUTPUT_SLOTS: readonly GenerationCandidateOutputSlot[] = [
  "combined",
  "left",
  "right",
  "subject-1",
  "subject-2",
];

type JsonObject = Record<string, unknown>;

export interface HttpGenerationProviderOptions {
  endpoint: string;
  apiKey: string;
  timeoutMilliseconds: number;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function normalizeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Generation Provider endpoint 必须是有效的 HTTP(S) URL");
  }
  const loopbackHttp = endpoint.protocol === "http:" && isLoopback(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !loopbackHttp) {
    throw new Error("Generation Provider endpoint 必须使用 HTTPS（loopback 测试除外）");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("Generation Provider endpoint 不能包含用户凭据或片段");
  }
  return endpoint.toString();
}

function sourceMediaType(contents: Buffer): "image/jpeg" | "image/png" | "image/webp" {
  if (contents.length >= 3 && contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff) {
    return "image/jpeg";
  }
  if (contents.length >= 8
    && contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (contents.length >= 12
    && contents.subarray(0, 4).toString("ascii") === "RIFF"
    && contents.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  throw new AppError(410, "GENERATION_SOURCE_ASSET_CORRUPTED", "AI 原始素材格式校验失败");
}

function invalidResponse(): never {
  throw new AppError(
    502,
    "GENERATION_PROVIDER_RESPONSE_INVALID",
    "生成服务返回了无效响应",
    undefined,
    false,
  );
}

async function readJsonResponse(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") invalidResponse();
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^(?:0|[1-9]\d*)$/.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maximumBytes) invalidResponse();
  }
  if (!response.body) invalidResponse();

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      invalidResponse();
    }
    chunks.push(Buffer.from(chunk.value));
  }
  let parsed: unknown;
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    parsed = JSON.parse(raw);
  } catch {
    invalidResponse();
  }
  return parsed;
}

function candidateFromUnknown(value: unknown, input: GenerationProviderInput): GenerationCandidate {
  if (!isObject(value)
    || typeof value.id !== "string"
    || value.id.length < MIN_GENERATION_CANDIDATE_ID_LENGTH
    || value.id.length > MAX_GENERATION_CANDIDATE_ID_LENGTH
    || !Number.isInteger(value.variantOrdinal)
    || typeof value.variantOrdinal !== "number"
    || typeof value.outputSlot !== "string"
    || !OUTPUT_SLOTS.includes(value.outputSlot as GenerationCandidateOutputSlot)
    || !Number.isInteger(value.ordinal)
    || typeof value.ordinal !== "number"
    || (value.subject !== undefined && value.subject !== 1 && value.subject !== 2)
    || "acceptedProjectId" in value
    || "acceptedAt" in value
    || !isObject(value.grid)) {
    invalidResponse();
  }
  const outputSlot = value.outputSlot as GenerationCandidateOutputSlot;
  const subject: 1 | 2 | undefined = outputSlot === "subject-1"
    ? 1
    : outputSlot === "subject-2" ? 2 : undefined;
  if (value.subject !== undefined && value.subject !== subject) invalidResponse();
  const grid = value.grid;
  if (grid.encoding !== "palette-code-v1"
    || !Number.isInteger(grid.width)
    || !Number.isInteger(grid.height)
    || typeof grid.width !== "number"
    || typeof grid.height !== "number"
    || !Array.isArray(grid.cells)
    || grid.cells.some((cell) => cell !== null && typeof cell !== "string")) {
    invalidResponse();
  }
  const normalizedGrid: PatternGrid = {
    encoding: "palette-code-v1",
    width: grid.width,
    height: grid.height,
    cells: [...grid.cells] as Array<string | null>,
  };
  return {
    id: value.id,
    jobId: input.job.id,
    variantOrdinal: value.variantOrdinal,
    outputSlot,
    ordinal: value.ordinal,
    ...(subject === undefined ? {} : { subject }),
    grid: normalizedGrid,
    createdAt: input.now,
  };
}

function candidatesFromResponse(payload: unknown, input: GenerationProviderInput): GenerationCandidate[] {
  if (!isObject(payload)
    || payload.schemaVersion !== "pindou-generation-v3"
    || !Array.isArray(payload.candidates)
    || payload.candidates.length < 1
    || payload.candidates.length > MAX_GENERATION_CANDIDATES) {
    invalidResponse();
  }
  const candidates = payload.candidates.map((candidate) => candidateFromUnknown(candidate, input));
  try {
    assertGenerationCandidatesStructure({
      jobId: input.job.id,
      kind: input.job.kind,
      options: input.job.options,
      width: input.job.width,
      height: input.job.height,
      candidates,
    });
    const available = input.availableColorCodes ? new Set(input.availableColorCodes) : null;
    for (const candidate of candidates) {
      assertValidGrid(candidate.grid, input.palette);
      const usedColors = new Set(candidate.grid.cells.filter((color): color is string => color !== null));
      if (usedColors.size > input.job.options.maxColors
        || available && [...usedColors].some((color) => !available.has(color))) {
        invalidResponse();
      }
    }
  } catch {
    invalidResponse();
  }
  return candidates;
}

function callerAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("GENERATION_ABORTED");
}

export class HttpGenerationProvider implements GenerationProvider {
  readonly kind = "http";

  #endpoint: string;
  #apiKey: string;
  #timeoutMilliseconds: number;
  #fetchImpl: typeof fetch;
  #maxResponseBytes: number;

  constructor(options: HttpGenerationProviderOptions) {
    this.#endpoint = normalizeEndpoint(options.endpoint);
    this.#apiKey = options.apiKey.trim();
    if (!this.#apiKey || this.#apiKey.length > 8_192) {
      throw new Error("Generation Provider API key 必须是 1-8192 个字符");
    }
    this.#timeoutMilliseconds = options.timeoutMilliseconds;
    if (!Number.isSafeInteger(this.#timeoutMilliseconds)
      || this.#timeoutMilliseconds < 1
      || this.#timeoutMilliseconds > 600_000) {
      throw new Error("Generation Provider timeout 必须介于 1 和 600000 毫秒之间");
    }
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.#maxResponseBytes)
      || this.#maxResponseBytes < 64
      || this.#maxResponseBytes > 16 * 1024 * 1024) {
      throw new Error("Generation Provider 响应上限必须介于 64 字节和 16 MiB 之间");
    }
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(input: GenerationProviderInput): Promise<GenerationCandidate[]> {
    if (input.signal.aborted) throw callerAbortReason(input.signal);
    const body = JSON.stringify({
      schemaVersion: "pindou-generation-v3",
      job: {
        id: input.job.id,
        kind: input.job.kind,
        seed: input.job.seed,
      },
      options: {
        crop: {
          ratio: input.job.options.crop.ratio,
          freeRatio: input.job.options.crop.freeRatio,
          rotation: input.job.options.crop.rotation,
          scale: input.job.options.crop.scale,
          offsetX: input.job.options.crop.offsetX,
          offsetY: input.job.options.crop.offsetY,
          flipX: input.job.options.crop.flipX,
          flipY: input.job.options.crop.flipY,
        },
        removeBackground: input.job.options.removeBackground,
        figureStyle: input.job.options.figureStyle,
        coupleLayout: input.job.options.coupleLayout,
        maxColors: input.job.options.maxColors,
        transparentBackground: input.job.options.transparentBackground,
        inventoryOnly: input.job.options.inventoryOnly,
        brightness: input.job.options.brightness,
        contrast: input.job.options.contrast,
        saturation: input.job.options.saturation,
        dither: input.job.options.dither,
      },
      target: { width: input.job.width, height: input.job.height },
      palette: {
        id: input.palette.id,
        version: input.palette.version,
        colors: input.palette.colors
          .filter((color) => color.available)
          .map((color) => ({ code: color.code, hex: color.hex })),
      },
      availableColorCodes: input.availableColorCodes ? [...input.availableColorCodes] : null,
      ...(input.sourceContents ? {
        sourceImage: {
          mediaType: sourceMediaType(input.sourceContents),
          encoding: "base64",
          data: input.sourceContents.toString("base64"),
        },
      } : {}),
    });
    if (input.signal.aborted) throw callerAbortReason(input.signal);
    const requestController = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => requestController.abort(input.signal.reason);
    input.signal.addEventListener("abort", abortFromCaller, { once: true });
    if (input.signal.aborted) abortFromCaller();
    const timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort(new Error("GENERATION_PROVIDER_TIMEOUT"));
    }, this.#timeoutMilliseconds);

    try {
      const response = await this.#fetchImpl(this.#endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          "idempotency-key": input.job.id,
        },
        body,
        cache: "no-store",
        redirect: "error",
        signal: requestController.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const retryable = response.status === 408
          || response.status === 425
          || response.status === 429
          || response.status >= 500;
        throw new AppError(
          retryable ? 503 : 422,
          retryable ? "GENERATION_PROVIDER_UNAVAILABLE" : "GENERATION_PROVIDER_REJECTED",
          retryable ? "生成服务暂时不可用" : "生成服务拒绝了本次请求",
          { providerStatus: response.status },
          retryable,
        );
      }
      const payload = await readJsonResponse(response, this.#maxResponseBytes);
      if (input.signal.aborted) throw callerAbortReason(input.signal);
      return candidatesFromResponse(payload, input);
    } catch (error) {
      if (input.signal.aborted) throw callerAbortReason(input.signal);
      if (timedOut) {
        throw new AppError(504, "GENERATION_PROVIDER_TIMEOUT", "生成服务请求超时", undefined, true);
      }
      if (error instanceof AppError) throw error;
      throw new AppError(503, "GENERATION_PROVIDER_UNAVAILABLE", "生成服务暂时不可用", undefined, true);
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abortFromCaller);
    }
  }
}
