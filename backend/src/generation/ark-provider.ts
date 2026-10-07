import sharp, { type Sharp } from "sharp";

import type { GenerationCandidate, GenerationJob, GenerationCandidateOutputSlot } from "../domain/models.js";
import { AppError } from "../errors.js";
import { RasterPaletteGenerationProvider } from "./raster-provider.js";
import type { GenerationProvider, GenerationProviderInput } from "./provider.js";

const ARK_GENERATIONS_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const ARK_RESPONSES_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/responses";
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 120_000;

type JsonObject = Record<string, unknown>;

export interface ArkGenerationProviderOptions {
  apiKey: string;
  imageModel?: string;
  visionModel?: string;
  timeoutMilliseconds?: number;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

interface OutputPlan {
  variantOrdinal: number;
  outputSlot: GenerationCandidateOutputSlot;
  prompt: string;
  subject?: 1 | 2;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("GENERATION_ABORTED");
}

function sourceDataUri(contents: Buffer): string {
  if (contents.length === 0 || contents.length > MAX_SOURCE_BYTES) {
    throw new AppError(413, "GENERATION_SOURCE_TOO_LARGE", "AI 原始图片不能超过 30 MB");
  }
  let mediaType: "image/jpeg" | "image/png" | "image/webp";
  if (contents.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) mediaType = "image/jpeg";
  else if (contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mediaType = "image/png";
  else if (contents.subarray(0, 4).toString("ascii") === "RIFF" && contents.subarray(8, 12).toString("ascii") === "WEBP") mediaType = "image/webp";
  else throw new AppError(415, "GENERATION_SOURCE_FORMAT_UNSUPPORTED", "AI 生成仅支持 JPEG、PNG 和 WebP 图片");
  return `data:${mediaType};base64,${contents.toString("base64")}`;
}

async function runSharp<T>(pipeline: Sharp, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  const abort = (): void => { pipeline.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await operation();
    if (signal.aborted) throw abortReason(signal);
    return result;
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function cropSourceForArk(input: GenerationProviderInput): Promise<Buffer> {
  const contents = input.sourceContents;
  if (!contents) throw new AppError(400, "GENERATION_SOURCE_REQUIRED", "AI 生成需要原始图片");
  if (contents.length === 0 || contents.length > MAX_SOURCE_BYTES) {
    throw new AppError(413, "GENERATION_SOURCE_TOO_LARGE", "AI 原始图片不能超过 30 MB");
  }

  try {
    const metadataPipeline = sharp(contents, { failOn: "error", limitInputPixels: 40_000_000, animated: false });
    const metadata = await runSharp(metadataPipeline, input.signal, () => metadataPipeline.metadata());
    if (!(metadata.format === "jpeg" || metadata.format === "png" || metadata.format === "webp")) {
      throw new AppError(415, "GENERATION_SOURCE_FORMAT_UNSUPPORTED", "AI 生成仅支持 JPEG、PNG 和 WebP 图片");
    }
    if ((metadata.pages ?? 1) > 1) throw new AppError(415, "GENERATION_SOURCE_ANIMATED_UNSUPPORTED", "AI 生成不支持动态图片");
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000) {
      throw new AppError(413, "GENERATION_SOURCE_DIMENSIONS_EXCEEDED", "AI 原图像素数超过上限");
    }

    const rotation = input.job.options.crop.rotation;
    const rotatePipeline = sharp(contents, { failOn: "error", limitInputPixels: 40_000_000, animated: false }).rotate(rotation);
    const rotated = await runSharp(rotatePipeline, input.signal, () => rotatePipeline.toBuffer({ resolveWithObject: true }));
    const sourceWidth = rotated.info.width;
    const sourceHeight = rotated.info.height;
    const cropOptions = input.job.options.crop;
    const aspect = cropOptions.ratio === "free"
      ? cropOptions.freeRatio
      : cropOptions.ratio === "original"
        ? sourceWidth / sourceHeight
        : cropOptions.ratio === "1:1" ? 1 : cropOptions.ratio === "4:3" ? 4 / 3 : 3 / 4;
    const scale = cropOptions.scale;
    if (!Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(scale) || scale <= 0) {
      throw new AppError(400, "GENERATION_CROP_INVALID", "裁剪比例或缩放参数无效");
    }
    let fittedWidth = sourceWidth;
    let fittedHeight = fittedWidth / aspect;
    if (fittedHeight > sourceHeight) {
      fittedHeight = sourceHeight;
      fittedWidth = fittedHeight * aspect;
    }
    const width = Math.max(1, Math.round(fittedWidth / scale));
    const height = Math.max(1, Math.round(fittedHeight / scale));
    const maxOffsetX = Math.min(300, Math.max(0, (sourceWidth - width) / 2));
    const maxOffsetY = Math.min(300, Math.max(0, (sourceHeight - height) / 2));
    const offsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, cropOptions.offsetX));
    const offsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, cropOptions.offsetY));
    const left = Math.round(sourceWidth / 2 + offsetX - width / 2);
    const top = Math.round(sourceHeight / 2 + offsetY - height / 2);
    let cropPipeline = sharp(rotated.data, { failOn: "error", limitInputPixels: 40_000_000, animated: false });
    if (cropOptions.flipY) cropPipeline = cropPipeline.flip();
    if (cropOptions.flipX) cropPipeline = cropPipeline.flop();
    cropPipeline = cropPipeline.extract({ left, top, width, height });
    if (metadata.format === "jpeg") cropPipeline = cropPipeline.jpeg({ quality: 96, chromaSubsampling: "4:4:4" });
    else if (metadata.format === "png") cropPipeline = cropPipeline.png({ compressionLevel: 6 });
    else cropPipeline = cropPipeline.webp({ quality: 96, lossless: false });
    const cropped = await runSharp(cropPipeline, input.signal, () => cropPipeline.toBuffer());
    if (cropped.length === 0 || cropped.length > MAX_SOURCE_BYTES) {
      throw new AppError(413, "GENERATION_SOURCE_TOO_LARGE", "裁剪后的高清图片超过 30 MB");
    }
    return cropped;
  } catch (error) {
    if (input.signal.aborted) throw abortReason(input.signal);
    if (error instanceof AppError) throw error;
    throw new AppError(400, "GENERATION_SOURCE_DECODE_FAILED", "AI 原图无法解码或已损坏");
  }
}

