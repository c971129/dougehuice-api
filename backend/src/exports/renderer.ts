import { createHash } from "node:crypto";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import { MAX_GRID_CELLS, MAX_GRID_SIDE } from "../domain/grid.js";
import type { Palette, ProjectDetail } from "../domain/models.js";
import { AppError } from "../errors.js";

export type ExportFormat = "png" | "pdf";
export type ExportOrientation = "auto" | "portrait" | "landscape";

export interface NormalizedExportOptions {
  paper: "A4";
  orientation: ExportOrientation;
  showCodes: boolean;
  showGrid: boolean;
  transparentBackground: boolean;
}

export interface RenderedExport {
  contents: Buffer;
  mimeType: "image/png" | "application/pdf";
  fileName: string;
  sha256: string;
  pageCount: number;
}

export interface RenderProjectExportInput {
  project: ProjectDetail;
  palette: Palette;
  format: ExportFormat;
  fileName?: string;
  options?: unknown;
  signal?: AbortSignal;
}

const ALLOWED_OPTION_KEYS = new Set([
  "paper",
  "orientation",
  "showCodes",
  "showGrid",
  "transparentBackground",
]);
const MAX_PALETTE_COLORS = 512;
const MAX_USED_COLORS = 256;
const MAX_PNG_PIXELS = 30_000_000;
const MAX_PDF_GRID_PAGES = 4_096;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const PDF_METADATA_DATE = new Date("2000-01-01T00:00:00.000Z");
const PDF_LEGEND_COLUMNS = 2;
const PDF_LEGEND_START_Y = 154;
const PDF_LEGEND_ITEM_HEIGHT = 38;
const PDF_LEGEND_ROW_HEIGHT = 58;
const PDF_LEGEND_FOOTER_RESERVED_HEIGHT = 84;

function throwIfRenderAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("EXPORT_RENDER_ABORTED");
  }
}

export function normalizeExportOptions(value: unknown): NormalizedExportOptions {
  if (value === undefined || value === null) value = {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "INVALID_EXPORT_OPTIONS", "导出设置必须是对象");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !ALLOWED_OPTION_KEYS.has(key));
  if (unknown.length > 0) {
    throw new AppError(400, "UNKNOWN_EXPORT_OPTION", "导出设置包含不支持的字段", { fields: unknown });
  }
  const paper = input.paper ?? "A4";
  const orientation = input.orientation ?? "auto";
  const showCodes = input.showCodes ?? true;
  const showGrid = input.showGrid ?? true;
  const transparentBackground = input.transparentBackground ?? false;
  if (paper !== "A4") throw new AppError(400, "UNSUPPORTED_EXPORT_PAPER", "首版仅支持 A4 纸张");
  if (!(["auto", "portrait", "landscape"] as const).includes(orientation as ExportOrientation)) {
    throw new AppError(400, "INVALID_EXPORT_ORIENTATION", "导出方向必须是 auto、portrait 或 landscape");
  }
  if (typeof showCodes !== "boolean" || typeof showGrid !== "boolean" || typeof transparentBackground !== "boolean") {
    throw new AppError(400, "INVALID_EXPORT_OPTIONS", "导出开关必须是布尔值");
  }
  return { paper, orientation: orientation as ExportOrientation, showCodes, showGrid, transparentBackground };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function toWellFormedUnicode(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] ?? "";
        result += value[index + 1] ?? "";
        index += 1;
      } else {
        result += "\ufffd";
      }
      continue;
    }
    if (current >= 0xdc00 && current <= 0xdfff) {
      result += "\ufffd";
      continue;
    }
    result += value[index] ?? "";
  }
  return result;
}

export function normalizeExportBaseName(value: string, fallback = "pindou-pattern"): string {
  const normalized = toWellFormedUnicode(value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = Array.from(normalized).slice(0, 80).join("");
  return truncated || toWellFormedUnicode(fallback);
}

function textColor(hex: string): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#25313a" : "#ffffff";
}

