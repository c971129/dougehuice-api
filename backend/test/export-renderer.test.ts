import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodePDFRawStream,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
} from "pdf-lib";
import sharp from "sharp";

import { MAX_GRID_SIDE } from "../src/domain/grid.js";
import type { Palette, ProjectDetail } from "../src/domain/models.js";
import { AppError } from "../src/errors.js";
import {
  normalizeExportBaseName,
  normalizeExportOptions,
  renderProjectExport,
} from "../src/exports/renderer.js";

const palette: Palette = {
  id: "test-palette",
  name: "测试色卡",
  brand: "测试",
  beadSizeMm: 5,
  verified: false,
  version: 1,
  colors: [
    { code: "R01", name: "莓果红", hex: "#e94359", unitPriceCents: 1, available: true },
    { code: "B01", name: "湖水蓝", hex: "#3fa7d6", unitPriceCents: 1, available: true },
  ],
};

const project: ProjectDetail = {
  id: "project-1",
  userId: "user-1",
  name: "莓果/爱心",
  mode: "normal",
  lifecycleStatus: "editable",
  metadataRevision: 1,
  tags: [],
  deviceSource: "unknown",
  sourceAssetId: null,
  previewAssetId: null,
  paletteId: palette.id,
  backgroundMode: "white",
  backgroundColor: null,
  currentRevision: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revisionDeviceSource: "unknown",
  revisionUpdatedAt: "2026-01-01T00:00:00.000Z",
  grid: {
    encoding: "palette-code-v1",
    width: 3,
    height: 2,
    cells: ["R01", "B01", null, "B01", "R01", "R01"],
  },
};

function embeddedPageRgb(pdf: PDFDocument, pageIndex: number): {
  pixels: Uint8Array;
  width: number;
  height: number;
} {
  const page = pdf.getPage(pageIndex);
  const resources = page.node.Resources();
  assert.ok(resources);
  const xObjects = resources.lookup(PDFName.of("XObject"), PDFDict);
  const imageStreams = xObjects.keys().map((key) => xObjects.lookup(key, PDFStream));
  assert.equal(imageStreams.length, 1);
  const image = imageStreams[0]!;
  assert.ok(image instanceof PDFRawStream);
  const width = image.dict.lookup(PDFName.of("Width"), PDFNumber).asNumber();
  const height = image.dict.lookup(PDFName.of("Height"), PDFNumber).asNumber();
  const pixels = decodePDFRawStream(image).decode();
  assert.equal(pixels.length, width * height * 3);
  return { pixels, width, height };
}

function darkPixelsInRegion(
  image: ReturnType<typeof embeddedPageRgb>,
  region: { x: number; y: number; width: number; height: number },
): number {
  let count = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (y * image.width + x) * 3;
      if ((image.pixels[offset] ?? 255) < 180
        && (image.pixels[offset + 1] ?? 255) < 180
        && (image.pixels[offset + 2] ?? 255) < 180) {
        count += 1;
      }
    }
  }
  return count;
}

function rgbAt(image: ReturnType<typeof embeddedPageRgb>, x: number, y: number): [number, number, number] {
  const offset = (y * image.width + x) * 3;
  return [image.pixels[offset]!, image.pixels[offset + 1]!, image.pixels[offset + 2]!];
}

function rgbFromHex(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

test("normalizes export options and rejects unknown fields", () => {
  assert.deepEqual(normalizeExportOptions(undefined), {
    paper: "A4",
    orientation: "auto",
    showCodes: true,
    showGrid: true,
    transparentBackground: false,
  });
  assert.throws(() => normalizeExportOptions({ injectedTemplate: "x" }), (error: unknown) => {
    return error instanceof AppError && error.code === "UNKNOWN_EXPORT_OPTION";
  });
});

test("makes export names well-formed and truncates them by Unicode code point", () => {
  assert.equal(normalizeExportBaseName("\ud800middle\udc00"), "\ufffdmiddle\ufffd");

  const prefix = "a".repeat(79);
  const normalized = normalizeExportBaseName(`${prefix}😀tail`);
  assert.equal(normalized, `${prefix}😀`);
  assert.equal(Array.from(normalized).length, 80);
});

test("renders a valid PNG with grid metadata and a safe file name", async () => {
  const result = await renderProjectExport({ project, palette, format: "png" });
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.fileName, "莓果_爱心.png");
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.pageCount, 1);
  const metadata = await sharp(result.contents).metadata();
  assert.equal(metadata.format, "png");
  assert.ok((metadata.width ?? 0) > 400);
  assert.ok((metadata.height ?? 0) > 150);
});

