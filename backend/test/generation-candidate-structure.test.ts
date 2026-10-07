import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertGenerationCandidatesStructure,
  generationOutputSlots,
} from "../src/domain/generation-candidates.js";
import { copyDefaultGenerationOptions } from "../src/domain/generation-options.js";
import { generateDeterministicCandidates } from "../src/domain/grid.js";
import type {
  GenerationCandidate,
  GenerationCoupleLayout,
  GenerationKind,
  Palette,
} from "../src/domain/models.js";
import { AppError } from "../src/errors.js";

const JOB_ID = "00000000-0000-4000-8000-000000000891";
const NOW = "2026-10-05T00:00:00.000Z";
const palette: Palette = {
  id: "candidate-structure-palette",
  name: "候选结构测试色卡",
  brand: "测试",
  beadSizeMm: 5,
  verified: false,
  version: 1,
  colors: [
    { code: "A01", name: "黑", hex: "#111111", unitPriceCents: 1, available: true },
    { code: "A02", name: "白", hex: "#eeeeee", unitPriceCents: 1, available: true },
  ],
};

function candidatesFor(kind: GenerationKind, layout: GenerationCoupleLayout = "together") {
  const options = copyDefaultGenerationOptions();
  options.coupleLayout = layout;
  return {
    options,
    candidates: generateDeterministicCandidates({
      jobId: JOB_ID,
      kind,
      palette,
      width: 2,
      height: 2,
      seed: `${kind}:${layout}`,
      createdAt: NOW,
      options,
    }),
  };
}

function expectInvalid(input: {
  kind: GenerationKind;
  layout?: GenerationCoupleLayout;
  mutate: (candidates: GenerationCandidate[]) => GenerationCandidate[];
}): void {
  const { options, candidates } = candidatesFor(input.kind, input.layout);
  assert.throws(() => assertGenerationCandidatesStructure({
    jobId: JOB_ID,
    kind: input.kind,
    options,
    width: 2,
    height: 2,
    candidates: input.mutate(structuredClone(candidates)),
  }), (error: unknown) => error instanceof AppError && error.code === "GENERATION_CANDIDATES_INVALID");
}

describe("generation candidate structure", () => {
  it("emits and accepts the canonical flat variant/output matrix", () => {
    const cases: Array<{
      kind: GenerationKind;
      layout?: GenerationCoupleLayout;
      expected: Array<[number, string, number, number | undefined]>;
    }> = [
      { kind: "normal", expected: [[1, "combined", 1, undefined]] },
      { kind: "pixel", expected: [[1, "combined", 1, undefined]] },
      {
        kind: "portrait",
        expected: [[1, "combined", 1, undefined], [2, "combined", 2, undefined]],
      },
      {
        kind: "couple",
        layout: "together",
        expected: [[1, "combined", 1, undefined], [2, "combined", 2, undefined]],
      },
      {
        kind: "couple",
        layout: "split",
        expected: [
          [1, "left", 1, undefined],
          [1, "right", 2, undefined],
          [2, "left", 3, undefined],
          [2, "right", 4, undefined],
        ],
      },
      {
        kind: "couple",
        layout: "solo",
        expected: [
          [1, "subject-1", 1, 1],
          [1, "subject-2", 2, 2],
          [2, "subject-1", 3, 1],
          [2, "subject-2", 4, 2],
        ],
      },
    ];

    for (const entry of cases) {
      const { options, candidates } = candidatesFor(entry.kind, entry.layout);
      assert.deepEqual(generationOutputSlots(entry.kind, options), [
        ...new Set(entry.expected.map((candidate) => candidate[1])),
      ]);
      assert.deepEqual(candidates.map((candidate) => [
        candidate.variantOrdinal,
        candidate.outputSlot,
        candidate.ordinal,
        candidate.subject,
      ]), entry.expected);
      assert.equal(assertGenerationCandidatesStructure({
        jobId: JOB_ID,
        kind: entry.kind,
        options,
        width: 2,
        height: 2,
        candidates,
      }), candidates.length * 4);
    }
  });

  it("rejects incomplete, duplicate, reordered, foreign, accepted, and malformed rows", () => {
    expectInvalid({
      kind: "portrait",
      mutate: (candidates) => candidates.slice(0, 1),
    });
    expectInvalid({
      kind: "couple",
      layout: "split",
      mutate: (candidates) => [candidates[1]!, candidates[0]!, ...candidates.slice(2)],
    });
    expectInvalid({
      kind: "couple",
      layout: "split",
      mutate: (candidates) => candidates.map((candidate, index) => index === 1
        ? { ...candidate, outputSlot: "left" }
        : candidate),
    });
    expectInvalid({
      kind: "portrait",
      mutate: (candidates) => candidates.map((candidate, index) => index === 1
        ? { ...candidate, variantOrdinal: 3 }
        : candidate),
    });
    expectInvalid({
      kind: "portrait",
      mutate: (candidates) => candidates.map((candidate, index) => index === 0
        ? { ...candidate, jobId: "foreign-job" }
        : candidate),
    });
    expectInvalid({
      kind: "portrait",
      mutate: (candidates) => candidates.map((candidate, index) => index === 0
        ? { ...candidate, acceptedAt: NOW }
        : candidate),
    });
    expectInvalid({
      kind: "couple",
      layout: "solo",
      mutate: (candidates) => candidates.map((candidate, index) => index === 0
        ? { ...candidate, subject: 2 }
        : candidate),
    });
    expectInvalid({
      kind: "normal",
      mutate: (candidates) => candidates.map((candidate) => ({
        ...candidate,
        grid: { ...candidate.grid, cells: ["A01"] },
      })),
    });
  });

  it("rejects dimensions above the bounded grid resource envelope", () => {
    const { options, candidates } = candidatesFor("normal");
    assert.throws(() => assertGenerationCandidatesStructure({
      jobId: JOB_ID,
      kind: "normal",
      options,
      width: 201,
      height: 1,
      candidates,
    }), (error: unknown) => error instanceof AppError && error.code === "GENERATION_CANDIDATES_INVALID");
  });
});
