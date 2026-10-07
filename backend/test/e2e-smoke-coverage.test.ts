import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const smokePath = join(dirname(fileURLToPath(import.meta.url)), "../scripts/e2e-smoke.mjs");

describe("e2e-smoke coverage for Fake payment, web-login domain, privacy purge, export cancel, idempotency conflict", () => {
  const source = readFileSync(smokePath, "utf8");

  it("covers Fake payment create/query/succeed/refresh without WeChat credentials", () => {
    assert.match(source, /\/credit-products/);
    assert.match(source, /\/payment-orders/);
    assert.match(source, /\/internal\/fake-payments\/.+\/succeed|fake-payments\/\$\{/);
    assert.match(source, /\/payment-orders\/.+\/refresh|payment-orders\/\$\{.*\}\/refresh/);
    assert.match(source, /productionCandidate/);
    assert.doesNotMatch(source, /WECHAT_APP_SECRET|mchid|pay\.weixin/);
  });

  it("covers Web login token domain: poll header vs sessionToken Bearer", () => {
    assert.match(source, /\/auth\/web-login-challenges/);
    assert.match(source, /\/auth\/web-login-challenges\/current/);
    assert.match(source, /\/auth\/web-login-challenges\/confirm/);
    assert.match(source, /x-web-login-token|X-Web-Login-Token/);
    assert.match(source, /sessionToken/);
    assert.match(source, /sessionToken.*token|token.*sessionToken|notEqual|!==/);
  });

  it("covers privacy delete-expired via internal worker key", () => {
    assert.match(source, /\/privacy\/delete-expired/);
    assert.match(source, /x-internal-worker-key/);
  });

  it("covers export cancel before worker completion", () => {
    assert.match(source, /\/exports\/.+\/cancel|exports\/\$\{.*\}\/cancel/);
    assert.match(source, /canceled|cancelled/);
  });

  it("covers Idempotency-Key conflict on same key different body", () => {
    assert.match(source, /IDEMPOTENCY_CONFLICT/);
    assert.match(source, /409/);
  });
});
