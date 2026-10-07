import sharp, { type Sharp } from "sharp";

import { MAX_GRID_CELLS, MAX_GRID_SIDE } from "../domain/grid.js";
import type { GenerationCandidate, PaletteColor } from "../domain/models.js";
import { AppError } from "../errors.js";
import { deltaE2000, rgbToLab, type Lab } from "./color-science.js";
import type { GenerationProvider, GenerationProviderInput } from "./provider.js";

/**
 * The upload path already sanitizes images, but the worker is a separate trust
 * boundary: stored bytes can be old, corrupted, or written by another service.
 */
export const MAX_RASTER_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_RASTER_DECODE_PIXELS = 40_000_000;
const TRANSPARENT_ALPHA_THRESHOLD = 8;
const BACKGROUND_BUCKET_SIZE = 32;
const BACKGROUND_DISTANCE_THRESHOLD = 46;
const BACKGROUND_EDGE_DOMINANCE = 0.68;
const SUPPORTED_FORMATS = new Set(["jpeg", "png", "webp"]);

interface RgbaImage {
  data: Buffer;
  width: number;
  height: number;
}

interface PaletteSample {
  code: string;
  linear: readonly [number, number, number];
  lab: Lab;
}

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("GENERATION_ABORTED");
}

async function runSharp<T>(pipeline: Sharp, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  const abort = (): void => {
    pipeline.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await operation();
    if (signal.aborted) throw abortReason(signal);
    return result;
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function validateTarget(input: GenerationProviderInput): void {
  const { width, height } = input.job;
  if (!Number.isInteger(width)
    || !Number.isInteger(height)
    || width < 1
    || height < 1
    || width > MAX_GRID_SIDE
    || height > MAX_GRID_SIDE
    || width * height > MAX_GRID_CELLS) {
    throw new AppError(400, "GENERATION_TARGET_SIZE_INVALID", "目标网格尺寸无效");
  }
}

function parseHex(color: PaletteColor): PaletteSample {
  const match = /^#([0-9a-f]{6})$/i.exec(color.hex);
  if (!match?.[1]) {
    throw new AppError(500, "GENERATION_PALETTE_INVALID", `色号 ${color.code} 的标准颜色无效`);
  }
  const value = Number.parseInt(match[1], 16);
  const srgb = [value >> 16, (value >> 8) & 0xff, value & 0xff] as const;
  const linear = srgb.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    }) as unknown as readonly [number, number, number];
  return { code: color.code, linear, lab: rgbToLab(...srgb) };
}

function allowedPalette(input: GenerationProviderInput): PaletteSample[] {
  const available = input.availableColorCodes ? new Set(input.availableColorCodes) : null;
  const colors = input.palette.colors
    .filter((color) => color.available && (!available || available.has(color.code)))
    .map(parseHex);
  if (colors.length === 0) {
    throw new AppError(409, "GENERATION_INVENTORY_EMPTY", "豆仓中没有可用于当前色卡的颜色");
  }
  return colors;
}

function linearRgb(red: number, green: number, blue: number): readonly [number, number, number] {
  const convert = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return [convert(red), convert(green), convert(blue)];
}

function pixelOffset(width: number, x: number, y: number): number {
  return (y * width + x) * 4;
}

function colorDistanceSquared(data: Buffer, offset: number, color: RgbColor): number {
  const red = (data[offset] ?? 0) - color.red;
  const green = (data[offset + 1] ?? 0) - color.green;
  const blue = (data[offset + 2] ?? 0) - color.blue;
  return red * red + green * green + blue * blue;
}

/**
 * Conservative grid-level background removal for ordinary image conversion.
 * It runs after resize (therefore at most 200x200), requires one dominant
 * opaque edge color and a genuinely different foreground, then clears only
 * the matching region connected to an edge. Complex/mixed edges and solid
 * images are deliberately left untouched instead of risking data loss.
 */
