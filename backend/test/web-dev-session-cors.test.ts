import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/repositories/memory-store.js";

describe("local Web workbench CORS for development sessions", () => {
  let app: FastifyInstance;

  before(async () => {
    const config = loadConfig({
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      DEV_AUTH_ENABLED: "true",
    });
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("creates a development session from the Vite 5174 origin instead of mapping CORS rejection to INTERNAL_ERROR", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-session",
      headers: {
        origin: "http://127.0.0.1:5174",
        "content-type": "application/json",
      },
      payload: { displayName: "Web 创作者" },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().error?.code, undefined);
    assert.equal(typeof response.json().token, "string");
    assert.equal(response.headers["access-control-allow-origin"], "http://127.0.0.1:5174");
  });

  it("answers allowed preflights and disables CORS for disallowed origins", async () => {
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/dev-session",
      headers: {
        origin: "http://127.0.0.1:5174",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    assert.equal(allowed.statusCode, 204, allowed.body);
    assert.equal(allowed.headers["access-control-allow-origin"], "http://127.0.0.1:5174");
    assert.match(allowed.headers["access-control-allow-methods"] ?? "", /POST/);
    assert.match(allowed.headers["access-control-allow-headers"] ?? "", /content-type/);

    const denied = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/dev-session",
      headers: {
        origin: "https://blocked.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    assert.equal(denied.statusCode, 404, denied.body);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
    assert.deepEqual(denied.json().error, {
      code: "ROUTE_NOT_FOUND",
      message: "接口不存在",
      retryable: false,
      details: null,
    });
    assert.equal(typeof denied.json().requestId, "string");
  });
});
