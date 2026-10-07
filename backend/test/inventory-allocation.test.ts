import assert from "node:assert/strict";
import { test } from "node:test";

import type { InventoryItem, MaterialSummary, Palette } from "../src/domain/models.js";
import { compareMaterialsWithInventory } from "../src/domain/inventory.js";

const palette: Palette = {
  id: "allocation-palette",
  name: "替代色分配色卡",
  brand: "测试",
  beadSizeMm: 5,
  verified: false,
  version: 1,
  colors: [
    { code: "A", name: "目标 A", hex: "#000000", unitPriceCents: 1, available: true },
    { code: "B", name: "目标 B", hex: "#010101", unitPriceCents: 1, available: true },
    { code: "C", name: "近似色", hex: "#020202", unitPriceCents: 1, available: true },
    { code: "D", name: "备用色", hex: "#ffffff", unitPriceCents: 1, available: true },
  ],
};

const materials: MaterialSummary = {
  projectId: "project-allocation",
  projectRevision: 1,
  width: 2,
  height: 2,
  colorCount: 2,
  beadCount: 4,
  occupiedBounds: { left: 0, top: 0, right: 1, bottom: 1, width: 2, height: 2 },
  physicalSize: {
    unit: "mm",
    beadSizeMm: 5,
    canvas: { widthMm: 10, heightMm: 10 },
    occupied: { widthMm: 10, heightMm: 10 },
  },
  estimatedTotalCents: 4,
  lines: [
    { colorCode: "A", colorName: "目标 A", hex: "#000000", quantity: 2, subtotalCents: 2 },
    { colorCode: "B", colorName: "目标 B", hex: "#010101", quantity: 2, subtotalCents: 2 },
  ],
};

function item(colorCode: string, quantity: number): InventoryItem {
  return {
    userId: "user-allocation",
    paletteId: palette.id,
    colorCode,
    quantity,
    location: `${colorCode} 盒`,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("allocates substitute surplus once and falls back to the next nearest color", () => {
  const summary = compareMaterialsWithInventory(palette, materials, [item("C", 3), item("D", 5)]);
  const reversedInventory = compareMaterialsWithInventory(palette, materials, [item("D", 5), item("C", 3)]);

  const first = summary.lines[0]?.suggestedSubstitute;
  const second = summary.lines[1]?.suggestedSubstitute;
  assert.equal(first?.colorCode, "C");
  assert.equal(first?.surplusQuantity, 3);
  assert.equal(second?.colorCode, "D");
  assert.equal(second?.surplusQuantity, 5);
  assert.ok((first?.rgbDistance ?? Infinity) < (second?.rgbDistance ?? 0));
  assert.deepEqual(
    reversedInventory.lines.map((line) => line.suggestedSubstitute?.colorCode ?? null),
    ["C", "D"],
  );
});

test("does not suggest a partially exhausted substitute for another full shortage", () => {
  const summary = compareMaterialsWithInventory(palette, materials, [item("C", 3)]);

  assert.equal(summary.lines[0]?.suggestedSubstitute?.colorCode, "C");
  assert.equal(summary.lines[1]?.suggestedSubstitute, null);
});
