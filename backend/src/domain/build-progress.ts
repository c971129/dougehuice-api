import { AppError } from "../errors.js";
import type {
  BuildMode,
  BuildNavigationCursor,
  PatternGrid,
} from "./models.js";

interface ResolveBuildNavigationCursorInput {
  mode: BuildMode;
  previousMode: BuildMode | undefined;
  previousCursor: BuildNavigationCursor | null | undefined;
  cursorProvided: boolean;
  requestedCursor: BuildNavigationCursor | null | undefined;
  grid: PatternGrid;
  paletteColorCodes: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function invalidCursor(message: string): never {
  throw new AppError(400, "INVALID_BUILD_NAVIGATION_CURSOR", message);
}

/**
 * Validate and normalize a build cursor against the immutable project revision.
 * Constructing a fresh object also prevents untrusted extra JSON properties from
 * leaking into persistence when the store is called without the HTTP schema.
 */
export function assertBuildNavigationCursor(
  value: unknown,
  mode: BuildMode,
  grid: PatternGrid,
  paletteColorCodes: ReadonlySet<string>,
): BuildNavigationCursor {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return invalidCursor("制作导航位置格式无效");
  }

  if (value.kind !== mode) {
    throw new AppError(400, "BUILD_NAVIGATION_CURSOR_MODE_MISMATCH", "制作导航位置与当前制作模式不匹配", {
      mode,
      cursorKind: value.kind,
    });
  }

  if (value.kind === "color") {
    if (!hasExactKeys(value, ["kind", "colorCode"])
      || typeof value.colorCode !== "string"
      || value.colorCode.length < 1
      || value.colorCode.length > 80) {
      return invalidCursor("按颜色导航位置必须包含有效的色号");
    }
    if (!paletteColorCodes.has(value.colorCode) || !grid.cells.some((cell) => cell === value.colorCode)) {
      throw new AppError(
        400,
        "BUILD_NAVIGATION_COLOR_NOT_FOUND",
        "导航色号不属于当前图纸版本或未出现在图纸中",
        { colorCode: value.colorCode },
      );
    }
    return { kind: "color", colorCode: value.colorCode };
  }

  if (value.kind === "region") {
    if (!hasExactKeys(value, ["kind", "regionIndex"])
      || !Number.isInteger(value.regionIndex)
      || (value.regionIndex as number) < 0
      || (value.regionIndex as number) > 3) {
      throw new AppError(400, "BUILD_NAVIGATION_CURSOR_OUT_OF_RANGE", "分区导航位置必须在 0 到 3 之间");
    }
    return { kind: "region", regionIndex: value.regionIndex as number };
  }

  if (value.kind === "row-column") {
    if (!hasExactKeys(value, ["kind", "axis", "index"])
      || (value.axis !== "row" && value.axis !== "column")
      || !Number.isInteger(value.index)
      || (value.index as number) < 0) {
      return invalidCursor("行列导航位置格式无效");
    }
    const limit = value.axis === "row" ? grid.height : grid.width;
    if ((value.index as number) >= limit) {
      throw new AppError(400, "BUILD_NAVIGATION_CURSOR_OUT_OF_RANGE", "行列导航位置超出当前图纸范围", {
        axis: value.axis,
        limit,
      });
    }
    return { kind: "row-column", axis: value.axis, index: value.index as number };
  }

  return invalidCursor("制作导航位置类型无效");
}

export function resolveBuildNavigationCursor(
  input: ResolveBuildNavigationCursorInput,
): BuildNavigationCursor | null {
  const candidate = input.cursorProvided
    ? input.requestedCursor
    : input.previousMode === input.mode
      ? input.previousCursor ?? null
      : null;

  if (candidate === null) return null;
  if (candidate === undefined) return invalidCursor("制作导航位置必须是对象或 null");
  return assertBuildNavigationCursor(candidate, input.mode, input.grid, input.paletteColorCodes);
}
