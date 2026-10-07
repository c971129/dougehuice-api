import { MAX_GRID_SIDE } from "./domain/grid.js";
import {
  MAX_GENERATION_CANDIDATE_ID_LENGTH,
  MIN_GENERATION_CANDIDATE_ID_LENGTH,
} from "./domain/resource-limits.js";

type JsonObject = Record<string, unknown>;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

const PUBLIC_OPERATIONS = new Set([
  "GET /health",
  "GET /ready",
  "POST /auth/wechat-session",
  "POST /auth/dev-session",
  "POST /auth/web-login-challenges",
  "GET /privacy/ai-processing-consent",
  "POST /wechat-pay/notifications",
]);

const WEB_LOGIN_TOKEN_OPERATIONS = new Set([
  "GET /auth/web-login-challenges/current",
]);

const OPTIONAL_AUTH_OPERATIONS = new Set([
  "GET /palettes",
]);

const INTERNAL_OPERATIONS = new Set([
  "POST /privacy/delete-expired",
  "POST /internal/fake-payments/{paymentOrderId}/succeed",
  "POST /internal/export-jobs/process-next",
  "POST /internal/export-artifacts/purge-expired",
  "POST /internal/generation-jobs/process-next",
]);

const IDEMPOTENT_OPERATIONS = new Set([
  "POST /assets",
  "POST /palettes",
  "POST /projects/{projectId}/completion-photos",
  "DELETE /projects/{projectId}/completion-photos/{photoId}",
  "POST /creation-draft/commit",
  "DELETE /creation-draft",
  "POST /projects",
  "PUT /projects/{projectId}/grid",
  "POST /projects/{projectId}/remap-palette",
  "PATCH /projects/{projectId}",
  "PATCH /projects/{projectId}/metadata",
  "POST /projects/{projectId}/copy",
  "POST /projects/{projectId}/revisions/{revision}/restore",
  "DELETE /projects/{projectId}",
  "POST /projects/{projectId}/draft/commit",
  "DELETE /projects/{projectId}/draft",
  "PUT /projects/{projectId}/build-progress",
  "POST /inventory/batch",
  "PUT /inventory/{paletteId}/{colorCode}",
  "POST /projects/{projectId}/inventory-consumption",
  "POST /payment-orders",
  "POST /payment-orders/{paymentOrderId}/refresh",
  "POST /exports",
  "POST /exports/{exportId}/cancel",
  "POST /generation-jobs",
  "POST /generation-jobs/{jobId}/cancel",
  "POST /generation-jobs/{jobId}/redraw",
  "POST /generation-jobs/{jobId}/accept",
  "POST /generation-jobs/{jobId}/variants/{variantOrdinal}/accept",
  "POST /invites/me/code",
  "POST /invites/accept",
]);

const RATE_LIMITED_OPERATIONS = new Set([
  "POST /auth/wechat-session",
  "POST /auth/web-login-challenges",
  "POST /auth/web-login-challenges/confirm",
  "POST /assets",
  "DELETE /assets/{assetId}",
  "POST /palettes",
  "POST /projects/{projectId}/completion-photos",
  "DELETE /projects/{projectId}/completion-photos/{photoId}",
  "PUT /creation-draft",
  "POST /creation-draft/commit",
  "DELETE /creation-draft",
  "POST /projects",
  "PUT /projects/{projectId}/grid",
  "POST /projects/{projectId}/remap-palette",
  "PATCH /projects/{projectId}",
  "PATCH /projects/{projectId}/metadata",
  "POST /projects/{projectId}/copy",
  "POST /projects/{projectId}/revisions/{revision}/restore",
  "DELETE /projects/{projectId}",
  "PUT /projects/{projectId}/draft",
  "POST /projects/{projectId}/draft/commit",
  "DELETE /projects/{projectId}/draft",
  "PUT /projects/{projectId}/build-progress",
  "POST /inventory/batch",
  "PUT /inventory/{paletteId}/{colorCode}",
  "POST /projects/{projectId}/inventory-consumption",
  "POST /payment-orders",
  "POST /payment-orders/{paymentOrderId}/refresh",
  "POST /exports",
  "GET /exports/{exportId}/content",
  "POST /generation-jobs",
  "POST /generation-jobs/{jobId}/redraw",
]);

const EXTRA_NOT_FOUND_OPERATIONS = new Set([
  "POST /auth/wechat-session",
  "POST /auth/dev-session",
  "GET /auth/web-login-challenges/current",
  "POST /auth/web-login-challenges/confirm",
  "PUT /creation-draft",
  "POST /creation-draft/commit",
  "POST /projects",
  "GET /inventory",
  "POST /inventory/batch",
  "POST /payment-orders",
  "POST /exports",
  "POST /generation-jobs",
  "POST /invites/accept",
]);

const CONFLICT_OPERATIONS = new Set([
  ...IDEMPOTENT_OPERATIONS,
  "POST /auth/web-login-challenges",
  "PUT /creation-draft",
  "PUT /projects/{projectId}/draft",
  "GET /exports/{exportId}/content",
  "POST /wechat-pay/notifications",
]);

const GONE_OPERATIONS = new Set([
  "POST /assets",
  "GET /assets/{assetId}",
  "GET /assets/{assetId}/content",
  "PUT /creation-draft",
  "POST /projects/{projectId}/completion-photos",
  "GET /projects/{projectId}/completion-photos/{photoId}/content",
  "GET /exports/{exportId}/content",
  "POST /generation-jobs",
  "POST /generation-jobs/{jobId}/redraw",
]);