function removeUniformEdgeBackground(image: RgbaImage): RgbaImage {
  if (image.width < 3 || image.height < 3) return image;

  const edgeIndices: number[] = [];
  for (let x = 0; x < image.width; x += 1) {
    edgeIndices.push(pixelOffset(image.width, x, 0));
    edgeIndices.push(pixelOffset(image.width, x, image.height - 1));
  }
  for (let y = 1; y < image.height - 1; y += 1) {
    edgeIndices.push(pixelOffset(image.width, 0, y));
    edgeIndices.push(pixelOffset(image.width, image.width - 1, y));
  }

  const buckets = new Map<string, { count: number; red: number; green: number; blue: number }>();
  let opaqueEdgeCount = 0;
  for (const offset of edgeIndices) {
    if ((image.data[offset + 3] ?? 0) < TRANSPARENT_ALPHA_THRESHOLD) continue;
    opaqueEdgeCount += 1;
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    const key = `${Math.floor(red / BACKGROUND_BUCKET_SIZE)}:${Math.floor(green / BACKGROUND_BUCKET_SIZE)}:${Math.floor(blue / BACKGROUND_BUCKET_SIZE)}`;
    const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    buckets.set(key, bucket);
  }
  if (opaqueEdgeCount < 8 || buckets.size === 0) return image;

  const dominant = [...buckets.values()].sort((left, right) => right.count - left.count)[0];
  if (!dominant || dominant.count / opaqueEdgeCount < BACKGROUND_EDGE_DOMINANCE) return image;
  const background: RgbColor = {
    red: dominant.red / dominant.count,
    green: dominant.green / dominant.count,
    blue: dominant.blue / dominant.count,
  };
  const thresholdSquared = BACKGROUND_DISTANCE_THRESHOLD ** 2;
  const matches = (offset: number): boolean => (image.data[offset + 3] ?? 0) >= TRANSPARENT_ALPHA_THRESHOLD
    && colorDistanceSquared(image.data, offset, background) <= thresholdSquared;

  let opaqueCount = 0;
  let distinctForegroundCount = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if ((image.data[offset + 3] ?? 0) < TRANSPARENT_ALPHA_THRESHOLD) continue;
    opaqueCount += 1;
    if (!matches(offset)) distinctForegroundCount += 1;
  }
  if (distinctForegroundCount === 0) return image;

  const cellCount = image.width * image.height;
  const visited = new Uint8Array(cellCount);
  const queue = new Int32Array(cellCount);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number): void => {
    if (visited[index] || !matches(index * 4)) return;
    visited[index] = 1;
    queue[tail] = index;
    tail += 1;
  };
  for (let x = 0; x < image.width; x += 1) {
    enqueue(x);
    enqueue((image.height - 1) * image.width + x);
  }
  for (let y = 1; y < image.height - 1; y += 1) {
    enqueue(y * image.width);
    enqueue(y * image.width + image.width - 1);
  }
  while (head < tail) {
    const index = queue[head];
    head += 1;
    if (index === undefined) break;
    const x = index % image.width;
    const y = Math.floor(index / image.width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < image.width) enqueue(index + 1);
    if (y > 0) enqueue(index - image.width);
    if (y + 1 < image.height) enqueue(index + image.width);
  }
  if (tail === 0 || tail >= opaqueCount) return image;

  const data = Buffer.from(image.data);
  for (let index = 0; index < visited.length; index += 1) {
    if (visited[index]) data[index * 4 + 3] = 0;
  }
  return { ...image, data };
}

