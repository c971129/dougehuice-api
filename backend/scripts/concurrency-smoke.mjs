import sharp from "sharp";

const baseUrls = (process.env.CONCURRENCY_BASE_URLS
  ?? "http://127.0.0.1:8787/api/v1,http://127.0.0.1:8789/api/v1")
  .split(",")
  .map((value) => value.trim().replace(/\/$/, ""))
  .filter(Boolean);
const jobCount = Number.parseInt(process.env.CONCURRENCY_JOB_COUNT ?? "12", 10);
const deadlineMilliseconds = Number.parseInt(process.env.CONCURRENCY_DEADLINE_MS ?? "60000", 10);
const stamp = `${Date.now()}-${process.pid}`;

function invariant(value, message) {
  if (!value) throw new Error(message);
}

invariant(baseUrls.length >= 2, "CONCURRENCY_BASE_URLS must contain at least two API nodes");
invariant(Number.isInteger(jobCount) && jobCount >= 2 && jobCount <= 20, "CONCURRENCY_JOB_COUNT must be 2-20");
invariant(
  Number.isInteger(deadlineMilliseconds) && deadlineMilliseconds >= 5_000 && deadlineMilliseconds <= 300_000,
  "CONCURRENCY_DEADLINE_MS must be 5000-300000",
);

async function requestUnchecked(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body, bytes };
}

