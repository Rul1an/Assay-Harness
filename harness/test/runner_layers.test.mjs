import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  RUNNER_ARCHIVE_MANIFEST_SCHEMA,
  RUNNER_CAPABILITY_SURFACE_PATH,
  RUNNER_CAPABILITY_SURFACE_SCHEMA,
  RUNNER_CORRELATION_REPORT_PATH,
  RUNNER_CORRELATION_REPORT_SCHEMA,
  RUNNER_MANIFEST_PATH,
  RUNNER_OBSERVATION_HEALTH_PATH,
  RUNNER_OBSERVATION_HEALTH_SCHEMA,
} from "../dist/runner_archive.js";
import {
  computeLayerProjection,
  formatRunnerLayerProjection,
  RUNNER_LAYER_PATHS,
} from "../dist/runner_layers.js";
import {
  compareRunnerArchivesCapabilitySurface,
  formatRunnerCompareResult,
} from "../dist/runner_compare.js";

// ---------------------------------------------------------------------------
// Minimal ustar+gzip writer (same as runner_compare.test.mjs)
// ---------------------------------------------------------------------------

const BLOCK = 512;

function buildHeader(name, size) {
  const header = Buffer.alloc(BLOCK);
  writeField(header, name, 0, 100);
  writeField(header, octal(0o644, 7) + "\0", 100, 8);
  writeField(header, octal(0, 7) + "\0", 108, 8);
  writeField(header, octal(0, 7) + "\0", 116, 8);
  writeField(header, octal(size, 11) + "\0", 124, 12);
  writeField(header, octal(0, 11) + "\0", 136, 12);
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header[156] = 0x30;
  writeField(header, "ustar", 257, 6);
  header[262] = 0;
  header[263] = 0x30; header[264] = 0x30;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i];
  const checksum = octal(sum, 6) + "\0 ";
  writeField(header, checksum, 148, 8);
  return header;
}

function writeField(buf, value, start, length) {
  const bytes = Buffer.from(value, "utf8");
  const copyLen = Math.min(bytes.byteLength, length);
  bytes.copy(buf, start, 0, copyLen);
}

function octal(n, width) {
  return n.toString(8).padStart(width, "0");
}

function buildTarGz(entries) {
  const chunks = [];
  for (const [path, body] of entries) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    chunks.push(buildHeader(path, data.byteLength));
    chunks.push(data);
    const pad = (BLOCK - (data.byteLength % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK));
  chunks.push(Buffer.alloc(BLOCK));
  return gzipSync(Buffer.concat(chunks));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function ndjson(events) {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
}

// ---------------------------------------------------------------------------
// Tier-1-clean archive builder with custom layer streams
// ---------------------------------------------------------------------------

function buildArchiveWithLayers({
  runId,
  kernelEvents = [],
  policyEvents = [],
  sdkEvents = [],
}) {
  const observationHealth = {
    schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
    run_id: runId,
    platform: "linux",
    kernel_layer: "complete",
    ringbuf_drops: 0,
    policy_layer: "present",
    sdk_layer: "self_reported",
    cgroup_correlation: "clean",
    notes: [],
  };
  const correlationReport = {
    schema: RUNNER_CORRELATION_REPORT_SCHEMA,
    run_id: runId,
    status: "clean",
    bindings: [],
    ambiguities: [],
  };
  const surface = {
    schema: RUNNER_CAPABILITY_SURFACE_SCHEMA,
    run_id: runId,
    filesystem_paths: [],
    network_endpoints: [],
    process_execs: [],
    mcp_tools: [],
    policy_decisions: [],
  };

  const fileBytes = new Map();
  fileBytes.set(RUNNER_OBSERVATION_HEALTH_PATH, Buffer.from(JSON.stringify(observationHealth), "utf8"));
  fileBytes.set(RUNNER_CORRELATION_REPORT_PATH, Buffer.from(JSON.stringify(correlationReport), "utf8"));
  fileBytes.set(RUNNER_CAPABILITY_SURFACE_PATH, Buffer.from(JSON.stringify(surface), "utf8"));
  fileBytes.set("events.ndjson", Buffer.from("", "utf8"));
  fileBytes.set(RUNNER_LAYER_PATHS.kernel, Buffer.from(ndjson(kernelEvents), "utf8"));
  fileBytes.set(RUNNER_LAYER_PATHS.policy, Buffer.from(ndjson(policyEvents), "utf8"));
  fileBytes.set(RUNNER_LAYER_PATHS.sdk, Buffer.from(ndjson(sdkEvents), "utf8"));

  const files = {};
  for (const [p, b] of fileBytes) {
    files[p] = { path: p, sha256: `sha256:${sha256Hex(b)}`, bytes: b.byteLength };
  }
  const manifest = { schema: RUNNER_ARCHIVE_MANIFEST_SCHEMA, run_id: runId, files };
  const entries = [
    [RUNNER_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest), "utf8")],
  ];
  for (const [p, b] of fileBytes) entries.push([p, b]);
  return buildTarGz(entries);
}