function nearestPaletteIndex(pixel: readonly [number, number, number], palette: readonly PaletteSample[]): number {
  const toSrgb = (channel: number): number => 255 * (channel <= .0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - .055);
  const lab = rgbToLab(toSrgb(pixel[0]), toSrgb(pixel[1]), toSrgb(pixel[2]));
  let bestIndex = 0;
  let bestCode: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < palette.length; index += 1) {
    const candidate = palette[index];
    if (!candidate) continue;
    const distance = deltaE2000(lab, candidate.lab);
    if (distance < bestDistance
      || (distance === bestDistance && (bestCode === null || candidate.code < bestCode))) {
      bestDistance = distance;
      bestCode = candidate.code;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/**
 * Select colors by how often each allowed palette entry is the nearest match
 * to the actual resized image. This keeps the subset content-sensitive instead
 * of taking the first N entries from a brand palette. Final pixels are then
 * remapped against that selected subset.
 */
function mapToPalette(
  image: RgbaImage,
  palette: PaletteSample[],
  maximumColors: number,
  dither: boolean,
  signal: AbortSignal,
): Array<string | null> {
  const pixels: Array<readonly [number, number, number] | null> = [];
  const assignments = new Array<number>(palette.length).fill(0);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = image.data[offset + 3] ?? 0;
    if (alpha < TRANSPARENT_ALPHA_THRESHOLD) {
      pixels.push(null);
      continue;
    }
    const pixel = linearRgb(
      image.data[offset] ?? 0,
      image.data[offset + 1] ?? 0,
      image.data[offset + 2] ?? 0,
    );
    pixels.push(pixel);
    const nearest = nearestPaletteIndex(pixel, palette);
    assignments[nearest] = (assignments[nearest] ?? 0) + 1;
  }

  const selected = palette
    .map((color, index) => ({ color, count: assignments[index] ?? 0, index }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count
      || left.color.code.localeCompare(right.color.code)
      || left.index - right.index)
    .slice(0, Math.min(maximumColors, palette.length))
    .map((entry) => entry.color);

  // A fully transparent image is a valid empty-bead grid.
  if (selected.length === 0) return pixels.map(() => null);
  if (!dither) {
    return pixels.map((pixel) => pixel === null ? null : selected[nearestPaletteIndex(pixel, selected)]!.code);
  }

  const cells: Array<string | null> = [];
  const work = new Float64Array(pixels.length * 3);
  for (let index = 0; index < pixels.length; index += 1) {
    const pixel = pixels[index];
    if (!pixel) continue;
    work[index * 3] = pixel[0];
    work[index * 3 + 1] = pixel[1];
    work[index * 3 + 2] = pixel[2];
  }
  const diffuse = (
    x: number,
    y: number,
    weight: number,
    error: readonly [number, number, number],
  ): void => {
    if (x < 0 || x >= image.width || y < 0 || y >= image.height) return;
    const index = y * image.width + x;
    // Transparent cells are holes in the physical pattern. They neither
    // receive nor forward quantization error and weights are not renormalized.
    if (pixels[index] === null) return;
    const offset = index * 3;
    work[offset] = clamp((work[offset] ?? 0) + error[0] * weight, 0, 1);
    work[offset + 1] = clamp((work[offset + 1] ?? 0) + error[1] * weight, 0, 1);
    work[offset + 2] = clamp((work[offset + 2] ?? 0) + error[2] * weight, 0, 1);
  };

  for (let y = 0; y < image.height; y += 1) {
    signal.throwIfAborted();
    for (let x = 0; x < image.width; x += 1) {
      const index = y * image.width + x;
      const pixel = pixels[index];
      if (pixel === null || pixel === undefined) {
        cells.push(null);
        continue;
      }
      const errorOffset = index * 3;
      const adjusted = [
        work[errorOffset] ?? 0,
        work[errorOffset + 1] ?? 0,
        work[errorOffset + 2] ?? 0,
      ] as const;
      const nearest = selected[nearestPaletteIndex(adjusted, selected)]!;
      cells.push(nearest.code);
      const quantizationError = [
        adjusted[0] - nearest.linear[0],
        adjusted[1] - nearest.linear[1],
        adjusted[2] - nearest.linear[2],
      ] as const;

      diffuse(x + 1, y, 7 / 16, quantizationError);
      diffuse(x - 1, y + 1, 3 / 16, quantizationError);
      diffuse(x, y + 1, 5 / 16, quantizationError);
      diffuse(x + 1, y + 1, 1 / 16, quantizationError);
    }
  }
  signal.throwIfAborted();
  return cells;
}

function cropAspect(input: GenerationProviderInput, source: RgbaImage): number {
  switch (input.job.options.crop.ratio) {
    case "free":
      return input.job.options.crop.freeRatio;
    case "original":
      return source.width / source.height;
    case "1:1":
      return 1;
    case "4:3":
      return 4 / 3;
    case "3:4":
      return 3 / 4;
  }
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function cropRectangle(input: GenerationProviderInput, source: RgbaImage): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const aspect = cropAspect(input, source);
  const scale = input.job.options.crop.scale;
  if (!Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(scale) || scale <= 0) {
    throw new AppError(400, "GENERATION_CROP_INVALID", "裁剪比例或缩放参数无效");
  }

  let fittedWidth = source.width;
  let fittedHeight = fittedWidth / aspect;
  if (fittedHeight > source.height) {
    fittedHeight = source.height;
    fittedWidth = fittedHeight * aspect;
  }
  const width = Math.max(1, Math.round(fittedWidth / scale));
  const height = Math.max(1, Math.round(fittedHeight / scale));
  const xMin = Math.min(width / 2, source.width - width / 2);
  const xMax = Math.max(width / 2, source.width - width / 2);
  const yMin = Math.min(height / 2, source.height - height / 2);
  const yMax = Math.max(height / 2, source.height - height / 2);
  const centerX = clamp(source.width / 2 + input.job.options.crop.offsetX, xMin, xMax);
  const centerY = clamp(source.height / 2 + input.job.options.crop.offsetY, yMin, yMax);
  return {
    left: Math.round(centerX - width / 2),
    top: Math.round(centerY - height / 2),
    width,
    height,
  };
}

async function decodeSource(input: GenerationProviderInput): Promise<RgbaImage> {
  const contents = input.sourceContents;
  if (!contents) {
    throw new AppError(400, "GENERATION_SOURCE_REQUIRED", "普通图片与像素图转换需要原始图片");
  }
  if (contents.length === 0 || contents.length > MAX_RASTER_SOURCE_BYTES) {
    throw new AppError(413, "GENERATION_SOURCE_TOO_LARGE", `转换原图不能超过 ${MAX_RASTER_SOURCE_BYTES} 字节`);
  }

  try {
    const inspector = sharp(contents, {
      failOn: "error",
      limitInputPixels: MAX_RASTER_DECODE_PIXELS,
      animated: false,
      sequentialRead: true,
    });
    const metadata = await runSharp(inspector, input.signal, () => inspector.metadata());
    if (!SUPPORTED_FORMATS.has(metadata.format ?? "")) {
      throw new AppError(415, "GENERATION_SOURCE_FORMAT_UNSUPPORTED", "转换仅支持 JPEG、PNG 和 WebP 图片");
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new AppError(415, "GENERATION_SOURCE_ANIMATED_UNSUPPORTED", "不支持动态图片转换");
    }
    if (!metadata.width
      || !metadata.height
      || metadata.width * metadata.height > MAX_RASTER_DECODE_PIXELS) {
      throw new AppError(413, "GENERATION_SOURCE_DIMENSIONS_EXCEEDED", "转换原图像素数超过上限");
    }

    let decoder = sharp(contents, {
      failOn: "error",
      limitInputPixels: MAX_RASTER_DECODE_PIXELS,
      animated: false,
      sequentialRead: true,
    }).rotate(input.job.options.crop.rotation);
    if (input.job.options.crop.flipY) decoder = decoder.flip();
    if (input.job.options.crop.flipX) decoder = decoder.flop();
    decoder = decoder.ensureAlpha().raw();
    const decoded = await runSharp(decoder, input.signal, () => decoder.toBuffer({ resolveWithObject: true }));
    if (!decoded.info.width
      || !decoded.info.height
      || decoded.info.channels !== 4
      || decoded.info.width * decoded.info.height > MAX_RASTER_DECODE_PIXELS) {
      throw new AppError(413, "GENERATION_SOURCE_DIMENSIONS_EXCEEDED", "转换原图像素数超过上限");
    }
    return { data: decoded.data, width: decoded.info.width, height: decoded.info.height };
  } catch (error) {
    if (input.signal.aborted) throw abortReason(input.signal);
    if (error instanceof AppError) throw error;
    throw new AppError(400, "GENERATION_SOURCE_DECODE_FAILED", "转换原图无法解码或已损坏");
  }
}

async function sampleGrid(input: GenerationProviderInput, source: RgbaImage): Promise<RgbaImage> {
  const crop = cropRectangle(input, source);
  const extractLeft = Math.max(0, crop.left);
  const extractTop = Math.max(0, crop.top);
  const extractRight = Math.min(source.width, crop.left + crop.width);
  const extractBottom = Math.min(source.height, crop.top + crop.height);
  const extractWidth = extractRight - extractLeft;
  const extractHeight = extractBottom - extractTop;
  if (extractWidth < 1 || extractHeight < 1) {
    throw new AppError(400, "GENERATION_CROP_OUTSIDE_SOURCE", "裁剪区域未与原图相交");
  }

  let pipeline = sharp(source.data, {
    raw: { width: source.width, height: source.height, channels: 4 },
    limitInputPixels: MAX_RASTER_DECODE_PIXELS,
  }).extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight });
  const extend = {
    top: Math.max(0, -crop.top),
    left: Math.max(0, -crop.left),
    bottom: Math.max(0, crop.top + crop.height - source.height),
    right: Math.max(0, crop.left + crop.width - source.width),
  };
  if (extend.top || extend.left || extend.bottom || extend.right) {
    pipeline = pipeline.extend({ ...extend, background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  pipeline = pipeline
    .resize(input.job.width, input.job.height, {
      fit: "fill",
      kernel: input.job.kind === "pixel" ? sharp.kernel.nearest : sharp.kernel.lanczos3,
    })
    .ensureAlpha()
    .raw();
  try {
    const sampled = await runSharp(pipeline, input.signal, () => pipeline.toBuffer({ resolveWithObject: true }));
    if (sampled.info.width !== input.job.width
      || sampled.info.height !== input.job.height
      || sampled.info.channels !== 4
      || sampled.data.length !== input.job.width * input.job.height * 4) {
      throw new AppError(500, "GENERATION_RASTER_OUTPUT_INVALID", "图片采样输出无效");
    }
    return { data: sampled.data, width: sampled.info.width, height: sampled.info.height };
  } catch (error) {
    if (input.signal.aborted) throw abortReason(input.signal);
    if (error instanceof AppError) throw error;
    throw new AppError(400, "GENERATION_SOURCE_TRANSFORM_FAILED", "原图裁剪或缩放失败");
  }
}

async function runTonePipeline(
  image: RgbaImage,
  signal: AbortSignal,
  transform: (pipeline: Sharp) => Sharp,
): Promise<RgbaImage> {
  let pipeline = sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
    limitInputPixels: MAX_GRID_CELLS,
  });
  pipeline = transform(pipeline).ensureAlpha().raw();
  try {
    const adjusted = await runSharp(pipeline, signal, () => pipeline.toBuffer({ resolveWithObject: true }));
    if (adjusted.info.width !== image.width
      || adjusted.info.height !== image.height
      || adjusted.info.channels !== 4
      || adjusted.data.length !== image.data.length) {
      throw new AppError(500, "GENERATION_RASTER_OUTPUT_INVALID", "图片预处理输出无效");
    }
    return { data: adjusted.data, width: adjusted.info.width, height: adjusted.info.height };
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error instanceof AppError) throw error;
    throw new AppError(400, "GENERATION_SOURCE_TRANSFORM_FAILED", "原图亮度、对比度或饱和度调整失败");
  }
}

