import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import sharp from "sharp";

const DEFAULT_INPUT = "C:/Users/win10/Desktop/蔡氏一族/蔡承瑾/2023_08_28_18_57_IMG_5737.jpg";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "docs", "perler-hd-experiment");
const inputPath = path.resolve(process.argv[2] ?? DEFAULT_INPUT);

const mardDefinitionsSource = await readFile(
  path.join(PROJECT_ROOT, "backend", "src", "domain", "mard-colors.ts"),
  "utf8",
);
const MARD_291_RAW = [...mardDefinitionsSource.matchAll(
  /\{ code: "([A-Z]+\d+)", hex: "(#[0-9A-F]{6})", finish: "([a-z-]+)" \}/g,
)].map(([, code, hex, finish]) => ({ code, hex, finish }));
if (MARD_291_RAW.length !== 291) throw new Error(`Expected 291 MARD colors, found ${MARD_291_RAW.length}`);

function literalCodeSet(exportName) {
  const block = new RegExp(`export const ${exportName} = \\[([\\s\\S]*?)\\] as const;`).exec(mardDefinitionsSource)?.[1];
  if (!block) throw new Error(`Missing ${exportName}`);
  return new Set([...block.matchAll(/"([A-Z]+\d+)"/g)].map((match) => match[1]));
}

const MARD_48_CODE_SET = literalCodeSet("MARD_48_CODES");
const MARD_72_CODE_SET = literalCodeSet("MARD_72_CODES");
const MARD_144_CODE_SET = new Set([
  ...Array.from({ length: 15 }, (_, index) => `A${index + 1}`),
  ...Array.from({ length: 8 }, (_, index) => `B${index + 1}`),
  ...Array.from({ length: 11 }, (_, index) => `B${index + 10}`),
  ...Array.from({ length: 11 }, (_, index) => `C${index + 1}`),
  ...Array.from({ length: 5 }, (_, index) => `C${index + 13}`),
  ...Array.from({ length: 3 }, (_, index) => `D${index + 1}`),
  ...Array.from({ length: 5 }, (_, index) => `D${index + 5}`),
  ...Array.from({ length: 11 }, (_, index) => `D${index + 11}`),
  ...Array.from({ length: 15 }, (_, index) => `E${index + 1}`),
  ...Array.from({ length: 14 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 17 }, (_, index) => `G${index + 1}`),
  ...Array.from({ length: 14 }, (_, index) => `H${index + 1}`),
  ...Array.from({ length: 15 }, (_, index) => `M${index + 1}`),
]);
const MARD_221_CODE_SET = new Set(MARD_291_RAW.map((color) => color.code)
  .filter((code) => /^(?:A|B|C|D|E|F|G|H|M)\d+$/.test(code)));

const MARD_291 = MARD_291_RAW.map(({ code, hex, finish }) => {
  const rgb = hex.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16));
  return { code, name: code, hex, finish, rgb, lab: rgbToLab(rgb) };
});
const paletteFrom = (id, codeSet) => ({
  id,
  colors: codeSet ? MARD_291.filter((color) => codeSet.has(color.code)) : MARD_291,
});
const MARD_PALETTES = {
  48: paletteFrom("mard-48-v1", MARD_48_CODE_SET),
  72: paletteFrom("mard-72-v1", MARD_72_CODE_SET),
  144: paletteFrom("mard-144-v1", MARD_144_CODE_SET),
  221: paletteFrom("mard-221-v1", MARD_221_CODE_SET),
  291: paletteFrom("mard-291-v1", null),
};
for (const [capacity, palette] of Object.entries(MARD_PALETTES)) {
  if (palette.colors.length !== Number(capacity)) {
    throw new Error(`${palette.id} count mismatch: ${palette.colors.length}`);
  }
}

function clamp(value, lower = 0, upper = 255) {
  return Math.max(lower, Math.min(upper, value));
}

function srgbChannelToLinear(value) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(value) {
  const encoded = value <= 0.0031308
    ? 12.92 * value
    : 1.055 * value ** (1 / 2.4) - 0.055;
  return clamp(encoded * 255);
}

