import { createHash } from "node:crypto";

import type {
  GenerationCandidate,
  GenerationCandidateOutputSlot,
  GenerationKind,
  GenerationOptions,
  MaterialSummary,
  Palette,
  PatternGrid,
} from "./models.js";
import { AppError } from "../errors.js";

// These limits are part of the API, renderer, and PostgreSQL contract. Raising
// them requires a measured renderer/worker capacity change, not only a schema
// change, because every grid operation is proportional to the cell count.
export const MAX_GRID_SIDE = 200;
export const MAX_GRID_CELLS = 40_000;
export const MAX_GENERATION_GRID_SIDE = 64;

export function assertValidGrid(grid: PatternGrid, palette: Palette): void {
  if (grid.encoding !== "palette-code-v1") {
    throw new AppError(400, "INVALID_GRID_ENCODING", "网格编码必须为 palette-code-v1");
  }
  if (!Number.isInteger(grid.width) || !Number.isInteger(grid.height)) {
    throw new AppError(400, "INVALID_GRID_SIZE", "网格宽高必须为整数");
  }
  if (grid.width < 1 || grid.height < 1 || grid.width > MAX_GRID_SIDE || grid.height > MAX_GRID_SIDE) {
    throw new AppError(400, "INVALID_GRID_SIZE", `网格宽高必须介于 1 与 ${MAX_GRID_SIDE} 之间`);
  }
  if (grid.width * grid.height > MAX_GRID_CELLS || grid.cells.length !== grid.width * grid.height) {
    throw new AppError(400, "INVALID_GRID_CELLS", "网格单元数量与宽高不一致");
  }
  const allowed = new Set(palette.colors.map((color) => color.code));
  const unknown = grid.cells.find((cell) => cell !== null && !allowed.has(cell));
  if (unknown !== undefined) {
    throw new AppError(400, "UNKNOWN_PALETTE_COLOR", `色号 ${String(unknown)} 不属于所选色卡`);
  }
}

export function calculateMaterials(
  projectId: string,
  projectRevision: number,
  grid: PatternGrid,
  palette: Palette,
): MaterialSummary {
  const counts = new Map<string, number>();
  let left = grid.width;
  let top = grid.height;
  let right = -1;
  let bottom = -1;
  for (const [index, cell] of grid.cells.entries()) {
    if (cell !== null) {
      counts.set(cell, (counts.get(cell) ?? 0) + 1);
      const x = index % grid.width;
      const y = Math.floor(index / grid.width);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  const colors = new Map(palette.colors.map((color) => [color.code, color]));
  const lines = [...counts.entries()]
    .map(([colorCode, quantity]) => {
      const color = colors.get(colorCode);
      if (!color) throw new AppError(500, "PALETTE_CORRUPTED", `无法解析色号 ${colorCode}`);
      return {
        colorCode,
        colorName: color.name,
        hex: color.hex,
        quantity,
        subtotalCents: quantity * color.unitPriceCents,
      };
    })
    .sort((left, right) => right.quantity - left.quantity || left.colorCode.localeCompare(right.colorCode));

  const occupiedBounds = right < left || bottom < top ? null : {
    left,
    top,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  };
  const millimeters = (cells: number): number => Number((cells * palette.beadSizeMm).toFixed(3));
  return {
    projectId,
    projectRevision,
    width: grid.width,
    height: grid.height,
    colorCount: lines.length,
    beadCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    occupiedBounds,
    physicalSize: {
      unit: "mm",
      beadSizeMm: palette.beadSizeMm,
      canvas: { widthMm: millimeters(grid.width), heightMm: millimeters(grid.height) },
      occupied: occupiedBounds
        ? { widthMm: millimeters(occupiedBounds.width), heightMm: millimeters(occupiedBounds.height) }
        : null,
    },
    estimatedTotalCents: lines.reduce((sum, line) => sum + line.subtotalCents, 0),
    lines,
  };
}

function digestByte(seed: string, ordinal: number, index: number): number {
  const digest = createHash("sha256").update(`${seed}:${ordinal}:${index}`).digest();
  return digest[index % digest.length] ?? 0;
}

export function generateDeterministicCandidates(input: {
  jobId: string;
  kind: GenerationKind;
  palette: Palette;
  width: number;
  height: number;
  seed: string;
  createdAt: string;
  options: GenerationOptions;
}): GenerationCandidate[] {
  const codes = input.palette.colors.map((color) => color.code);
  if (codes.length === 0) throw new AppError(500, "EMPTY_PALETTE", "色卡没有可用色号");
  const slots: GenerationCandidateOutputSlot[] = input.kind !== "couple"
    ? ["combined"]
    : input.options.coupleLayout === "split"
      ? ["left", "right"]
      : input.options.coupleLayout === "solo"
        ? ["subject-1", "subject-2"]
        : ["combined"];
  const variantCount = input.kind === "normal" || input.kind === "pixel" ? 1 : 2;
  const candidates: GenerationCandidate[] = [];

  for (let variantOrdinal = 1; variantOrdinal <= variantCount; variantOrdinal += 1) {
    for (const outputSlot of slots) {
      const ordinal = candidates.length + 1;
      const subject: 1 | 2 | undefined = outputSlot === "subject-1"
        ? 1
        : outputSlot === "subject-2" ? 2 : undefined;
      const cells = Array.from({ length: input.width * input.height }, (_, index) => {
        const x = index % input.width;
        const y = Math.floor(index / input.width);
        const byte = digestByte(
          `${input.kind}:${input.seed}:variant-${variantOrdinal}:${outputSlot}`,
          variantOrdinal,
          index,
        );
        const distance = Math.hypot(x - (input.width - 1) / 2, y - (input.height - 1) / 2);
        const radius = Math.min(input.width, input.height) * (0.42 + (variantOrdinal - 1) * 0.04);
        if ((input.kind === "portrait" || input.kind === "couple")
          && input.options.removeBackground && distance > radius && byte % 5 !== 0) {
          return input.options.transparentBackground ? null : codes[0] ?? null;
        }
        const offset = input.kind === "couple"
          ? outputSlot === "right" || outputSlot === "subject-2"
            ? 3
            : outputSlot === "combined" && x >= input.width / 2 ? 3 : 0
          : 0;
        return codes[(byte + x + y + offset) % codes.length] ?? codes[0] ?? null;
      });

      candidates.push({
        id: `${input.jobId}-variant-${variantOrdinal}-${outputSlot}`,
        jobId: input.jobId,
        variantOrdinal,
        outputSlot,
        ordinal,
        ...(subject === undefined ? {} : { subject }),
        grid: {
          encoding: "palette-code-v1",
          width: input.width,
          height: input.height,
          cells,
        },
        createdAt: input.createdAt,
      });
    }
  }
  return candidates;
}

export function generationCost(kind: GenerationKind): number {
  if (kind === "portrait") return 1;
  if (kind === "couple") return 2;
  return 0;
}