function validateProjectPalette(project: ProjectDetail, palette: Palette): Map<string, { name: string; hex: string }> {
  if (project.paletteId !== palette.id) {
    throw new AppError(500, "EXPORT_PALETTE_MISMATCH", "项目与导出色卡不一致");
  }
  if (!Number.isInteger(project.grid.width) || !Number.isInteger(project.grid.height)
    || project.grid.width < 1 || project.grid.height < 1) {
    throw new AppError(500, "EXPORT_GRID_CORRUPTED", "项目网格尺寸无效");
  }
  const cellCount = project.grid.width * project.grid.height;
  if (project.grid.width > MAX_GRID_SIDE || project.grid.height > MAX_GRID_SIDE || cellCount > MAX_GRID_CELLS) {
    throw new AppError(422, "EXPORT_RENDER_LIMIT_EXCEEDED", "图纸尺寸超出安全导出上限", {
      maxGridSide: MAX_GRID_SIDE,
      maxGridCells: MAX_GRID_CELLS,
    });
  }
  if (!Array.isArray(project.grid.cells)) {
    throw new AppError(500, "EXPORT_GRID_CORRUPTED", "项目网格数据格式无效");
  }
  if (project.grid.cells.length !== project.grid.width * project.grid.height) {
    throw new AppError(500, "EXPORT_GRID_CORRUPTED", "项目网格数据不完整");
  }
  if (palette.colors.length > MAX_PALETTE_COLORS) {
    throw new AppError(422, "EXPORT_RENDER_LIMIT_EXCEEDED", "色卡规模超出安全导出上限", {
      maxPaletteColors: MAX_PALETTE_COLORS,
    });
  }
  for (const color of palette.colors) {
    if (!/^#[0-9a-f]{6}$/i.test(color.hex)) {
      throw new AppError(500, "EXPORT_PALETTE_CORRUPTED", "色卡包含无效颜色值");
    }
  }
  const colors = new Map(palette.colors.map((color) => [color.code, { name: color.name, hex: color.hex }]));
  if (colors.size !== palette.colors.length) {
    throw new AppError(500, "EXPORT_PALETTE_CORRUPTED", "色卡包含重复色号");
  }
  const usedCodes = new Set<string>();
  for (const code of project.grid.cells) {
    if (code !== null && !colors.has(code)) {
      throw new AppError(500, "EXPORT_COLOR_NOT_FOUND", "项目包含色卡中不存在的色号", { colorCode: code });
    }
    if (code !== null) usedCodes.add(code);
  }
  if (usedCodes.size > MAX_USED_COLORS) {
    throw new AppError(422, "EXPORT_RENDER_LIMIT_EXCEEDED", "图纸使用的颜色数量超出安全导出上限", {
      maxUsedColors: MAX_USED_COLORS,
    });
  }
  return colors;
}

function assertRenderedSize(contents: Buffer): void {
  if (contents.length === 0) throw new AppError(500, "EXPORT_RENDER_EMPTY", "导出渲染结果为空");
  if (contents.length > MAX_EXPORT_BYTES) {
    throw new AppError(422, "EXPORT_OUTPUT_LIMIT_EXCEEDED", "导出文件超出安全大小上限", {
      maxBytes: MAX_EXPORT_BYTES,
    });
  }
}

function usedColorCounts(project: ProjectDetail): Map<string, number> {
  const result = new Map<string, number>();
  for (const code of project.grid.cells) {
    if (code !== null) result.set(code, (result.get(code) ?? 0) + 1);
  }
  return result;
}

function svgDocument(width: number, height: number, body: string, transparent: boolean): string {
  const background = transparent ? "" : `<rect width="${width}" height="${height}" fill="#ffffff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${background}
  <style>text{font-family:"Microsoft YaHei","Noto Sans CJK SC",Arial,sans-serif}</style>
  ${body}
</svg>`;
}

