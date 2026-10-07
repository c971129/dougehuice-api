import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import sharp from "sharp";

import { copyDefaultGenerationOptions } from "../src/domain/generation-options.js";
import type { GenerationJob, Palette } from "../src/domain/models.js";
import { BUILTIN_PALETTES } from "../src/domain/palettes.js";
import { AppError } from "../src/errors.js";
import { createConfiguredGenerationProvider } from "../src/generation/configured-provider.js";
import { ModeRoutingGenerationProvider } from "../src/generation/mode-routing-provider.js";
import type { GenerationProvider, GenerationProviderInput } from "../src/generation/provider.js";
import {
  MAX_RASTER_SOURCE_BYTES,
  RasterPaletteGenerationProvider,
} from "../src/generation/raster-provider.js";
import { processNextGeneration } from "../src/generation/worker.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import type { StorageProvider } from "../src/storage/storage-provider.js";

const NOW = "2026-10-04T10:00:00.000Z";
const JOB_ID = "00000000-0000-4000-8000-000000009001";

const palette: Palette = {
  id: "raster-test-palette",
  name: "图片转换测试色卡",
  brand: "测试",
  beadSizeMm: 5,
  verified: false,
  version: 1,
  colors: [
    { code: "BLACK", name: "黑", hex: "#000000", unitPriceCents: 1, available: true },
    { code: "WHITE", name: "白", hex: "#FFFFFF", unitPriceCents: 1, available: true },
    { code: "GRAY", name: "灰", hex: "#808080", unitPriceCents: 1, available: true },
    { code: "RED", name: "红", hex: "#FF0000", unitPriceCents: 1, available: true },
    { code: "GREEN", name: "绿", hex: "#00FF00", unitPriceCents: 1, available: true },
    { code: "BLUE", name: "蓝", hex: "#0000FF", unitPriceCents: 1, available: true },
  ],
};

