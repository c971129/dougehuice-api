import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { copyDefaultGenerationOptions } from "../src/domain/generation-options.js";
import type { GenerationJob, Palette } from "../src/domain/models.js";
import { AppError } from "../src/errors.js";
import { createConfiguredGenerationProvider } from "../src/generation/configured-provider.js";
import { HttpGenerationProvider } from "../src/generation/http-provider.js";
import type { GenerationProviderInput } from "../src/generation/provider.js";

const NOW = "2026-10-04T10:00:00.000Z";
const JOB_ID = "00000000-0000-4000-8000-000000000801";

const palette: Palette = {
  id: "provider-test-palette",
  name: "Provider 测试色卡",
  brand: "测试",
  beadSizeMm: 5,
  verified: false,
  version: 7,
  colors: [
    { code: "A01", name: "曜石黑", hex: "#27313B", unitPriceCents: 3, available: true },
    { code: "B02", name: "暖白", hex: "#FFF4DF", unitPriceCents: 4, available: true },
  ],
};

function generationJob(input: { kind?: GenerationJob["kind"]; solo?: boolean } = {}): GenerationJob {
  const options = copyDefaultGenerationOptions();
  options.inventoryOnly = true;
  options.brightness = -10;
  options.contrast = 20;
  options.saturation = 30;
  options.dither = true;
  if (input.solo) options.coupleLayout = "solo";
  return {
    id: JOB_ID,
    userId: "private-user-id",
    parentJobId: null,
    kind: input.kind ?? "portrait",
    status: "generating",
    paletteId: palette.id,
    sourceAssetId: "private-source-asset-id",
    options,
    cost: 1,
    seed: "provider-test-seed",
    width: 2,
    height: 2,
    progress: 45,
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: NOW,
    leaseToken: "private-lease-token",
    leaseExpiresAt: "2026-10-04T10:02:00.000Z",
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

function providerInput(input: {
  signal?: AbortSignal;
  sourceContents?: Buffer | null;
  kind?: GenerationJob["kind"];
  solo?: boolean;
  availableColorCodes?: string[] | null;
} = {}): GenerationProviderInput {
  const job = generationJob({ ...(input.kind ? { kind: input.kind } : {}), ...(input.solo ? { solo: true } : {}) });
  if (input.availableColorCodes === null) job.options.inventoryOnly = false;
  return {
    job,
    palette,
    sourceContents: input.sourceContents === undefined ? null : input.sourceContents,
    availableColorCodes: input.availableColorCodes === undefined ? ["A01"] : input.availableColorCodes,
    signal: input.signal ?? new AbortController().signal,
    now: NOW,
  };
}

function responseCandidate(input: {
  id?: string;
  variantOrdinal?: number;
  outputSlot?: "combined" | "left" | "right" | "subject-1" | "subject-2";
  ordinal?: number;
  subject?: 1 | 2;
  cells?: Array<string | null>;
} = {}) {
  return {
    id: input.id ?? "provider-candidate-1",
    variantOrdinal: input.variantOrdinal ?? 1,
    outputSlot: input.outputSlot ?? "combined",
    ordinal: input.ordinal ?? 1,
    ...(input.subject ? { subject: input.subject } : {}),
    grid: {
      encoding: "palette-code-v1",
      width: 2,
      height: 2,
      cells: input.cells ?? ["A01", null, "A01", null],
    },
  };
}

function portraitCandidates(cells?: Array<string | null>): unknown[] {
  return [
    responseCandidate({ id: "provider-candidate-1", variantOrdinal: 1, ordinal: 1, ...(cells ? { cells } : {}) }),
    responseCandidate({ id: "provider-candidate-2", variantOrdinal: 2, ordinal: 2, ...(cells ? { cells } : {}) }),
  ];
}

function jsonResponse(candidates: unknown[], init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ schemaVersion: "pindou-generation-v3", candidates }), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AppError && error.code === code;
}