function rgbToLab(rgb) {
  const [red, green, blue] = rgb.map(srgbChannelToLinear);
  const x = (red * 0.4124564 + green * 0.3575761 + blue * 0.1804375) / 0.95047;
  const y = (red * 0.2126729 + green * 0.7151522 + blue * 0.0721750);
  const z = (red * 0.0193339 + green * 0.1191920 + blue * 0.9503041) / 1.08883;
  const f = (value) => value > 216 / 24389
    ? Math.cbrt(value)
    : (24389 / 27 * value + 16) / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

// Sharma, Wu and Dalal's CIEDE2000 implementation, expressed in degrees.
function deltaE2000(left, right) {
  const [l1, a1, b1] = left;
  const [l2, a2, b2] = right;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const hp = (a, b) => {
    if (a === 0 && b === 0) return 0;
    const angle = Math.atan2(b, a) * 180 / Math.PI;
    return angle < 0 ? angle + 360 : angle;
  };
  const hp1 = hp(ap1, b1);
  const hp2 = hp(ap2, b2);
  const dlp = l2 - l1;
  const dcp = cp2 - cp1;
  let dhp;
  if (cp1 * cp2 === 0) dhp = 0;
  else if (Math.abs(hp2 - hp1) <= 180) dhp = hp2 - hp1;
  else if (hp2 <= hp1) dhp = hp2 - hp1 + 360;
  else dhp = hp2 - hp1 - 360;
  const dh = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dhp * Math.PI / 360);
  const lp = (l1 + l2) / 2;
  const cp = (cp1 + cp2) / 2;
  let hpBar;
  if (cp1 * cp2 === 0) hpBar = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) hpBar = (hp1 + hp2) / 2;
  else if (hp1 + hp2 < 360) hpBar = (hp1 + hp2 + 360) / 2;
  else hpBar = (hp1 + hp2 - 360) / 2;
  const t = 1
    - 0.17 * Math.cos((hpBar - 30) * Math.PI / 180)
    + 0.24 * Math.cos(2 * hpBar * Math.PI / 180)
    + 0.32 * Math.cos((3 * hpBar + 6) * Math.PI / 180)
    - 0.20 * Math.cos((4 * hpBar - 63) * Math.PI / 180);
  const dTheta = 30 * Math.exp(-(((hpBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cp ** 7 / (cp ** 7 + 25 ** 7));
  const sl = 1 + 0.015 * (lp - 50) ** 2 / Math.sqrt(20 + (lp - 50) ** 2);
  const sc = 1 + 0.045 * cp;
  const sh = 1 + 0.015 * cp * t;
  const rt = -Math.sin(2 * dTheta * Math.PI / 180) * rc;
  const lTerm = dlp / sl;
  const cTerm = dcp / sc;
  const hTerm = dh / sh;
  return Math.sqrt(lTerm ** 2 + cTerm ** 2 + hTerm ** 2 + rt * cTerm * hTerm);
}

const ciede2000Reference = deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485]);
if (Math.abs(ciede2000Reference - 2.0425) > 0.0001) {
  throw new Error(`CIEDE2000 self-check failed: ${ciede2000Reference}`);
}

function redmeanDistance(rgb, color) {
  const redMean = (rgb[0] + color.rgb[0]) / 2;
  const red = rgb[0] - color.rgb[0];
  const green = rgb[1] - color.rgb[1];
  const blue = rgb[2] - color.rgb[2];
  return (2 + redMean / 256) * red ** 2
    + 4 * green ** 2
    + (2 + (255 - redMean) / 256) * blue ** 2;
}

function nearestColor(rgb, palette, metric) {
  const lab = metric === "ciede2000" ? rgbToLab(rgb) : null;
  let best = palette[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const color of palette) {
    const distance = metric === "ciede2000"
      ? deltaE2000(lab, color.lab)
      : redmeanDistance(rgb, color);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = color;
    }
  }
  return best;
}

async function readMetadata(file) {
  const metadata = await sharp(file).metadata();
  const swap = [5, 6, 7, 8].includes(metadata.orientation);
  return {
    width: swap ? metadata.height : metadata.width,
    height: swap ? metadata.width : metadata.height,
    format: metadata.format,
  };
}

async function sampleImage(file, width, height, kernel) {
  const { data, info } = await sharp(file)
    .rotate()
    .resize(width, height, { fit: "fill", kernel, fastShrinkOnLoad: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`Unexpected channel count: ${info.channels}`);
  return new Uint8ClampedArray(data);
}

function unsharp(data, width, height, amount) {
  const output = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const blur = (
          data[index - width * 3 + channel]
          + data[index + width * 3 + channel]
          + data[index - 3 + channel]
          + data[index + 3 + channel]
        ) / 4;
        output[index + channel] = clamp(data[index + channel] + (data[index + channel] - blur) * amount);
      }
    }
  }
  return output;
}

