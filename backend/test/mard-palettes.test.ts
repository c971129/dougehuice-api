import assert from "node:assert/strict";
import test from "node:test";

import { LEGACY_DEMO_TO_MARD_291 } from "../src/domain/legacy-palette-migration.js";
import { BUILTIN_PALETTES, PALETTE_PRODUCT_PRESETS } from "../src/domain/palettes.js";

test("ships only the five versioned MARD product palettes", () => {
  assert.deepEqual(BUILTIN_PALETTES.map((palette) => palette.id), [
    "mard-48-v1", "mard-72-v1", "mard-144-v1", "mard-221-v1", "mard-291-v1",
  ]);
  assert.deepEqual(BUILTIN_PALETTES.map((palette) => palette.colors.length), [48, 72, 144, 221, 291]);
  assert.equal(BUILTIN_PALETTES.every((palette) => palette.verified === false), true);
  for (const palette of BUILTIN_PALETTES.slice(0, 4)) {
    assert.match(palette.source?.name ?? "", /project subset v1 \(non-official\)$/);
    assert.match(palette.source?.revision ?? "", new RegExp(`^pindou-mard-${palette.colors.length}-subset-v1@`));
  }
  assert.match(BUILTIN_PALETTES[4]?.source?.name ?? "", /non-official reference/);
  assert.equal(BUILTIN_PALETTES[4]?.source?.revision, "f97ff4283d03cef5cd7e1071a86f5892e0c0c61b");
  assert.equal(PALETTE_PRODUCT_PRESETS.quick.defaultMaxColors, 16);
  assert.equal(PALETTE_PRODUCT_PRESETS.photo.defaultPaletteId, "mard-221-v1");
  assert.equal(PALETTE_PRODUCT_PRESETS.photo.defaultMaxColors, 24);
  assert.equal(PALETTE_PRODUCT_PRESETS.portrait.defaultMaxColors, 32);
});

test("legacy migration is HEX/CIEDE2000 based and flags uncertain rows", () => {
  assert.equal(LEGACY_DEMO_TO_MARD_291.length, 25);
  assert.ok(LEGACY_DEMO_TO_MARD_291.every((row) => row.oldHex.startsWith("#") && row.newHex.startsWith("#")));
  assert.deepEqual(
    LEGACY_DEMO_TO_MARD_291.filter((row) => !row.reliable).map((row) => row.oldCode),
    ["M05", "M10", "M14", "V09"],
  );
});