describe("HTTP Generation Provider", () => {
  it("sends only the versioned generation contract and owns persisted candidate metadata", async () => {
    const apiKey = "provider-secret-must-not-leak";
    const sourceContents = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
    let observedUrl = "";
    let observedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      observedUrl = String(url);
      observedInit = init;
      return jsonResponse(portraitCandidates());
    }) as typeof fetch;
    const provider = new HttpGenerationProvider({
      endpoint: "https://generation.example.test/v1/generate",
      apiKey,
      timeoutMilliseconds: 1_000,
      fetchImpl,
    });

    const candidates = await provider.generate(providerInput({ sourceContents }));

    assert.equal(observedUrl, "https://generation.example.test/v1/generate");
    assert.equal(observedInit?.method, "POST");
    assert.equal(observedInit?.redirect, "error");
    assert.equal(observedInit?.cache, "no-store");
    const headers = new Headers(observedInit?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
    assert.equal(headers.get("idempotency-key"), JOB_ID);
    assert.equal(headers.get("content-type"), "application/json");

    const body = JSON.parse(String(observedInit?.body)) as Record<string, any>;
    assert.equal(body.schemaVersion, "pindou-generation-v3");
    assert.deepEqual(body.job, { id: JOB_ID, kind: "portrait", seed: "provider-test-seed" });
    assert.deepEqual(body.target, { width: 2, height: 2 });
    assert.deepEqual(body.availableColorCodes, ["A01"]);
    assert.deepEqual({
      brightness: body.options.brightness,
      contrast: body.options.contrast,
      saturation: body.options.saturation,
      dither: body.options.dither,
    }, { brightness: -10, contrast: 20, saturation: 30, dither: true });
    assert.deepEqual(body.palette, {
      id: palette.id,
      version: palette.version,
      colors: [{ code: "A01", hex: "#27313B" }, { code: "B02", hex: "#FFF4DF" }],
    });
    assert.equal(body.sourceImage.mediaType, "image/jpeg");
    assert.equal(body.sourceImage.encoding, "base64");
    assert.deepEqual(Buffer.from(body.sourceImage.data, "base64"), sourceContents);
    const serializedBody = JSON.stringify(body);
    for (const privateField of [
      "userId",
      "sourceAssetId",
      "leaseToken",
      "leaseExpiresAt",
      "cost",
      "unitPriceCents",
    ]) assert.equal(serializedBody.includes(privateField), false, privateField);

    assert.deepEqual(candidates.map((candidate) => ({
      id: candidate.id,
      variantOrdinal: candidate.variantOrdinal,
      outputSlot: candidate.outputSlot,
      ordinal: candidate.ordinal,
      jobId: candidate.jobId,
      createdAt: candidate.createdAt,
    })), [
      {
        id: "provider-candidate-1",
        variantOrdinal: 1,
        outputSlot: "combined",
        ordinal: 1,
        jobId: JOB_ID,
        createdAt: NOW,
      },
      {
        id: "provider-candidate-2",
        variantOrdinal: 2,
        outputSlot: "combined",
        ordinal: 2,
        jobId: JOB_ID,
        createdAt: NOW,
      },
    ]);
  });

  it("routes raster modes locally and uses HTTP for AI when configured", () => {
    assert.equal(createConfiguredGenerationProvider({ nodeEnv: "development" }).kind, "mode-router:raster-palette+deterministic+deterministic-compat");
    assert.equal(createConfiguredGenerationProvider({ nodeEnv: "test" }).kind, "mode-router:raster-palette+deterministic+deterministic-compat");
    assert.equal(createConfiguredGenerationProvider({
      nodeEnv: "development",
      generationProviderTimeoutMilliseconds: 120_000,
    }).kind, "mode-router:raster-palette+deterministic+deterministic-compat");
    assert.equal(createConfiguredGenerationProvider(loadConfig({ NODE_ENV: "development" })).kind, "mode-router:raster-palette+deterministic+deterministic-compat");
    assert.equal(createConfiguredGenerationProvider({
      nodeEnv: "development",
      generationProviderUrl: "https://generation.example.test/v1/generate",
      generationProviderApiKey: "local-integration-secret",
      generationProviderTimeoutMilliseconds: 2_000,
    }).kind, "mode-router:raster-palette+http+deterministic-compat");
    assert.equal(createConfiguredGenerationProvider({
      nodeEnv: "production",
      generationProviderUrl: "https://generation.example.test/v1/generate",
      generationProviderApiKey: "production-secret",
      generationProviderTimeoutMilliseconds: 2_000,
    }).kind, "mode-router:raster-palette+http");
    assert.equal(createConfiguredGenerationProvider({
      nodeEnv: "development",
      arkApiKey: "ark-secret",
      arkImageModel: "doubao-seedream-5-0-flash-260915",
      generationProviderTimeoutMilliseconds: 2_000,
    }).kind, "mode-router:raster-palette+ark-seedream+deterministic-compat");
    assert.throws(() => createConfiguredGenerationProvider({
      nodeEnv: "production",
      generationProviderUrl: "http://127.0.0.1:9999/generate",
      generationProviderApiKey: "production-secret",
      generationProviderTimeoutMilliseconds: 2_000,
    }), /HTTPS/);
    assert.throws(
      () => createConfiguredGenerationProvider({ nodeEnv: "development", generationProviderUrl: "https://generation.example.test" }),
      /配置不完整/,
    );
    assert.throws(() => createConfiguredGenerationProvider({
      nodeEnv: "development",
      generationProviderUrl: "",
      generationProviderApiKey: "",
      generationProviderTimeoutMilliseconds: 2_000,
    }));
    assert.throws(() => createConfiguredGenerationProvider({ nodeEnv: "production" }), /生产环境/);
  });

  it("omits an absent source image and preserves the no-inventory-constraint marker", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new HttpGenerationProvider({
      endpoint: "https://generation.example.test/v1/generate",
      apiKey: "optional-source-secret",
      timeoutMilliseconds: 1_000,
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(portraitCandidates(["B02", null, null, null]));
      }) as typeof fetch,
    });
    await provider.generate(providerInput({ availableColorCodes: null }));
    assert.equal(body?.availableColorCodes, null);
    assert.equal(Object.hasOwn(body ?? {}, "sourceImage"), false);
  });

  it("propagates the caller AbortSignal reason without misclassifying lease loss", async () => {
    let calls = 0;
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        const onAbort = (): void => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;
    const provider = new HttpGenerationProvider({
      endpoint: "https://generation.example.test/v1/generate",
      apiKey: "abort-test-secret",
      timeoutMilliseconds: 1_000,
      fetchImpl,
    });
    const controller = new AbortController();
    const reason = new Error("WORKER_LEASE_LOST");
    const pending = provider.generate(providerInput({ signal: controller.signal }));
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(calls, 1);

    const preAborted = new AbortController();
    preAborted.abort(reason);
    await assert.rejects(provider.generate(providerInput({ signal: preAborted.signal })), (error) => error === reason);
    assert.equal(calls, 1);
  });

  it("distinguishes timeout, retryable upstream failures, and terminal upstream rejection without leaking bodies", async () => {
    const waitingFetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
    const timeoutProvider = new HttpGenerationProvider({
      endpoint: "https://generation.example.test/v1/generate",
      apiKey: "timeout-secret",
      timeoutMilliseconds: 10,
      fetchImpl: waitingFetch,
    });
    await assert.rejects(timeoutProvider.generate(providerInput()), rejectsWithCode("GENERATION_PROVIDER_TIMEOUT"));

    const bodyTimeoutProvider = new HttpGenerationProvider({
      endpoint: "https://generation.example.test/v1/generate",
      apiKey: "body-timeout-secret",
      timeoutMilliseconds: 10,
      fetchImpl: (async (_url, init) => {
        const signal = init?.signal as AbortSignal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('{"schemaVersion":"pindou-generation-v3",'));
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        });
        return new Response(stream, { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await assert.rejects(bodyTimeoutProvider.generate(providerInput()), rejectsWithCode("GENERATION_PROVIDER_TIMEOUT"));

    for (const [status, code, retryable] of [
      [429, "GENERATION_PROVIDER_UNAVAILABLE", true],
      [425, "GENERATION_PROVIDER_UNAVAILABLE", true],
      [503, "GENERATION_PROVIDER_UNAVAILABLE", true],
      [401, "GENERATION_PROVIDER_REJECTED", false],
    ] as const) {
      const provider = new HttpGenerationProvider({
        endpoint: "https://generation.example.test/v1/generate",
        apiKey: "non-2xx-secret",
        timeoutMilliseconds: 1_000,
        fetchImpl: (async () => new Response("remote-secret-body", { status })) as typeof fetch,
      });
      await assert.rejects(provider.generate(providerInput()), (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.equal(`${error.message}${JSON.stringify(error.details)}`.includes("remote-secret-body"), false);
        assert.equal(`${error.message}${JSON.stringify(error.details)}`.includes("non-2xx-secret"), false);
        return true;
      });
    }
  });

  it("rejects malformed, oversized, reserved, palette-invalid, and layout-invalid responses", async () => {
    const cases: Array<{ response: () => Response; input?: GenerationProviderInput; maxResponseBytes?: number }> = [
      {
        response: () => new Response("{", { headers: { "content-type": "application/json" } }),
        input: providerInput(),
      },
      {
        response: () => new Response(JSON.stringify({
          schemaVersion: "pindou-generation-v3",
          candidates: [responseCandidate()],
        }), { headers: { "content-type": "text/plain" } }),
        input: providerInput(),
      },
      {
        response: () => new Response(Uint8Array.from([0xff, 0xfe, 0xfd]), {
          headers: { "content-type": "application/json" },
        }),
        input: providerInput(),
      },
      {
        response: () => new Response(JSON.stringify({ candidates: [responseCandidate()] }), {
          headers: { "content-type": "application/json" },
        }),
        input: providerInput(),
      },
      {
        response: () => new Response(JSON.stringify({
          schemaVersion: "pindou-generation-v2",
          candidates: portraitCandidates(),
        }), { headers: { "content-type": "application/json" } }),
        input: providerInput(),
      },
      { response: () => jsonResponse([null]), input: providerInput() },
      {
        response: () => jsonResponse([
          { ...responseCandidate(), acceptedAt: NOW },
          responseCandidate({ id: "provider-candidate-2", variantOrdinal: 2, ordinal: 2 }),
        ]),
        input: providerInput(),
      },
      {
        response: () => jsonResponse(portraitCandidates(["B02", null, null, null])),
        input: providerInput({ availableColorCodes: ["A01"] }),
      },
      {
        response: () => jsonResponse([responseCandidate()]),
        input: providerInput({ kind: "couple", solo: true }),
      },
      {
        response: () => jsonResponse([responseCandidate({ subject: 1 })]),
        input: providerInput({ kind: "couple" }),
      },
      {
        response: () => new Response("{}", {
          headers: { "content-length": "1000", "content-type": "application/json" },
        }),
        input: providerInput(),
        maxResponseBytes: 64,
      },
    ];
    for (const entry of cases) {
      const provider = new HttpGenerationProvider({
        endpoint: "https://generation.example.test/v1/generate",
        apiKey: "invalid-response-secret",
        timeoutMilliseconds: 1_000,
        maxResponseBytes: entry.maxResponseBytes ?? 4_096,
        fetchImpl: (async () => entry.response()) as typeof fetch,
      });
      await assert.rejects(
        provider.generate(entry.input ?? providerInput()),
        rejectsWithCode("GENERATION_PROVIDER_RESPONSE_INVALID"),
      );
    }
  });

  it("accepts the final couple-solo subject contract", async () => {
    const provider = new HttpGenerationProvider({
      endpoint: "https://generation.example.test/v1/generate",
      apiKey: "solo-contract-secret",
      timeoutMilliseconds: 1_000,
      fetchImpl: (async () => jsonResponse([
        responseCandidate({
          id: "solo-variant-1-subject-1",
          variantOrdinal: 1,
          outputSlot: "subject-1",
          ordinal: 1,
          subject: 1,
        }),
        responseCandidate({
          id: "solo-variant-1-subject-2",
          variantOrdinal: 1,
          outputSlot: "subject-2",
          ordinal: 2,
          subject: 2,
        }),
        responseCandidate({
          id: "solo-variant-2-subject-1",
          variantOrdinal: 2,
          outputSlot: "subject-1",
          ordinal: 3,
        }),
        responseCandidate({
          id: "solo-variant-2-subject-2",
          variantOrdinal: 2,
          outputSlot: "subject-2",
          ordinal: 4,
        }),
      ])) as typeof fetch,
    });
    const result = await provider.generate(providerInput({ kind: "couple", solo: true }));
    assert.deepEqual(result.map((candidate) => [
      candidate.variantOrdinal,
      candidate.outputSlot,
      candidate.subject,
    ]), [
      [1, "subject-1", 1],
      [1, "subject-2", 2],
      [2, "subject-1", 1],
      [2, "subject-2", 2],
    ]);
    assert.ok(result.every((candidate) => candidate.acceptedProjectId === undefined && candidate.acceptedAt === undefined));
  });
});