test("rejects before rendering when its cancellation signal is already aborted", async () => {
  const controller = new AbortController();
  const reason = new Error("test export cancellation");
  controller.abort(reason);

  await assert.rejects(
    renderProjectExport({ project, palette, format: "png", signal: controller.signal }),
    (error: unknown) => error === reason,
  );
});

test("stops a PDF at the next render checkpoint when cancellation arrives mid-render", { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  const reason = new Error("test mid-render cancellation");
  const timer = setTimeout(() => controller.abort(reason), 0);

  try {
    await assert.rejects(
      renderProjectExport({ project, palette, format: "pdf", signal: controller.signal }),
      (error: unknown) => error === reason,
    );
  } finally {
    clearTimeout(timer);
  }
});

test("renders a readable paginated A4 PDF with a legend page", async () => {
  const result = await renderProjectExport({
    project,
    palette,
    format: "pdf",
    options: { orientation: "portrait", showCodes: true },
  });
  assert.equal(result.mimeType, "application/pdf");
  assert.equal(result.fileName, "莓果_爱心.pdf");
  assert.equal(result.contents.subarray(0, 4).toString("ascii"), "%PDF");
  const pdf = await PDFDocument.load(result.contents);
  assert.equal(pdf.getPageCount(), 2);
  assert.equal(result.pageCount, 2);

  const retried = await renderProjectExport({
    project,
    palette,
    format: "pdf",
    options: { orientation: "portrait", showCodes: true },
  });
  assert.equal(retried.sha256, result.sha256);
  assert.deepEqual(retried.contents, result.contents);
});

test("renders deterministic multi-page PDF chunks with locators and registration marks", async () => {
  const width = 40;
  const height = 40;
  const largeProject: ProjectDetail = {
    ...project,
    id: "project-multipage",
    name: "四页拼接定位图",
    currentRevision: 9,
    grid: {
      encoding: "palette-code-v1",
      width,
      height,
      cells: Array.from({ length: width * height }, (_, index) => (
        (index + Math.floor(index / width)) % 3 === 0 ? "B01" : "R01"
      )),
    },
  };

  const result = await renderProjectExport({
    project: largeProject,
    palette,
    format: "pdf",
    options: { orientation: "portrait", showCodes: true, showGrid: true },
  });
  const pdf = await PDFDocument.load(result.contents);
  assert.equal(result.pageCount, 5);
  assert.equal(pdf.getPageCount(), 5);

  const firstPage = embeddedPageRgb(pdf, 0);
  assert.deepEqual({ width: firstPage.width, height: firstPage.height }, { width: 1190, height: 1684 });
  assert.ok(
    darkPixelsInRegion(firstPage, { x: 45, y: 112, width: 1_100, height: 38 }) > 100,
    "the locator band should contain adjacent-page guidance",
  );
  assert.ok(
    darkPixelsInRegion(firstPage, { x: 132, y: 163, width: 24, height: 25 }) > 20,
    "the top-left registration mark should be visible outside the grid",
  );

  const rightPage = embeddedPageRgb(pdf, 1);
  assert.ok(
    darkPixelsInRegion(rightPage, { x: 45, y: 112, width: 1_100, height: 38 }) > 100,
    "the right page should identify its left and lower neighbours",
  );
  assert.ok(
    darkPixelsInRegion(rightPage, { x: 336, y: 163, width: 24, height: 25 }) > 20,
    "the right page registration mark should match its centered chunk",
  );

  const bottomPage = embeddedPageRgb(pdf, 2);
  assert.ok(
    darkPixelsInRegion(bottomPage, { x: 45, y: 112, width: 1_100, height: 38 }) > 100,
    "the lower page should identify its upper and right neighbours",
  );
  assert.ok(
    darkPixelsInRegion(bottomPage, { x: 132, y: 163, width: 24, height: 25 }) > 20,
    "the lower page registration mark should remain visible",
  );

  const cellSize = 34;
  const pageOriginY = 184;
  const fullChunkOriginX = Math.floor((1_190 - 26 * cellSize) / 2);
  const narrowChunkOriginX = Math.floor((1_190 - 14 * cellSize) / 2);
  assert.deepEqual(
    rgbAt(firstPage, fullChunkOriginX + 25 * cellSize + 8, pageOriginY + cellSize + 8),
    rgbFromHex(palette.colors[1]!.hex),
    "the last column on the left page should preserve its global grid color",
  );
  assert.deepEqual(
    rgbAt(rightPage, narrowChunkOriginX + 8, pageOriginY + cellSize + 8),
    rgbFromHex(palette.colors[0]!.hex),
    "the first column on the right page should continue at global column 27",
  );
  assert.deepEqual(
    rgbAt(firstPage, fullChunkOriginX + 8, pageOriginY + 33 * cellSize + 8),
    rgbFromHex(palette.colors[1]!.hex),
    "the last row on the upper page should preserve its global grid color",
  );
  assert.deepEqual(
    rgbAt(bottomPage, fullChunkOriginX + 8, pageOriginY + 8),
    rgbFromHex(palette.colors[0]!.hex),
    "the first row on the lower page should continue at global row 35",
  );

  const retried = await renderProjectExport({
    project: largeProject,
    palette,
    format: "pdf",
    options: { orientation: "portrait", showCodes: true, showGrid: true },
  });
  assert.equal(retried.sha256, result.sha256);
  assert.deepEqual(retried.contents, result.contents);
});

