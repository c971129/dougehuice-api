import type { GenerationCandidate, GenerationJob, Palette } from "../domain/models.js";

export interface GenerationProviderInput {
  job: GenerationJob;
  palette: Palette;
  sourceContents: Buffer | null;
  availableColorCodes: string[] | null;
  signal: AbortSignal;
  now: string;
}

export interface GenerationProvider {
  readonly kind: string;
  /**
   * Returns a stable flat representation ordered by variantOrdinal and outputSlot:
   * - normal/pixel: one `combined` output;
   * - portrait and couple/together: at least two `combined` variants;
   * - couple/split: at least two variants, each with `left` and `right`;
   * - couple/solo: at least two variants, each with `subject-1` and `subject-2`.
   *
   * `ordinal` is the one-based flat position. `subject` remains only as the
   * persistence compatibility projection of the two solo output slots.
   */
  generate(input: GenerationProviderInput): Promise<GenerationCandidate[]>;
}