function writeArchive(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

// ---------------------------------------------------------------------------
// Tier 2B — per-layer projection
// ---------------------------------------------------------------------------

test("layer projection counts events per layer and groups by event_type", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2b-counts-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchiveWithLayers({
    runId: "rb",
    kernelEvents: [
      { event_type: "file_open", path: "/tmp/a" },
      { event_type: "file_open", path: "/tmp/b" },
      { event_type: "process_exec", path: "/usr/bin/ls" },
    ],
    policyEvents: [
      { event_type: "decision", decision: "allow", tool: "read_file" },
    ],
    sdkEvents: [
      { event_type: "run_started", source: "openai-agents-fixture" },
      { event_type: "tool_call_started", source: "openai-agents-fixture", tool: "read_file", tool_call_id: "tc_1" },
      { event_type: "tool_call_completed", source: "openai-agents-fixture", tool: "read_file", tool_call_id: "tc_1" },
    ],
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchiveWithLayers({
    runId: "rc",
    kernelEvents: [
      { event_type: "file_open", path: "/tmp/a" },
      { event_type: "file_open", path: "/tmp/b" },
      { event_type: "file_open", path: "/tmp/c" },
      { event_type: "process_exec", path: "/usr/bin/ls" },
      { event_type: "network_connect", endpoint: "api.example.com:443" },
    ],
    policyEvents: [
      { event_type: "decision", decision: "allow", tool: "read_file" },
      { event_type: "decision", decision: "deny", tool: "write_file" },
    ],
    sdkEvents: [
      { event_type: "run_started", source: "openai-agents-fixture" },
      { event_type: "tool_call_started", source: "openai-agents-fixture", tool: "read_file", tool_call_id: "tc_1" },
      { event_type: "tool_call_completed", source: "openai-agents-fixture", tool: "read_file", tool_call_id: "tc_1" },
      { event_type: "tool_call_started", source: "openai-agents-fixture", tool: "list_dir", tool_call_id: "tc_2" },
      { event_type: "tool_call_completed", source: "openai-agents-fixture", tool: "list_dir", tool_call_id: "tc_2" },
    ],
  }));

  const proj = computeLayerProjection(baseline, candidate);
  assert.equal(proj.computed, true);

  // Kernel: 3 -> 5 events, new event type "network_connect"
  assert.equal(proj.kernel.baseline_total, 3);
  assert.equal(proj.kernel.candidate_total, 5);
  assert.equal(proj.kernel.total_delta, 2);
  assert.deepEqual(proj.kernel.added_event_types, ["network_connect"]);
  assert.deepEqual(proj.kernel.removed_event_types, []);

  // Policy: 1 -> 2 events, same event type (decision) so no added/removed types
  assert.equal(proj.policy.baseline_total, 1);
  assert.equal(proj.policy.candidate_total, 2);
  assert.deepEqual(proj.policy.added_event_types, []);

  // SDK: 3 -> 5 events; tool set went from {read_file} to {list_dir, read_file}
  assert.equal(proj.sdk.baseline_total, 3);
  assert.equal(proj.sdk.candidate_total, 5);
  assert.ok(proj.sdk.sdk_tools);
  assert.deepEqual(proj.sdk.sdk_tools.added, ["list_dir"]);
  assert.deepEqual(proj.sdk.sdk_tools.removed, []);
});

test("SDK layer carries the self_reported caveat note", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2b-sdk-note-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchiveWithLayers({ runId: "rb" }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchiveWithLayers({ runId: "rc" }));
  const proj = computeLayerProjection(baseline, candidate);
  assert.ok(
    proj.sdk.notes.some((n) => n.startsWith("sdk_layer_is_self_reported")),
    `expected self-reported note in ${JSON.stringify(proj.sdk.notes)}`,
  );
});