test("paginates every used color across deterministic legend pages", async () => {
  const colors: Palette["colors"] = Array.from({ length: 55 }, (_, index) => ({
    code: `C${index.toString().padStart(3, "0")}`,
    name: `测试色 ${index}`,
    hex: `#${((index * 37) % 256).toString(16).padStart(2, "0")}${((index * 67) % 256).toString(16).padStart(2, "0")}${((index * 97) % 256).toString(16).padStart(2, "0")}`,
    unitPriceCents: 1,
    available: true,
  }));
  const manyColorPalette: Palette = { ...palette, id: "many-colors", colors };
  const manyColorProject: ProjectDetail = {
    ...project,
    id: "project-many-colors",
    name: "多页图例",
    paletteId: manyColorPalette.id,
    grid: {
      encoding: "palette-code-v1",
      width: colors.length,
      height: 1,
      cells: colors.map((color) => color.code),
    },
  };

  const result = await renderProjectExport({
    project: manyColorProject,
    palette: manyColorPalette,
    format: "pdf",
    options: { orientation: "portrait" },
  });
  const pdf = await PDFDocument.load(result.contents);
  assert.equal(result.pageCount, 5, "three grid pages should be followed by two legend pages");
  assert.equal(pdf.getPageCount(), 5);

  const firstLegendPage = embeddedPageRgb(pdf, 3);
  const secondLegendPage = embeddedPageRgb(pdf, 4);
  assert.deepEqual(
    rgbAt(firstLegendPage, 614, 1_565),
    rgbFromHex(colors[49]!.hex),
    "the final swatch at the first-page capacity boundary should be rendered",
  );
  assert.deepEqual(
    rgbAt(secondLegendPage, 73, 173),
    rgbFromHex(colors[50]!.hex),
    "the next swatch should begin a second legend page",
  );
  assert.deepEqual(
    rgbAt(secondLegendPage, 73, 289),
    rgbFromHex(colors[54]!.hex),
    "the final used color should not be clipped",
  );

  const retried = await renderProjectExport({
    project: manyColorProject,
    palette: manyColorPalette,
    format: "pdf",
    options: { orientation: "portrait" },
  });
  assert.equal(retried.sha256, result.sha256);
  assert.deepEqual(retried.contents, result.contents);
});

test("refuses a grid color that is absent from the frozen palette", async () => {
  await assert.rejects(
    renderProjectExport({
      project: { ...project, grid: { ...project.grid, cells: ["NOPE", "B01", null, "B01", "R01", "R01"] } },
      palette,
      format: "png",
    }),
    (error: unknown) => error instanceof AppError && error.code === "EXPORT_COLOR_NOT_FOUND",
  );
});

test("rejects oversized grids and malformed palette colors before rasterization", async () => {
  await assert.rejects(
    renderProjectExport({
      project: {
        ...project,
        grid: {
          encoding: "palette-code-v1",
          width: MAX_GRID_SIDE + 1,
          height: 1,
          cells: Array.from({ length: MAX_GRID_SIDE + 1 }, () => "R01"),
        },
      },
      palette,
      format: "png",
    }),
    (error: unknown) => error instanceof AppError && error.code === "EXPORT_RENDER_LIMIT_EXCEEDED",
  );

  await assert.rejects(
    renderProjectExport({
      project,
      palette: { ...palette, colors: [{ ...palette.colors[0]!, hex: "url(#payload)" }] },
      format: "png",
    }),
    (error: unknown) => error instanceof AppError && error.code === "EXPORT_PALETTE_CORRUPTED",
  );
});