const SERVICE_UNAVAILABLE_OPERATIONS = new Set([
  "GET /ready",
  "POST /auth/wechat-session",
  "POST /assets",
  "GET /assets/{assetId}/content",
  "POST /projects/{projectId}/completion-photos",
  "GET /projects/{projectId}/completion-photos/{photoId}/content",
  "POST /payment-orders",
  "POST /payment-orders/{paymentOrderId}/refresh",
  "POST /internal/generation-jobs/process-next",
  ...RATE_LIMITED_OPERATIONS,
]);

const BAD_GATEWAY_OPERATIONS = new Set([
  "POST /auth/wechat-session",
  "POST /payment-orders",
  "POST /payment-orders/{paymentOrderId}/refresh",
]);

const PAYMENT_REQUIRED_OPERATIONS = new Set([
  "POST /generation-jobs",
  "POST /generation-jobs/{jobId}/redraw",
]);

const SUCCESS_STATUSES: Readonly<Record<string, readonly string[]>> = {
  "POST /auth/wechat-session": ["201"],
  "POST /auth/dev-session": ["201"],
  "POST /auth/web-login-challenges": ["201"],
  "POST /palettes": ["201"],
  "POST /wechat-pay/notifications": ["204"],
  "POST /assets": ["201"],
  "DELETE /assets/{assetId}": ["204"],
  "DELETE /auth/session": ["204"],
  "POST /projects/{projectId}/completion-photos": ["201"],
  "DELETE /projects/{projectId}/completion-photos/{photoId}": ["204"],
  "POST /privacy/delete-expired": ["200", "207"],
  "POST /creation-draft/commit": ["201"],
  "DELETE /creation-draft": ["204"],
  "POST /projects": ["201"],
  "POST /projects/{projectId}/copy": ["201"],
  "DELETE /projects/{projectId}": ["204"],
  "DELETE /projects/{projectId}/draft": ["204"],
  "PUT /inventory/{paletteId}/{colorCode}": ["200", "201"],
  "POST /payment-orders": ["201"],
  "POST /internal/fake-payments/{paymentOrderId}/succeed": ["202"],
  "POST /exports": ["202"],
  "POST /internal/export-jobs/process-next": ["200", "204"],
  "POST /internal/export-artifacts/purge-expired": ["200", "207"],
  "POST /generation-jobs": ["202"],
  "POST /generation-jobs/{jobId}/redraw": ["202"],
  "POST /generation-jobs/{jobId}/accept": ["201"],
  "POST /generation-jobs/{jobId}/variants/{variantOrdinal}/accept": ["201"],
  "POST /internal/generation-jobs/process-next": ["200", "204"],
};

const BINARY_RESPONSES: Readonly<Record<string, readonly string[]>> = {
  "GET /assets/{assetId}/content": ["image/jpeg", "image/png", "image/webp"],
  "GET /projects/{projectId}/completion-photos/{photoId}/content": ["image/jpeg", "image/png", "image/webp"],
  "GET /exports/{exportId}/content": ["image/png", "application/pdf"],
};

const SUCCESS_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "200": "请求成功",
  "201": "资源已创建",
  "202": "请求已接受并等待异步处理",
  "204": "请求成功，无响应正文",
  "207": "批处理完成，部分项目处理失败",
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(parent: JsonObject, key: string): JsonObject {
  const existing = parent[key];
  if (isObject(existing)) return existing;
  const created: JsonObject = {};
  parent[key] = created;
  return created;
}

function hasRequestInputs(operation: JsonObject): boolean {
  const parameters = operation.parameters;
  return operation.requestBody !== undefined || (Array.isArray(parameters) && parameters.length > 0);
}

function appendParameter(operation: JsonObject, reference: string, name: string): void {
  const parameters = Array.isArray(operation.parameters) ? [...operation.parameters] : [];
  const alreadyPresent = parameters.some((parameter) => {
    if (!isObject(parameter)) return false;
    if (parameter.$ref === reference) return true;
    return typeof parameter.name === "string"
      && parameter.name.toLowerCase() === name.toLowerCase()
      && parameter.in === "header";
  });
  if (!alreadyPresent) parameters.push({ $ref: reference });
  operation.parameters = parameters;
}

function jsonErrorResponse(componentName: string): JsonObject {
  return { $ref: `#/components/responses/${componentName}` };
}

function schemaRef(componentName: string): JsonObject {
  return { $ref: `#/components/schemas/${componentName}` };
}

function objectSchema(
  properties: Record<string, JsonObject>,
  required: readonly string[] = Object.keys(properties),
): JsonObject {
  return {
    type: "object",
    required: [...required],
    additionalProperties: false,
    properties,
  };
}

function arrayOf(items: JsonObject): JsonObject {
  return { type: "array", items };
}

function nullable(schema: JsonObject): JsonObject {
  if (typeof schema.$ref === "string") {
    return {
      anyOf: [
        schema,
        { type: "object", nullable: true, enum: [null] },
      ],
    };
  }
  return { ...schema, nullable: true };
}

/**
 * Fastify validators use JSON Schema's numeric exclusive bounds, while an
 * OpenAPI 3.0 Schema Object requires a boolean flag paired with minimum or
 * maximum. Convert only the published clone so runtime validation is unchanged.
 */
function normalizeOpenApi30SchemaKeywords(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) normalizeOpenApi30SchemaKeywords(item);
    return;
  }
  if (!isObject(value)) return;

  if (typeof value.exclusiveMinimum === "number") {
    const exclusiveMinimum = value.exclusiveMinimum;
    if (typeof value.minimum !== "number" || exclusiveMinimum >= value.minimum) {
      value.minimum = exclusiveMinimum;
      value.exclusiveMinimum = true;
    } else {
      delete value.exclusiveMinimum;
    }
  }
  if (typeof value.exclusiveMaximum === "number") {
    const exclusiveMaximum = value.exclusiveMaximum;
    if (typeof value.maximum !== "number" || exclusiveMaximum <= value.maximum) {
      value.maximum = exclusiveMaximum;
      value.exclusiveMaximum = true;
    } else {
      delete value.exclusiveMaximum;
    }
  }

  for (const nested of Object.values(value)) normalizeOpenApi30SchemaKeywords(nested);
}

