import type { Palette, PaletteColor, PatternGrid } from "./models.js";
import { AppError } from "../errors.js";
import { deltaE2000, rgbToLab, type Lab } from "../generation/color-science.js";

interface PerceptualColor {
  code: string;
  lab: Lab;
}

function toPerceptual(color: PaletteColor): PerceptualColor {
  const match = /^#([0-9a-f]{6})$/i.exec(color.hex);
  if (!match?.[1]) {
    throw new AppError(500, "PALETTE_COLOR_INVALID", `色号 ${color.code} 的标准颜色无效`);
  }
  const value = Number.parseInt(match[1], 16);
  return {
    code: color.code,
    lab: rgbToLab(value >> 16, (value >> 8) & 0xff, value & 0xff),
  };
}

function nearest(source: PerceptualColor, targets: readonly PerceptualColor[]): PerceptualColor {
  let result = targets[0];
  if (!result) throw new AppError(409, "PALETTE_REMAP_NO_COLORS", "目标色卡没有可用颜色");
  let bestDistance = deltaE2000(source.lab, result.lab);
  for (let index = 1; index < targets.length; index += 1) {
    const candidate = targets[index];
    if (!candidate) continue;
    const candidateDistance = deltaE2000(source.lab, candidate.lab);
    if (candidateDistance < bestDistance
      || candidateDistance === bestDistance && candidate.code.localeCompare(result.code) < 0) {
      result = candidate;
      bestDistance = candidateDistance;
    }
  }
  return result;
}

/**
 * Remaps stable color codes through CIEDE2000 perceptual distance. Target colors are first
 * ranked by how many actual non-empty source cells consider them nearest, then
 * the grid is remapped against the selected content-sensitive maxColors set.
 */
export function remapGridPalette(input: {
  grid: PatternGrid;
  sourcePalette: Palette;
  targetPalette: Palette;
  maxColors: number;
  availableColorCodes: string[] | null;
}): PatternGrid {
  if (!Number.isInteger(input.maxColors) || input.maxColors < 1) {
    throw new AppError(400, "PALETTE_REMAP_MAX_COLORS_INVALID", "最大颜色数必须是正整数");
  }
  const available = input.availableColorCodes ? new Set(input.availableColorCodes) : null;
  const targetColors = input.targetPalette.colors
    .filter((color) => color.available && (!available || available.has(color.code)))
    .map(toPerceptual);
  if (targetColors.length === 0) {
    throw new AppError(409, "PALETTE_REMAP_NO_COLORS", "目标色卡没有符合库存约束的可用颜色");
  }
  const sourceColors = new Map(input.sourcePalette.colors.map((color) => [color.code, toPerceptual(color)]));
  const sourceCounts = new Map<string, number>();
  for (const code of input.grid.cells) {
    if (code === null) continue;
    if (!sourceColors.has(code)) {
      throw new AppError(500, "PALETTE_REMAP_SOURCE_COLOR_UNKNOWN", `原图色号 ${code} 不属于原色卡`);
    }
    sourceCounts.set(code, (sourceCounts.get(code) ?? 0) + 1);
  }
  if (sourceCounts.size === 0) return { ...input.grid, cells: [...input.grid.cells] };

  const targetWeights = new Map<string, number>();
  for (const [sourceCode, count] of sourceCounts) {
    const source = sourceColors.get(sourceCode)!;
    const target = nearest(source, targetColors);
    targetWeights.set(target.code, (targetWeights.get(target.code) ?? 0) + count);
  }
  const selectedCodes = [...targetWeights]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, Math.min(input.maxColors, targetColors.length))
    .map(([code]) => code);
  const selected = targetColors.filter((color) => selectedCodes.includes(color.code));
  const replacements = new Map<string, string>();
  for (const sourceCode of sourceCounts.keys()) {
    replacements.set(sourceCode, nearest(sourceColors.get(sourceCode)!, selected).code);
  }
  return {
    ...input.grid,
    cells: input.grid.cells.map((code) => code === null ? null : replacements.get(code)!),
  };
}
