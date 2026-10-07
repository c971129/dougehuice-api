import { createHash } from "node:crypto";

import sharp from "sharp";

import type { AssetMimeType } from "../domain/models.js";
import { AppError } from "../errors.js";

export const SUPPORTED_ASSET_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const satisfies
  readonly AssetMimeType[];
const SUPPORTED_MIME_TYPES = new Set<AssetMimeType>(SUPPORTED_ASSET_MIME_TYPES);

export interface SanitizedImage {
  contents: Buffer;
  sha256: string;
  mimeType: AssetMimeType;
  width: number;
  height: number;
}

function mimeForFormat(format: string | undefined): AssetMimeType | null {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  return null;
}

export function assertSupportedDeclaredMimeType(value: string): asserts value is AssetMimeType {
  if (!SUPPORTED_MIME_TYPES.has(value as AssetMimeType)) {
    throw new AppError(415, "UNSUPPORTED_ASSET_TYPE", "仅支持 JPG、PNG 和 WebP 图片");
  }
}

export async function sanitizeImage(
  input: Buffer,
  declaredMimeType: AssetMimeType,
  maximumOutputBytes: number,
): Promise<SanitizedImage> {
  try {
    const source = sharp(input, {
      failOn: "error",
      limitInputPixels: 40_000_000,
      animated: false,
    });
    const metadata = await source.metadata();
    const detectedMimeType = mimeForFormat(metadata.format);
    if (!detectedMimeType || detectedMimeType !== declaredMimeType) {
      throw new AppError(415, "ASSET_MIME_MISMATCH", "图片实际格式与声明类型不一致");
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new AppError(415, "ANIMATED_ASSET_UNSUPPORTED", "不支持动态图片");
    }

    const rotated = source.rotate();
    const encoded = detectedMimeType === "image/jpeg"
      ? rotated.jpeg({ quality: 95, mozjpeg: true })
      : detectedMimeType === "image/png"
        ? rotated.png({ compressionLevel: 9 })
        : rotated.webp({ quality: 95 });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height || info.width > 10_000 || info.height > 10_000) {
      throw new AppError(400, "INVALID_ASSET_DIMENSIONS", "图片尺寸无效或过大");
    }
    if (data.length === 0 || data.length > maximumOutputBytes) {
      throw new AppError(413, "ASSET_TOO_LARGE", "图片处理后仍超过大小限制");
    }
    return {
      contents: data,
      sha256: createHash("sha256").update(data).digest("hex"),
      mimeType: detectedMimeType,
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "INVALID_IMAGE", "图片无法解码或已损坏");
  }
}
