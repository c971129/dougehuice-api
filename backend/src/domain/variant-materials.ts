import type { MaterialLine, MaterialSummary } from "./models.js";

export interface VariantMaterialTotal {
  outputCount: number;
  colorCount: number;
  beadCount: number;
  estimatedTotalCents: number;
  lines: MaterialLine[];
}

/**
 * Adds independently computed output summaries without inventing a shared
 * canvas size. All outputs in a generation variant use the same palette, so a
 * stable palette color code is the aggregation key.
 */
export function aggregateVariantMaterials(
  summaries: readonly MaterialSummary[],
): VariantMaterialTotal {
  const lines = new Map<string, MaterialLine>();
  for (const summary of summaries) {
    for (const line of summary.lines) {
      const current = lines.get(line.colorCode);
      if (current) {
        current.quantity += line.quantity;
        current.subtotalCents += line.subtotalCents;
      } else {
        lines.set(line.colorCode, { ...line });
      }
    }
  }
  const ordered = [...lines.values()]
    .sort((left, right) => right.quantity - left.quantity || left.colorCode.localeCompare(right.colorCode));
  return {
    outputCount: summaries.length,
    colorCount: ordered.length,
    beadCount: summaries.reduce((sum, summary) => sum + summary.beadCount, 0),
    estimatedTotalCents: summaries.reduce((sum, summary) => sum + summary.estimatedTotalCents, 0),
    lines: ordered,
  };
}