function paged(property: string, componentName: string): JsonObject {
  return objectSchema({
    [property]: arrayOf(schemaRef(componentName)),
    pagination: schemaRef("OffsetPagination"),
  });
}

/**
 * Swagger cannot infer response bodies from Fastify handlers. Keep this map at
 * the public-operation boundary so every generated client sees at least the
 * actual envelope and model type instead of an untyped `unknown` response.
 */
function successBodySchema(operationKey: string): JsonObject {
  const envelope = (property: string, componentName: string, optional = false) => objectSchema(
    { [property]: optional ? nullable(schemaRef(componentName)) : schemaRef(componentName) },
  );
  const projectEnvelope = envelope("project", "Project");
  const jobEnvelope = envelope("job", "GenerationJob");
  const exportEnvelope = envelope("export", "ExportJob");

  const schemas: Readonly<Record<string, JsonObject>> = {
    "GET /health": objectSchema({
      status: { type: "string", enum: ["ok"] },
      service: { type: "string", enum: ["pindou-backend"] },
    }),
    "GET /ready": objectSchema({ status: { type: "string", enum: ["ready"] } }),
    "POST /auth/web-login-challenges": objectSchema({
      token: { type: "string" },
      sessionToken: { type: "string" },
      code: { type: "string", pattern: "^[0-9]{6}$" },
      expiresAt: { type: "string", format: "date-time" },
    }),
    "GET /auth/web-login-challenges/current": objectSchema({
      status: { type: "string", enum: ["pending", "approved", "expired"] },
      expiresAt: { type: "string", format: "date-time" },
    }),
    "POST /auth/web-login-challenges/confirm": objectSchema({ confirmed: { type: "boolean", enum: [true] } }),
    "POST /auth/wechat-session": schemaRef("SessionCreated"),
    "POST /auth/dev-session": schemaRef("SessionCreated"),
    "GET /me": objectSchema({
      user: schemaRef("User"),
      account: schemaRef("CreditAccount"),
      stats: { type: "object", additionalProperties: true },
    }),
    "GET /creation-draft": envelope("draft", "CreationDraft", true),
    "PUT /creation-draft": envelope("draft", "CreationDraft"),
    "POST /creation-draft/commit": projectEnvelope,
    "POST /projects/{projectId}/completion-photos": envelope("photo", "CompletionPhoto"),
    "GET /projects/{projectId}/completion-photos": objectSchema({
      photos: arrayOf(schemaRef("CompletionPhoto")),
      revision: { type: "integer", minimum: 1 },
      pagination: schemaRef("OffsetPagination"),
    }),
    "GET /privacy/ai-processing-consent": schemaRef("AiProcessingConsent"),
    "GET /privacy/ai-processing-consent/events": paged("events", "AssetConsentEvent"),
    "POST /assets": envelope("asset", "Asset"),
    "GET /assets": paged("assets", "Asset"),
    "GET /assets/{assetId}": envelope("asset", "Asset"),
    "POST /privacy/delete-expired": schemaRef("PurgeResult"),
    "GET /palettes": objectSchema({ palettes: arrayOf(schemaRef("Palette")) }),
    "POST /palettes": envelope("palette", "Palette"),
    "GET /credit-products": objectSchema({ products: arrayOf(schemaRef("CreditProduct")) }),
    "POST /payment-orders": objectSchema({
      order: schemaRef("PaymentOrder"),
      paymentParams: nullable(schemaRef("MiniProgramPaymentParams")),
      paymentSessionStatus: { type: "string", enum: ["ready", "not-required", "unavailable"] },
    }),
    "GET /payment-orders/{paymentOrderId}": envelope("order", "PaymentOrder"),
    "POST /payment-orders/{paymentOrderId}/refresh": objectSchema({
      order: schemaRef("PaymentOrder"),
      credited: { type: "boolean" },
    }),
    "POST /internal/fake-payments/{paymentOrderId}/succeed": objectSchema({ accepted: { type: "boolean", enum: [true] } }),
    "POST /projects": projectEnvelope,
    "GET /projects": paged("projects", "ProjectListItem"),
    "GET /projects/{projectId}": projectEnvelope,
    "PATCH /projects/{projectId}": projectEnvelope,
    "PUT /projects/{projectId}/grid": projectEnvelope,
    "PATCH /projects/{projectId}/metadata": projectEnvelope,
    "POST /projects/{projectId}/copy": projectEnvelope,
    "GET /projects/{projectId}/revisions": paged("revisions", "ProjectRevisionMetadata"),
    "POST /projects/{projectId}/revisions/{revision}/restore": projectEnvelope,
    "POST /projects/{projectId}/remap-palette": objectSchema({
      project: schemaRef("Project"),
      materials: schemaRef("MaterialSummary"),
    }),
    "GET /projects/{projectId}/draft": objectSchema({
      draft: nullable(schemaRef("ProjectDraft")),
      baseProjectRevision: { type: "integer", minimum: 1 },
    }),
    "PUT /projects/{projectId}/draft": envelope("draft", "ProjectDraft"),
    "POST /projects/{projectId}/draft/commit": projectEnvelope,
    "GET /projects/{projectId}/materials": envelope("materials", "MaterialSummary"),
    "GET /projects/{projectId}/build-progress": envelope("progress", "BuildProgress"),
    "PUT /projects/{projectId}/build-progress": envelope("progress", "BuildProgress"),
    "GET /inventory": objectSchema({ items: arrayOf(schemaRef("InventoryItem")) }),
    "GET /inventory/operations": paged("operations", "InventoryOperation"),
    "GET /inventory/transactions": paged("transactions", "InventoryTransaction"),
    "POST /inventory/batch": schemaRef("InventoryMutationResult"),
    "PUT /inventory/{paletteId}/{colorCode}": envelope("item", "InventoryItem"),
    "POST /projects/{projectId}/inventory-consumption": envelope("consumption", "InventoryConsumption"),
    "GET /projects/{projectId}/shortages": objectSchema({ shortages: { type: "object", additionalProperties: true } }),
    "GET /credits": envelope("account", "CreditAccount"),
    "GET /credits/ledger": paged("entries", "CreditLedgerEntry"),
    "POST /exports": exportEnvelope,
    "GET /exports": paged("exports", "ExportJob"),
    "GET /exports/{exportId}": exportEnvelope,
    "POST /exports/{exportId}/cancel": exportEnvelope,
    "POST /internal/export-jobs/process-next": exportEnvelope,
    "POST /internal/export-artifacts/purge-expired": schemaRef("PurgeResult"),
    "POST /generation-jobs": jobEnvelope,
    "GET /generation-jobs": paged("jobs", "GenerationJob"),
    "GET /generation-jobs/{jobId}": jobEnvelope,
    "POST /generation-jobs/{jobId}/cancel": jobEnvelope,
    "POST /generation-jobs/{jobId}/redraw": jobEnvelope,
    "POST /generation-jobs/{jobId}/accept": objectSchema({
      job: schemaRef("GenerationJob"),
      project: schemaRef("Project"),
    }),
    "POST /generation-jobs/{jobId}/variants/{variantOrdinal}/accept": objectSchema({
      job: schemaRef("GenerationJob"),
      variant: { type: "object", additionalProperties: true },
      totalMaterials: { type: "object", additionalProperties: true },
    }),
    "POST /internal/generation-jobs/process-next": jobEnvelope,
  };
  return schemas[operationKey] ?? { type: "object", additionalProperties: true };
}