function gridElements(input: {
  project: ProjectDetail;
  colors: Map<string, { name: string; hex: string }>;
  options: NormalizedExportOptions;
  startColumn: number;
  endColumn: number;
  startRow: number;
  endRow: number;
  cellSize: number;
  originX: number;
  originY: number;
}): string {
  const elements: string[] = [];
  const codeSize = Math.max(7, Math.min(13, Math.floor(input.cellSize * 0.3)));
  for (let row = input.startRow; row < input.endRow; row += 1) {
    for (let column = input.startColumn; column < input.endColumn; column += 1) {
      const code = input.project.grid.cells[row * input.project.grid.width + column] ?? null;
      const color = code ? input.colors.get(code) : undefined;
      const x = input.originX + (column - input.startColumn) * input.cellSize;
      const y = input.originY + (row - input.startRow) * input.cellSize;
      elements.push(`<rect x="${x}" y="${y}" width="${input.cellSize}" height="${input.cellSize}" fill="${color?.hex ?? "#ffffff"}"${input.options.showGrid ? ' stroke="#8e9aa2" stroke-width="0.8"' : ""}/>`);
      if (code && input.options.showCodes && input.cellSize >= 24) {
        elements.push(`<text x="${x + input.cellSize / 2}" y="${y + input.cellSize / 2}" fill="${textColor(color?.hex ?? "#ffffff")}" font-size="${codeSize}" font-weight="700" text-anchor="middle" dominant-baseline="central">${escapeXml(code)}</text>`);
      }
    }
  }
  if (input.options.showGrid) {
    const chunkWidth = (input.endColumn - input.startColumn) * input.cellSize;
    const chunkHeight = (input.endRow - input.startRow) * input.cellSize;
    for (let column = input.startColumn; column <= input.endColumn; column += 1) {
      const isEdge = column === input.startColumn || column === input.endColumn;
      if (!isEdge && column % 5 !== 0) continue;
      const x = input.originX + (column - input.startColumn) * input.cellSize;
      const strokeWidth = isEdge || column % 10 === 0 ? 2.4 : 1.5;
      elements.push(`<line x1="${x}" y1="${input.originY}" x2="${x}" y2="${input.originY + chunkHeight}" stroke="#46545e" stroke-width="${strokeWidth}"/>`);
    }
    for (let row = input.startRow; row <= input.endRow; row += 1) {
      const isEdge = row === input.startRow || row === input.endRow;
      if (!isEdge && row % 5 !== 0) continue;
      const y = input.originY + (row - input.startRow) * input.cellSize;
      const strokeWidth = isEdge || row % 10 === 0 ? 2.4 : 1.5;
      elements.push(`<line x1="${input.originX}" y1="${y}" x2="${input.originX + chunkWidth}" y2="${y}" stroke="#46545e" stroke-width="${strokeWidth}"/>`);
    }
  }
  return elements.join("\n");
}

function registrationMarks(originX: number, originY: number, width: number, height: number): string {
  const marks: string[] = [];
  for (const [x, y, horizontalDirection, verticalDirection] of [
    [originX, originY, -1, -1],
    [originX + width, originY, 1, -1],
    [originX, originY + height, -1, 1],
    [originX + width, originY + height, 1, 1],
  ] as const) {
    marks.push(`<line x1="${x + horizontalDirection * 5}" y1="${y}" x2="${x + horizontalDirection * 18}" y2="${y}" stroke="#202a31" stroke-width="2"/>`);
    marks.push(`<line x1="${x}" y1="${y + verticalDirection * 5}" x2="${x}" y2="${y + verticalDirection * 18}" stroke="#202a31" stroke-width="2"/>`);
  }
  return marks.join("\n");
}

function pdfLegendItemsPerPage(pixelHeight: number): number {
  const contentBottom = pixelHeight - PDF_LEGEND_FOOTER_RESERVED_HEIGHT;
  const rows = Math.floor(
    (contentBottom - PDF_LEGEND_START_Y - PDF_LEGEND_ITEM_HEIGHT) / PDF_LEGEND_ROW_HEIGHT,
  ) + 1;
  if (rows < 1) {
    throw new AppError(500, "EXPORT_LEGEND_LAYOUT_INVALID", "PDF 图例页面没有可用空间");
  }
  return rows * PDF_LEGEND_COLUMNS;
}

