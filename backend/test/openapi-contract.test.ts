import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import SwaggerParser from "@apidevtools/swagger-parser";
import Fastify, { type FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { MemoryStore } from "../src/repositories/memory-store.js";
import { GRID_JSON_BODY_LIMIT_BYTES } from "../src/routes/schemas.js";

type JsonObject = Record<string, unknown>;

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused",
  databaseSsl: false,
  devAuthEnabled: true,
  corsOrigins: ["http://localhost:5173"],
  sessionTtlDays: 30,
  devStartingCredits: 20,
  assetStorageRoot: join(tmpdir(), "pindou-openapi-contract-assets"),
  assetEncryptionKeyBase64: "cGluZG91LWRldi1hc3NldC1rZXktMzItYnl0ZXMhISE=",
  assetMaxBytes: 10 * 1024 * 1024,
  assetDefaultTtlHours: 23,
  assetConsentVersion: "privacy-v1",
  assetPurgeBatchSize: 500,
  assetPurgeMaxBatches: 100,
  internalWorkerKey: "pindou-test-worker-key-at-least-32-chars",
};

function object(value: unknown, label: string): JsonObject {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object`);
  return value as JsonObject;
}

function operation(document: JsonObject, method: string, path: string): JsonObject {
  const paths = object(document.paths, "paths");
  const pathItem = object(paths[path], `path ${path}`);
  return object(pathItem[method.toLowerCase()], `${method} ${path}`);
}

function responses(operationObject: JsonObject): JsonObject {
  return object(operationObject.responses, "operation responses");
}

function parameterReferences(operationObject: JsonObject): string[] {
  if (!Array.isArray(operationObject.parameters)) return [];
  return operationObject.parameters.flatMap((parameter) => {
    if (typeof parameter !== "object" || parameter === null || Array.isArray(parameter)) return [];
    const reference = (parameter as JsonObject).$ref;
    return typeof reference === "string" ? [reference] : [];
  });
}

function resolveReference(document: JsonObject, reference: string): unknown {
  assert.ok(reference.startsWith("#/"), `unsupported OpenAPI reference: ${reference}`);
  return reference.slice(2).split("/").reduce<unknown>((current, rawSegment) => {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    return object(current, `reference ${reference}`)[segment];
  }, document);
}

function schemaErrors(
  value: unknown,
  rawSchema: unknown,
  document: JsonObject,
  path = "$",
): string[] {
  const schema = object(rawSchema, `${path} schema`);
  if (typeof schema.$ref === "string") {
    return schemaErrors(value, resolveReference(document, schema.$ref), document, path);
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.flatMap((candidate) => schemaErrors(value, candidate, document, path));
  }
  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.some((candidate) => schemaErrors(value, candidate, document, path).length === 0)) return [];
    return [`${path} does not match anyOf`];
  }
  if (Array.isArray(schema.enum)
    && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    return [`${path} is not one of the documented enum values`];
  }
  // OpenAPI 3.0 only lets `nullable` extend a `type` declared in the same
  // Schema Object. In particular, `nullable` beside `$ref`/`allOf` cannot
  // bypass validation of the referenced object, and enum still constrains null.
  if (value === null && schema.nullable === true && typeof schema.type === "string") return [];

  switch (schema.type) {
    case "null":
      return value === null ? [] : [`${path} must be null`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)
        || schema.type === "integer" && !Number.isInteger(value)) {
        return [`${path} must be a ${schema.type}`];
      }
      const errors: string[] = [];
      if (typeof schema.minimum === "number"
        && (schema.exclusiveMinimum === true ? value <= schema.minimum : value < schema.minimum)) {
        errors.push(`${path} is below minimum`);
      }
      if (typeof schema.maximum === "number"
        && (schema.exclusiveMaximum === true ? value >= schema.maximum : value > schema.maximum)) {
        errors.push(`${path} is above maximum`);
      }
      return errors;
    }
    case "string": {
      if (typeof value !== "string") return [`${path} must be a string`];
      const errors: string[] = [];
      const codePointLength = Array.from(value).length;
      if (typeof schema.minLength === "number" && codePointLength < schema.minLength) {
        errors.push(`${path} is shorter than minLength`);
      }
      if (typeof schema.maxLength === "number" && codePointLength > schema.maxLength) {
        errors.push(`${path} is longer than maxLength`);
      }
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
        errors.push(`${path} does not match pattern`);
      }
      if (schema.format === "uuid"
        && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
        errors.push(`${path} is not a UUID`);
      }
      if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) {
        errors.push(`${path} is not a date-time`);
      }
      return errors;
    }
    case "array": {
      if (!Array.isArray(value)) return [`${path} must be an array`];
      const errors: string[] = [];
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        errors.push(`${path} has fewer than minItems`);
      }
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
        errors.push(`${path} has more than maxItems`);
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items, document, `${path}[${index}]`)));
      }
      return errors;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [`${path} must be an object`];
      }
      const record = value as JsonObject;
      const properties = schema.properties === undefined
        ? {} : object(schema.properties, `${path} properties`);
      const errors: string[] = [];
      if (Array.isArray(schema.required)) {
        for (const required of schema.required) {
          if (typeof required === "string" && !(required in record)) {
            errors.push(`${path}.${required} is required`);
          }
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in properties)) errors.push(`${path}.${key} is not documented`);
        }
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (key in record) errors.push(...schemaErrors(record[key], propertySchema, document, `${path}.${key}`));
      }
      return errors;
    }
    default:
      return [];
  }
}

function assertMatchesSchema(value: unknown, schema: unknown, document: JsonObject, label: string): void {
  assert.deepEqual(schemaErrors(value, schema, document), [], label);
}

async function assertStrictResponseInstances(
  schema: unknown,
  instances: readonly { expectedStatus?: number; label: string; value: unknown }[],
): Promise<void> {
  const validator = Fastify({ logger: false });
  try {
    validator.post("/validate-response", {
      schema: { body: object(schema, "strict response schema") },
    }, async () => ({ valid: true }));
    await validator.ready();

    for (const instance of instances) {
      const result = await validator.inject({
        method: "POST",
        url: "/validate-response",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(instance.value),
      });
      assert.equal(result.statusCode, instance.expectedStatus ?? 200, `${instance.label}: ${result.body}`);
    }
  } finally {
    await validator.close();
  }
}

function jsonRequestSchema(operationObject: JsonObject): unknown {
  const requestBody = object(operationObject.requestBody, "request body");
  const content = object(requestBody.content, "request content");
  return object(content["application/json"], "request JSON").schema;
}

function jsonResponseSchema(document: JsonObject, operationObject: JsonObject, status: string): unknown {
  const rawResponse = object(responses(operationObject)[status], `${status} response`);
  const response = typeof rawResponse.$ref === "string"
    ? object(resolveReference(document, rawResponse.$ref), `${status} referenced response`)
    : rawResponse;
  const content = object(response.content, `${status} response content`);
  return object(content["application/json"], `${status} response JSON`).schema;
}

class WebLoginCollisionStore extends MemoryStore {
  override async createWebLoginChallenge(
    _input: { tokenHash: string; code: string; expiresAt: string },
  ): Promise<void> {
    throw new AppError(409, "WEB_LOGIN_CODE_COLLISION", "登录码冲突，请重试");
  }
}

describe("generated OpenAPI contract", () => {
  let app: FastifyInstance;
  let document: JsonObject;

  before(async () => {
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(response.statusCode, 200);
    document = object(response.json() as unknown, "OpenAPI document");
  });

  after(async () => {
    await app.close();
  });

  it("marks every operation with its actual bearer, API-key, internal-worker, or public security boundary", () => {
    const publicOperations = new Set([
      "GET /health",
      "GET /ready",
      "POST /auth/wechat-session",
      "POST /auth/dev-session",
      "POST /auth/web-login-challenges",
      "GET /privacy/ai-processing-consent",
      "POST /wechat-pay/notifications",
    ]);
    const internalOperations = new Set([
      "POST /privacy/delete-expired",
      "POST /internal/fake-payments/{paymentOrderId}/succeed",
      "POST /internal/export-jobs/process-next",
      "POST /internal/export-artifacts/purge-expired",
      "POST /internal/generation-jobs/process-next",
    ]);
    const optionalAuthOperations = new Set([
      "GET /palettes",
    ]);
    const paths = object(document.paths, "paths");
    for (const [path, rawPathItem] of Object.entries(paths)) {
      const pathItem = object(rawPathItem, `path ${path}`);
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        if (pathItem[method] === undefined) continue;
        const current = object(pathItem[method], `${method} ${path}`);
        const key = `${method.toUpperCase()} ${path}`;
        const expected = internalOperations.has(key)
          ? [{ internalWorkerKey: [] }]
          : key === "GET /auth/web-login-challenges/current" ? [{ webLoginToken: [] }]
          : optionalAuthOperations.has(key) ? [{}, { bearerAuth: [] }]
            : publicOperations.has(key) ? [] : [{ bearerAuth: [] }];
        assert.deepEqual(current.security, expected, key);
        if (!publicOperations.has(key)) {
          assert.ok(responses(current)["401"], `${key} must document its 401 response`);
        }
        assert.ok(responses(current)["500"], `${key} must document its 500 response`);
      }
    }

    const components = object(document.components, "components");
    const securitySchemes = object(components.securitySchemes, "security schemes");
    assert.deepEqual(object(securitySchemes.bearerAuth, "bearerAuth"), {
      type: "http",
      scheme: "bearer",
      bearerFormat: "opaque session token",
      description: "由微信登录或本地开发登录接口签发的会话令牌",
    });
    assert.equal(object(securitySchemes.internalWorkerKey, "internalWorkerKey").name, "X-Internal-Worker-Key");
    assert.deepEqual(object(securitySchemes.webLoginToken, "webLoginToken"), {
      type: "apiKey",
      in: "header",
      name: "X-Web-Login-Token",
      description: "创建 Web 登录挑战时签发、仅用于轮询该挑战状态的一次性随机令牌",
    });
  });

  it("publishes a standards-valid OpenAPI 3.0.3 document without 3.1-only null or numeric exclusive bounds", async () => {
    assert.equal(document.openapi, "3.0.3");
    await SwaggerParser.validate(JSON.parse(JSON.stringify(document)));

    const nullableObjectReferences: string[] = [];
    const visit = (value: unknown, path = "$"): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as JsonObject;
      assert.notEqual(record.type, "null", `${path} uses the OpenAPI 3.1 null type`);
      assert.notEqual(typeof record.exclusiveMinimum, "number", `${path}.exclusiveMinimum must be boolean in OAS 3.0`);
      assert.notEqual(typeof record.exclusiveMaximum, "number", `${path}.exclusiveMaximum must be boolean in OAS 3.0`);
      if (Array.isArray(record.anyOf) && record.anyOf.length === 2) {
        const referenceBranch = record.anyOf[0];
        const nullBranch = record.anyOf[1];
        if (typeof nullBranch === "object" && nullBranch !== null && !Array.isArray(nullBranch)) {
          const nullSchema = nullBranch as JsonObject;
          if (nullSchema.type === "object"
            && nullSchema.nullable === true
            && Array.isArray(nullSchema.enum)
            && nullSchema.enum.length === 1
            && nullSchema.enum[0] === null) {
            const referenceSchema = object(referenceBranch, `${path}.anyOf[0]`);
            if (typeof referenceSchema.$ref === "string") {
              const reference = referenceSchema.$ref;
              const target = object(resolveReference(document, reference), `${path} nullable reference target`);
              assert.equal(target.type, "object", `${reference} must remain an object schema`);
              nullableObjectReferences.push(reference);
            }
          }
        }
      }
      for (const [key, nested] of Object.entries(record)) visit(nested, `${path}.${key}`);
    };
    visit(document);
    assert.deepEqual([...new Set(nullableObjectReferences)].sort(), [
      "#/components/schemas/CreationDraft",
      "#/components/schemas/MiniProgramPaymentParams",
      "#/components/schemas/PatternGrid",
      "#/components/schemas/ProjectDraft",
    ]);

    const components = object(document.components, "components");
    const schemas = object(components.schemas, "schemas");
    const paymentOrderResponse = object(
      jsonResponseSchema(document, operation(document, "post", "/payment-orders"), "201"),
      "payment order response schema",
    );
    const paymentParams = object(
      object(paymentOrderResponse.properties, "payment response properties").paymentParams,
      "nullable payment params",
    );
    assert.deepEqual(paymentParams, {
      anyOf: [
        { $ref: "#/components/schemas/MiniProgramPaymentParams" },
        { type: "object", nullable: true, enum: [null] },
      ],
    });

    const ledgerEntry = object(schemas.CreditLedgerEntry, "CreditLedgerEntry");
    const referenceId = object(
      object(ledgerEntry.properties, "CreditLedgerEntry properties").referenceId,
      "nullable primitive referenceId",
    );
    assert.deepEqual(referenceId, { type: "string", nullable: true });

    const palette = object(schemas.Palette, "Palette");
    const beadSize = object(object(palette.properties, "Palette properties").beadSizeMm, "bead size");
    assert.equal(beadSize.minimum, 0);
    assert.equal(beadSize.exclusiveMinimum, true);
  });

  it("strictly validates both null and referenced-object creation-draft responses", async () => {
    const draftOperation = operation(document, "get", "/creation-draft");
    const responseSchema = jsonResponseSchema(document, draftOperation, "200");
    assert.notDeepEqual(
      schemaErrors(null, {
        nullable: true,
        allOf: [{ $ref: "#/components/schemas/CreationDraft" }],
      }, document),
      [],
      "nullable without a same-level type must not bypass a referenced object schema",
    );

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: "OpenAPI nullable 引用用户" },
    });
    assert.equal(login.statusCode, 201, login.body);
    const authorization = { authorization: `Bearer ${login.json().token as string}` };

    const empty = await app.inject({
      method: "GET",
      url: "/api/v1/creation-draft",
      headers: authorization,
    });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.deepEqual(empty.json(), { draft: null });
    assertMatchesSchema(
      empty.json(),
      responseSchema,
      document,
      "GET /creation-draft draft:null must match the published nullable reference",
    );

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/creation-draft",
      headers: authorization,
      payload: {
        draftId: null,
        baseDraftRevision: 0,
        name: "OpenAPI nullable 引用草稿",
        kind: "normal",
        setupStep: 3,
        paletteId: "mard-48-v1",
        sourceAssetId: null,
        width: 2,
        height: 2,
        options: {},
        grid: {
          encoding: "palette-code-v1",
          width: 2,
          height: 2,
          cells: ["F5", null, "C5", "A11"],
        },
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);

    const populated = await app.inject({
      method: "GET",
      url: "/api/v1/creation-draft",
      headers: authorization,
    });
    assert.equal(populated.statusCode, 200, populated.body);
    assert.equal(populated.json().draft.id, saved.json().draft.id);
    assertMatchesSchema(
      populated.json(),
      responseSchema,
      document,
      "GET /creation-draft non-null referenced draft must match the published schema",
    );

    const dereferencedDocument = object(
      await SwaggerParser.dereference(JSON.parse(JSON.stringify(document))),
      "dereferenced OpenAPI document",
    );
    await assertStrictResponseInstances(
      jsonResponseSchema(
        dereferencedDocument,
        operation(dereferencedDocument, "get", "/creation-draft"),
        "200",
      ),
      [
        { label: "strict draft:null response validation", value: empty.json() },
        { label: "strict non-null draft response validation", value: populated.json() },
        {
          expectedStatus: 400,
          label: "strict malformed draft response rejection",
          value: { draft: {} },
        },
      ],
    );
  });

  it("documents and returns the real Web login challenge authentication and error statuses", async () => {
    const createOperation = operation(document, "post", "/auth/web-login-challenges");
    const currentOperation = operation(document, "get", "/auth/web-login-challenges/current");
    const confirmOperation = operation(document, "post", "/auth/web-login-challenges/confirm");
    assert.deepEqual(responses(createOperation)["409"], { $ref: "#/components/responses/Conflict" });
    assert.deepEqual(responses(currentOperation)["401"], { $ref: "#/components/responses/Unauthorized" });
    assert.deepEqual(responses(currentOperation)["404"], { $ref: "#/components/responses/NotFound" });
    assert.deepEqual(responses(confirmOperation)["404"], { $ref: "#/components/responses/NotFound" });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/auth/web-login-challenges",
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdBody = created.json();
    assert.equal(typeof createdBody.token, "string");
    assert.equal(typeof createdBody.sessionToken, "string");
    assert.notEqual(createdBody.token, createdBody.sessionToken);
    assertMatchesSchema(
      createdBody,
      jsonResponseSchema(document, createOperation, "201"),
      document,
      "live Web login challenge creation response must match OpenAPI",
    );

    const missingToken = await app.inject({
      method: "GET",
      url: "/api/v1/auth/web-login-challenges/current",
    });
    assert.equal(missingToken.statusCode, 401, missingToken.body);
    assert.equal(missingToken.json().error.code, "WEB_LOGIN_TOKEN_REQUIRED");
    assertMatchesSchema(
      missingToken.json(),
      jsonResponseSchema(document, currentOperation, "401"),
      document,
      "live missing Web login token response must match OpenAPI",
    );

    const unknownChallenge = await app.inject({
      method: "GET",
      url: "/api/v1/auth/web-login-challenges/current",
      headers: { "x-web-login-token": "unknown-web-login-token-at-least-20-chars" },
    });
    assert.equal(unknownChallenge.statusCode, 404, unknownChallenge.body);
    assert.equal(unknownChallenge.json().error.code, "WEB_LOGIN_CHALLENGE_NOT_FOUND");
    assertMatchesSchema(
      unknownChallenge.json(),
      jsonResponseSchema(document, currentOperation, "404"),
      document,
      "live unknown Web login challenge response must match OpenAPI",
    );

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: "Web 配对错误契约用户" },
    });
    assert.equal(login.statusCode, 201, login.body);
    const invalidCode = await app.inject({
      method: "POST",
      url: "/api/v1/auth/web-login-challenges/confirm",
      headers: { authorization: `Bearer ${login.json().token as string}` },
      payload: { code: "999999" },
    });
    assert.equal(invalidCode.statusCode, 404, invalidCode.body);
    assert.equal(invalidCode.json().error.code, "WEB_LOGIN_CODE_INVALID");
    assertMatchesSchema(
      invalidCode.json(),
      jsonResponseSchema(document, confirmOperation, "404"),
      document,
      "live invalid Web login code response must match OpenAPI",
    );

    const collisionApp = await buildApp({ config, store: new WebLoginCollisionStore(), logger: false });
    try {
      await collisionApp.ready();
      const collision = await collisionApp.inject({
        method: "POST",
        url: "/api/v1/auth/web-login-challenges",
      });
      assert.equal(collision.statusCode, 409, collision.body);
      assert.equal(collision.json().error.code, "WEB_LOGIN_CODE_COLLISION");
      assertMatchesSchema(
        collision.json(),
        jsonResponseSchema(document, createOperation, "409"),
        document,
        "live colliding Web login code response must match OpenAPI",
      );
    } finally {
      await collisionApp.close();
    }
  });

  it("validates live health and generation-accept traffic against the published schemas", async () => {
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    assert.equal(health.statusCode, 200, health.body);
    assertMatchesSchema(
      health.json(),
      jsonResponseSchema(document, operation(document, "get", "/health"), "200"),
      document,
      "live health response must match OpenAPI",
    );
    assert.deepEqual(health.json(), { status: "ok", service: "pindou-backend" });

    const oversizedOrdinaryJson = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(oversizedOrdinaryJson.statusCode, 413, oversizedOrdinaryJson.body);
    assert.equal(oversizedOrdinaryJson.json().error.code, "PAYLOAD_TOO_LARGE");

    const unauthenticatedGridRoutes = [
      { method: "POST", url: "/api/v1/projects" },
      { method: "PUT", url: "/api/v1/projects/00000000-0000-4000-8000-000000000001/grid" },
      { method: "PUT", url: "/api/v1/projects/00000000-0000-4000-8000-000000000001/draft" },
      { method: "PUT", url: "/api/v1/creation-draft" },
    ] as const;
    const overGridRouteLimitPayload = " ".repeat(GRID_JSON_BODY_LIMIT_BYTES + 1);
    const unauthenticatedPayloads = [
      { label: "malformed JSON", payload: "{" },
      { label: "over-limit JSON", payload: overGridRouteLimitPayload },
    ];
    for (const route of unauthenticatedGridRoutes) {
      for (const testPayload of unauthenticatedPayloads) {
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers: { "content-type": "application/json" },
          payload: testPayload.payload,
        });
        assert.equal(
          response.statusCode,
          401,
          `${route.method} ${route.url} must authenticate before ${testPayload.label}: ${response.body}`,
        );
        assert.equal(response.json().error.code, "AUTH_REQUIRED");
      }
    }

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      payload: { displayName: "OpenAPI 运行时契约用户" },
    });
    assert.equal(login.statusCode, 201, login.body);
    const token = login.json().token as string;
    const authorization = { authorization: `Bearer ${token}` };

    const authenticatedOverLimitGridRoute = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: {
        ...authorization,
        "content-type": "application/json",
        "idempotency-key": "openapi-grid-route-over-limit-0001",
      },
      payload: overGridRouteLimitPayload,
    });
    assert.equal(authenticatedOverLimitGridRoute.statusCode, 413, authenticatedOverLimitGridRoute.body);
    assert.equal(authenticatedOverLimitGridRoute.json().error.code, "PAYLOAD_TOO_LARGE");

    const longUnicodeColorCode = "豆".repeat(32);
    const astralColorCode = "😀".repeat(32);
    assert.equal(Array.from(astralColorCode).length, 32);
    assert.equal(astralColorCode.length, 64);
    assert.deepEqual(
      schemaErrors(astralColorCode, { type: "string", minLength: 1, maxLength: 32 }, document),
      [],
    );
    assert.notDeepEqual(
      schemaErrors(`${astralColorCode}😀`, { type: "string", minLength: 1, maxLength: 32 }, document),
      [],
    );
    const customPalette = await app.inject({
      method: "POST",
      url: "/api/v1/palettes",
      headers: { ...authorization, "idempotency-key": "openapi-large-grid-palette-0001" },
      payload: {
        name: "大请求色卡",
        brand: "契约测试",
        beadSizeMm: 2.6,
        colors: [
          { code: longUnicodeColorCode, name: "长色号", hex: "#AABBCC" },
          { code: astralColorCode, name: "星空色号", hex: "#4455CC" },
          { code: "B", name: "备用色", hex: "#112233" },
        ],
      },
    });
    assert.equal(customPalette.statusCode, 201, customPalette.body);
    const customPaletteId = customPalette.json().palette.id as string;
    const largeGridValue = {
      encoding: "palette-code-v1" as const,
      width: 200,
      height: 200,
      cells: Array.from({ length: 40_000 }, () => longUnicodeColorCode),
    };
    const assertLargeGridPayloadSize = (payload: string): void => {
      assert.ok(Buffer.byteLength(payload) > 2 * 1024 * 1024);
      assert.ok(Buffer.byteLength(payload) < GRID_JSON_BODY_LIMIT_BYTES);
    };

    let largeProjectId = "";
    let largeProjectRevision = 0;
    {
      const payload = JSON.stringify({
        name: "合法大图纸",
        paletteId: customPaletteId,
        grid: largeGridValue,
      });
      assertLargeGridPayloadSize(payload);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: {
          ...authorization,
          "content-type": "application/json",
          "idempotency-key": "openapi-large-grid-project-0001",
        },
        payload,
      });
      assert.equal(response.statusCode, 201, response.body.slice(0, 1_000));
      const body = response.json() as {
        project: { id: string; currentRevision: number; grid: { cells: unknown[] } };
      };
      largeProjectId = body.project.id;
      largeProjectRevision = body.project.currentRevision;
      assert.equal(body.project.grid.cells.length, 40_000);
    }

    {
      const payload = JSON.stringify({ baseRevision: largeProjectRevision, grid: largeGridValue });
      assertLargeGridPayloadSize(payload);
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/projects/${largeProjectId}/grid`,
        headers: {
          ...authorization,
          "content-type": "application/json",
          "idempotency-key": "openapi-large-grid-update-0001",
        },
        payload,
      });
      assert.equal(response.statusCode, 200, response.body.slice(0, 1_000));
      const body = response.json() as { project: { currentRevision: number } };
      largeProjectRevision = body.project.currentRevision;
    }

    {
      const payload = JSON.stringify({
        baseProjectRevision: largeProjectRevision,
        baseDraftRevision: 0,
        grid: largeGridValue,
      });
      assertLargeGridPayloadSize(payload);
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/projects/${largeProjectId}/draft`,
        headers: { ...authorization, "content-type": "application/json" },
        payload,
      });
      assert.equal(response.statusCode, 200, response.body.slice(0, 1_000));
    }

    {
      const payload = JSON.stringify({
        draftId: null,
        baseDraftRevision: 0,
        name: "合法大创建草稿",
        kind: "normal",
        setupStep: 2,
        paletteId: customPaletteId,
        sourceAssetId: null,
        width: 200,
        height: 200,
        grid: largeGridValue,
      });
      assertLargeGridPayloadSize(payload);
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/creation-draft",
        headers: { ...authorization, "content-type": "application/json" },
        payload,
      });
      assert.equal(response.statusCode, 200, response.body.slice(0, 1_000));
    }

    {
      const escapedAstralColorCode = "\\ud83d\\ude00".repeat(32);
      assert.equal(JSON.parse(`"${escapedAstralColorCode}"`), astralColorCode);
      const escapedAstralCell = `"${escapedAstralColorCode}"`;
      const compactPayload =
        `{"name":"合法转义星空图纸","paletteId":${JSON.stringify(customPaletteId)},`
        + '"grid":{"encoding":"palette-code-v1","width":200,"height":200,"cells":['
        + new Array(40_000).fill(escapedAstralCell).join(",")
        + "]}}";
      const compactPayloadBytes = Buffer.byteLength(compactPayload);
      assert.ok(compactPayloadBytes > 9 * 1024 * 1024);
      assert.ok(compactPayloadBytes < GRID_JSON_BODY_LIMIT_BYTES);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: {
          ...authorization,
          "content-type": "application/json",
          "idempotency-key": "openapi-astral-grid-project-0001",
        },
        payload: compactPayload,
      });
      assert.equal(response.statusCode, 201, response.body.slice(0, 1_000));
    }

    const oversizedProjectPayload = {
      name: "越界图纸",
      paletteId: "mard-48-v1",
      grid: {
        encoding: "palette-code-v1",
        width: 201,
        height: 1,
        cells: Array.from({ length: 201 }, () => null),
      },
    };
    const projectCreateSchema = jsonRequestSchema(operation(document, "post", "/projects"));
    assert.notDeepEqual(schemaErrors(oversizedProjectPayload, projectCreateSchema, document), []);
    const oversizedProject = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...authorization, "idempotency-key": "openapi-project-size-limit-0001" },
      payload: oversizedProjectPayload,
    });
    assert.equal(oversizedProject.statusCode, 400, oversizedProject.body);
    assert.equal(oversizedProject.json().error.code, "VALIDATION_ERROR");

    const oversizedGenerationPayload = {
      kind: "normal",
      paletteId: "mard-48-v1",
      width: 65,
      height: 8,
      seed: "openapi-generation-size-limit",
    };
    const generationCreateSchema = jsonRequestSchema(operation(document, "post", "/generation-jobs"));
    const maximumColorGenerationPayload = {
      ...oversizedGenerationPayload,
      width: 8,
      options: { maxColors: 32 },
    };
    assert.deepEqual(schemaErrors(maximumColorGenerationPayload, generationCreateSchema, document), []);
    assert.notDeepEqual(schemaErrors({
      ...maximumColorGenerationPayload,
      options: { maxColors: 33 },
    }, generationCreateSchema, document), []);
    assert.notDeepEqual(schemaErrors(oversizedGenerationPayload, generationCreateSchema, document), []);
    const oversizedGeneration = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: { ...authorization, "idempotency-key": "openapi-generation-size-limit-0001" },
      payload: oversizedGenerationPayload,
    });
    assert.equal(oversizedGeneration.statusCode, 400, oversizedGeneration.body);
    assert.equal(oversizedGeneration.json().error.code, "VALIDATION_ERROR");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/generation-jobs",
      headers: { ...authorization, "idempotency-key": "openapi-generation-create-0001" },
      payload: {
        kind: "normal",
        paletteId: "mard-48-v1",
        width: 8,
        height: 8,
        seed: "openapi-runtime-contract",
      },
    });
    assert.equal(created.statusCode, 202, created.body);
    const jobId = created.json().job.id as string;
    const processed = await app.inject({
      method: "POST",
      url: "/api/v1/internal/generation-jobs/process-next",
      headers: { "x-internal-worker-key": config.internalWorkerKey },
    });
    assert.equal(processed.statusCode, 200, processed.body);
    const candidateId = processed.json().job.candidates[0].id as string;
    assert.ok(candidateId.length >= 1 && candidateId.length <= 100);
    assert.doesNotMatch(candidateId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

    const acceptOperation = operation(document, "post", "/generation-jobs/{jobId}/accept");
    const requestSchema = jsonRequestSchema(acceptOperation);
    const validPayload = { candidateId, projectName: "运行时契约图纸" };
    assertMatchesSchema(validPayload, requestSchema, document, "live accept request must match OpenAPI");

    const tooLongPayload = { candidateId: "x".repeat(101), projectName: "越界候选" };
    assert.notDeepEqual(schemaErrors(tooLongPayload, requestSchema, document), []);
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${jobId}/accept`,
      headers: { ...authorization, "idempotency-key": "openapi-generation-invalid-0001" },
      payload: tooLongPayload,
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(rejected.json().error.code, "VALIDATION_ERROR");

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/generation-jobs/${jobId}/accept`,
      headers: { ...authorization, "idempotency-key": "openapi-generation-accept-0001" },
      payload: validPayload,
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
    assert.equal(accepted.json().job.acceptedCandidateId, candidateId);
    assertMatchesSchema(
      accepted.json(),
      jsonResponseSchema(document, acceptOperation, "201"),
      document,
      "live accept response must match OpenAPI",
    );
  });

  it("exposes the complete immutable AI consent policy snapshot", () => {
    const components = object(document.components, "components");
    const schemas = object(components.schemas, "schemas");
    const consent = object(schemas.AiProcessingConsent, "AiProcessingConsent");
    assert.deepEqual(consent.required, [
      "consentVersion",
      "policySha256",
      "processor",
      "purpose",
      "upload",
      "retention",
    ]);
    const properties = object(consent.properties, "AiProcessingConsent properties");
    assert.equal(object(properties.policySha256, "policySha256").pattern, "^[0-9a-f]{64}$");
    const retention = object(properties.retention, "retention");
    assert.deepEqual(retention.required, ["defaultHours", "description"]);

    const event = object(schemas.AssetConsentEvent, "AssetConsentEvent");
    assert.deepEqual(event.required, [
      "id",
      "assetId",
      "consentVersion",
      "assetPurpose",
      "policySha256",
      "processor",
      "purpose",
      "retention",
      "source",
      "occurredAt",
      "recordedAt",
    ]);
    assert.equal(object(event.properties, "AssetConsentEvent properties").userId, undefined);

    const historyResponse = object(
      responses(operation(document, "get", "/privacy/ai-processing-consent/events"))["200"],
      "consent history response",
    );
    const historyContent = object(historyResponse.content, "consent history content");
    const historyJson = object(historyContent["application/json"], "consent history JSON");
    const historySchema = object(historyJson.schema, "consent history schema");
    const historyProperties = object(historySchema.properties, "consent history properties");
    assert.deepEqual(object(historyProperties.events, "consent events").items, {
      $ref: "#/components/schemas/AssetConsentEvent",
    });
    assert.deepEqual(historyProperties.pagination, { $ref: "#/components/schemas/OffsetPagination" });
  });

  it("documents the asset-delete rate limit", () => {
    assert.deepEqual(
      responses(operation(document, "delete", "/assets/{assetId}"))["429"],
      { $ref: "#/components/responses/RateLimited" },
    );
  });

  it("exposes only bounded inventory operation audit facts", () => {
    const components = object(document.components, "components");
    const schemas = object(components.schemas, "schemas");
    const inventoryOperation = object(schemas.InventoryOperation, "InventoryOperation");
    assert.equal(inventoryOperation.additionalProperties, false);
    assert.deepEqual(inventoryOperation.required, [
      "id",
      "userId",
      "type",
      "projectId",
      "projectRevision",
      "idempotencyReference",
      "consumedAt",
      "createdAt",
    ]);
    assert.deepEqual(Object.keys(object(inventoryOperation.properties, "InventoryOperation properties")), [
      "id",
      "userId",
      "type",
      "projectId",
      "projectRevision",
      "idempotencyReference",
      "consumedAt",
      "createdAt",
    ]);

    const response = object(
      responses(operation(document, "get", "/inventory/operations"))["200"],
      "inventory operations response",
    );
    const content = object(response.content, "inventory operations response content");
    const json = object(content["application/json"], "inventory operations response JSON");
    const schema = object(json.schema, "inventory operations response schema");
    const properties = object(schema.properties, "inventory operations response properties");
    assert.deepEqual(object(properties.operations, "inventory operations").items, {
      $ref: "#/components/schemas/InventoryOperation",
    });
  });

  it("documents every durable idempotent write and its replay response header", () => {
    const idempotentOperations = [
      ["post", "/assets"],
      ["post", "/palettes"],
      ["post", "/projects/{projectId}/completion-photos"],
      ["delete", "/projects/{projectId}/completion-photos/{photoId}"],
      ["post", "/creation-draft/commit"],
      ["delete", "/creation-draft"],
      ["post", "/projects"],
      ["put", "/projects/{projectId}/grid"],
      ["post", "/projects/{projectId}/remap-palette"],
      ["patch", "/projects/{projectId}"],
      ["patch", "/projects/{projectId}/metadata"],
      ["post", "/projects/{projectId}/copy"],
      ["post", "/projects/{projectId}/revisions/{revision}/restore"],
      ["delete", "/projects/{projectId}"],
      ["post", "/projects/{projectId}/draft/commit"],
      ["delete", "/projects/{projectId}/draft"],
      ["put", "/projects/{projectId}/build-progress"],
      ["post", "/inventory/batch"],
      ["put", "/inventory/{paletteId}/{colorCode}"],
      ["post", "/projects/{projectId}/inventory-consumption"],
      ["post", "/payment-orders"],
      ["post", "/payment-orders/{paymentOrderId}/refresh"],
      ["post", "/exports"],
      ["post", "/exports/{exportId}/cancel"],
      ["post", "/generation-jobs"],
      ["post", "/generation-jobs/{jobId}/cancel"],
      ["post", "/generation-jobs/{jobId}/redraw"],
      ["post", "/generation-jobs/{jobId}/accept"],
      ["post", "/generation-jobs/{jobId}/variants/{variantOrdinal}/accept"],
    ] as const;

    for (const [method, path] of idempotentOperations) {
      const current = operation(document, method, path);
      assert.ok(
        parameterReferences(current).includes("#/components/parameters/IdempotencyKey"),
        `${method.toUpperCase()} ${path}`,
      );
      for (const [status, rawResponse] of Object.entries(responses(current))) {
        if (!status.startsWith("2")) continue;
        const response = object(rawResponse, `${method} ${path} ${status}`);
        const headers = object(response.headers, `${method} ${path} ${status} headers`);
        assert.deepEqual(headers["Idempotency-Replayed"], {
          $ref: "#/components/headers/IdempotencyReplayed",
        });
      }
      assert.deepEqual(responses(current)["409"], { $ref: "#/components/responses/Conflict" });
      assert.deepEqual(
        responses(current)["429"],
        { $ref: "#/components/responses/RateLimited" },
        `${method.toUpperCase()} ${path} can reject a saturated durable idempotency history`,
      );
    }

    for (const path of [
      "/generation-jobs/{jobId}/accept",
      "/generation-jobs/{jobId}/variants/{variantOrdinal}/accept",
    ]) {
      assert.deepEqual(
        responses(operation(document, "post", path))["429"],
        { $ref: "#/components/responses/RateLimited" },
        `${path} can also reject project creation when the active-project quota is full`,
      );
    }

    assert.equal(
      parameterReferences(operation(document, "put", "/creation-draft"))
        .includes("#/components/parameters/IdempotencyKey"),
      false,
    );
    const components = object(document.components, "components");
    const parameters = object(components.parameters, "parameters");
    assert.deepEqual(object(parameters.IdempotencyKey, "IdempotencyKey").schema, {
      type: "string",
      minLength: 8,
      maxLength: 128,
    });
  });

  it("publishes searchable project-library models and revision restore contracts", () => {
    const components = object(document.components, "components");
    const schemas = object(components.schemas, "schemas");
    const project = object(schemas.Project, "Project");
    const projectRequired = project.required as unknown[];
    for (const field of ["tags", "deviceSource", "revisionDeviceSource", "revisionUpdatedAt"]) {
      assert.ok(projectRequired.includes(field), `Project.${field}`);
    }
    const revision = object(schemas.ProjectRevisionMetadata, "ProjectRevisionMetadata");
    assert.deepEqual(revision.required, [
      "projectId",
      "revision",
      "paletteId",
      "width",
      "height",
      "deviceSource",
      "createdAt",
      "updatedAt",
    ]);

    const listed = operation(document, "get", "/projects/{projectId}/revisions");
    const listedResponse = object(responses(listed)["200"], "revision list response");
    const listedContent = object(listedResponse.content, "revision list content");
    const listedJson = object(listedContent["application/json"], "revision list json");
    const listedSchema = object(listedJson.schema, "revision list schema");
    const listedProperties = object(listedSchema.properties, "revision list properties");
    assert.deepEqual(object(listedProperties.revisions, "revisions").items, {
      $ref: "#/components/schemas/ProjectRevisionMetadata",
    });

    const restore = operation(document, "post", "/projects/{projectId}/revisions/{revision}/restore");
    assert.ok(parameterReferences(restore).includes("#/components/parameters/IdempotencyKey"));
    assert.deepEqual(responses(restore)["409"], { $ref: "#/components/responses/Conflict" });
    assert.deepEqual(responses(restore)["429"], { $ref: "#/components/responses/RateLimited" });
  });

  it("describes multipart uploads, webhook headers, and private binary downloads", () => {
    const assetUpload = operation(document, "post", "/assets");
    const assetRequest = object(assetUpload.requestBody, "asset request body");
    const assetContent = object(assetRequest.content, "asset request content");
    const assetMultipart = object(assetContent["multipart/form-data"], "asset multipart content");
    const assetSchema = object(assetMultipart.schema, "asset multipart schema");
    assert.deepEqual(assetSchema.required, ["file"]);
    assert.equal(object(object(assetSchema.properties, "asset properties").file, "asset file").format, "binary");

    const photoUpload = operation(document, "post", "/projects/{projectId}/completion-photos");
    const photoContent = object(object(photoUpload.requestBody, "photo request body").content, "photo content");
    const photoSchema = object(object(photoContent["multipart/form-data"], "photo multipart").schema, "photo schema");
    assert.deepEqual(photoSchema.required, ["file"]);
    assert.equal(object(object(photoSchema.properties, "photo properties").file, "photo file").format, "binary");

    const exportDownload = responses(operation(document, "get", "/exports/{exportId}/content"));
    const exportContent = object(object(exportDownload["200"], "export response").content, "export content");
    assert.equal(object(object(exportContent["image/png"], "png content").schema, "png schema").format, "binary");
    assert.equal(object(object(exportContent["application/pdf"], "pdf content").schema, "pdf schema").format, "binary");
    assert.deepEqual(exportDownload["410"], { $ref: "#/components/responses/Gone" });
    assert.deepEqual(exportDownload["429"], { $ref: "#/components/responses/RateLimited" });
    assert.deepEqual(exportDownload["503"], { $ref: "#/components/responses/ServiceUnavailable" });
    const serviceUnavailable = object(
      object(object(document.components, "components").responses, "responses").ServiceUnavailable,
      "service unavailable response",
    );
    assert.ok(object(serviceUnavailable.headers, "service unavailable headers")["Retry-After"]);
    assert.deepEqual(
      responses(operation(document, "get", "/assets/{assetId}/content"))["503"],
      { $ref: "#/components/responses/ServiceUnavailable" },
    );
    assert.deepEqual(
      responses(operation(document, "get", "/projects/{projectId}/completion-photos/{photoId}/content"))["503"],
      { $ref: "#/components/responses/ServiceUnavailable" },
    );
    const exportDownloadParameters = parameterReferences(operation(document, "get", "/exports/{exportId}/content"));
    assert.equal(exportDownloadParameters.includes("#/components/parameters/IdempotencyKey"), false);

    const webhook = operation(document, "post", "/wechat-pay/notifications");
    const webhookContent = object(object(webhook.requestBody, "webhook request body").content, "webhook content");
    assert.ok(webhookContent["application/json"]);
    const references = parameterReferences(webhook);
    for (const name of ["WechatpaySerial", "WechatpaySignature", "WechatpayTimestamp", "WechatpayNonce"]) {
      assert.ok(references.includes(`#/components/parameters/${name}`), name);
    }
    assert.deepEqual(webhook.security, []);
    assert.deepEqual(responses(webhook)["400"], {
      $ref: "#/components/responses/WechatPayNotificationFailure",
    });
    assert.deepEqual(responses(webhook)["401"], {
      $ref: "#/components/responses/WechatPayNotificationFailure",
    });
    assert.deepEqual(responses(webhook)["503"], {
      $ref: "#/components/responses/WechatPayNotificationFailure",
    });
    assert.deepEqual(responses(webhook)["413"], { $ref: "#/components/responses/PayloadTooLarge" });
  });

  it("uses the runtime success codes instead of Swagger's default 200 placeholder", () => {
    const assetResponses = responses(operation(document, "post", "/assets"));
    assert.ok(assetResponses["201"]);
    assert.equal(assetResponses["200"], undefined);

    const exportResponses = responses(operation(document, "post", "/exports"));
    assert.ok(exportResponses["202"]);
    assert.equal(exportResponses["200"], undefined);

    const deleteResponses = responses(operation(document, "delete", "/projects/{projectId}"));
    assert.ok(deleteResponses["204"]);
    assert.equal(deleteResponses["200"], undefined);

    const inventoryResponses = responses(operation(document, "put", "/inventory/{paletteId}/{colorCode}"));
    assert.ok(inventoryResponses["200"]);
    assert.ok(inventoryResponses["201"]);

    const purgeResponses = responses(operation(document, "post", "/internal/export-artifacts/purge-expired"));
    assert.ok(purgeResponses["200"]);
    assert.ok(purgeResponses["207"]);

    const generationResponses = responses(operation(document, "post", "/generation-jobs"));
    assert.deepEqual(generationResponses["402"], { $ref: "#/components/responses/PaymentRequired" });
    assert.deepEqual(generationResponses["503"], { $ref: "#/components/responses/ServiceUnavailable" });

    const wechatLoginResponses = responses(operation(document, "post", "/auth/wechat-session"));
    assert.deepEqual(wechatLoginResponses["502"], { $ref: "#/components/responses/BadGateway" });
    assert.deepEqual(wechatLoginResponses["503"], { $ref: "#/components/responses/ServiceUnavailable" });
  });

  it("publishes a JSON schema for every non-empty, non-binary success response", () => {
    const paths = object(document.paths, "paths");
    let checked = 0;
    for (const [path, rawPathItem] of Object.entries(paths)) {
      const pathItem = object(rawPathItem, `path ${path}`);
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        if (pathItem[method] === undefined) continue;
        const current = object(pathItem[method], `${method} ${path}`);
        for (const [status, rawResponse] of Object.entries(responses(current))) {
          if (!status.startsWith("2") || status === "204") continue;
          const response = object(rawResponse, `${method} ${path} ${status}`);
          const content = object(response.content, `${method} ${path} ${status} content`);
          const mediaTypes = Object.keys(content);
          if (mediaTypes.some((mediaType) => mediaType !== "application/json")) {
            assert.ok(
              mediaTypes.every((mediaType) => [
                "image/jpeg",
                "image/png",
                "image/webp",
                "application/pdf",
              ].includes(mediaType)),
              `${method.toUpperCase()} ${path} ${status} has an unexpected non-JSON media type`,
            );
            continue;
          }
          assert.ok(content["application/json"], `${method.toUpperCase()} ${path} ${status}`);
          assert.ok(
            object(content["application/json"], `${method} ${path} ${status} JSON`).schema,
            `${method.toUpperCase()} ${path} ${status} must define its JSON body`,
          );
          checked += 1;
        }
      }
    }
    assert.ok(checked >= 60, `expected the full JSON API surface, got ${checked}`);

    const components = object(object(document.components, "components").schemas, "component schemas");
    assert.deepEqual(object(components.SessionCreated, "SessionCreated").required, [
      "token",
      "tokenType",
      "user",
      "expiresAt",
      "credits",
    ]);
    assert.ok((object(components.Project, "Project").required as unknown[]).includes("grid"));
    assert.ok((object(components.PaymentOrder, "PaymentOrder").required as unknown[]).includes("status"));
    assert.ok((object(components.GenerationJob, "GenerationJob").required as unknown[]).includes("candidates"));
  });
});
