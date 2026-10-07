import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { createConfiguredGenerationProvider } from "./generation/configured-provider.js";
import type { GenerationProvider } from "./generation/provider.js";
import { hardenOpenApiDocument } from "./openapi-contract.js";
import { FakePaymentProvider } from "./payments/fake-provider.js";
import type { PaymentProvider } from "./payments/provider.js";
import type { AppStore } from "./repositories/store.js";
import { registerAssetRoutes } from "./routes/asset-routes.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerCreditRoutes } from "./routes/credit-routes.js";
import { registerInviteRoutes } from "./routes/invite-routes.js";
import { registerCompletionPhotoRoutes } from "./routes/completion-photo-routes.js";
import { registerCreationDraftRoutes } from "./routes/creation-draft-routes.js";
import { registerExportRoutes } from "./routes/export-routes.js";
import { registerGenerationRoutes } from "./routes/generation-routes.js";
import { registerInventoryRoutes } from "./routes/inventory-routes.js";
import { registerPaletteRoutes } from "./routes/palette-routes.js";
import { registerPaymentRoutes } from "./routes/payment-routes.js";
import { registerProjectRoutes } from "./routes/project-routes.js";
import { createConfiguredStorageProvider } from "./storage/configured-storage.js";
import {
  closeStorageProvider,
  StorageDependencyUnavailableError,
  type StorageProvider,
} from "./storage/storage-provider.js";
import {
  isDevelopmentWechatAuthAllowed,
  type WechatMiniProgramAuthProvider,
} from "./wechat/mini-program-auth.js";