async function renderPng(
  project: ProjectDetail,
  palette: Palette,
  options: NormalizedExportOptions,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfRenderAborted(signal);
  const colors = validateProjectPalette(project, palette);
  const counts = usedColorCounts(project);
  const maxGridEdge = Math.max(project.grid.width, project.grid.height);
  const cellSize = Math.max(1, Math.min(40, Math.floor(3_520 / maxGridEdge)));
  const margin = 28;
  const headerHeight = 102;
  const legendWidth = 330;
  const gridWidth = project.grid.width * cellSize;
  const gridHeight = project.grid.height * cellSize;
  const legendHeight = Math.max(180, counts.size * 42 + 86);
  const width = gridWidth + legendWidth + margin * 3;
  const height = Math.max(gridHeight + headerHeight + margin, legendHeight + headerHeight);
  if (width * height > MAX_PNG_PIXELS) {
    throw new AppError(422, "EXPORT_RENDER_LIMIT_EXCEEDED", "PNG 像素数量超出安全导出上限", {
      maxPixels: MAX_PNG_PIXELS,
    });
  }
  const beadCount = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const body: string[] = [
    `<text x="${margin}" y="42" fill="#202a31" font-size="28" font-weight="800">${escapeXml(project.name)}</text>`,
    `<text x="${margin}" y="73" fill="#66747d" font-size="16">${project.grid.width} × ${project.grid.height} 格 · ${counts.size} 色 · ${beadCount} 颗 · 版本 ${project.currentRevision}</text>`,
    gridElements({
      project,
      colors,
      options,
      startColumn: 0,
      endColumn: project.grid.width,
      startRow: 0,
      endRow: project.grid.height,
      cellSize,
      originX: margin,
      originY: headerHeight,
    }),
    `<text x="${margin * 2 + gridWidth}" y="${headerHeight + 3}" fill="#202a31" font-size="21" font-weight="800">材料图例</text>`,
  ];
  let legendY = headerHeight + 32;
  for (const [code, count] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const color = colors.get(code);
    body.push(`<rect x="${margin * 2 + gridWidth}" y="${legendY}" width="26" height="26" rx="5" fill="${color?.hex ?? "#ffffff"}" stroke="#c7ced2"/>`);
    body.push(`<text x="${margin * 2 + gridWidth + 38}" y="${legendY + 18}" fill="#263139" font-size="15" font-weight="700">${escapeXml(code)} · ${escapeXml(color?.name ?? "")}</text>`);
    body.push(`<text x="${width - margin}" y="${legendY + 18}" fill="#66747d" font-size="15" text-anchor="end">${count} 颗</text>`);
    legendY += 42;
  }
  throwIfRenderAborted(signal);
  const svg = svgDocument(width, height, body.join("\n"), options.transparentBackground);
  const contents = await sharp(Buffer.from(svg), { limitInputPixels: MAX_PNG_PIXELS })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  throwIfRenderAborted(signal);
  return contents;
}

function resolveOrientation(project: ProjectDetail, orientation: ExportOrientation): "portrait" | "landscape" {
  if (orientation !== "auto") return orientation;
  return project.grid.width > project.grid.height * 1.15 ? "landscape" : "portrait";
}