async function request(baseUrl, path, options = {}) {
  const result = await requestUnchecked(baseUrl, path, options);
  if (!result.response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${baseUrl}${path} failed (${result.response.status}): ${result.bytes
        .toString("utf8")
        .slice(0, 500)}`,
    );
  }
  return result;
}

async function json(baseUrl, path, method, body, headers = {}) {
  return request(baseUrl, path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

for (const baseUrl of baseUrls) {
  const ready = await request(baseUrl, "/ready");
  invariant(ready.body?.status === "ready", `${baseUrl} did not report ready`);
}

const primary = baseUrls[0];
const session = await json(primary, "/auth/dev-session", "POST", {
  displayName: `多节点并发冒烟 ${stamp}`,
});
const authorization = `Bearer ${session.body.token}`;
const authHeaders = { authorization };
const initialCredits = session.body.credits?.balance;
invariant(Number.isInteger(initialCredits) && initialCredits >= jobCount, "development session has insufficient credits");

const consent = await request(primary, "/privacy/ai-processing-consent");
invariant(typeof consent.body?.consentVersion === "string", "AI consent version is missing");

const width = 8;
const height = 8;
const rgba = Buffer.alloc(width * height * 4);
for (let index = 0; index < width * height; index += 1) {
  const offset = index * 4;
  rgba[offset] = index % 2 === 0 ? 0xe9 : 0x3f;
  rgba[offset + 1] = index % 2 === 0 ? 0x43 : 0xa7;
  rgba[offset + 2] = index % 2 === 0 ? 0x59 : 0xd6;
  rgba[offset + 3] = 0xff;
}
const sourcePng = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
const uploadKey = `concurrency-asset-${stamp}`;

function uploadForm() {
  const form = new FormData();
  form.append("purpose", "ai-source");
  form.append("consentVersion", consent.body.consentVersion);
  form.append("file", new Blob([sourcePng], { type: "image/png" }), "concurrency-source.png");
  return form;
}

const uploadResults = await Promise.all(baseUrls.slice(0, 2).map((baseUrl) => request(baseUrl, "/assets", {
  method: "POST",
  headers: { ...authHeaders, "idempotency-key": uploadKey },
  body: uploadForm(),
})));
for (const result of uploadResults) {
  invariant(result.response.status === 201, "idempotent asset upload did not return HTTP 201");
}
const sourceAssetId = uploadResults[0].body?.asset?.id;
invariant(sourceAssetId, "idempotent asset upload did not return an asset id");
invariant(
  uploadResults.every((result) => result.body?.asset?.id === sourceAssetId),
  "two API nodes published different assets for one Idempotency-Key",
);
invariant(
  uploadResults.some((result) => result.response.headers.get("idempotency-replayed") === "true"),
  "concurrent asset replay was not identified by Idempotency-Replayed",
);

async function createGenerationPair(index) {
  const payload = {
    kind: "portrait",
    paletteId: "mard-48-v1",
    sourceAssetId,
    width,
    height,
    seed: `concurrency-${stamp}-${index}`,
    options: {
      removeBackground: true,
      figureStyle: "chibi-full",
      maxColors: 8,
      transparentBackground: true,
    },
  };
  const headers = {
    ...authHeaders,
    "idempotency-key": `concurrency-generation-${stamp}-${index}`,
  };
  const leftBaseUrl = baseUrls[index % baseUrls.length];
  const rightBaseUrl = baseUrls[(index + 1) % baseUrls.length];
  const [left, right] = await Promise.all([
    json(leftBaseUrl, "/generation-jobs", "POST", payload, headers),
    json(rightBaseUrl, "/generation-jobs", "POST", payload, headers),
  ]);
  invariant(left.response.status === 202 && right.response.status === 202, "generation was not queued on both nodes");
  invariant(left.body?.job?.id === right.body?.job?.id, "cross-node replay created duplicate generation jobs");
  return left.body.job.id;
}

const startedAt = Date.now();
async function waitForGenerationWave(generationIds) {
  const pending = new Set(generationIds);
  while (pending.size > 0 && Date.now() - startedAt < deadlineMilliseconds) {
    await Promise.all([...pending].map(async (generationId, index) => {
      const baseUrl = baseUrls[index % baseUrls.length];
      const current = await request(baseUrl, `/generation-jobs/${generationId}`, { headers: authHeaders });
      const status = current.body?.job?.status;
      if (status === "completed") pending.delete(generationId);
      else if (status === "accepted" || status === "failed" || status === "canceled") {
        throw new Error(`generation ${generationId} ended unexpectedly as ${status}`);
      }
    }));
    if (pending.size > 0) await wait(100);
  }
  invariant(pending.size === 0, `${pending.size} generation jobs did not finish before the deadline`);
}

const generationPairs = [];
// The product contract permits four active generation jobs per user. Run
// repeated four-job waves so the smoke test stresses both API/worker nodes
// without treating the intended resource guard as a failure.
for (let start = 0; start < jobCount; start += 4) {
  const waveSize = Math.min(4, jobCount - start);
  const wave = await Promise.all(Array.from(
    { length: waveSize },
    (_, offset) => createGenerationPair(start + offset),
  ));
  generationPairs.push(...wave);
  await waitForGenerationWave(wave);
}

invariant(new Set(generationPairs).size === jobCount, "distinct generation keys did not create distinct jobs");

const [profile, history, assets] = await Promise.all([
  request(baseUrls[0], "/me", { headers: authHeaders }),
  request(baseUrls[1], "/generation-jobs?limit=100&offset=0", { headers: authHeaders }),
  request(baseUrls[0], "/assets?limit=100&offset=0", { headers: authHeaders }),
]);
invariant(profile.body?.account?.balance === initialCredits - jobCount, "generation credits were not charged exactly once");
invariant(history.body?.jobs?.length === jobCount, "generation history contains missing or duplicate jobs");
invariant(
  assets.body?.assets?.filter((asset) => asset.id === sourceAssetId).length === 1,
  "asset listing did not contain exactly one idempotent source asset",
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  apiNodes: baseUrls.length,
  jobsRequested: jobCount,
  jobsCompleted: generationPairs.length,
  uniqueGenerationIds: new Set(generationPairs).size,
  sourceAssetId,
  assetReplayObserved: uploadResults.some(
    (result) => result.response.headers.get("idempotency-replayed") === "true",
  ),
  initialCredits,
  remainingCredits: profile.body.account.balance,
  elapsedMilliseconds: Date.now() - startedAt,
}, null, 2)}\n`);