export interface BuildAppOptions {
  config: AppConfig;
  store: AppStore;
  storage?: StorageProvider;
  paymentProvider?: PaymentProvider;
  generationProvider?: GenerationProvider;
  wechatAuthProvider?: WechatMiniProgramAuthProvider;
  paymentEffectLeaseMilliseconds?: number;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? options.config.nodeEnv !== "test",
    // Ordinary JSON contracts stay below this limit. The four grid-bearing
    // routes have a measured, finite override and authenticate in `preParsing`
    // before Fastify buffers the larger body. Multipart routes use streaming
    // parser limits of their own.
    bodyLimit: 2 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
    trustProxy: options.config.trustedProxies?.length ? options.config.trustedProxies : false,
  });
  const storage = options.storage ?? createConfiguredStorageProvider(options.config);
  const paymentProvider = options.paymentProvider ?? (options.config.nodeEnv === "production" ? null : new FakePaymentProvider());
  if (!paymentProvider || (options.config.nodeEnv === "production" && paymentProvider.kind === "fake")) {
    throw new Error("生产环境必须配置非 Fake 的微信支付 Provider");
  }
  const generationProvider = options.generationProvider
    ?? (options.config.nodeEnv === "production" ? undefined : createConfiguredGenerationProvider(options.config));
  if (options.config.nodeEnv === "production"
    && (generationProvider?.kind === "deterministic" || generationProvider?.kind.includes("deterministic"))) {
    throw new Error("生产环境必须配置真实 AI Generation Provider");
  }
  if (options.config.nodeEnv === "production"
    && options.wechatAuthProvider?.kind !== "wechat-code2session") {
    throw new Error("生产环境必须配置真实微信小程序登录 Provider");
  }
  if (options.wechatAuthProvider?.kind === "development"
    && !isDevelopmentWechatAuthAllowed(options.config)) {
    throw new Error("开发微信登录 Provider 必须显式启用 DEV_AUTH_ENABLED 并绑定 loopback 地址");
  }

  await app.register(cors, {
    origin(origin, callback) {
      callback(null, !origin || options.config.corsOrigins.includes(origin));
    },
  });
  await app.register(swagger, {
    openapi: {
      info: { title: "拼豆小程序 API", version: "0.1.0" },
      servers: [{ url: "/api/v1" }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
    },
    transformObject: (documentObject) => "openapiObject" in documentObject
      ? hardenOpenApiDocument(documentObject.openapiObject)
      : documentObject.swaggerObject,
  });
  await app.register(multipart, {
    limits: {
      fileSize: options.config.assetMaxBytes,
      files: 1,
      fields: 10,
      parts: 11,
    },
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if ((error.statusCode === 409 || error.statusCode === 429 || error.statusCode === 503)
        && typeof error.details === "object" && error.details !== null
        && "retryAfterMilliseconds" in error.details
        && typeof error.details.retryAfterMilliseconds === "number"
        && Number.isFinite(error.details.retryAfterMilliseconds)
        && error.details.retryAfterMilliseconds > 0) {
        reply.header("Retry-After", String(Math.max(1, Math.ceil(error.details.retryAfterMilliseconds / 1000))));
      }
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable ?? error.statusCode >= 500,
          details: error.details ?? null,
        },
        requestId: request.id,
      });
    }
    if (error instanceof StorageDependencyUnavailableError) {
      request.log.warn({ storageError: error.name }, "private storage dependency unavailable");
      reply.header("Retry-After", "1");
      return reply.code(503).send({
        error: {
          code: "STORAGE_DEPENDENCY_UNAVAILABLE",
          message: "私有存储暂时不可用，请稍后重试",
          retryable: true,
          details: { retryAfterMilliseconds: 1_000 },
        },
        requestId: request.id,
      });
    }
    if (typeof error === "object" && error !== null && "validation" in error && error.validation) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "请求参数不符合接口约定",
          retryable: false,
          details: error.validation,
        },
        requestId: request.id,
      });
    }
    if (typeof error === "object" && error !== null && "statusCode" in error
      && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      const code = error.statusCode === 415
        ? "UNSUPPORTED_MEDIA_TYPE"
        : error.statusCode === 413
          ? "PAYLOAD_TOO_LARGE"
          : "BAD_REQUEST";
      const message = error.statusCode === 415
        ? "请求 Content-Type 不受支持"
        : error.statusCode === 413
          ? "请求正文超过大小限制"
          : "请求无法处理";
      return reply.code(error.statusCode).send({
        error: { code, message, retryable: false, details: null },
        requestId: request.id,
      });
    }
    request.log.error({ err: error }, "unhandled request error");
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "服务暂时不可用", retryable: true, details: null },
      requestId: request.id,
    });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({
    error: { code: "ROUTE_NOT_FOUND", message: "接口不存在", retryable: false, details: null },
    requestId: request.id,
  }));

  app.get("/api/v1/health", {
    schema: { tags: ["system"], summary: "进程存活检查" },
  }, async () => ({ status: "ok", service: "pindou-backend" }));

  app.get("/api/v1/ready", {
    schema: { tags: ["system"], summary: "依赖就绪检查" },
  }, async () => {
    try {
      await options.store.ready();
      await storage.ready();
      return { status: "ready" };
    } catch {
      throw new AppError(503, "DEPENDENCY_UNAVAILABLE", "数据库尚未就绪");
    }
  });

  await app.register(async (api) => {
    const dependencies = {
      config: options.config,
      store: options.store,
      storage,
      paymentProvider,
      ...(generationProvider ? { generationProvider } : {}),
      ...(options.wechatAuthProvider ? { wechatAuthProvider: options.wechatAuthProvider } : {}),
      paymentEffectLeaseMilliseconds: options.paymentEffectLeaseMilliseconds ?? 30_000,
    };
    await registerAuthRoutes(api, dependencies);
    await registerCreationDraftRoutes(api, dependencies);
    await registerCompletionPhotoRoutes(api, dependencies);
    await registerAssetRoutes(api, dependencies);
    await registerPaletteRoutes(api, dependencies);
    await registerPaymentRoutes(api, dependencies);
    await registerProjectRoutes(api, dependencies);
    await registerInventoryRoutes(api, dependencies);
    await registerCreditRoutes(api, dependencies);
    await registerInviteRoutes(api, dependencies);
    await registerExportRoutes(api, dependencies);
    await registerGenerationRoutes(api, dependencies);
  }, { prefix: "/api/v1" });

  app.get("/openapi.json", {
    schema: { hide: true },
  }, async () => app.swagger());

  app.addHook("onClose", async () => {
    const results = await Promise.allSettled([
      closeStorageProvider(storage),
      options.store.close(),
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length === 1) throw failures[0]?.reason;
    if (failures.length > 1) {
      throw new AggregateError(failures.map((failure) => failure.reason), "应用依赖关闭失败");
    }
  });
  return app;
}
