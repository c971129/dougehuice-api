import type {
  ProjectBackgroundMode,
  ProjectLifecycleStatus,
  ProjectMode,
} from "./models.js";
import { AppError } from "../errors.js";

const PROJECT_MODES = new Set<ProjectMode>(["normal", "pixel", "portrait", "couple"]);
const PROJECT_LIFECYCLE_STATUSES = new Set<ProjectLifecycleStatus>([
  "draft",
  "generating",
  "editable",
  "exported",
]);
const PROJECT_BACKGROUND_MODES = new Set<ProjectBackgroundMode>(["white", "transparent", "solid"]);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export function assertProjectMode(value: ProjectMode): void {
  if (!PROJECT_MODES.has(value)) {
    throw new AppError(400, "PROJECT_MODE_INVALID", "作品模式无效");
  }
}

export function assertProjectLifecycleStatus(value: ProjectLifecycleStatus): void {
  if (!PROJECT_LIFECYCLE_STATUSES.has(value)) {
    throw new AppError(400, "PROJECT_LIFECYCLE_STATUS_INVALID", "作品生命周期状态无效");
  }
}

export function normalizeProjectBackground(
  backgroundMode: ProjectBackgroundMode,
  backgroundColor: string | null | undefined,
): { backgroundMode: ProjectBackgroundMode; backgroundColor: string | null } {
  if (!PROJECT_BACKGROUND_MODES.has(backgroundMode)) {
    throw new AppError(400, "PROJECT_BACKGROUND_MODE_INVALID", "作品背景模式无效");
  }
  if (backgroundMode !== "solid") {
    if (backgroundColor !== undefined && backgroundColor !== null) {
      throw new AppError(400, "PROJECT_BACKGROUND_COLOR_NOT_ALLOWED", "白底或透明背景不能指定纯色值");
    }
    return { backgroundMode, backgroundColor: null };
  }
  if (typeof backgroundColor !== "string" || !HEX_COLOR.test(backgroundColor)) {
    throw new AppError(400, "PROJECT_BACKGROUND_COLOR_INVALID", "纯色背景必须使用 #RRGGBB 格式");
  }
  return { backgroundMode, backgroundColor: backgroundColor.toUpperCase() };
}
