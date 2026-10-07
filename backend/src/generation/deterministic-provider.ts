import { generateDeterministicCandidates } from "../domain/grid.js";
import { AppError } from "../errors.js";
import type { GenerationProvider, GenerationProviderInput } from "./provider.js";

export class DeterministicGenerationProvider implements GenerationProvider {
  readonly kind = "deterministic";

  async generate(input: GenerationProviderInput) {
    input.signal.throwIfAborted();
    const allowed = input.availableColorCodes ? new Set(input.availableColorCodes) : null;
    const colors = input.palette.colors
      .filter((color) => color.available && (!allowed || allowed.has(color.code)))
      .slice(0, input.job.options.maxColors);
    if (colors.length === 0) {
      throw new AppError(409, "GENERATION_INVENTORY_EMPTY", "豆仓中没有可用于当前色卡的颜色");
    }
    const candidates = generateDeterministicCandidates({
      jobId: input.job.id,
      kind: input.job.kind,
      palette: { ...input.palette, colors },
      width: input.job.width,
      height: input.job.height,
      seed: `${input.job.seed}:${JSON.stringify(input.job.options)}`,
      options: input.job.options,
      createdAt: input.now,
    });
    input.signal.throwIfAborted();
    return candidates;
  }
}