/**
 * Tone controls intentionally run after sampling and background removal. Two
 * separate raw-to-raw pipelines pin modulate-before-linear semantics across
 * Sharp upgrades and provide an abort boundary between the stages. Neutral
 * stages are skipped completely so historical output remains byte-identical.
 */
async function adjustTone(input: GenerationProviderInput, image: RgbaImage): Promise<RgbaImage> {
  const { brightness, saturation, contrast } = input.job.options;
  let adjusted = image;
  if (brightness !== 0 || saturation !== 0) {
    adjusted = await runTonePipeline(adjusted, input.signal, (pipeline) => pipeline.modulate({
      brightness: 1 + brightness / 100,
      saturation: 1 + saturation / 100,
    }));
  }
  if (contrast !== 0) {
    const factor = 1 + contrast / 100;
    adjusted = await runTonePipeline(
      adjusted,
      input.signal,
      (pipeline) => pipeline.linear(factor, 128 * (1 - factor)),
    );
  }
  return adjusted;
}

/**
 * Converts normal and existing-pixel images locally. Color matching uses
 * full-candidate CIEDE2000 distance in Lab space, with stable palette-code
 * tie-breaking so the same bounded 200x200 input remains deterministic.
 */
export class RasterPaletteGenerationProvider implements GenerationProvider {
  readonly kind = "raster-palette";