function pixels(data) {
  const result = [];
  for (let offset = 0; offset < data.length; offset += 3) {
    result.push([data[offset], data[offset + 1], data[offset + 2]]);
  }
  return result;
}

function selectPalette(sourcePixels, availablePalette, maximumColors, metric) {
  const counts = new Map(availablePalette.map((color) => [color.code, 0]));
  for (const rgb of sourcePixels) {
    const color = nearestColor(rgb, availablePalette, metric);
    counts.set(color.code, counts.get(color.code) + 1);
  }
  const selectedCodes = [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, maximumColors)
    .map(([code]) => code);
  return availablePalette.filter((color) => selectedCodes.includes(color.code));
}

function quantize(source, width, height, options) {
  const sourcePixels = pixels(source);
  const palette = selectPalette(sourcePixels, options.palette.colors, options.maxColors, options.metric);
  const cells = new Array(width * height);
  if (!options.ditherStrength) {
    for (let index = 0; index < sourcePixels.length; index += 1) {
      cells[index] = nearestColor(sourcePixels[index], palette, options.metric);
    }
    return { cells, palette };
  }

  // Error is diffused in linear-light RGB; matching still uses CIEDE2000.
  const work = new Float64Array(sourcePixels.length * 3);
  for (let index = 0; index < sourcePixels.length; index += 1) {
    const rgb = sourcePixels[index];
    work[index * 3] = srgbChannelToLinear(rgb[0]);
    work[index * 3 + 1] = srgbChannelToLinear(rgb[1]);
    work[index * 3 + 2] = srgbChannelToLinear(rgb[2]);
  }
  const diffuse = (x, y, error, weight) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      work[offset + channel] = clamp(
        work[offset + channel] + error[channel] * weight * options.ditherStrength,
        0,
        1,
      );
    }
  };
  for (let y = 0; y < height; y += 1) {
    const leftToRight = y % 2 === 0;
    const start = leftToRight ? 0 : width - 1;
    const end = leftToRight ? width : -1;
    const step = leftToRight ? 1 : -1;
    for (let x = start; x !== end; x += step) {
      const index = y * width + x;
      const offset = index * 3;
      const rgb = [
        linearChannelToSrgb(work[offset]),
        linearChannelToSrgb(work[offset + 1]),
        linearChannelToSrgb(work[offset + 2]),
      ];
      const matched = nearestColor(rgb, palette, options.metric);
      cells[index] = matched;
      const matchedLinear = matched.rgb.map(srgbChannelToLinear);
      const error = [
        work[offset] - matchedLinear[0],
        work[offset + 1] - matchedLinear[1],
        work[offset + 2] - matchedLinear[2],
      ];
      if (leftToRight) {
        diffuse(x + 1, y, error, 7 / 16);
        diffuse(x - 1, y + 1, error, 3 / 16);
        diffuse(x, y + 1, error, 5 / 16);
        diffuse(x + 1, y + 1, error, 1 / 16);
      } else {
        diffuse(x - 1, y, error, 7 / 16);
        diffuse(x + 1, y + 1, error, 3 / 16);
        diffuse(x, y + 1, error, 5 / 16);
        diffuse(x - 1, y + 1, error, 1 / 16);
      }
    }
  }
  return { cells, palette };
}

function luminance(rgb) {
  return 0.2126 * srgbChannelToLinear(rgb[0])
    + 0.7152 * srgbChannelToLinear(rgb[1])
    + 0.0722 * srgbChannelToLinear(rgb[2]);
}

function sobel(values, width, height) {
  const output = new Float64Array(values.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = (dx, dy) => values[(y + dy) * width + x + dx];
      const gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1);
      const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
      output[y * width + x] = Math.hypot(gx, gy);
    }
  }
  return output;
}

function pearson(left, right, indices) {
  const count = indices.length;
  const leftMean = indices.reduce((sum, index) => sum + left[index], 0) / count;
  const rightMean = indices.reduce((sum, index) => sum + right[index], 0) / count;
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (const index of indices) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    numerator += a * b;
    leftSquare += a * a;
    rightSquare += b * b;
  }
  return numerator / Math.sqrt(leftSquare * rightSquare || 1);
}