function job(kind: GenerationJob["kind"], width: number, height: number): GenerationJob {
  const options = copyDefaultGenerationOptions();
  options.crop.ratio = "original";
  options.maxColors = 6;
  return {
    id: JOB_ID,
    userId: "private-user",
    parentJobId: null,
    kind,
    status: "generating",
    paletteId: palette.id,
    sourceAssetId: "private-source",
    options,
    cost: 0,
    seed: "raster-test-seed",
    width,
    height,
    progress: 45,
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: NOW,
    leaseToken: "lease",
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

function input(
  contents: Buffer | null,
  kind: GenerationJob["kind"] = "normal",
  width = 1,
  height = 1,
): GenerationProviderInput {
  return {
    job: job(kind, width, height),
    palette,
    sourceContents: contents,
    availableColorCodes: null,
    signal: new AbortController().signal,
    now: NOW,
  };
}

async function rgbaPng(width: number, height: number, pixels: number[]): Promise<Buffer> {
  assert.equal(pixels.length, width * height * 4);
  return sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function cells(result: Awaited<ReturnType<RasterPaletteGenerationProvider["generate"]>>): Array<string | null> {
  assert.equal(result.length, 1);
  assert.equal(result[0]?.grid.encoding, "palette-code-v1");
  return result[0]!.grid.cells;
}

describe("local raster/palette generation", () => {
  const provider = new RasterPaletteGenerationProvider();

  it("is image-content-sensitive and selects colors from content rather than the first palette entries", async () => {
    const red = await rgbaPng(1, 1, [255, 0, 0, 255]);
    const blue = await rgbaPng(1, 1, [0, 0, 255, 255]);
    const redInput = input(red);
    const blueInput = input(blue);
    redInput.job.options.maxColors = 1;
    blueInput.job.options.maxColors = 1;

    assert.deepEqual(cells(await provider.generate(redInput)), ["RED"]);
    assert.deepEqual(cells(await provider.generate(blueInput)), ["BLUE"]);
  });

  it("evaluates the complete CIEDE2000 palette deterministically at the 64x64 limit", { timeout: 10_000 }, async () => {
    const mard291 = BUILTIN_PALETTES.find((candidate) => candidate.id === "mard-291-v1");
    assert.ok(mard291);
    const auditPixel = await rgbaPng(1, 1, [0, 0, 92, 255]);
    const auditInput = input(auditPixel, "pixel", 1, 1);
    auditInput.palette = mard291;
    auditInput.job.options.removeBackground = false;
    auditInput.job.options.maxColors = 32;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(cells(await provider.generate(auditInput)), ["D15"]);
    }

    const maximumPixels = Array.from({ length: 64 * 64 }, () => [0, 0, 92, 255]).flat();
    const maximumInput = input(await rgbaPng(64, 64, maximumPixels), "pixel", 64, 64);
    maximumInput.palette = mard291;
    maximumInput.job.options.removeBackground = false;
    maximumInput.job.options.maxColors = 32;
    const maximumCells = cells(await provider.generate(maximumInput));
    assert.equal(maximumCells.length, 64 * 64);
    assert.equal(maximumCells.every((code) => code === "D15"), true);
  });

  it("preserves transparent source pixels as null cells", async () => {
    const image = await rgbaPng(2, 1, [
      255, 0, 0, 255,
      0, 0, 255, 0,
    ]);
    assert.deepEqual(cells(await provider.generate(input(image, "pixel", 2, 1))), ["RED", null]);

    const adjusted = input(image, "pixel", 2, 1);
    adjusted.job.options.brightness = 60;
    adjusted.job.options.contrast = 40;
    adjusted.job.options.saturation = -50;
    adjusted.job.options.dither = true;
    assert.equal(cells(await provider.generate(adjusted))[1], null);
  });

  it("keeps neutral preprocessing byte-compatible and maps tone controls deterministically", async () => {
    const neutralImage = await rgbaPng(3, 1, [
      255, 0, 0, 255,
      100, 100, 100, 255,
      0, 0, 255, 255,
    ]);
    const neutral = input(neutralImage, "pixel", 3, 1);
    neutral.job.options.removeBackground = false;
    neutral.job.options.brightness = 0;
    neutral.job.options.contrast = 0;
    neutral.job.options.saturation = 0;
    neutral.job.options.dither = false;
    assert.deepEqual(cells(await provider.generate(neutral)), ["RED", "GRAY", "BLUE"]);

    const gray = await rgbaPng(1, 1, [100, 100, 100, 255]);
    const darker = input(gray, "pixel", 1, 1);
    darker.job.options.removeBackground = false;
    darker.job.options.brightness = -50;
    assert.deepEqual(cells(await provider.generate(darker)), ["BLACK"]);

    const brighter = input(gray, "pixel", 1, 1);
    brighter.job.options.removeBackground = false;
    brighter.job.options.brightness = 100;
    assert.deepEqual(cells(await provider.generate(brighter)), ["WHITE"]);

    const contrasted = input(await rgbaPng(1, 1, [96, 96, 96, 255]), "pixel", 1, 1);
    contrasted.job.options.removeBackground = false;
    contrasted.job.options.contrast = 100;
    assert.deepEqual(cells(await provider.generate(contrasted)), ["BLACK"]);

    const desaturated = input(await rgbaPng(1, 1, [255, 0, 0, 255]), "pixel", 1, 1);
    desaturated.job.options.removeBackground = false;
    desaturated.job.options.saturation = -100;
    assert.deepEqual(cells(await provider.generate(desaturated)), ["GRAY"]);
  });

  it("applies deterministic Floyd-Steinberg only inside the selected palette subset", async () => {
    const values = [0, 36, 72, 109, 145, 182, 218, 255];
    const gradient = await rgbaPng(
      8,
      2,
      [...values, ...values].flatMap((value) => [value, value, value, 255]),
    );
    const blackAndWhite: Palette = { ...palette, colors: palette.colors.slice(0, 2) };

    const withoutDither = input(gradient, "pixel", 8, 2);
    withoutDither.palette = blackAndWhite;
    withoutDither.job.options.removeBackground = false;
    withoutDither.job.options.maxColors = 2;
    assert.deepEqual(cells(await provider.generate(withoutDither)), [
      "BLACK", "BLACK", "BLACK", "BLACK", "WHITE", "WHITE", "WHITE", "WHITE",
      "BLACK", "BLACK", "BLACK", "BLACK", "WHITE", "WHITE", "WHITE", "WHITE",
    ]);

    const withDither = input(gradient, "pixel", 8, 2);
    withDither.palette = blackAndWhite;
    withDither.job.options.removeBackground = false;
    withDither.job.options.maxColors = 2;
    withDither.job.options.dither = true;
    const expected = [
      "BLACK", "BLACK", "BLACK", "WHITE", "BLACK", "WHITE", "WHITE", "WHITE",
      "BLACK", "BLACK", "BLACK", "BLACK", "BLACK", "WHITE", "BLACK", "WHITE",
    ];
    assert.deepEqual(cells(await provider.generate(withDither)), expected);
    assert.deepEqual(cells(await provider.generate(withDither)), expected);

    const hole = await rgbaPng(3, 2, [
      180, 180, 180, 255,
      255, 255, 255, 0,
      180, 180, 180, 255,
      180, 180, 180, 255,
      255, 255, 255, 0,
      180, 180, 180, 255,
    ]);
    const withTransparentHole = input(hole, "pixel", 3, 2);
    withTransparentHole.palette = blackAndWhite;
    withTransparentHole.job.options.removeBackground = false;
    withTransparentHole.job.options.maxColors = 2;
    withTransparentHole.job.options.dither = true;
    assert.deepEqual(cells(await provider.generate(withTransparentHole)), [
      "WHITE", null, "WHITE",
      "WHITE", null, "WHITE",
    ]);

    const perRowAbort = input(gradient, "pixel", 8, 2);
    perRowAbort.palette = blackAndWhite;
    perRowAbort.job.options.removeBackground = false;
    perRowAbort.job.options.maxColors = 2;
    perRowAbort.job.options.dither = true;
    const abortReason = new Error("abort during second dither row");
    let abortChecks = 0;
    Object.defineProperty(perRowAbort.signal, "throwIfAborted", {
      value: () => {
        abortChecks += 1;
        if (abortChecks === 4) throw abortReason;
      },
    });
    await assert.rejects(provider.generate(perRowAbort), (error: unknown) => error === abortReason);
    assert.equal(abortChecks, 4);
  });

  it("removes only a dominant edge-connected background and honors the opt-out", async () => {
    const pixels = Array.from({ length: 5 * 5 }, (_, index) => {
      const x = index % 5;
      const y = Math.floor(index / 5);
      return x === 2 && y === 2
        ? [255, 0, 0, 255]
        : [255, 255, 255, 255];
    }).flat();
    const image = await rgbaPng(5, 5, pixels);
    const removed = input(image, "pixel", 5, 5);
    removed.job.options.removeBackground = true;
    const removedCells = cells(await provider.generate(removed));
    assert.equal(removedCells.filter((cell) => cell === null).length, 24);
    assert.equal(removedCells[12], "RED");

    const darkenedAfterRemoval = input(image, "pixel", 5, 5);
    darkenedAfterRemoval.job.options.removeBackground = true;
    darkenedAfterRemoval.job.options.brightness = -100;
    const darkenedCells = cells(await provider.generate(darkenedAfterRemoval));
    assert.equal(darkenedCells.filter((cell) => cell === null).length, 24);
    assert.equal(darkenedCells[12], "BLACK");

    const retained = input(image, "pixel", 5, 5);
    retained.job.options.removeBackground = false;
    const retainedCells = cells(await provider.generate(retained));
    assert.equal(retainedCells.filter((cell) => cell === null).length, 0);
    assert.equal(retainedCells.filter((cell) => cell === "WHITE").length, 24);
    assert.equal(retainedCells[12], "RED");
  });

  it("keeps solid images and mixed-edge artwork when background evidence is ambiguous", async () => {
    const solid = await rgbaPng(4, 4, Array.from({ length: 16 }, () => [255, 0, 0, 255]).flat());
    assert.deepEqual(
      cells(await provider.generate(input(solid, "pixel", 4, 4))),
      Array.from({ length: 16 }, () => "RED"),
    );

    const mixedPixels = Array.from({ length: 4 * 4 }, (_, index) => {
      const x = index % 4;
      const y = Math.floor(index / 4);
      if (x === 0 || y === 0) return [255, 0, 0, 255];
      if (x === 3 || y === 3) return [0, 0, 255, 255];
      return [0, 255, 0, 255];
    }).flat();
    const mixed = await rgbaPng(4, 4, mixedPixels);
    assert.equal(
      cells(await provider.generate(input(mixed, "pixel", 4, 4))).filter((cell) => cell === null).length,
      0,
    );
  });

  it("honors inventory and maxColors constraints before final remapping", async () => {
    const image = await rgbaPng(3, 1, [
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
    ]);
    const constrained = input(image, "pixel", 3, 1);
    constrained.availableColorCodes = ["WHITE", "GREEN", "BLUE"];
    constrained.job.options.inventoryOnly = true;
    constrained.job.options.maxColors = 2;
    constrained.job.options.dither = true;

    const result = cells(await provider.generate(constrained));
    const used = new Set(result.filter((code): code is string => code !== null));
    assert.ok(used.size <= 2);
    assert.deepEqual([...used].filter((code) => !constrained.availableColorCodes!.includes(code)), []);
    assert.equal(used.has("RED"), false);
    assert.equal(used.has("BLACK"), false);
    assert.deepEqual(cells(await provider.generate(constrained)), result);
  });

  it("applies crop offsets and horizontal flips deterministically", async () => {
    const wide = await rgbaPng(4, 2, [
      255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
      255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
    ]);
    const cropped = input(wide, "pixel", 2, 2);
    cropped.job.options.crop.ratio = "1:1";
    cropped.job.options.crop.offsetX = -1;
    assert.deepEqual(cells(await provider.generate(cropped)), ["RED", "RED", "RED", "RED"]);

    const strip = await rgbaPng(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]);
    const flipped = input(strip, "pixel", 2, 1);
    flipped.job.options.crop.flipX = true;
    assert.deepEqual(cells(await provider.generate(flipped)), ["BLUE", "RED"]);
  });

  it("applies rotation and scale before sampling the target grid", async () => {
    const strip = await rgbaPng(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]);
    const rotated = input(strip, "pixel", 1, 2);
    rotated.job.options.crop.rotation = 90;
    const rotatedCells = cells(await provider.generate(rotated));
    assert.deepEqual([...rotatedCells].sort(), ["BLUE", "RED"]);

    const center = await rgbaPng(4, 4, [
      0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255,
      0, 0, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255,
      0, 0, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255,
      0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255,
    ]);
    const zoomed = input(center, "pixel", 2, 2);
    zoomed.job.options.crop.ratio = "1:1";
    zoomed.job.options.crop.scale = 2;
    assert.deepEqual(cells(await provider.generate(zoomed)), ["RED", "RED", "RED", "RED"]);
  });

  it("uses smooth downsampling for normal images and nearest-neighbor for pixel images", async () => {
    const checker = await rgbaPng(2, 2, [
      0, 0, 0, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 0, 0, 0, 255,
    ]);
    const normal = cells(await provider.generate(input(checker, "normal", 1, 1)));
    const pixel = cells(await provider.generate(input(checker, "pixel", 1, 1)));
    assert.deepEqual(normal, ["GRAY"]);
    assert.notDeepEqual(pixel, normal);
    assert.ok(pixel[0] === "BLACK" || pixel[0] === "WHITE");
  });

  it("fails closed on corrupt, oversized, and aborted work with stable error semantics", async () => {
    await assert.rejects(
      provider.generate(input(Buffer.from("not-an-image"))),
      (error: unknown) => error instanceof AppError && error.code === "GENERATION_SOURCE_DECODE_FAILED",
    );
    await assert.rejects(
      provider.generate(input(Buffer.alloc(MAX_RASTER_SOURCE_BYTES + 1))),
      (error: unknown) => error instanceof AppError && error.code === "GENERATION_SOURCE_TOO_LARGE",
    );

    const controller = new AbortController();
    const reason = new Error("lease lost during raster test");
    controller.abort(reason);
    const aborted = input(await rgbaPng(1, 1, [1, 2, 3, 255]));
    aborted.signal = controller.signal;
    await assert.rejects(provider.generate(aborted), (error: unknown) => error === reason);
  });
});