test("unparseable lines are counted and surfaced as notes, not thrown", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2b-unparseable-"));
  // Build a candidate with a kernel layer that has one bad line in the middle.
  const obs = {
    schema: RUNNER_OBSERVATION_HEALTH_SCHEMA, run_id: "rc",
    platform: "linux", kernel_layer: "complete", ringbuf_drops: 0,
    policy_layer: "present", sdk_layer: "self_reported", cgroup_correlation: "clean", notes: [],
  };
  const corr = {
    schema: RUNNER_CORRELATION_REPORT_SCHEMA, run_id: "rc",
    status: "clean", bindings: [], ambiguities: [],
  };
  const surface = {
    schema: RUNNER_CAPABILITY_SURFACE_SCHEMA, run_id: "rc",
    filesystem_paths: [], network_endpoints: [], process_execs: [], mcp_tools: [], policy_decisions: [],
  };
  const kernelText = '{"event_type":"file_open"}\nthis is not json\n{"event_type":"process_exec"}\n';
  const fb = new Map();
  fb.set(RUNNER_OBSERVATION_HEALTH_PATH, Buffer.from(JSON.stringify(obs), "utf8"));
  fb.set(RUNNER_CORRELATION_REPORT_PATH, Buffer.from(JSON.stringify(corr), "utf8"));
  fb.set(RUNNER_CAPABILITY_SURFACE_PATH, Buffer.from(JSON.stringify(surface), "utf8"));
  fb.set("events.ndjson", Buffer.from("", "utf8"));
  fb.set(RUNNER_LAYER_PATHS.kernel, Buffer.from(kernelText, "utf8"));
  fb.set(RUNNER_LAYER_PATHS.policy, Buffer.from("", "utf8"));
  fb.set(RUNNER_LAYER_PATHS.sdk, Buffer.from("", "utf8"));
  const files = {};
  for (const [p, b] of fb) files[p] = { path: p, sha256: `sha256:${sha256Hex(b)}`, bytes: b.byteLength };
  const manifest = { schema: RUNNER_ARCHIVE_MANIFEST_SCHEMA, run_id: "rc", files };
  const entries = [[RUNNER_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest), "utf8")]];
  for (const [p, b] of fb) entries.push([p, b]);
  const candidate = writeArchive(dir, "c.tar.gz", buildTarGz(entries));

  const baseline = writeArchive(dir, "b.tar.gz", buildArchiveWithLayers({ runId: "rb" }));
  const proj = computeLayerProjection(baseline, candidate);
  // Two events parsed (file_open + process_exec), one bad line counted.
  assert.equal(proj.kernel.candidate_total, 2);
  assert.ok(
    proj.kernel.notes.some((n) => n.startsWith("candidate_kernel_unparseable_lines:")),
    `expected candidate_kernel_unparseable_lines note in ${JSON.stringify(proj.kernel.notes)}`,
  );
});

test("missing layer ndjson is surfaced as a note, not an error", () => {
  // Build a Tier-1-clean archive WITHOUT any layer ndjson files. Manifest
  // must not list them either, otherwise Tier 1 fails.
  const dir = mkdtempSync(join(tmpdir(), "tier2b-missing-"));
  function buildMinimal(runId) {
    const obs = {
      schema: RUNNER_OBSERVATION_HEALTH_SCHEMA, run_id: runId,
      platform: "linux", kernel_layer: "complete", ringbuf_drops: 0,
      policy_layer: "present", sdk_layer: "self_reported", cgroup_correlation: "clean", notes: [],
    };
    const corr = {
      schema: RUNNER_CORRELATION_REPORT_SCHEMA, run_id: runId,
      status: "clean", bindings: [], ambiguities: [],
    };
    const surface = {
      schema: RUNNER_CAPABILITY_SURFACE_SCHEMA, run_id: runId,
      filesystem_paths: [], network_endpoints: [], process_execs: [], mcp_tools: [], policy_decisions: [],
    };
    const fb = new Map();
    fb.set(RUNNER_OBSERVATION_HEALTH_PATH, Buffer.from(JSON.stringify(obs), "utf8"));
    fb.set(RUNNER_CORRELATION_REPORT_PATH, Buffer.from(JSON.stringify(corr), "utf8"));
    fb.set(RUNNER_CAPABILITY_SURFACE_PATH, Buffer.from(JSON.stringify(surface), "utf8"));
    const files = {};
    for (const [p, b] of fb) files[p] = { path: p, sha256: `sha256:${sha256Hex(b)}`, bytes: b.byteLength };
    const manifest = { schema: RUNNER_ARCHIVE_MANIFEST_SCHEMA, run_id: runId, files };
    const entries = [[RUNNER_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest), "utf8")]];
    for (const [p, b] of fb) entries.push([p, b]);
    return buildTarGz(entries);
  }
  const baseline = writeArchive(dir, "b.tar.gz", buildMinimal("rb"));
  const candidate = writeArchive(dir, "c.tar.gz", buildMinimal("rc"));
  const proj = computeLayerProjection(baseline, candidate);
  // Each layer reports zero events and contains a missing-ndjson note via
  // the projection.notes aggregate.
  assert.ok(proj.notes.some((n) => n.includes("kernel_layer_ndjson_missing")));
  assert.ok(proj.notes.some((n) => n.includes("policy_layer_ndjson_missing")));
  assert.ok(proj.notes.some((n) => n.includes("sdk_layer_ndjson_missing")));
});