  async generate(input: GenerationProviderInput): Promise<GenerationCandidate[]> {
    if (input.job.kind !== "normal" && input.job.kind !== "pixel") {
      throw new AppError(400, "GENERATION_RASTER_MODE_UNSUPPORTED", "本地图片转换仅支持普通图片与像素图模式");
    }
    input.signal.throwIfAborted();
    validateTarget(input);
    const palette = allowedPalette(input);
    if (!Number.isInteger(input.job.options.maxColors) || input.job.options.maxColors < 1) {
      throw new AppError(400, "GENERATION_MAX_COLORS_INVALID", "最大颜色数必须是正整数");
    }
    const source = await decodeSource(input);
    const sampledSource = await sampleGrid(input, source);
    const sampled = input.job.options.removeBackground
      ? removeUniformEdgeBackground(sampledSource)
      : sampledSource;
    input.signal.throwIfAborted();
    const adjusted = await adjustTone(input, sampled);
    const cells = mapToPalette(
      adjusted,
      palette,
      input.job.options.maxColors,
      input.job.options.dither,
      input.signal,
    );
    input.signal.throwIfAborted();

    const candidate: GenerationCandidate = {
      id: `${input.job.id}-raster-1`,
      jobId: input.job.id,
      variantOrdinal: 1,
      outputSlot: "combined",
      ordinal: 1,
      grid: {
        encoding: "palette-code-v1",
        width: input.job.width,
        height: input.job.height,
        cells,
      },
      createdAt: input.now,
    };
    return [candidate];
  }
}
