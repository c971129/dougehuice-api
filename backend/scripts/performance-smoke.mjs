const baseUrl = (process.env.PERF_BASE_URL ?? "http://127.0.0.1:8787/api/v1").replace(/\/$/, "");
const workerKey = process.env.INTERNAL_WORKER_KEY ?? "pindou-dev-only-worker-key-change-me";
const side = parsePositiveInteger(process.env.PERF_GRID_SIDE ?? "200", "PERF_GRID_SIDE", 200);
const maxCreateMs = parsePositiveInteger(process.env.PERF_MAX_CREATE_MS ?? "3000", "PERF_MAX_CREATE_MS");
const maxPngMs = parsePositiveInteger(process.env.PERF_MAX_PNG_MS ?? "15000", "PERF_MAX_PNG_MS");
const maxPdfMs = parsePositiveInteger(process.env.PERF_MAX_PDF_MS ?? "30000", "PERF_MAX_PDF_MS");
const stamp = `${Date.now()}-${process.pid}`;

function parsePositiveInteger(raw, name, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return { response, body };
}

async function json(path, method, body, headers = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function timed(operation) {
  const startedAt = performance.now();
  const value = await operation();
  return { value, durationMs: Math.round(performance.now() - startedAt) };
}

async function processExportUntilDone(exportId, authorization) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await json("/internal/export-jobs/process-next", "POST", {}, { "x-internal-worker-key": workerKey });
    const current = await request(`/exports/${exportId}`, { headers: { authorization } });
    if (current.body.export.status === "succeeded") return current.body.export;
    if (current.body.export.status === "failed" || current.body.export.status === "canceled") {
      throw new Error(`export ${exportId} ended as ${current.body.export.status}: ${current.body.export.errorCode ?? "unknown"}`);
    }
  }
  throw new Error(`export ${exportId} did not finish after 20 worker claims`);
}

async function createAndRenderExport({ format, project, authorization }) {
  const created = await json("/exports", "POST", {
    projectId: project.id,
    projectRevision: project.currentRevision,
    format,
    fileName: `${side}x${side}-performance-${format}`,
  }, {
    authorization,
    "idempotency-key": `performance-${format}-${stamp}`,
  });
  const measured = await timed(() => processExportUntilDone(created.body.export.id, authorization));
  const download = await fetch(`${baseUrl}/exports/${created.body.export.id}/content`, { headers: { authorization } });
  if (!download.ok) {
    throw new Error(`download ${created.body.export.id} failed (${download.status}): ${(await download.text()).slice(0, 500)}`);
  }
  const bytes = Buffer.from(await download.arrayBuffer()).length;
  if (bytes !== measured.value.artifact.sizeBytes) {
    throw new Error(`${format} download size ${bytes} differs from metadata ${measured.value.artifact.sizeBytes}`);
  }
  return { durationMs: measured.durationMs, bytes, status: measured.value.status };
}

await request("/ready");
const session = await json("/auth/dev-session", "POST", { displayName: `性能冒烟 ${stamp}` });
const authorization = `Bearer ${session.body.token}`;
const cells = Array.from({ length: side * side }, (_, index) => (
  index % 17 === 0 ? "A11" : index % 11 === 0 ? "E2" : "H2"
));
const created = await timed(() => json("/projects", "POST", {
  name: `${side}×${side} 性能图纸`,
  paletteId: "mard-48-v1",
  grid: { encoding: "palette-code-v1", width: side, height: side, cells },
}, {
  authorization,
  "idempotency-key": `performance-project-${stamp}`,
}));
const project = created.value.body.project;
const png = await createAndRenderExport({ format: "png", project, authorization });
const pdf = await createAndRenderExport({ format: "pdf", project, authorization });
const result = {
  baseUrl,
  grid: `${side}x${side}`,
  createMs: created.durationMs,
  png,
  pdf,
  thresholdsMs: { create: maxCreateMs, png: maxPngMs, pdf: maxPdfMs },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (created.durationMs > maxCreateMs || png.durationMs > maxPngMs || pdf.durationMs > maxPdfMs) {
  process.stderr.write("performance smoke exceeded one or more configured thresholds\n");
  process.exitCode = 1;
}
