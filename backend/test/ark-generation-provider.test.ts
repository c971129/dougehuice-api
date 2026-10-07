import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sharp from "sharp";

import { copyDefaultGenerationOptions } from "../src/domain/generation-options.js";
import type { GenerationJob, Palette } from "../src/domain/models.js";
import { AppError } from "../src/errors.js";
import { ArkGenerationProvider } from "../src/generation/ark-provider.js";
import type { GenerationProviderInput } from "../src/generation/provider.js";

const NOW = "2026-10-06T10:00:00.000Z";
const palette: Palette = {
  id: "ark-test-palette",
  name: "测试色卡",
  brand: "测试",
  beadSizeMm: 5,
  verified: false,
  version: 1,
  colors: [
    { code: "BLACK", name: "黑", hex: "#000000", unitPriceCents: 1, available: true },
    { code: "WHITE", name: "白", hex: "#FFFFFF", unitPriceCents: 1, available: true },
    { code: "RED", name: "红", hex: "#FF0000", unitPriceCents: 1, available: true },
  ],
};

function job(kind: GenerationJob["kind"] = "portrait"): GenerationJob {
  const options = copyDefaultGenerationOptions();
  options.maxColors = 3;
  return {
    id: "00000000-0000-4000-8000-000000000901",
    userId: "user",
    parentJobId: null,
    kind,
    status: "generating",
    paletteId: palette.id,
    sourceAssetId: "source",
    options,
    cost: 1,
    seed: "seed-1",
    width: 2,
    height: 2,
    progress: 45,
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: NOW,
    leaseToken: "lease",
    leaseExpiresAt: NOW,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    canceledAt: null,
    acceptedCandidateId: null,
    candidates: [],
  };
}

function input(sourceContents: Buffer, kind: GenerationJob["kind"] = "portrait"): GenerationProviderInput {
  return {
    job: job(kind),
    palette,
    sourceContents,
    availableColorCodes: null,
    signal: new AbortController().signal,
    now: NOW,
  };
}

async function sourceImage(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer();
}

function rejectedWith(code: string, statusCode: number, retryable: boolean) {
  return (error: unknown): boolean => error instanceof AppError
    && error.code === code
    && error.statusCode === statusCode
    && error.retryable === retryable;
}

describe("Ark Generation Provider", () => {
  it("sends an image-to-image request and converts returned images to palette grids", async () => {
    const source = await sourceImage();
    let generationCalls = 0;
    const requestBodies: Record<string, unknown>[] = [];
    const generated = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ffffff" } }).png().toBuffer();
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value === "https://ark.cn-beijing.volces.com/api/v3/images/generations") {
        generationCalls += 1;
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: [{ url: `https://image.test/${generationCalls}.png` }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(generated, { status: 200, headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const provider = new ArkGenerationProvider({
      apiKey: "ark-secret",
      imageModel: "doubao-seedream-5-0-flash-260915",
      fetchImpl,
    });

    const candidates = await provider.generate(input(source));

    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((candidate) => [candidate.variantOrdinal, candidate.outputSlot]), [
      [1, "combined"],
      [2, "combined"],
    ]);
    assert.equal(generationCalls, 2);
    assert.equal(requestBodies[0]?.model, "doubao-seedream-5-0-flash-260915");
    assert.equal(typeof requestBodies[0]?.image, "string");
    assert.match(String(requestBodies[0]?.image), /^data:image\/png;base64,/);
    assert.match(String(requestBodies[0]?.prompt), /Q版/);
    assert.equal(candidates[0]?.grid.encoding, "palette-code-v1");
    assert.equal(candidates[0]?.grid.cells.length, 4);
  });

  it("fails closed when Ark returns no image", async () => {
    const provider = new ArkGenerationProvider({
      apiKey: "ark-secret",
      fetchImpl: (async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });
    const source = await sourceImage();

    await assert.rejects(
      provider.generate(input(source)),
      (error: unknown) => error instanceof AppError && error.code === "GENERATION_PROVIDER_RESPONSE_INVALID",
    );
  });

  it("maps Ark rejection, throttling, and server errors to stable retry contracts without exposing response text", async () => {
    const source = await sourceImage();
    const cases = [
      { status: 400, code: "GENERATION_PROVIDER_REJECTED", mappedStatus: 422, retryable: false },
      { status: 429, code: "GENERATION_PROVIDER_UNAVAILABLE", mappedStatus: 503, retryable: true },
      { status: 503, code: "GENERATION_PROVIDER_UNAVAILABLE", mappedStatus: 503, retryable: true },
    ];

    for (const scenario of cases) {
      const provider = new ArkGenerationProvider({
        apiKey: "synthetic-ark-key",
        fetchImpl: (async () => new Response("synthetic provider detail synthetic-ark-key", {
          status: scenario.status,
          headers: { "content-type": "text/plain" },
        })) as typeof fetch,
      });
      await assert.rejects(
        provider.generate(input(source)),
        (error: unknown) => error instanceof AppError
          && rejectedWith(scenario.code, scenario.mappedStatus, scenario.retryable)(error)
          && !error.message.includes("synthetic")
          && !JSON.stringify(error.details).includes("synthetic"),
      );
    }
  });

  it("maps provider timeouts to a retryable timeout error", async () => {
    const source = await sourceImage();
    const provider = new ArkGenerationProvider({
      apiKey: "synthetic-ark-key",
      timeoutMilliseconds: 1_000,
      fetchImpl: ((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as typeof fetch,
    });

    await assert.rejects(
      provider.generate(input(source)),
      rejectedWith("GENERATION_PROVIDER_TIMEOUT", 504, true),
    );
  });

  it("treats malformed successful payloads and failed image downloads as distinct failures", async () => {
    const source = await sourceImage();
    const invalidPayloadProvider = new ArkGenerationProvider({
      apiKey: "synthetic-ark-key",
      fetchImpl: (async () => new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });
    await assert.rejects(
      invalidPayloadProvider.generate(input(source)),
      rejectedWith("GENERATION_PROVIDER_RESPONSE_INVALID", 502, false),
    );

    const failedDownloadProvider = new ArkGenerationProvider({
      apiKey: "synthetic-ark-key",
      fetchImpl: (async (url) => String(url).includes("images/generations")
        ? new Response(JSON.stringify({ data: [{ url: "https://image.test/result.png" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
        : new Response("unavailable", { status: 502 })) as typeof fetch,
    });
    await assert.rejects(
      failedDownloadProvider.generate(input(source)),
      rejectedWith("GENERATION_PROVIDER_UNAVAILABLE", 503, true),
    );
  });
});
