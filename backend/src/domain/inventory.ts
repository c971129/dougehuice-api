import type { InventoryItem, MaterialSummary, Palette } from "./models.js";

export interface InventorySubstitutionSuggestion {
  colorCode: string;
  colorName: string;
  hex: string;
  surplusQuantity: number;
  storageLocation: string | null;
  inventoryRevision: number;
  rgbDistance: number;
}

export interface InventoryComparisonLine {
  colorCode: string;
  colorName: string;
  hex: string;
  requiredQuantity: number;
  availableQuantity: number;
  coveredQuantity: number;
  shortageQuantity: number;
  storageLocation: string | null;
  inventoryRevision: number;
  suggestedSubstitute: InventorySubstitutionSuggestion | null;
}

export interface InventoryShortageSummary {
  projectId: string;
  projectRevision: number;
  paletteId: string;
  requiredBeadCount: number;
  coveredBeadCount: number;
  shortageBeadCount: number;
  hasShortage: boolean;
  lines: InventoryComparisonLine[];
  purchaseList: Array<Pick<
    InventoryComparisonLine,
    "colorCode" | "colorName" | "hex" | "shortageQuantity"
  >>;
}

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbDistance(leftHex: string, rightHex: string): number {
  const left = rgb(leftHex);
  const right = rgb(rightHex);
  return Math.round(Math.sqrt(
    (left[0] - right[0]) ** 2
    + (left[1] - right[1]) ** 2
    + (left[2] - right[2]) ** 2,
  ));
}

export function compareMaterialsWithInventory(
  palette: Palette,
  materials: MaterialSummary,
  inventory: InventoryItem[],
): InventoryShortageSummary {
  const paletteId = palette.id;
  const availableByColor = new Map(
    inventory
      .filter((item) => item.paletteId === paletteId)
      .map((item) => [item.colorCode, item]),
  );
  const requiredByColor = new Map(materials.lines.map((line) => [line.colorCode, line.quantity]));
  const surplusColors = inventory
    .filter((item) => item.paletteId === paletteId)
    .map((item) => {
      const color = palette.colors.find((candidate) => candidate.code === item.colorCode);
      return color ? {
        color,
        item,
        surplusQuantity: Math.max(0, item.quantity - (requiredByColor.get(item.colorCode) ?? 0)),
      } : null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null && candidate.surplusQuantity > 0);
  const remainingSurplusByColor = new Map(
    surplusColors.map((candidate) => [candidate.color.code, candidate.surplusQuantity]),
  );

  const lines = materials.lines.map((material): InventoryComparisonLine => {
    const item = availableByColor.get(material.colorCode);
    const availableQuantity = item?.quantity ?? 0;
    const coveredQuantity = Math.min(material.quantity, availableQuantity);
    const shortageQuantity = material.quantity - coveredQuantity;
    const substitute = shortageQuantity > 0
      ? surplusColors
        .filter((candidate) => candidate.color.code !== material.colorCode)
        .map((candidate) => ({
          candidate,
          remainingSurplus: remainingSurplusByColor.get(candidate.color.code) ?? 0,
          distance: rgbDistance(material.hex, candidate.color.hex),
        }))
        .filter((candidate) => candidate.remainingSurplus >= shortageQuantity)
        .sort((left, right) => left.distance - right.distance
          || left.candidate.color.code.localeCompare(right.candidate.color.code))[0]
      : undefined;
    if (substitute) {
      remainingSurplusByColor.set(
        substitute.candidate.color.code,
        substitute.remainingSurplus - shortageQuantity,
      );
    }
    return {
      colorCode: material.colorCode,
      colorName: material.colorName,
      hex: material.hex,
      requiredQuantity: material.quantity,
      availableQuantity,
      coveredQuantity,
      shortageQuantity,
      storageLocation: item?.location ?? null,
      inventoryRevision: item?.revision ?? 0,
      suggestedSubstitute: substitute ? {
        colorCode: substitute.candidate.color.code,
        colorName: substitute.candidate.color.name,
        hex: substitute.candidate.color.hex,
        surplusQuantity: substitute.remainingSurplus,
        storageLocation: substitute.candidate.item.location,
        inventoryRevision: substitute.candidate.item.revision,
        rgbDistance: substitute.distance,
      } : null,
    };
  });
  const coveredBeadCount = lines.reduce((sum, line) => sum + line.coveredQuantity, 0);
  const shortageBeadCount = lines.reduce((sum, line) => sum + line.shortageQuantity, 0);
  return {
    projectId: materials.projectId,
    projectRevision: materials.projectRevision,
    paletteId,
    requiredBeadCount: materials.beadCount,
    coveredBeadCount,
    shortageBeadCount,
    hasShortage: shortageBeadCount > 0,
    lines,
    purchaseList: lines
      .filter((line) => line.shortageQuantity > 0)
      .map(({ colorCode, colorName, hex, shortageQuantity }) => ({
        colorCode,
        colorName,
        hex,
        shortageQuantity,
      })),
  };
}
