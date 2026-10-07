import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Palette, PatternGrid } from "../src/domain/models.js";
import { remapGridPalette } from "../src/domain/palette-remap.js";
import { AppError } from "../src/errors.js";

const sourcePalette: Palette = {
  id: "source",
  name: "源色卡",
  brand: "测试",
  beadSizeMm: 5,
  verified: false,
  version: 1,
  colors: [
    { code: "SRED", name: "红", hex: "#FF0000", unitPriceCents: 1, available: true },
    { code: "SBLUE", name: "蓝", hex: "#0000FF", unitPriceCents: 1, available: true },
    { code: "SGREEN", name: "绿", hex: "#00FF00", unitPriceCents: 1, available: true },
  ],
};

const targetPalette: Palette = {
  id: "target",
  name: "目标色卡",
  brand: "测试",
  beadSizeMm: 2.6,
  verified: true,
  version: 1,
  // Black comes first deliberately: maxColors selection must depend on the
  // source image rather than truncating the palette array.
  colors: [
    { code: "TBLACK", name: "黑", hex: "#000000", unitPriceCents: 2, available: true },
    { code: "TRED", name: "红", hex: "#FE0000", unitPriceCents: 2, available: true },
    { code: "TBLUE", name: "蓝", hex: "#0000FE", unitPriceCents: 2, available: true },
    { code: "TGREEN", name: "绿", hex: "#00FE00", unitPriceCents: 2, available: false },
  ],
};

const grid: PatternGrid = {
  encoding: "palette-code-v1",
  width: 4,
  height: 2,
  cells: ["SRED", "SRED", "SRED", null, "SBLUE", "SBLUE", "SGREEN", null],
};

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

describe("palette remapping", () => {
  it("uses content-sensitive CIEDE2000 nearest colors and preserves transparent cells", () => {
    const result = remapGridPalette({
      grid,
      sourcePalette,
      targetPalette,
      maxColors: 2,
      availableColorCodes: null,
    });

    const used = new Set(result.cells.filter((cell): cell is string => cell !== null));
    assert.deepEqual([...used].sort(), ["TBLUE", "TRED"]);
    assert.equal(used.has("TBLACK"), false, "must not simply take the first palette entries");
    assert.equal(used.has("TGREEN"), false, "disabled target colors must never be used");
    assert.deepEqual(
      result.cells.map((cell) => cell === null),
      grid.cells.map((cell) => cell === null),
    );
  });

  it("applies inventory and maxColors as hard upper bounds", () => {
    const result = remapGridPalette({
      grid,
      sourcePalette,
      targetPalette,
      maxColors: 1,
      availableColorCodes: ["TRED", "TBLUE"],
    });
    assert.deepEqual(
      new Set(result.cells.filter((cell): cell is string => cell !== null)),
      new Set(["TBLUE"]),
    );

    const inventoryOnly = remapGridPalette({
      grid,
      sourcePalette,
      targetPalette,
      maxColors: 4,
      availableColorCodes: ["TBLUE", "TGREEN"],
    });
    assert.deepEqual(
      new Set(inventoryOnly.cells.filter((cell): cell is string => cell !== null)),
      new Set(["TBLUE"]),
      "unavailable TGREEN stays excluded even if inventory claims it exists",
    );
  });

  it("fails with stable codes when constraints leave no color or source codes are corrupt", () => {
    assert.throws(
      () => remapGridPalette({
        grid,
        sourcePalette,
        targetPalette,
        maxColors: 2,
        availableColorCodes: [],
      }),
      rejectsWithCode("PALETTE_REMAP_NO_COLORS"),
    );
    assert.throws(
      () => remapGridPalette({
        grid: { ...grid, cells: ["UNKNOWN", ...grid.cells.slice(1)] },
        sourcePalette,
        targetPalette,
        maxColors: 2,
        availableColorCodes: null,
      }),
      rejectsWithCode("PALETTE_REMAP_SOURCE_COLOR_UNKNOWN"),
    );
  });
});
