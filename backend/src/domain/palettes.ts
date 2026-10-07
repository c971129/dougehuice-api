import {
  MARD_144_CODES,
  MARD_221_CODES,
  MARD_291_COLORS,
  MARD_48_CODES,
  MARD_72_CODES,
  MARD_SOURCE,
} from "./mard-colors.js";
import type { Palette } from "./models.js";

export type PaletteProductMode = "quick" | "photo" | "portrait";

export interface PaletteProductPreset {
  mode: PaletteProductMode;
  name: string;
  paletteIds: readonly string[];
  defaultPaletteId: string;
  defaultMaxColors: number;
  resizeKernel: "lanczos3";
  colorDifference: "ciede2000";
  ditherStrength: number;
}

const colorByCode = new Map(MARD_291_COLORS.map((color) => [color.code, color]));

function mardPaletteSource(count: number): NonNullable<Palette["source"]> {
  if (count === 291) return MARD_SOURCE;
  const subsetVersion = `pindou-mard-${count}-subset-v1`;
  return {
    name: `Pindou MARD ${count}-color project subset v1 (non-official)`,
    url: MARD_SOURCE.url,
    revision: `${subsetVersion}@${MARD_SOURCE.revision}`,
    license: `${MARD_SOURCE.license}; project-defined subset`,
  };
}

function buildMardPalette(id: string, count: number, codes: readonly string[]): Palette {
  const colors = codes.map((code) => {
    const color = colorByCode.get(code);
    if (!color) throw new Error(`MARD color ${code} is missing from the pinned dataset`);
    return {
      code: color.code,
      name: `MARD ${color.code}`,
      hex: color.hex,
      finish: color.finish,
      unitPriceCents: 0,
      available: true,
    };
  });
  if (colors.length !== count) throw new Error(`MARD ${count} palette has ${colors.length} colors`);
  return {
    id,
    name: `MARD ${count} 色`,
    brand: "MARD",
    series: "MARD 2.6mm",
    material: "PE",
    beadSizeMm: 2.6,
    verified: false,
    version: 1,
    retired: false,
    source: mardPaletteSource(count),
    colors,
  };
}

const allMardCodes = MARD_291_COLORS.map((color) => color.code);

export const BUILTIN_PALETTES: Palette[] = [
  buildMardPalette("mard-48-v1", 48, MARD_48_CODES),
  buildMardPalette("mard-72-v1", 72, MARD_72_CODES),
  buildMardPalette("mard-144-v1", 144, MARD_144_CODES),
  buildMardPalette("mard-221-v1", 221, MARD_221_CODES),
  buildMardPalette("mard-291-v1", 291, allMardCodes),
];

export const PALETTE_PRODUCT_PRESETS: Record<PaletteProductMode, PaletteProductPreset> = {
  quick: {
    mode: "quick",
    name: "快速模式",
    paletteIds: ["mard-48-v1", "mard-72-v1"],
    defaultPaletteId: "mard-48-v1",
    defaultMaxColors: 16,
    resizeKernel: "lanczos3",
    colorDifference: "ciede2000",
    ditherStrength: 0,
  },
  photo: {
    mode: "photo",
    name: "标准照片模式",
    paletteIds: ["mard-144-v1", "mard-221-v1"],
    defaultPaletteId: "mard-221-v1",
    defaultMaxColors: 24,
    resizeKernel: "lanczos3",
    colorDifference: "ciede2000",
    ditherStrength: 0,
  },
  portrait: {
    mode: "portrait",
    name: "高精度人物模式",
    paletteIds: ["mard-291-v1"],
    defaultPaletteId: "mard-291-v1",
    defaultMaxColors: 32,
    resizeKernel: "lanczos3",
    colorDifference: "ciede2000",
    ditherStrength: 0,
  },
};

export const DEFAULT_BUILTIN_PALETTE_ID = PALETTE_PRODUCT_PRESETS.photo.defaultPaletteId;
export const DEFAULT_CUSTOM_PALETTE_MAX_COLORS = 16;

export function palettePresetForId(paletteId: string): PaletteProductPreset | null {
  return Object.values(PALETTE_PRODUCT_PRESETS)
    .find((preset) => preset.paletteIds.includes(paletteId)) ?? null;
}

export function defaultMaxColorsForPaletteId(paletteId: string): number {
  return palettePresetForId(paletteId)?.defaultMaxColors ?? DEFAULT_CUSTOM_PALETTE_MAX_COLORS;
}

export function isPaletteSelectable(palette: Palette): boolean {
  return palette.retired !== true;
}