function calculateMetrics(referenceData, result, width, height) {
  const reference = pixels(referenceData);
  const rendered = result.cells.map((color) => color.rgb);
  const differences = reference.map((rgb, index) => deltaE2000(rgbToLab(rgb), result.cells[index].lab));
  const sorted = [...differences].sort((a, b) => a - b);
  const faceIndices = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= width * 0.16 && x <= width * 0.84 && y >= height * 0.02 && y <= height * 0.64) {
        faceIndices.push(y * width + x);
      }
    }
  }
  const referenceLuma = reference.map(luminance);
  const renderedLuma = rendered.map(luminance);
  const edgeReference = sobel(referenceLuma, width, height);
  const edgeRendered = sobel(renderedLuma, width, height);
  const interior = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) interior.push(y * width + x);
  }
  let neighborPairs = 0;
  let transitions = 0;
  let isolated = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const code = result.cells[index].code;
      if (x + 1 < width) {
        neighborPairs += 1;
        if (code !== result.cells[index + 1].code) transitions += 1;
      }
      if (y + 1 < height) {
        neighborPairs += 1;
        if (code !== result.cells[index + width].code) transitions += 1;
      }
      const neighbors = [];
      if (x > 0) neighbors.push(index - 1);
      if (x + 1 < width) neighbors.push(index + 1);
      if (y > 0) neighbors.push(index - width);
      if (y + 1 < height) neighbors.push(index + width);
      if (neighbors.every((neighbor) => result.cells[neighbor].code !== code)) isolated += 1;
    }
  }
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    meanDeltaE00: average(differences),
    p95DeltaE00: sorted[Math.floor(sorted.length * 0.95)],
    faceMeanDeltaE00: average(faceIndices.map((index) => differences[index])),
    edgeCorrelation: pearson(edgeReference, edgeRendered, interior),
    transitionRate: transitions / neighborPairs,
    isolatedRate: isolated / result.cells.length,
    uniqueColors: new Set(result.cells.map((color) => color.code)).size,
    beadCount: width * height,
  };
}

function roundMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [
    key,
    typeof value === "number" ? Number(value.toFixed(4)) : value,
  ]));
}

