import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access, chmod, constants, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapPath = join(backendRoot, "scf_bootstrap");

test("CloudBase bootstrap references the absolute Node.js 24 runtime binary", async () => {
  const source = await readFile(bootstrapPath, "utf8");
  assert.match(source, /\/var\/lang\/node24\/bin\/node/);
});

test("CloudBase bootstrap defaults production mode and pool max while preserving explicit overrides", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pindou-cloudbase-pool-config-"));
  const fakeNode = join(tempRoot, "fake-node");
  await writeFile(fakeNode, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ nodeEnv: process.env.NODE_ENV ?? \"unset\", poolMax: process.env.DATABASE_POOL_MAX ?? \"unset\" }));\n");
  await chmod(fakeNode, 0o755);
  const pathEntries = [dirname(process.execPath), process.env.PATH].filter(Boolean);

  const runBootstrap = async (options: { nodeEnv?: string; databasePoolMax?: string } = {}): Promise<{ nodeEnv: string; poolMax: string }> => {
    const child = spawn(bootstrapPath, [], {
      cwd: backendRoot,
      env: {
        PATH: pathEntries.join(":"),
        NODE_BIN: fakeNode,
        ...(options.nodeEnv === undefined ? {} : { NODE_ENV: options.nodeEnv }),
        ...(options.databasePoolMax === undefined ? {} : { DATABASE_POOL_MAX: options.databasePoolMax }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
    assert.equal(exitCode, 0, stderr);
    return JSON.parse(stdout) as { nodeEnv: string; poolMax: string };
  };

  try {
    assert.deepEqual(await runBootstrap(), { nodeEnv: "production", poolMax: "2" });
    assert.deepEqual(await runBootstrap({ nodeEnv: "development", databasePoolMax: "4" }), { nodeEnv: "development", poolMax: "4" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(3_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

test("CloudBase bootstrap starts the API health route locally", async (t) => {
  await access(bootstrapPath, constants.X_OK);
  await access(join(backendRoot, "index.js"));
  await access(join(backendRoot, "dist/src/index.js"));

  const port = await availablePort();
  const pathEntries = [dirname(process.execPath), process.env.PATH].filter(Boolean);
  const testKeyRoot = await mkdtemp(join(tmpdir(), "pindou-cloudbase-runtime-keys-"));
  const merchantKeyPath = join(testKeyRoot, "merchant-private.pem");
  const verifierKeyPath = join(testKeyRoot, "verifier-public.pem");
  const merchantKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const verifierKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(merchantKeyPath, merchantKeyPair.privateKey.export({ format: "pem", type: "pkcs8" }));
  await writeFile(verifierKeyPath, verifierKeyPair.publicKey.export({ format: "pem", type: "spki" }));
  const child = spawn(bootstrapPath, [], {
    cwd: backendRoot,
    env: {
      PATH: pathEntries.join(":"),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      DOTENV_CONFIG_PATH: "/dev/null",
      NODE_BIN: process.execPath,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: "postgresql://smoke:smoke@db.example.test:5432/pindou_smoke",
      DATABASE_SSL: "true",
      DEV_AUTH_ENABLED: "false",
      INTERNAL_WORKER_KEY: "cloudbase-runtime-smoke-worker-key",
      TRUSTED_PROXIES: "127.0.0.1/32",
      ASSET_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
      ASSET_STORAGE_PROVIDER: "s3",
      ASSET_S3_BUCKET: "pindou-smoke-bucket",
      ASSET_S3_REGION: "ap-beijing",
      ASSET_S3_PREFIX: "smoke",
      GENERATION_PROVIDER_URL: "https://generation.example.test/v1/generate",
      GENERATION_PROVIDER_API_KEY: "cloudbase-runtime-smoke-generation-key",
      GENERATION_PROVIDER_TIMEOUT_MS: "120000",
      ASSET_CONSENT_PROCESSOR: "CloudBase runtime smoke fixture",
      ASSET_CONSENT_PURPOSE_TEXT: "仅用于 CloudBase runtime 本地启动冒烟测试",
      ASSET_CONSENT_RETENTION_TEXT: "仅用于 CloudBase runtime 本地启动冒烟测试",
      WECHAT_APP_ID: "wx1234567890abcdef",
      WECHAT_APP_SECRET: "0123456789abcdef0123456789abcdef",
      WECHAT_PAY_MCH_ID: "1900000001",
      WECHAT_PAY_MERCHANT_CERT_SERIAL: "0123456789ABCDEF",
      WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: merchantKeyPath,
      WECHAT_PAY_VERIFIER_SERIAL: "PUB_KEY_ID_3000000001",
      WECHAT_PAY_VERIFIER_PUBLIC_KEY_PATH: verifierKeyPath,
      WECHAT_PAY_API_V3_KEY: "0123456789abcdef0123456789abcdef",
      WECHAT_PAY_NOTIFY_URL: "https://api.example.test/api/v1/wechat-pay/notifications",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { childOutput += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { childOutput += chunk; });
  t.after(async () => {
    await stop(child);
    await rm(testKeyRoot, { recursive: true, force: true });
  });

  let response: Response | undefined;
  let lastError: unknown;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(`CloudBase bootstrap exited before health became available (exit=${child.exitCode}, signal=${child.signalCode}): ${childOutput}`);
    }
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(500) });
      break;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  assert.ok(response, `CloudBase health route did not start: ${String(lastError)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "pindou-backend" });
});
