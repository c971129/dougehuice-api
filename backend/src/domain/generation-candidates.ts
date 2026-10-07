import { AppError } from "../errors.js";
import { MAX_GRID_CELLS, MAX_GRID_SIDE } from "./grid.js";
import type {
  GenerationCandidate,
  GenerationCandidateOutputSlot,
  GenerationKind,
  GenerationOptions,
} from "./models.js";
import {
  MAX_GENERATION_CANDIDATES,
  MAX_GENERATION_CANDIDATE_ID_LENGTH,
  MIN_GENERATION_CANDIDATE_ID_LENGTH,
} from "./resource-limits.js";

const OUTPUT_SLOT_ORDER: readonly GenerationCandidateOutputSlot[] = [
  "combined",
  "left",
  "right",
  "subject-1",
  "subject-2",
];

export function generationOutputSlots(
  kind: GenerationKind,
  options: GenerationOptions,
): readonly GenerationCandidateOutputSlot[] {
  if (kind !== "couple") return ["combined"];
  if (options.coupleLayout === "split") return ["left", "right"];
  if (options.coupleLayout === "solo") return ["subject-1", "subject-2"];
  return ["combined"];
}

function minimumVariantCount(kind: GenerationKind): number {
  return kind === "normal" || kind === "pixel" ? 1 : 2;
}

function expectedSubject(slot: GenerationCandidateOutputSlot): 1 | 2 | undefined {
  if (slot === "subject-1") return 1;
  if (slot === "subject-2") return 2;
  return undefined;
}

export function assertGenerationCandidatesStructure(input: {
  jobId: string;
  kind: GenerationKind;
  options: GenerationOptions;
  width: number;
  height: number;
  candidates: GenerationCandidate[];
}): number {
  const ids = new Set<string>();
  const flatOrdinals = new Set<number>();
  const variants = new Map<number, Set<GenerationCandidateOutputSlot>>();
  const slots = generationOutputSlots(input.kind, input.options);
  const slotSet = new Set<GenerationCandidateOutputSlot>(slots);
  const singleVariant = input.kind === "normal" || input.kind === "pixel";
  let cellCount = 0;
  const invalid = input.candidates.length < 1
    || input.candidates.length > MAX_GENERATION_CANDIDATES
    || !Number.isInteger(input.width)
    || !Number.isInteger(input.height)
    || input.width < 1
    || input.height < 1
    || input.width > MAX_GRID_SIDE
    || input.height > MAX_GRID_SIDE
    || input.width * input.height > MAX_GRID_CELLS
    || input.candidates.some((candidate, index) => {
      if (!candidate
        || typeof candidate !== "object"
        || !candidate.grid
        || typeof candidate.grid !== "object"
        || !Array.isArray(candidate.grid.cells)) {
        return true;
      }
      const candidateCells = candidate.grid.width * candidate.grid.height;
      const subject = expectedSubject(candidate.outputSlot);
      const expectedVariantOrdinal = Math.floor(index / slots.length) + 1;
      const expectedOutputSlot = slots[index % slots.length];
      const outputSlots = variants.get(candidate.variantOrdinal) ?? new Set<GenerationCandidateOutputSlot>();
      const candidateInvalid = candidate.jobId !== input.jobId
        || typeof candidate.id !== "string"
        || candidate.id.length < MIN_GENERATION_CANDIDATE_ID_LENGTH
        || candidate.id.length > MAX_GENERATION_CANDIDATE_ID_LENGTH
        || !Number.isInteger(candidate.variantOrdinal)
        || candidate.variantOrdinal < 1
        || candidate.variantOrdinal > MAX_GENERATION_CANDIDATES
        || candidate.variantOrdinal !== expectedVariantOrdinal
        || !OUTPUT_SLOT_ORDER.includes(candidate.outputSlot)
        || !slotSet.has(candidate.outputSlot)
        || candidate.outputSlot !== expectedOutputSlot
        || !Number.isInteger(candidate.ordinal)
        || candidate.ordinal < 1
        || candidate.ordinal > MAX_GENERATION_CANDIDATES
        || candidate.ordinal !== index + 1
        || candidate.grid.encoding !== "palette-code-v1"
        || candidate.grid.width !== input.width
        || candidate.grid.height !== input.height
        || candidateCells > MAX_GRID_CELLS
        || candidate.grid.cells.length !== candidateCells
        || !Number.isFinite(Date.parse(candidate.createdAt))
        || candidate.acceptedProjectId !== undefined
        || candidate.acceptedAt !== undefined
        || candidate.subject !== subject
        || ids.has(candidate.id)
        || flatOrdinals.has(candidate.ordinal)
        || outputSlots.has(candidate.outputSlot);
      ids.add(candidate.id);
      flatOrdinals.add(candidate.ordinal);
      outputSlots.add(candidate.outputSlot);
      variants.set(candidate.variantOrdinal, outputSlots);
      cellCount += candidateCells;
      return candidateInvalid;
    })
    || cellCount > MAX_GENERATION_CANDIDATES * MAX_GRID_CELLS
    || variants.size < minimumVariantCount(input.kind)
    || (singleVariant && variants.size !== 1)
    || [...variants.keys()].sort((left, right) => left - right)
      .some((variantOrdinal, index) => variantOrdinal !== index + 1)
    || [...variants.values()].some((variantSlots) =>
      variantSlots.size !== slots.length || slots.some((slot) => !variantSlots.has(slot)));
  if (invalid) {
    throw new AppError(500, "GENERATION_CANDIDATES_INVALID", "生成候选结果无效");
  }
  return cellCount;
}