async function renderGrid(result, width, height, outputPath, cellSize = 10) {
  const canvasWidth = width * cellSize;
  const canvasHeight = height * cellSize;
  const radius = Math.max(1.5, cellSize * 0.43);
  const circles = result.cells.map((color, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    return `<circle cx="${x * cellSize + cellSize / 2}" cy="${y * cellSize + cellSize / 2}" r="${radius}" fill="${color.hex}"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}"><rect width="100%" height="100%" fill="#d9d7d1"/>${circles}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

async function renderPixelPreview(result, width, height, outputPath, scale = 10) {
  const buffer = Buffer.alloc(width * height * 3);
  result.cells.forEach((color, index) => {
    buffer[index * 3] = color.rgb[0];
    buffer[index * 3 + 1] = color.rgb[1];
    buffer[index * 3 + 2] = color.rgb[2];
  });
  await sharp(buffer, { raw: { width, height, channels: 3 } })
    .resize(width * scale, height * scale, { kernel: "nearest" })
    .png()
    .toFile(outputPath);
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function contactSheet(items, outputPath, columns = 2) {
  const tileWidth = 560;
  const tileHeight = 760;
  const labelHeight = 54;
  const rows = Math.ceil(items.length / columns);
  const composites = [];
  for (let index = 0; index < items.length; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const image = await sharp(items[index].path)
      .resize(tileWidth - 30, tileHeight - labelHeight - 30, { fit: "contain", background: "#ffffff" })
      .png()
      .toBuffer();
    composites.push({ input: image, left: column * tileWidth + 15, top: row * tileHeight + labelHeight });
    const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileWidth}" height="${labelHeight}"><rect width="100%" height="100%" fill="#f7f5f0"/><text x="20" y="35" font-family="Arial, Microsoft YaHei, sans-serif" font-size="21" fill="#1d1d1f">${escapeXml(items[index].label)}</text></svg>`;
    composites.push({ input: Buffer.from(label), left: column * tileWidth, top: row * tileHeight });
  }
  await sharp({ create: { width: tileWidth * columns, height: tileHeight * rows, channels: 3, background: "#f7f5f0" } })
    .composite(composites)
    .png()
    .toFile(outputPath);
}

function gridDimensions(sourceWidth, sourceHeight, longSide) {
  return sourceWidth >= sourceHeight
    ? { width: longSide, height: Math.round(longSide * sourceHeight / sourceWidth) }
    : { width: Math.round(longSide * sourceWidth / sourceHeight), height: longSide };
}

async function runCase(definition, metadata) {
  const { width, height } = gridDimensions(metadata.width, metadata.height, definition.longSide);
  let sampled = await sampleImage(inputPath, width, height, definition.kernel);
  if (definition.sharpen) sampled = unsharp(sampled, width, height, definition.sharpen);
  const result = quantize(sampled, width, height, definition);
  const reference = await sampleImage(inputPath, width, height, "lanczos3");
  const metrics = roundMetrics(calculateMetrics(reference, result, width, height));
  const previewPath = path.join(OUTPUT_DIR, `${definition.id}.png`);
  await renderGrid(result, width, height, previewPath, Math.max(7, Math.floor(640 / height)));
  return { ...definition, width, height, result, metrics, previewPath };
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function makeCsv(rows) {
  const headers = Object.keys(rows[0]);
  return [headers, ...rows.map((row) => headers.map((header) => row[header]))]
    .map((row) => row.map(csvCell).join(","))
    .join("\n") + "\n";
}

await mkdir(OUTPUT_DIR, { recursive: true });
const metadata = await readMetadata(inputPath);
if (!metadata.width || !metadata.height) throw new Error("Unable to read source dimensions");

const common = { longSide: 64, maxColors: 32, palette: MARD_PALETTES[291] };
const algorithmDefinitions = [
  { ...common, id: "algorithm-a-nearest-redmean", label: "A 最近邻 + Redmean + 无抖动", kernel: "nearest", metric: "redmean", ditherStrength: 0, sharpen: 0 },
  { ...common, id: "algorithm-b-lanczos-redmean", label: "B Lanczos3 + Redmean + 无抖动", kernel: "lanczos3", metric: "redmean", ditherStrength: 0, sharpen: 0 },
  { ...common, id: "algorithm-c-lanczos-ciede2000", label: "C Lanczos3 + CIEDE2000 + 无抖动", kernel: "lanczos3", metric: "ciede2000", ditherStrength: 0, sharpen: 0 },
  { ...common, id: "algorithm-d-lanczos-ciede2000-fs35", label: "D CIEDE2000 + 35% FS 抖动", kernel: "lanczos3", metric: "ciede2000", ditherStrength: 0.35, sharpen: 0 },
  { ...common, id: "algorithm-e-lanczos-sharp-ciede2000", label: "E CIEDE2000 + 低分辨率锐化", kernel: "lanczos3", metric: "ciede2000", ditherStrength: 0, sharpen: 0.55 },
  { ...common, id: "algorithm-f-lanczos-sharp-ciede2000-fs35", label: "F 锐化 + CIEDE2000 + 35% FS", kernel: "lanczos3", metric: "ciede2000", ditherStrength: 0.35, sharpen: 0.55 },
];

const sizeDefinitions = [32, 48, 64, 96].map((longSide) => ({
  id: `size-${longSide}`,
  label: `${Math.round(longSide * metadata.width / metadata.height)}×${longSide} / MARD 291 / 最多 32 色`,
  longSide,
  maxColors: 32,
  palette: MARD_PALETTES[291],
  kernel: "lanczos3",
  metric: "ciede2000",
  ditherStrength: 0,
  sharpen: 0,
}));

const colorDefinitions = [16, 24, 32].map((maxColors) => ({
  id: `colors-${maxColors}`,
  label: `48×64 / MARD 291 / 最多 ${maxColors} 色`,
  longSide: 64,
  maxColors,
  palette: MARD_PALETTES[291],
  kernel: "lanczos3",
  metric: "ciede2000",
  ditherStrength: 0,
  sharpen: 0,
}));

const paletteDefinitions = [
  { capacity: 48, maxColors: 16 },
  { capacity: 72, maxColors: 16 },
  { capacity: 144, maxColors: 24 },
  { capacity: 221, maxColors: 24 },
  { capacity: 291, maxColors: 32 },
].map(({ capacity, maxColors }) => ({
  id: `palette-${capacity}`,
  label: `48×64 / MARD ${capacity} / 最多 ${maxColors} 色`,
  longSide: 64,
  maxColors,
  palette: MARD_PALETTES[capacity],
  kernel: "lanczos3",
  metric: "ciede2000",
  ditherStrength: 0,
  sharpen: 0,
}));

const algorithmRuns = [];
for (const definition of algorithmDefinitions) algorithmRuns.push(await runCase(definition, metadata));
const sizeRuns = [];
for (const definition of sizeDefinitions) sizeRuns.push(await runCase(definition, metadata));
const colorRuns = [];
for (const definition of colorDefinitions) colorRuns.push(await runCase(definition, metadata));
const paletteRuns = [];
for (const definition of paletteDefinitions) paletteRuns.push(await runCase(definition, metadata));

await contactSheet(algorithmRuns.map((run) => ({ path: run.previewPath, label: run.label })), path.join(OUTPUT_DIR, "comparison-algorithms.png"), 3);
await contactSheet(sizeRuns.map((run) => ({ path: run.previewPath, label: run.label })), path.join(OUTPUT_DIR, "comparison-grid-sizes.png"), 2);
await contactSheet(colorRuns.map((run) => ({ path: run.previewPath, label: run.label })), path.join(OUTPUT_DIR, "comparison-color-counts.png"), 2);
await contactSheet(paletteRuns.map((run) => ({ path: run.previewPath, label: run.label })), path.join(OUTPUT_DIR, "comparison-palette-capacities.png"), 3);

const recommended = paletteRuns.find((run) => run.palette.id === "mard-291-v1");
await renderGrid(recommended.result, recommended.width, recommended.height, path.join(OUTPUT_DIR, "recommended-48x64-bead-grid.png"), 14);
await renderPixelPreview(recommended.result, recommended.width, recommended.height, path.join(OUTPUT_DIR, "recommended-48x64-pixel-preview.png"), 14);

const usage = new Map();
for (const color of recommended.result.cells) usage.set(color.code, (usage.get(color.code) ?? 0) + 1);
const materialRows = [...usage.entries()]
  .map(([code, quantity]) => {
    const color = recommended.palette.colors.find((entry) => entry.code === code);
    return { code, name: color.name, hex: color.hex, quantity };
  })
  .sort((left, right) => right.quantity - left.quantity || left.code.localeCompare(right.code));
await writeFile(path.join(OUTPUT_DIR, "recommended-48x64-materials.csv"), makeCsv(materialRows), "utf8");

const serializable = (run, family) => ({
  family,
  id: run.id,
  label: run.label,
  width: run.width,
  height: run.height,
  longSide: run.longSide,
  maxColors: run.maxColors,
  paletteId: run.palette.id,
  paletteCapacity: run.palette.colors.length,
  kernel: run.kernel,
  metric: run.metric,
  ditherStrength: run.ditherStrength,
  sharpen: run.sharpen,
  ...run.metrics,
});
const metricRows = [
  ...algorithmRuns.map((run) => serializable(run, "algorithm")),
  ...sizeRuns.map((run) => serializable(run, "grid-size")),
  ...colorRuns.map((run) => serializable(run, "color-count")),
  ...paletteRuns.map((run) => serializable(run, "palette-capacity")),
];
await writeFile(path.join(OUTPUT_DIR, "metrics.csv"), makeCsv(metricRows), "utf8");
await writeFile(path.join(OUTPUT_DIR, "experiment-manifest.json"), JSON.stringify({
  source: { path: inputPath, ...metadata },
  palettes: Object.values(MARD_PALETTES).map((palette) => ({ id: palette.id, colors: palette.colors.length })),
  paletteSource: {
    name: "maxcleme/beadcolors MARD dataset",
    revision: "f97ff4283d03cef5cd7e1071a86f5892e0c0c61b",
    commercialAccuracy: false,
  },
  faceRoi: { x: [0.16, 0.84], y: [0.02, 0.64], note: "Manual normalized ROI for this one portrait; no face detector was used." },
  runs: metricRows,
}, null, 2) + "\n", "utf8");

console.log(JSON.stringify({ outputDirectory: OUTPUT_DIR, source: metadata, runs: metricRows }, null, 2));