function successResponse(status: string, idempotent: boolean, operationKey: string): JsonObject {
  const response: JsonObject = { description: SUCCESS_DESCRIPTIONS[status] ?? "请求成功" };
  if (status !== "204") {
    response.content = {
      "application/json": { schema: successBodySchema(operationKey) },
    };
  }
  if (idempotent) {
    response.headers = {
      "Idempotency-Replayed": { $ref: "#/components/headers/IdempotencyReplayed" },
    };
  }
  return response;
}

function binaryResponse(mediaTypes: readonly string[], includeDisposition: boolean): JsonObject {
  const content: JsonObject = {};
  for (const mediaType of mediaTypes) {
    content[mediaType] = { schema: { type: "string", format: "binary" } };
  }
  const headers: JsonObject = {
    "Cache-Control": { schema: { type: "string" }, description: "私有内容禁止共享缓存" },
    "Content-Length": { schema: { type: "integer", minimum: 0 } },
    "X-Content-Type-Options": { schema: { type: "string", enum: ["nosniff"] } },
  };
  if (includeDisposition) {
    headers["Content-Disposition"] = { schema: { type: "string" }, description: "下载文件名" };
  }
  return {
    description: "私有二进制文件内容",
    headers,
    content,
  };
}

function errorStatuses(operationKey: string, operation: JsonObject): Set<string> {
  const statuses = new Set<string>(["500"]);
  const isInternal = INTERNAL_OPERATIONS.has(operationKey);
  const isOptionalAuth = OPTIONAL_AUTH_OPERATIONS.has(operationKey);
  const usesWebLoginToken = WEB_LOGIN_TOKEN_OPERATIONS.has(operationKey);
  const isProtected = !PUBLIC_OPERATIONS.has(operationKey) && !isOptionalAuth && !isInternal && !usesWebLoginToken;
  if (isProtected || isInternal) statuses.add("401");
  if (isOptionalAuth) statuses.add("401");
  if (operationKey === "POST /auth/wechat-session" || usesWebLoginToken) statuses.add("401");
  if (hasRequestInputs(operation) || IDEMPOTENT_OPERATIONS.has(operationKey)) statuses.add("400");
  if (operationKey.includes("{" ) || EXTRA_NOT_FOUND_OPERATIONS.has(operationKey)) statuses.add("404");
  if (CONFLICT_OPERATIONS.has(operationKey)) statuses.add("409");
  if (RATE_LIMITED_OPERATIONS.has(operationKey) || IDEMPOTENT_OPERATIONS.has(operationKey)) statuses.add("429");
  if (GONE_OPERATIONS.has(operationKey)) statuses.add("410");
  if (SERVICE_UNAVAILABLE_OPERATIONS.has(operationKey)) statuses.add("503");
  if (BAD_GATEWAY_OPERATIONS.has(operationKey)) statuses.add("502");
  if (PAYMENT_REQUIRED_OPERATIONS.has(operationKey)) statuses.add("402");
  if (operationKey === "POST /assets" || operationKey === "POST /projects/{projectId}/completion-photos") {
    statuses.add("413");
    statuses.add("415");
  }
  if (operationKey === "POST /wechat-pay/notifications") {
    statuses.add("400");
    statuses.add("401");
    statuses.add("404");
    statuses.add("409");
    statuses.add("413");
    statuses.add("503");
  }
  return statuses;
}