function promptFor(input: GenerationProviderInput, plan: OutputPlan, visionDescription?: string): string {
  const style = input.job.options.figureStyle === "pixel-avatar" ? "像素头像" : "Q版人物";
  const framing = input.job.options.figureStyle === "chibi-half" ? "半身构图" : "完整人物构图";
  const background = input.job.options.transparentBackground ? "透明背景" : "简洁浅色背景";
  return [
    "请严格参考输入照片中的人物特征、发型、服装和配饰，生成一张适合制作拼豆图纸的图片。",
    `风格：${style}，${framing}，${background}。`,
    "保持主体清晰、轮廓完整、颜色分区明确，避免文字、水印、边框和多余人物。",
    input.job.kind === "couple" ? "这是情侣照片，请保留两位人物的身份特征和相对位置。" : "只保留照片中的主要人物。",
    ...(visionDescription ? [`图片理解摘要：${visionDescription}`] : []),
    plan.prompt,
  ].join(" ");
}

function outputPlans(job: GenerationJob): OutputPlan[] {
  if (job.kind === "portrait") {
    return [1, 2].map((variantOrdinal) => ({
      variantOrdinal,
      outputSlot: "combined",
      prompt: `生成第 ${variantOrdinal} 个独立方案，构图和配色可以有轻微变化。`,
    }));
  }
  if (job.kind !== "couple") {
    throw new AppError(400, "GENERATION_MODE_UNSUPPORTED", "火山方舟 Provider 仅支持真人和情侣 AI 模式");
  }
  if (job.options.coupleLayout === "together") {
    return [1, 2].map((variantOrdinal) => ({
      variantOrdinal,
      outputSlot: "combined",
      prompt: `保留两位人物的合体构图，生成第 ${variantOrdinal} 个独立方案。`,
    }));
  }
  const plans: OutputPlan[] = [];
  for (const variantOrdinal of [1, 2]) {
    for (const subject of [1, 2] as const) {
      const outputSlot = job.options.coupleLayout === "solo"
        ? (subject === 1 ? "subject-1" : "subject-2")
        : (subject === 1 ? "left" : "right");
      plans.push({
        variantOrdinal,
        outputSlot,
        ...(job.options.coupleLayout === "solo" ? { subject } : {}),
        prompt: job.options.coupleLayout === "solo"
          ? `仅保留第 ${subject} 位人物，生成第 ${variantOrdinal} 个独立方案。`
          : `仅保留位于${subject === 1 ? "左侧" : "右侧"}的人物，生成第 ${variantOrdinal} 个独立方案。`,
      });
    }
  }
  return plans;
}