describe("mode routing generation provider", () => {
  it("routes sourced normal/pixel work locally, portrait/couple work to AI, and production-like missing sources nowhere", async () => {
    const calls: string[] = [];
    const raster: GenerationProvider = {
      kind: "raster-spy",
      generate: async () => {
        calls.push("raster");
        return [];
      },
    };
    const ai: GenerationProvider = {
      kind: "http-spy",
      generate: async () => {
        calls.push("ai");
        return [];
      },
    };
    const router = new ModeRoutingGenerationProvider({ raster, ai });
    const source = Buffer.from("source-present");

    await router.generate(input(source, "normal"));
    await router.generate(input(source, "pixel"));
    await router.generate(input(source, "portrait"));
    await router.generate(input(source, "couple"));
    assert.deepEqual(calls, ["raster", "raster", "ai", "ai"]);
    await assert.rejects(
      router.generate(input(null, "normal")),
      (error: unknown) => error instanceof AppError && error.code === "GENERATION_SOURCE_REQUIRED",
    );
    assert.deepEqual(calls, ["raster", "raster", "ai", "ai"]);
  });

  it("uses a development compatibility fallback only when source bytes are absent", async () => {
    const calls: string[] = [];
    const raster: GenerationProvider = { kind: "raster", generate: async () => { calls.push("raster"); return []; } };
    const ai: GenerationProvider = { kind: "ai", generate: async () => { calls.push("ai"); return []; } };
    const fallback: GenerationProvider = {
      kind: "deterministic",
      generate: async () => { calls.push("fallback"); return []; },
    };
    const router = new ModeRoutingGenerationProvider({ raster, ai, missingRasterSourceFallback: fallback });
    await router.generate(input(null, "normal"));
    await router.generate(input(Buffer.from("present"), "normal"));
    assert.deepEqual(calls, ["fallback", "raster"]);
  });
});