function hardenOperation(path: string, method: string, operation: JsonObject): void {
  const operationKey = `${method.toUpperCase()} ${path}`;
  const isInternal = INTERNAL_OPERATIONS.has(operationKey);
  const isOptionalAuth = OPTIONAL_AUTH_OPERATIONS.has(operationKey);
  const usesWebLoginToken = WEB_LOGIN_TOKEN_OPERATIONS.has(operationKey);
  const isProtected = !PUBLIC_OPERATIONS.has(operationKey) && !isOptionalAuth && !isInternal && !usesWebLoginToken;
  operation.security = isInternal
    ? [{ internalWorkerKey: [] }]
    : usesWebLoginToken ? [{ webLoginToken: [] }]
      : isOptionalAuth ? [{}, { bearerAuth: [] }]
        : isProtected ? [{ bearerAuth: [] }] : [];

  const isIdempotent = IDEMPOTENT_OPERATIONS.has(operationKey);
  if (isIdempotent) {
    appendParameter(operation, "#/components/parameters/IdempotencyKey", "Idempotency-Key");
  }

  if (operationKey === "POST /assets") {
    operation.requestBody = {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            required: ["file"],
            properties: {
              file: { type: "string", format: "binary", description: "JPG、PNG 或 WebP 图片" },
              purpose: { type: "string", enum: ["ai-source", "ai-intermediate"], default: "ai-source" },
              consentVersion: {
                type: "string",
                minLength: 1,
                maxLength: 64,
                description: "也可通过 X-Consent-Version 请求头传递",
              },
            },
          },
        },
      },
    };
    appendParameter(operation, "#/components/parameters/AssetPurpose", "X-Asset-Purpose");
    appendParameter(operation, "#/components/parameters/ConsentVersion", "X-Consent-Version");
  }

  if (operationKey === "POST /projects/{projectId}/completion-photos") {
    operation.requestBody = {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            required: ["file"],
            properties: {
              file: { type: "string", format: "binary", description: "JPG、PNG 或 WebP 完工照片" },
            },
          },
        },
      },
    };
  }

  if (operationKey === "POST /wechat-pay/notifications") {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: { type: "object", additionalProperties: true, description: "微信支付 v3 通知原文" },
        },
      },
    };
    for (const [reference, name] of [
      ["#/components/parameters/WechatpaySerial", "Wechatpay-Serial"],
      ["#/components/parameters/WechatpaySignature", "Wechatpay-Signature"],
      ["#/components/parameters/WechatpayTimestamp", "Wechatpay-Timestamp"],
      ["#/components/parameters/WechatpayNonce", "Wechatpay-Nonce"],
    ] as const) appendParameter(operation, reference, name);
  }

  const existingResponses = isObject(operation.responses) ? operation.responses : {};
  const responses: JsonObject = {};
  const statuses = SUCCESS_STATUSES[operationKey] ?? ["200"];
  const binaryMediaTypes = BINARY_RESPONSES[operationKey];
  for (const status of statuses) {
    if (binaryMediaTypes && status === "200") {
      responses[status] = binaryResponse(binaryMediaTypes, operationKey === "GET /exports/{exportId}/content");
      continue;
    }
    const existing = existingResponses[status];
    responses[status] = isObject(existing) ? { ...existing } : successResponse(status, isIdempotent, operationKey);
    const success = responses[status];
    if (status !== "204" && isObject(success) && !isObject(success.content)) {
      success.content = {
        "application/json": { schema: successBodySchema(operationKey) },
      };
    }
    if (isIdempotent) {
      const response = responses[status];
      if (isObject(response)) {
        response.headers = {
          ...(isObject(response.headers) ? response.headers : {}),
          "Idempotency-Replayed": { $ref: "#/components/headers/IdempotencyReplayed" },
        };
      }
    }
  }

  const componentForStatus: Readonly<Record<string, string>> = {
    "400": "BadRequest",
    "401": "Unauthorized",
    "402": "PaymentRequired",
    "403": "Forbidden",
    "404": "NotFound",
    "409": "Conflict",
    "410": "Gone",
    "413": "PayloadTooLarge",
    "415": "UnsupportedMediaType",
    "429": "RateLimited",
    "500": "InternalError",
    "502": "BadGateway",
    "503": "ServiceUnavailable",
  };
  for (const status of errorStatuses(operationKey, operation)) {
    const component = componentForStatus[status];
    if (component) responses[status] = jsonErrorResponse(component);
  }
  if (operationKey === "POST /wechat-pay/notifications") {
    for (const status of ["400", "401", "404", "409", "500", "503"]) {
      responses[status] = { $ref: "#/components/responses/WechatPayNotificationFailure" };
    }
  }
  operation.responses = responses;
}