function invalidResponse(): never {
  throw new AppError(502, "GENERATION_PROVIDER_RESPONSE_INVALID", "火山方舟返回了无效图片结果", undefined, false);
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") invalidResponse();
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_RESPONSE_BYTES) invalidResponse();
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    invalidResponse();
  }
}

async function readImage(response: Response): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppError(503, "GENERATION_PROVIDER_UNAVAILABLE", "火山方舟图片下载失败", { providerStatus: response.status }, true);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0 || body.length > MAX_SOURCE_BYTES) invalidResponse();
  return body;
}

export class ArkGenerationProvider implements GenerationProvider {
  readonly kind = "ark-seedream";

  readonly #apiKey: string;
  readonly #imageModel: string;
  readonly #visionModel: string | undefined;
  readonly #timeoutMilliseconds: number;
  readonly #fetchImpl: typeof fetch;
  readonly #endpoint: string;
  readonly #raster = new RasterPaletteGenerationProvider();

  constructor(options: ArkGenerationProviderOptions) {
    this.#apiKey = options.apiKey.trim();
    if (!this.#apiKey || this.#apiKey.length > 8_192) throw new Error("ARK_API_KEY 必须是 1-8192 个字符");
    this.#imageModel = options.imageModel?.trim() || "doubao-seedream-5-0-pro-260628";
    this.#visionModel = options.visionModel?.trim() || undefined;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(this.#timeoutMilliseconds)
      || this.#timeoutMilliseconds < 1_000
      || this.#timeoutMilliseconds > 600_000) {
      throw new Error("ARK_TIMEOUT_MS 必须介于 1000 和 600000 之间");
    }
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#endpoint = options.endpoint ?? ARK_GENERATIONS_ENDPOINT;
  }