test("Tier 2B does not affect Tier 2A regression flag", () => {
  // Even if SDK layer adds new tools, that should not become a regression
  // signal at the Tier-2A capability_surface level. Tier 2A reads the
  // capability-surface.json (which we left empty for `mcp_tools` in both
  // archives), so has_regressions must be false despite Tier 2B showing
  // SDK tool churn.
  const dir = mkdtempSync(join(tmpdir(), "tier2b-noaffect-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchiveWithLayers({
    runId: "rb",
    sdkEvents: [{ event_type: "tool_call_started", source: "fixture", tool: "read_file" }],
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchiveWithLayers({
    runId: "rc",
    sdkEvents: [
      { event_type: "tool_call_started", source: "fixture", tool: "read_file" },
      { event_type: "tool_call_started", source: "fixture", tool: "list_dir" },
    ],
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.has_regressions, false);
  assert.ok(result.layer_projection, "expected layer_projection on Tier-1-clean result");
  // The SDK tool diff is visible in the projection, but Tier-2A still
  // reports OK because capability_surface.mcp_tools is empty in both
  // fixtures (it is the upstream emitter's job to populate it).
  assert.deepEqual(result.layer_projection.sdk.sdk_tools.added, ["list_dir"]);
});

test("formatRunnerLayerProjection includes per-layer headings + self-reported caveat", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2b-fmt-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchiveWithLayers({
    runId: "rb",
    kernelEvents: [{ event_type: "file_open", path: "/tmp/a" }],
    sdkEvents: [{ event_type: "tool_call_started", tool: "read_file" }],
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchiveWithLayers({
    runId: "rc",
    kernelEvents: [
      { event_type: "file_open", path: "/tmp/a" },
      { event_type: "network_connect", endpoint: "x:1" },
    ],
    sdkEvents: [
      { event_type: "tool_call_started", tool: "read_file" },
      { event_type: "tool_call_started", tool: "list_dir" },
    ],
  }));
  const proj = computeLayerProjection(baseline, candidate);
  const md = formatRunnerLayerProjection(proj);
  assert.match(md, /## Per-Layer Projection \(Tier 2B/);
  assert.match(md, /### KERNEL layer/);
  assert.match(md, /### POLICY layer/);
  assert.match(md, /### SDK layer/);
  assert.match(md, /sdk_layer_is_self_reported_per_v0_contract/);
  assert.match(md, /Added event types/);
  assert.match(md, /network_connect/);
  assert.match(md, /SDK tool names/);
  assert.match(md, /list_dir/);
});

test("layer_projection is undefined when Tier 1 fails (Tier 2A skipped)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2b-tier1fail-"));
  const baseline = join(dir, "bad.tar.gz");
  writeFileSync(baseline, "not a gzip");
  const candidate = writeArchive(dir, "c.tar.gz", buildArchiveWithLayers({ runId: "rc" }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.tier1_clean, false);
  assert.equal(result.layer_projection, undefined);
});

test("layer projection markdown lives below the Tier-2A diff in runner compare output", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2b-fmt-integrated-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchiveWithLayers({
    runId: "rb",
    kernelEvents: [{ event_type: "file_open" }],
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchiveWithLayers({
    runId: "rc",
    kernelEvents: [{ event_type: "file_open" }, { event_type: "process_exec" }],
  }));
  const md = formatRunnerCompareResult(
    compareRunnerArchivesCapabilitySurface(baseline, candidate),
  );
  // Tier-2A heading comes first, Tier-2B section comes after.
  const tier2aIdx = md.indexOf("# Runner Capability-Surface Diff");
  const tier2bIdx = md.indexOf("## Per-Layer Projection");
  assert.ok(tier2aIdx >= 0, "expected Tier-2A heading");
  assert.ok(tier2bIdx > tier2aIdx, "expected Tier-2B projection AFTER Tier-2A heading");
});