async function renderPdf(
  project: ProjectDetail,
  palette: Palette,
  options: NormalizedExportOptions,
  signal?: AbortSignal,
): Promise<{ contents: Buffer; pageCount: number }> {
  throwIfRenderAborted(signal);
  const colors = validateProjectPalette(project, palette);
  const counts = usedColorCounts(project);
  const orientation = resolveOrientation(project, options.orientation);
  const pageWidth = orientation === "landscape" ? 842 : 595;
  const pageHeight = orientation === "landscape" ? 595 : 842;
  const columnsPerPage = orientation === "landscape" ? 38 : 26;
  const rowsPerPage = orientation === "landscape" ? 22 : 34;
  const cellSize = 34;
  const pixelWidth = orientation === "landscape" ? 1684 : 1190;
  const pixelHeight = orientation === "landscape" ? 1190 : 1684;
  const totalColumnPages = Math.ceil(project.grid.width / columnsPerPage);
  const totalRowPages = Math.ceil(project.grid.height / rowsPerPage);
  const gridPageCount = totalColumnPages * totalRowPages;
  if (gridPageCount > MAX_PDF_GRID_PAGES) {
    throw new AppError(422, "EXPORT_RENDER_LIMIT_EXCEEDED", "PDF 页数超出安全导出上限", {
      maxGridPages: MAX_PDF_GRID_PAGES,
    });
  }
  const sortedCounts = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
  const legendItemsPerPage = pdfLegendItemsPerPage(pixelHeight);
  const legendPageCount = Math.max(1, Math.ceil(sortedCounts.length / legendItemsPerPage));
  const totalPageCount = gridPageCount + legendPageCount;
  const pdf = await PDFDocument.create({ updateMetadata: false });
  throwIfRenderAborted(signal);
  pdf.setProducer("Pindou Export Renderer");
  pdf.setCreator("Pindou Export Renderer");
  pdf.setCreationDate(PDF_METADATA_DATE);
  pdf.setModificationDate(PDF_METADATA_DATE);
  let pageNumber = 0;

  for (let rowPage = 0; rowPage < totalRowPages; rowPage += 1) {
    for (let columnPage = 0; columnPage < totalColumnPages; columnPage += 1) {
      throwIfRenderAborted(signal);
      pageNumber += 1;
      const startColumn = columnPage * columnsPerPage;
      const endColumn = Math.min(project.grid.width, startColumn + columnsPerPage);
      const startRow = rowPage * rowsPerPage;
      const endRow = Math.min(project.grid.height, startRow + rowsPerPage);
      const chunkWidth = (endColumn - startColumn) * cellSize;
      const chunkHeight = (endRow - startRow) * cellSize;
      const originX = Math.floor((pixelWidth - chunkWidth) / 2);
      const originY = 184;
      const locatorLabels = [
        columnPage > 0 ? `← 左页 C${Math.max(1, startColumn - columnsPerPage + 1)}–${startColumn}` : null,
        columnPage + 1 < totalColumnPages ? `右页 C${endColumn + 1}–${Math.min(project.grid.width, endColumn + columnsPerPage)} →` : null,
        rowPage > 0 ? `↑ 上页 R${Math.max(1, startRow - rowsPerPage + 1)}–${startRow}` : null,
        rowPage + 1 < totalRowPages ? `下页 R${endRow + 1}–${Math.min(project.grid.height, endRow + rowsPerPage)} ↓` : null,
      ].filter((label): label is string => label !== null);
      const body = [
        `<text x="54" y="62" fill="#202a31" font-size="30" font-weight="800">${escapeXml(project.name)}</text>`,
        `<text x="54" y="102" fill="#66747d" font-size="18">行 ${startRow + 1}–${endRow} · 列 ${startColumn + 1}–${endColumn} · 版本 ${project.currentRevision}</text>`,
        locatorLabels.length > 0
          ? `<text x="54" y="137" fill="#46545e" font-size="15">拼接定位：${escapeXml(locatorLabels.join(" · "))}</text>`
          : "",
        gridElements({ project, colors, options, startColumn, endColumn, startRow, endRow, cellSize, originX, originY }),
        registrationMarks(originX, originY, chunkWidth, chunkHeight),
        `<text x="${pixelWidth / 2}" y="${pixelHeight - 42}" fill="#66747d" font-size="16" text-anchor="middle">第 ${pageNumber} / ${totalPageCount} 页</text>`,
      ].join("\n");
      const png = await sharp(Buffer.from(svgDocument(pixelWidth, pixelHeight, body, false)), { limitInputPixels: 20_000_000 }).png().toBuffer();
      throwIfRenderAborted(signal);
      const embedded = await pdf.embedPng(png);
      throwIfRenderAborted(signal);
      const page = pdf.addPage([pageWidth, pageHeight]);
      page.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
    }
  }

  const beadCount = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const itemWidth = Math.floor((pixelWidth - 108) / 2);
  for (let legendPageIndex = 0; legendPageIndex < legendPageCount; legendPageIndex += 1) {
    throwIfRenderAborted(signal);
    const legendBody: string[] = [
      `<text x="54" y="64" fill="#202a31" font-size="32" font-weight="800">${escapeXml(project.name)} · 材料图例</text>`,
      `<text x="54" y="106" fill="#66747d" font-size="19">${project.grid.width} × ${project.grid.height} 格 · ${counts.size} 色 · ${beadCount} 颗 · 图例 ${legendPageIndex + 1} / ${legendPageCount}</text>`,
    ];
    let x = 54;
    let y = PDF_LEGEND_START_Y;
    const pageCounts = sortedCounts.slice(
      legendPageIndex * legendItemsPerPage,
      (legendPageIndex + 1) * legendItemsPerPage,
    );
    for (const [code, count] of pageCounts) {
      const color = colors.get(code);
      legendBody.push(`<rect x="${x}" y="${y}" width="38" height="38" rx="7" fill="${color?.hex ?? "#ffffff"}" stroke="#c7ced2"/>`);
      legendBody.push(`<text x="${x + 54}" y="${y + 25}" fill="#263139" font-size="18" font-weight="700">${escapeXml(code)} · ${escapeXml(color?.name ?? "")}</text>`);
      legendBody.push(`<text x="${x + itemWidth - 18}" y="${y + 25}" fill="#66747d" font-size="18" text-anchor="end">${count} 颗</text>`);
      if (x > 54) {
        x = 54;
        y += PDF_LEGEND_ROW_HEIGHT;
      } else {
        x = 54 + itemWidth;
      }
    }
    const legendPageNumber = gridPageCount + legendPageIndex + 1;
    legendBody.push(`<text x="${pixelWidth / 2}" y="${pixelHeight - 42}" fill="#66747d" font-size="16" text-anchor="middle">第 ${legendPageNumber} / ${totalPageCount} 页</text>`);
    const legendPng = await sharp(Buffer.from(svgDocument(pixelWidth, pixelHeight, legendBody.join("\n"), false)), { limitInputPixels: 20_000_000 }).png().toBuffer();
    throwIfRenderAborted(signal);
    const legendImage = await pdf.embedPng(legendPng);
    throwIfRenderAborted(signal);
    const legendPage = pdf.addPage([pageWidth, pageHeight]);
    legendPage.drawImage(legendImage, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  }
  throwIfRenderAborted(signal);
  const bytes = await pdf.save({ useObjectStreams: false });
  throwIfRenderAborted(signal);
  return { contents: Buffer.from(bytes), pageCount: totalPageCount };
}

export async function renderProjectExport(input: RenderProjectExportInput): Promise<RenderedExport> {
  throwIfRenderAborted(input.signal);
  const options = normalizeExportOptions(input.options);
  const baseName = normalizeExportBaseName(input.fileName ?? input.project.name);
  if (input.format === "png") {
    const contents = await renderPng(input.project, input.palette, options, input.signal);
    throwIfRenderAborted(input.signal);
    assertRenderedSize(contents);
    return {
      contents,
      mimeType: "image/png",
      fileName: `${baseName}.png`,
      sha256: createHash("sha256").update(contents).digest("hex"),
      pageCount: 1,
    };
  }
  if (input.format !== "pdf") throw new AppError(400, "UNSUPPORTED_EXPORT_FORMAT", "导出格式必须是 png 或 pdf");
  const rendered = await renderPdf(input.project, input.palette, options, input.signal);
  throwIfRenderAborted(input.signal);
  assertRenderedSize(rendered.contents);
  return {
    ...rendered,
    mimeType: "application/pdf",
    fileName: `${baseName}.pdf`,
    sha256: createHash("sha256").update(rendered.contents).digest("hex"),
  };
}