function installComponents(document: JsonObject): void {
  const components = objectAt(document, "components");
  const securitySchemes = objectAt(components, "securitySchemes");
  securitySchemes.bearerAuth = {
    type: "http",
    scheme: "bearer",
    bearerFormat: "opaque session token",
    description: "由微信登录或本地开发登录接口签发的会话令牌",
  };
  securitySchemes.internalWorkerKey = {
    type: "apiKey",
    in: "header",
    name: "X-Internal-Worker-Key",
    description: "仅供可信内部 Worker 与清理任务使用",
  };
  securitySchemes.webLoginToken = {
    type: "apiKey",
    in: "header",
    name: "X-Web-Login-Token",
    description: "创建 Web 登录挑战时签发、仅用于轮询该挑战状态的一次性随机令牌",
  };

  const schemas = objectAt(components, "schemas");
  schemas.ErrorEnvelope = {
    type: "object",
    required: ["error", "requestId"],
    additionalProperties: false,
    properties: {
      error: {
        type: "object",
        required: ["code", "message", "retryable", "details"],
        additionalProperties: false,
        properties: {
          code: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" },
          message: { type: "string" },
          retryable: { type: "boolean" },
          details: { nullable: true },
        },
      },
      requestId: { type: "string" },
    },
  };
  schemas.WechatPayNotificationFailure = {
    type: "object",
    required: ["code", "message"],
    additionalProperties: false,
    properties: {
      code: { type: "string", enum: ["FAIL"] },
      message: { type: "string" },
    },
  };
  const dateTime = { type: "string", format: "date-time" };
  const uuid = { type: "string", format: "uuid" };
  const integer = { type: "integer" };
  const nonNegativeInteger = { type: "integer", minimum: 0 };
  const string = { type: "string" };
  const boolean = { type: "boolean" };
  const paletteColorFinish = {
    type: "string",
    enum: [
      "solid", "pearlescent", "thermochromic", "translucent", "transparent",
      "glow-in-the-dark", "photochromic", "special",
    ],
  };
  const model = (
    properties: Record<string, JsonObject>,
    required: readonly string[] = Object.keys(properties),
  ): JsonObject => ({ ...objectSchema(properties, required), additionalProperties: true });

  schemas.OffsetPagination = objectSchema({
    limit: { type: "integer", minimum: 1 },
    offset: nonNegativeInteger,
    hasMore: boolean,
    nextOffset: nullable(nonNegativeInteger),
  });
  schemas.CursorPagination = objectSchema({
    limit: { type: "integer", minimum: 1, maximum: 50 },
    hasMore: boolean,
    nextCursor: nullable(string),
  });
  schemas.User = objectSchema({ id: uuid, displayName: string, createdAt: dateTime });
  schemas.CreditAccount = objectSchema({ userId: uuid, balance: integer, updatedAt: dateTime });
  schemas.CreditLedgerEntry = model({
    id: uuid,
    userId: uuid,
    delta: integer,
    balanceAfter: integer,
    reason: string,
    referenceId: nullable(string),
    createdAt: dateTime,
  });
  schemas.SessionCreated = objectSchema({
    token: string,
    tokenType: { type: "string", enum: ["Bearer"] },
    user: schemaRef("User"),
    expiresAt: dateTime,
    credits: schemaRef("CreditAccount"),
  });
  schemas.PatternGrid = objectSchema({
    encoding: { type: "string", enum: ["palette-code-v1"] },
    width: { type: "integer", minimum: 1, maximum: MAX_GRID_SIDE },
    height: { type: "integer", minimum: 1, maximum: MAX_GRID_SIDE },
    cells: arrayOf(nullable(string)),
  });
  schemas.Project = model({
    id: uuid,
    userId: uuid,
    name: string,
    mode: { type: "string", enum: ["normal", "pixel", "portrait", "couple"] },
    lifecycleStatus: { type: "string", enum: ["draft", "generating", "editable", "exported"] },
    metadataRevision: { type: "integer", minimum: 1 },
    tags: arrayOf(string),
    deviceSource: { type: "string", enum: ["mini-program", "web", "api", "unknown"] },
    sourceAssetId: nullable(uuid),
    previewAssetId: nullable(uuid),
    paletteId: string,
    backgroundMode: { type: "string", enum: ["white", "transparent", "solid"] },
    backgroundColor: nullable(string),
    currentRevision: { type: "integer", minimum: 1 },
    createdAt: dateTime,
    updatedAt: dateTime,
    grid: schemaRef("PatternGrid"),
    revisionDeviceSource: { type: "string", enum: ["mini-program", "web", "api", "unknown"] },
    revisionUpdatedAt: dateTime,
  });
  schemas.ProjectListItem = model({
    id: uuid,
    userId: uuid,
    name: string,
    mode: string,
    lifecycleStatus: string,
    metadataRevision: { type: "integer", minimum: 1 },
    tags: arrayOf(string),
    deviceSource: { type: "string", enum: ["mini-program", "web", "api", "unknown"] },
    sourceAssetId: nullable(uuid),
    previewAssetId: nullable(uuid),
    paletteId: string,
    backgroundMode: string,
    backgroundColor: nullable(string),
    currentRevision: { type: "integer", minimum: 1 },
    createdAt: dateTime,
    updatedAt: dateTime,
    width: nonNegativeInteger,
    height: nonNegativeInteger,
    colorCount: nonNegativeInteger,
    beadCount: nonNegativeInteger,
    completedBeadCount: nonNegativeInteger,
    status: { type: "string", enum: ["draft", "in_progress", "completed"] },
    hasDraft: boolean,
  });
  schemas.ProjectRevisionMetadata = objectSchema({
    projectId: uuid,
    revision: { type: "integer", minimum: 1 },
    paletteId: string,
    width: { type: "integer", minimum: 1, maximum: MAX_GRID_SIDE },
    height: { type: "integer", minimum: 1, maximum: MAX_GRID_SIDE },
    deviceSource: { type: "string", enum: ["mini-program", "web", "api", "unknown"] },
    createdAt: dateTime,
    updatedAt: dateTime,
  });
  schemas.CreationDraft = model({
    id: uuid,
    draftRevision: { type: "integer", minimum: 1 },
    name: string,
    kind: string,
    setupStep: { type: "integer", minimum: 1, maximum: 3 },
    paletteId: string,
    sourceAssetId: nullable(uuid),
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    options: { type: "object", additionalProperties: true },
    grid: nullable(schemaRef("PatternGrid")),
    updatedAt: dateTime,
  });
  schemas.ProjectDraft = model({
    projectId: uuid,
    baseProjectRevision: { type: "integer", minimum: 1 },
    draftRevision: { type: "integer", minimum: 1 },
    name: string,
    grid: schemaRef("PatternGrid"),
    updatedAt: dateTime,
  });
  schemas.Asset = model({
    id: uuid,
    purpose: { type: "string", enum: ["ai-source", "ai-intermediate"] },
    consentVersion: string,
    sha256: string,
    mimeType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp"] },
    sizeBytes: nonNegativeInteger,
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    expiresAt: dateTime,
    deletedAt: nullable(dateTime),
    createdAt: dateTime,
  });
  schemas.CompletionPhoto = model({
    id: uuid,
    projectId: uuid,
    projectRevision: { type: "integer", minimum: 1 },
    mimeType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp"] },
    sizeBytes: nonNegativeInteger,
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    createdAt: dateTime,
  });
  schemas.AiProcessingConsent = objectSchema({
    consentVersion: string,
    policySha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    processor: string,
    purpose: string,
    upload: objectSchema({
      maxBytes: { type: "integer", minimum: 1 },
      supportedMimeTypes: arrayOf(string),
      supportedPurposes: arrayOf(string),
    }),
    retention: objectSchema({
      defaultHours: { type: "integer", minimum: 1 },
      description: string,
    }),
  });
  schemas.AssetConsentEvent = objectSchema({
    id: uuid,
    assetId: uuid,
    consentVersion: { type: "string", minLength: 1, maxLength: 64 },
    assetPurpose: { type: "string", enum: ["ai-source", "ai-intermediate"] },
    policySha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    processor: { type: "string", minLength: 1, maxLength: 500 },
    purpose: { type: "string", minLength: 1, maxLength: 1_000 },
    retention: { type: "string", minLength: 1, maxLength: 1_000 },
    source: { type: "string", enum: ["asset-upload", "legacy-asset-backfill"] },
    occurredAt: dateTime,
    recordedAt: dateTime,
  });
  schemas.PurgeResult = model({
    scanned: nonNegativeInteger,
    deleted: nonNegativeInteger,
    failed: nonNegativeInteger,
  });
  schemas.Palette = model({
    id: string,
    name: string,
    brand: string,
    series: string,
    material: string,
    beadSizeMm: { type: "number", minimum: 0, exclusiveMinimum: true },
    verified: boolean,
    version: { type: "integer", minimum: 1 },
    retired: boolean,
    source: objectSchema({
      name: string,
      url: string,
      revision: string,
      license: string,
    }),
    colors: arrayOf(model({
      code: string,
      name: string,
      hex: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
      finish: paletteColorFinish,
      unitPriceCents: nonNegativeInteger,
      available: boolean,
    })),
  });
  schemas.CreditProduct = objectSchema({
    id: string,
    version: { type: "integer", minimum: 1 },
    name: string,
    description: string,
    creditAmount: { type: "integer", minimum: 1 },
    amountCents: { type: "integer", minimum: 1 },
    currency: { type: "string", enum: ["CNY"] },
    enabled: boolean,
  });
  schemas.PaymentOrder = model({
    id: uuid,
    userId: uuid,
    productId: string,
    productVersion: { type: "integer", minimum: 1 },
    productName: string,
    creditAmount: { type: "integer", minimum: 1 },
    amountCents: { type: "integer", minimum: 1 },
    currency: { type: "string", enum: ["CNY"] },
    status: { type: "string", enum: ["pending", "succeeded", "failed", "closed"] },
    providerTradeState: nullable(string),
    paymentExpiresAt: dateTime,
    paidAt: nullable(dateTime),
    createdAt: dateTime,
    updatedAt: dateTime,
  });
  schemas.MiniProgramPaymentParams = objectSchema({
    timeStamp: { type: "string", pattern: "^[0-9]+$" },
    nonceStr: { type: "string", minLength: 1, maxLength: 64 },
    package: { type: "string", pattern: "^prepay_id=" },
    signType: { type: "string", enum: ["RSA"] },
    paySign: { type: "string", minLength: 1 },
  });
  schemas.MaterialSummary = model({
    projectId: uuid,
    projectRevision: { type: "integer", minimum: 1 },
    width: nonNegativeInteger,
    height: nonNegativeInteger,
    colorCount: nonNegativeInteger,
    beadCount: nonNegativeInteger,
    estimatedTotalCents: nonNegativeInteger,
    lines: arrayOf({ type: "object", additionalProperties: true }),
  });
  schemas.BuildProgress = model({
    projectId: uuid,
    projectRevision: { type: "integer", minimum: 1 },
    progressRevision: nonNegativeInteger,
    mode: { type: "string", enum: ["color", "region", "row-column"] },
    navigationCursor: nullable({ type: "object", additionalProperties: true }),
    completedIndices: arrayOf(nonNegativeInteger),
    elapsedTime: nonNegativeInteger,
    startedAt: nullable(dateTime),
    completedAt: nullable(dateTime),
    updatedAt: dateTime,
  });
  schemas.InventoryItem = model({
    userId: uuid,
    paletteId: string,
    colorCode: string,
    quantity: nonNegativeInteger,
    location: nullable(string),
    revision: nonNegativeInteger,
    updatedAt: dateTime,
  });
  schemas.InventoryOperation = objectSchema({
    id: uuid,
    userId: uuid,
    type: { type: "string", enum: ["calibration", "manual_adjustment", "project_consumption"] },
    projectId: nullable(uuid),
    projectRevision: nullable(integer),
    idempotencyReference: string,
    consumedAt: nullable(dateTime),
    createdAt: dateTime,
  });
  schemas.InventoryTransaction = model({
    id: uuid,
    operationId: uuid,
    userId: uuid,
    type: { type: "string", enum: ["calibration", "manual_adjustment", "project_consumption"] },
    paletteId: string,
    colorCode: string,
    quantityBefore: nonNegativeInteger,
    delta: integer,
    quantityAfter: nonNegativeInteger,
    locationBefore: nullable(string),
    locationAfter: nullable(string),
    projectId: nullable(uuid),
    projectRevision: nullable(integer),
    idempotencyReference: string,
    createdAt: dateTime,
  });
  schemas.InventoryMutationResult = objectSchema({
    operationId: uuid,
    items: arrayOf(schemaRef("InventoryItem")),
    transactions: arrayOf(schemaRef("InventoryTransaction")),
  });
  schemas.InventoryConsumption = model({
    operationId: uuid,
    items: arrayOf(schemaRef("InventoryItem")),
    transactions: arrayOf(schemaRef("InventoryTransaction")),
    projectId: uuid,
    projectRevision: { type: "integer", minimum: 1 },
    consumedAt: dateTime,
  });
  schemas.ExportJob = model({
    id: uuid,
    projectId: uuid,
    projectRevision: { type: "integer", minimum: 1 },
    format: { type: "string", enum: ["png", "pdf"] },
    fileName: string,
    options: { type: "object", additionalProperties: true },
    status: { type: "string", enum: ["queued", "running", "retry_wait", "succeeded", "failed", "canceled"] },
    progress: nonNegativeInteger,
    attemptCount: nonNegativeInteger,
    maxAttempts: { type: "integer", minimum: 1 },
    availableAt: dateTime,
    errorCode: nullable(string),
    errorMessage: nullable(string),
    createdAt: dateTime,
    updatedAt: dateTime,
    finishedAt: nullable(dateTime),
    artifact: nullable({ type: "object", additionalProperties: true }),
  });
  schemas.GenerationJob = model({
    id: uuid,
    parentJobId: nullable(uuid),
    kind: { type: "string", enum: ["normal", "pixel", "portrait", "couple"] },
    status: string,
    paletteId: string,
    sourceAssetId: nullable(uuid),
    options: { type: "object", additionalProperties: true },
    cost: nonNegativeInteger,
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    progress: { type: "integer", minimum: 0, maximum: 100 },
    attemptCount: nonNegativeInteger,
    maxAttempts: { type: "integer", minimum: 1 },
    availableAt: dateTime,
    errorCode: nullable(string),
    errorMessage: nullable(string),
    createdAt: dateTime,
    updatedAt: dateTime,
    completedAt: nullable(dateTime),
    canceledAt: nullable(dateTime),
    acceptedCandidateId: nullable({
      type: "string",
      minLength: MIN_GENERATION_CANDIDATE_ID_LENGTH,
      maxLength: MAX_GENERATION_CANDIDATE_ID_LENGTH,
    }),
    candidates: arrayOf({ type: "object", additionalProperties: true }),
    variants: arrayOf({ type: "object", additionalProperties: true }),
  });

  const headers = objectAt(components, "headers");
  headers.IdempotencyReplayed = {
    description: "仅在返回先前已持久化的幂等结果时出现",
    schema: { type: "string", enum: ["true"] },
  };
  headers.RetryAfter = {
    description: "建议等待的秒数",
    schema: { type: "integer", minimum: 1 },
  };

  const parameters = objectAt(components, "parameters");
  parameters.IdempotencyKey = {
    name: "Idempotency-Key",
    in: "header",
    required: true,
    description: "同一用户与操作范围内唯一；长度为 8–128 个字符",
    schema: { type: "string", minLength: 8, maxLength: 128 },
  };
  parameters.AssetPurpose = {
    name: "X-Asset-Purpose",
    in: "header",
    required: false,
    description: "purpose 表单字段的可选替代项",
    schema: { type: "string", enum: ["ai-source", "ai-intermediate"] },
  };
  parameters.ConsentVersion = {
    name: "X-Consent-Version",
    in: "header",
    required: false,
    description: "consentVersion 表单字段的可选替代项",
    schema: { type: "string", minLength: 1, maxLength: 64 },
  };
  for (const [key, name] of [
    ["WechatpaySerial", "Wechatpay-Serial"],
    ["WechatpaySignature", "Wechatpay-Signature"],
    ["WechatpayTimestamp", "Wechatpay-Timestamp"],
    ["WechatpayNonce", "Wechatpay-Nonce"],
  ] as const) {
    parameters[key] = {
      name,
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1 },
    };
  }

  const responses = objectAt(components, "responses");
  const errorContent = { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } };
  responses.BadRequest = { description: "请求格式、参数或幂等键无效", content: errorContent };
  responses.Unauthorized = { description: "认证凭证缺失或无效", content: errorContent };
  responses.PaymentRequired = { description: "AI 次数余额不足", content: errorContent };
  responses.Forbidden = { description: "当前身份没有执行该操作的权限", content: errorContent };
  responses.NotFound = { description: "资源不存在或不属于当前用户", content: errorContent };
  responses.Conflict = {
    description: "幂等键冲突、乐观锁冲突或资源状态冲突",
    headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
    content: errorContent,
  };
  responses.Gone = { description: "资源内容已过期、删除或不可再下载", content: errorContent };
  responses.PayloadTooLarge = { description: "请求正文或上传文件超过限制", content: errorContent };
  responses.UnsupportedMediaType = { description: "Content-Type 或图片实际格式不受支持", content: errorContent };
  responses.RateLimited = {
    description: "当前用户操作过于频繁",
    headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
    content: errorContent,
  };
  responses.InternalError = { description: "服务内部错误，可按 retryable 决定是否重试", content: errorContent };
  responses.BadGateway = { description: "上游微信服务返回了无效响应", content: errorContent };
  responses.ServiceUnavailable = {
    description: "依赖、Provider 或私有存储暂不可用",
    headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
    content: errorContent,
  };
  responses.WechatPayNotificationFailure = {
    description: "微信支付要求的失败应答",
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/WechatPayNotificationFailure" } },
    },
  };
}

/**
 * Completes the generated document without attaching new Fastify validators.
 * This function is intentionally used only as Swagger's transformObject hook,
 * so documenting headers and multipart bodies cannot change runtime behavior.
 */
export function hardenOpenApiDocument<T>(input: T): T {
  if (!isObject(input)) return input;
  const document = structuredClone(input);
  if (!isObject(document)) return input;
  installComponents(document);
  const paths = objectAt(document, "paths");
  for (const [path, rawPathItem] of Object.entries(paths)) {
    if (!isObject(rawPathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = rawPathItem[method];
      if (isObject(operation)) hardenOperation(path, method, operation);
    }
  }
  normalizeOpenApi30SchemaKeywords(document);
  return document as T;
}