  async #describeSource(input: GenerationProviderInput): Promise<string | undefined> {
    if (!this.#visionModel || !input.sourceContents) return undefined;
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("ARK_TIMEOUT"));
    }, this.#timeoutMilliseconds);
    try {
      const response = await this.#fetchImpl(ARK_RESPONSES_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.#visionModel,
          input: [{
            role: "user",
            content: [
              { type: "input_image", image_url: sourceDataUri(input.sourceContents) },
              { type: "input_text", text: "请用不超过 80 个中文字符描述人物主体、姿态、服装、配饰和背景，供后续 Q 版拼豆图纸生成使用。" },
            ],
          }],
        }),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw new AppError(
          retryable ? 503 : 422,
          retryable ? "GENERATION_PROVIDER_UNAVAILABLE" : "GENERATION_PROVIDER_REJECTED",
          retryable ? "火山方舟图片理解暂时不可用" : "火山方舟图片理解请求被拒绝",
          { providerStatus: response.status },
          retryable,
        );
      }
      const payload = await readJson(response);
      if (!isObject(payload)) invalidResponse();
      if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim().slice(0, 500);
      if (Array.isArray(payload.output)) {
        for (const item of payload.output) {
          if (!isObject(item) || !Array.isArray(item.content)) continue;
          for (const content of item.content) {
            if (!isObject(content) || typeof content.text !== "string" || !content.text.trim()) continue;
            return content.text.trim().slice(0, 500);
          }
        }
      }
      invalidResponse();
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      if (timedOut) throw new AppError(504, "GENERATION_PROVIDER_TIMEOUT", "火山方舟图片理解请求超时", undefined, true);
      if (error instanceof AppError) throw error;
      throw new AppError(503, "GENERATION_PROVIDER_UNAVAILABLE", "火山方舟图片理解暂时不可用", undefined, true);
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abortFromCaller);
    }
  }

  async #requestImage(input: GenerationProviderInput, plan: OutputPlan, visionDescription?: string): Promise<Buffer> {
    if (!input.sourceContents) throw new AppError(400, "GENERATION_SOURCE_REQUIRED", "AI 生成需要原始图片");
    if (input.signal.aborted) throw abortReason(input.signal);
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("ARK_TIMEOUT"));
    }, this.#timeoutMilliseconds);
    try {
      const response = await this.#fetchImpl(this.#endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.#imageModel,
          prompt: promptFor(input, plan, visionDescription),
          image: sourceDataUri(input.sourceContents),
          response_format: "url",
          size: "2K",
          background: input.job.options.transparentBackground ? "transparent" : "opaque",
          watermark: false,
        }),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw new AppError(
          retryable ? 503 : 422,
          retryable ? "GENERATION_PROVIDER_UNAVAILABLE" : "GENERATION_PROVIDER_REJECTED",
          retryable ? "火山方舟暂时不可用" : "火山方舟拒绝了本次生成请求",
          { providerStatus: response.status },
          retryable,
        );
      }
      const payload = await readJson(response);
      if (!isObject(payload) || !Array.isArray(payload.data)) invalidResponse();
      const first = payload.data[0];
      if (!isObject(first)) invalidResponse();
      let image: Buffer;
      if (typeof first.url === "string") {
        let imageUrl: URL;
        try {
          imageUrl = new URL(first.url);
        } catch {
          invalidResponse();
        }
        if (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password || imageUrl.hash) invalidResponse();
        const imageResponse = await this.#fetchImpl(imageUrl, {
          headers: { accept: "image/*" },
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        image = await readImage(imageResponse);
      } else if (typeof first.b64_json === "string") {
        try {
          image = Buffer.from(first.b64_json, "base64");
        } catch {
          invalidResponse();
        }
        if (image.length === 0 || image.length > MAX_SOURCE_BYTES) invalidResponse();
      } else {
        invalidResponse();
      }
      if (input.signal.aborted) throw abortReason(input.signal);
      return image;
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      if (timedOut) throw new AppError(504, "GENERATION_PROVIDER_TIMEOUT", "火山方舟请求超时", undefined, true);
      if (error instanceof AppError) throw error;
      throw new AppError(503, "GENERATION_PROVIDER_UNAVAILABLE", "火山方舟暂时不可用", undefined, true);
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abortFromCaller);
    }
  }

  async generate(input: GenerationProviderInput): Promise<GenerationCandidate[]> {
    const plans = outputPlans(input.job);
    const croppedInput: GenerationProviderInput = {
      ...input,
      sourceContents: await cropSourceForArk(input),
    };
    const visionDescription = await this.#describeSource(croppedInput);
    const candidates: GenerationCandidate[] = [];
    for (const [index, plan] of plans.entries()) {
      input.signal.throwIfAborted();
      const generatedImage = await this.#requestImage(croppedInput, plan, visionDescription);
      const rasterInput: GenerationProviderInput = {
        ...input,
        sourceContents: generatedImage,
        job: {
          ...input.job,
          kind: "normal",
          options: {
            ...input.job.options,
            crop: {
              ...input.job.options.crop,
              ratio: "original",
              rotation: 0,
              scale: 1,
              offsetX: 0,
              offsetY: 0,
              flipX: false,
              flipY: false,
            },
          },
        },
      };
      const mapped = await this.#raster.generate(rasterInput);
      const rasterCandidate = mapped[0];
      if (!rasterCandidate) invalidResponse();
      candidates.push({
        ...rasterCandidate,
        id: `${input.job.id}-ark-${index + 1}`,
        variantOrdinal: plan.variantOrdinal,
        outputSlot: plan.outputSlot,
        ordinal: index + 1,
        ...(plan.subject ? { subject: plan.subject } : {}),
      });
    }
    return candidates;
  }
}
