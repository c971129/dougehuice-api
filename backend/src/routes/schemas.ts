import { Type } from "@sinclair/typebox";

import { MAX_GRID_CELLS, MAX_GRID_SIDE } from "../domain/grid.js";

// JSON Schema measures maxLength in Unicode code points. A supplementary code
// point can use two six-byte `\\uXXXX` surrogate escapes, so the largest bare
// compact grid is 64 + 40,000 * (2 + 32 * 12) + 39,999 + 2 = 15,480,065 bytes.
// Sixteen MiB leaves 1,297,151 bytes for the schema-bounded route wrapper while
// keeping this authenticated grid-route exception finite and measured.
export const GRID_JSON_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

export const ProjectIdParamsSchema = Type.Object(
  { projectId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export const JobIdParamsSchema = Type.Object(
  { jobId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export const AssetIdParamsSchema = Type.Object(
  { assetId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

export const GridSchema = Type.Object({
  encoding: Type.Literal("palette-code-v1"),
  width: Type.Integer({ minimum: 1, maximum: MAX_GRID_SIDE }),
  height: Type.Integer({ minimum: 1, maximum: MAX_GRID_SIDE }),
  cells: Type.Array(Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]), {
    minItems: 1,
    maxItems: MAX_GRID_CELLS,
  }),
}, { additionalProperties: false });
