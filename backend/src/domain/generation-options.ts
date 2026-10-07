import { AppError } from "../errors.js";
import type {
  GenerationCoupleLayout,
  GenerationCropOptions,
  GenerationCropRatio,
  GenerationFigureStyle,
  GenerationOptions,
} from "./models.js";

export interface GenerationOptionsInput {
  crop?: Partial<GenerationCropOptions>;
  removeBackground?: boolean;
  figureStyle?: GenerationFigureStyle;
  coupleLayout?: GenerationCoupleLayout;
  maxColors?: number;
  transparentBackground?: boolean;
  inventoryOnly?: boolean;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  dither?: boolean;
}

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  crop: {
    ratio: "1:1",
    freeRatio: 1,
    rotation: 0,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    flipX: false,
    flipY: false,
  },
  removeBackground: true,
  figureStyle: "chibi-full",
  coupleLayout: "together",
  maxColors: 16,
  transparentBackground: false,
  inventoryOnly: false,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  dither: false,
};

export function copyDefaultGenerationOptions(): GenerationOptions {
  return structuredClone(DEFAULT_GENERATION_OPTIONS);
}

/**
 * Canonicalizes a validated public-API options patch. Runtime validation of
 * request bodies remains the responsibility of the shared TypeBox schema.
 */
export function normalizeGenerationOptions(
  input?: GenerationOptionsInput,
  defaultMaxColors = DEFAULT_GENERATION_OPTIONS.maxColors,
): GenerationOptions {
  const defaults = copyDefaultGenerationOptions();
  return {
    crop: { ...defaults.crop, ...input?.crop },
    removeBackground: input?.removeBackground ?? defaults.removeBackground,
    figureStyle: input?.figureStyle ?? defaults.figureStyle,
    coupleLayout: input?.coupleLayout ?? defaults.coupleLayout,
    maxColors: input?.maxColors ?? defaultMaxColors,
    transparentBackground: input?.transparentBackground ?? defaults.transparentBackground,
    inventoryOnly: input?.inventoryOnly ?? defaults.inventoryOnly,
    brightness: input?.brightness ?? defaults.brightness,
    contrast: input?.contrast ?? defaults.contrast,
    saturation: input?.saturation ?? defaults.saturation,
    dither: input?.dither ?? defaults.dither,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

const CROP_RATIOS = new Set<GenerationCropRatio>(["free", "original", "1:1", "4:3", "3:4"]);
const FIGURE_STYLES = new Set<GenerationFigureStyle>(["chibi-full", "chibi-half", "pixel-avatar"]);
const COUPLE_LAYOUTS = new Set<GenerationCoupleLayout>(["together", "split", "solo"]);

function corruptOptions(): never {
  throw new AppError(
    500,
    "GENERATION_OPTIONS_CORRUPT",
    "生成参数持久化数据无效",
  );
}

/**
 * Parses the JSONB trust boundary. The four FR-028 fields default only when
 * absent so rows written before migration remain readable; present invalid
 * values fail closed instead of being silently replaced.
 */
export function deserializeGenerationOptions(value: unknown): GenerationOptions {
  if (!isObject(value) || !isObject(value.crop)) corruptOptions();
  const crop = value.crop;
  const maxColors = value.maxColors === undefined
    ? DEFAULT_GENERATION_OPTIONS.maxColors
    : value.maxColors;
  if (typeof crop.ratio !== "string" || !CROP_RATIOS.has(crop.ratio as GenerationCropRatio)
    || !isFiniteNumberInRange(crop.freeRatio, 0.65, 1.5)
    || !isIntegerInRange(crop.rotation, 0, 270)
    || ![0, 90, 180, 270].includes(crop.rotation as number)
    || !isFiniteNumberInRange(crop.scale, 0.8, 2)
    || !isFiniteNumberInRange(crop.offsetX, -300, 300)
    || !isFiniteNumberInRange(crop.offsetY, -300, 300)
    || typeof crop.flipX !== "boolean"
    || typeof crop.flipY !== "boolean"
    || typeof value.removeBackground !== "boolean"
    || typeof value.figureStyle !== "string"
    || !FIGURE_STYLES.has(value.figureStyle as GenerationFigureStyle)
    || typeof value.coupleLayout !== "string"
    || !COUPLE_LAYOUTS.has(value.coupleLayout as GenerationCoupleLayout)
    || !isIntegerInRange(maxColors, 5, 32)
    || typeof value.transparentBackground !== "boolean"
    || typeof value.inventoryOnly !== "boolean") {
    corruptOptions();
  }

  const defaults = DEFAULT_GENERATION_OPTIONS;
  const brightness = value.brightness === undefined ? defaults.brightness : value.brightness;
  const contrast = value.contrast === undefined ? defaults.contrast : value.contrast;
  const saturation = value.saturation === undefined ? defaults.saturation : value.saturation;
  const dither = value.dither === undefined ? defaults.dither : value.dither;
  if (!isIntegerInRange(brightness, -100, 100)
    || !isIntegerInRange(contrast, -100, 100)
    || !isIntegerInRange(saturation, -100, 100)
    || typeof dither !== "boolean") {
    corruptOptions();
  }

  return {
    crop: {
      ratio: crop.ratio as GenerationCropRatio,
      freeRatio: crop.freeRatio,
      rotation: crop.rotation as GenerationCropOptions["rotation"],
      scale: crop.scale,
      offsetX: crop.offsetX,
      offsetY: crop.offsetY,
      flipX: crop.flipX,
      flipY: crop.flipY,
    },
    removeBackground: value.removeBackground,
    figureStyle: value.figureStyle as GenerationFigureStyle,
    coupleLayout: value.coupleLayout as GenerationCoupleLayout,
    maxColors,
    transparentBackground: value.transparentBackground,
    inventoryOnly: value.inventoryOnly,
    brightness,
    contrast,
    saturation,
    dither,
  };
}

export function generationOptionsEqual(left: GenerationOptions, right: GenerationOptions): boolean {
  return left.crop.ratio === right.crop.ratio
    && left.crop.freeRatio === right.crop.freeRatio
    && left.crop.rotation === right.crop.rotation
    && left.crop.scale === right.crop.scale
    && left.crop.offsetX === right.crop.offsetX
    && left.crop.offsetY === right.crop.offsetY
    && left.crop.flipX === right.crop.flipX
    && left.crop.flipY === right.crop.flipY
    && left.removeBackground === right.removeBackground
    && left.figureStyle === right.figureStyle
    && left.coupleLayout === right.coupleLayout
    && left.maxColors === right.maxColors
    && left.transparentBackground === right.transparentBackground
    && left.inventoryOnly === right.inventoryOnly
    && left.brightness === right.brightness
    && left.contrast === right.contrast
    && left.saturation === right.saturation
    && left.dither === right.dither;
}
