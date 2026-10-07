import { AppError } from "../errors.js";
import type { GenerationProvider, GenerationProviderInput } from "./provider.js";

export interface ModeRoutingGenerationProviderOptions {
  raster: GenerationProvider;
  ai: GenerationProvider;
  /** Development/test compatibility for legacy jobs created without an image. */
  missingRasterSourceFallback?: GenerationProvider;
}

/**
 * Keeps deterministic raster conversion in-process while sending only the two
 * AI modes to the remote provider. Production deliberately has no missing-
 * source fallback, so an old or malformed normal/pixel job cannot become a
 * fabricated pattern.
 */
export class ModeRoutingGenerationProvider implements GenerationProvider {
  readonly kind: string;

  readonly #raster: GenerationProvider;
  readonly #ai: GenerationProvider;
  readonly #missingRasterSourceFallback: GenerationProvider | undefined;

  constructor(options: ModeRoutingGenerationProviderOptions) {
    this.#raster = options.raster;
    this.#ai = options.ai;
    this.#missingRasterSourceFallback = options.missingRasterSourceFallback;
    this.kind = `mode-router:${options.raster.kind}+${options.ai.kind}${
      options.missingRasterSourceFallback ? `+${options.missingRasterSourceFallback.kind}-compat` : ""
    }`;
  }

  async generate(input: GenerationProviderInput) {
    if (input.job.kind === "normal" || input.job.kind === "pixel") {
      if (input.sourceContents) return await this.#raster.generate(input);
      if (this.#missingRasterSourceFallback) return await this.#missingRasterSourceFallback.generate(input);
      throw new AppError(
        400,
        "GENERATION_SOURCE_REQUIRED",
        "普通图片与像素图转换需要原始图片",
      );
    }
    return await this.#ai.generate(input);
  }
}
