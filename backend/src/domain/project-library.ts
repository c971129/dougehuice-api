import { AppError } from "../errors.js";

import type { ProjectBuildStatus, ProjectDeviceSource } from "./models.js";

export const MAX_PROJECT_TAGS = 20;
export const MAX_PROJECT_TAG_LENGTH = 32;
export const MAX_PROJECT_SEARCH_LENGTH = 100;
export const MAX_PROJECT_NAME_LENGTH = 100;

export const PROJECT_DEVICE_SOURCES = ["mini-program", "web", "api", "unknown"] as const;
export const PROJECT_BUILD_STATUSES = ["draft", "in_progress", "completed"] as const;

export function assertProjectDeviceSource(value: string): asserts value is ProjectDeviceSource {
  if (!(PROJECT_DEVICE_SOURCES as readonly string[]).includes(value)) {
    throw new AppError(400, "PROJECT_DEVICE_SOURCE_INVALID", "设备来源不合法");
  }
}

export function assertProjectBuildStatus(value: string): asserts value is ProjectBuildStatus {
  if (!(PROJECT_BUILD_STATUSES as readonly string[]).includes(value)) {
    throw new AppError(400, "PROJECT_STATUS_INVALID", "制作状态不合法");
  }
}

/**
 * Tags are persisted in a canonical form so MemoryStore and PostgreSQL use
 * identical equality and filtering semantics. NFKC folds compatibility
 * variants, whitespace is collapsed, and the first spelling wins when tags
 * differ only by Unicode-aware case.
 */
export function normalizeProjectTags(input: readonly string[]): string[] {
  if (input.length > MAX_PROJECT_TAGS) {
    throw new AppError(400, "PROJECT_TAG_LIMIT_EXCEEDED", "作品标签数量超过上限", {
      limit: MAX_PROJECT_TAGS,
    });
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const normalized = raw.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!normalized) {
      throw new AppError(400, "PROJECT_TAG_EMPTY", "作品标签不能为空");
    }
    if ([...normalized].length > MAX_PROJECT_TAG_LENGTH) {
      throw new AppError(400, "PROJECT_TAG_TOO_LONG", "作品标签过长", {
        limit: MAX_PROJECT_TAG_LENGTH,
      });
    }
    const key = normalized.toLocaleLowerCase("zh-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(normalized);
  }
  return tags;
}

export function normalizeProjectTagFilter(input: string): string {
  return normalizeProjectTags([input])[0]!;
}

export function normalizeProjectSearch(input: string): string {
  const query = input.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if ([...query].length > MAX_PROJECT_SEARCH_LENGTH) {
    throw new AppError(400, "PROJECT_SEARCH_TOO_LONG", "作品搜索词过长", {
      limit: MAX_PROJECT_SEARCH_LENGTH,
    });
  }
  return query;
}

export function defaultProjectCopyName(sourceName: string): string {
  const suffix = " 副本";
  const retainedSourceLength = MAX_PROJECT_NAME_LENGTH - Array.from(suffix).length;
  return `${Array.from(sourceName).slice(0, retainedSourceLength).join("")}${suffix}`;
}