describe("raster worker failure contract", () => {
  it("persists a stable, terminal decode error instead of retrying corrupt source bytes", async () => {
    const store = new MemoryStore();
    const session = await store.createDevSession({
      displayName: "栅格工作器测试",
      tokenHash: "9".repeat(64),
      expiresAt: "2027-10-04T00:00:00.000Z",
      startingCredits: 1,
    });
    const corrupt = Buffer.from("stored-but-corrupt-image");
    const assetId = "00000000-0000-4000-8000-000000009101";
    await store.createAsset({
      id: assetId,
      userId: session.user.id,
      purpose: "ai-source",
      consentVersion: "privacy-v1",
      sha256: createHash("sha256").update(corrupt).digest("hex"),
      mimeType: "image/png",
      sizeBytes: corrupt.length,
      width: 1,
      height: 1,
      storageKey: "corrupt-raster-object",
      expiresAt: "2026-10-05T10:00:00.000Z",
      createdAt: "2026-10-04T09:00:00.000Z",
    });
    await store.markAssetReady(session.user.id, assetId, "2026-10-04T09:00:01.000Z");
    const options = copyDefaultGenerationOptions();
    const created = await store.createGenerationJob({
      jobId: "00000000-0000-4000-8000-000000009102",
      userId: session.user.id,
      kind: "normal",
      paletteId: "mard-48-v1",
      sourceAssetId: assetId,
      options,
      cost: 0,
      seed: "corrupt-raster-worker",
      width: 8,
      height: 8,
      now: NOW,
    });
    const storage: StorageProvider = {
      ready: async () => undefined,
      put: async () => ({ storageKey: "unused" }),
      get: async () => corrupt,
      delete: async () => undefined,
    };

    const result = await processNextGeneration({
      store,
      storage,
      provider: createConfiguredGenerationProvider({ nodeEnv: "development" }),
      now: new Date(NOW),
    });
    assert.equal(result?.id, created.id);
    assert.equal(result?.status, "failed");
    assert.equal(result?.attemptCount, 1);
    assert.equal(result?.errorCode, "GENERATION_SOURCE_DECODE_FAILED");
    assert.equal(result?.errorMessage, "转换原图无法解码或已损坏");
  });
});
