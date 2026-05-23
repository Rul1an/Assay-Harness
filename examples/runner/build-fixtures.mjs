#!/usr/bin/env node
/**
 * Generate the demo fixtures used by docs/DEMO_RUNNER.md.
 *
 * Produces, into the directory this script lives in:
 *
 *   clean.tar.gz                            — Tier-1-clean Runner archive
 *   regression.tar.gz                       — Tier-1-clean archive with one
 *                                             extra mcp_tool, intended to
 *                                             trigger Tier-2A regression
 *                                             vs `clean.tar.gz`
 *   cross-runtime-diff-clean.json           — Tier-3 input that exits 0
 *   cross-runtime-diff-regression.json      — Tier-3 input that exits 6
 *
 * Same minimal ustar+gzip writer pattern as `harness/test/`. No external
 * npm dependency; uses only node:crypto and node:zlib.
 *
 * Run:
 *   node examples/runner/build-fixtures.mjs
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Schema string + path constants — mirror the Runner-side v0 contracts.
// ---------------------------------------------------------------------------

const RUNNER_ARCHIVE_MANIFEST_SCHEMA = "assay.runner.archive_manifest.v0";
const RUNNER_OBSERVATION_HEALTH_SCHEMA = "assay.runner.observation_health.v0";
const RUNNER_CORRELATION_REPORT_SCHEMA = "assay.runner.correlation_report.v0";
const RUNNER_CAPABILITY_SURFACE_SCHEMA = "assay.runner.capability_surface.v0";
const RUNNER_CROSS_RUNTIME_DIFF_SCHEMA = "assay.runner.cross_runtime_diff.v0";

const PATHS = {
  manifest: "manifest.json",
  observationHealth: "observation-health.json",
  correlationReport: "correlation-report.json",
  capabilitySurface: "capability-surface.json",
  events: "events.ndjson",
  kernel: "layers/kernel.ndjson",
  policy: "layers/policy.ndjson",
  sdk: "layers/sdk.ndjson",
};

// ---------------------------------------------------------------------------
// Minimal ustar+gzip writer
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
  header[156] = 0x30; // typeflag '0' (regular file)
  writeField(header, "ustar", 257, 6);
  header[262] = 0;
  header[263] = 0x30;
  header[264] = 0x30;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i];
  writeField(header, octal(sum, 6) + "\0 ", 148, 8);
  return header;
}

function writeField(buf, value, start, length) {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(buf, start, 0, Math.min(bytes.byteLength, length));
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

// ---------------------------------------------------------------------------
// Build one Tier-1-clean Runner archive
// ---------------------------------------------------------------------------

function buildArchive({ runId, mcpTools, filesystemPaths, policyDecisions }) {
  const observationHealth = {
    schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
    run_id: runId,
    platform: "linux",
    kernel_layer: "complete",
    ringbuf_drops: 0,
    policy_layer: "present",
    sdk_layer: "self_reported",
    cgroup_correlation: "clean",
    notes: ["demo_fixture"],
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
    filesystem_paths: filesystemPaths,
    network_endpoints: [],
    process_execs: [],
    mcp_tools: mcpTools,
    policy_decisions: policyDecisions,
  };

  const files = new Map();
  files.set(PATHS.observationHealth, Buffer.from(JSON.stringify(observationHealth, null, 2)));
  files.set(PATHS.correlationReport, Buffer.from(JSON.stringify(correlationReport, null, 2)));
  files.set(PATHS.capabilitySurface, Buffer.from(JSON.stringify(surface, null, 2)));
  files.set(PATHS.events, Buffer.from(""));
  files.set(PATHS.kernel, Buffer.from(""));
  files.set(PATHS.policy, Buffer.from(""));
  files.set(PATHS.sdk, Buffer.from(""));

  const manifestFiles = {};
  for (const [p, b] of files) {
    manifestFiles[p] = { path: p, sha256: `sha256:${sha256Hex(b)}`, bytes: b.byteLength };
  }
  const manifest = {
    schema: RUNNER_ARCHIVE_MANIFEST_SCHEMA,
    run_id: runId,
    files: manifestFiles,
  };

  const entries = [
    [PATHS.manifest, Buffer.from(JSON.stringify(manifest, null, 2))],
  ];
  for (const [p, b] of files) entries.push([p, b]);
  return buildTarGz(entries);
}

// ---------------------------------------------------------------------------
// Cross-runtime diff fixtures
// ---------------------------------------------------------------------------

const REQUIRED_NON_CLAIMS = [
  "cross_runtime_no_acceptability_judgment",
  "cross_runtime_no_declared_capability_input",
  "cross_runtime_no_derived_binding_identity",
  "cross_runtime_no_filename_semantic_equivalence",
  "cross_runtime_no_sdk_capability_equivalence",
];

const REQUIRED_NOTES = [
  "cross_runtime_diff_binding_ids_out_of_scope: binding ids are not cross-runtime comparable in v0; required only for within-runtime correlation",
  "cross_runtime_diff_sdk_metadata_side_band: sdk metadata reported as side-band runtime provenance, not capability surface",
  "cross_runtime_diff_work_dir_prefix_canonicalized: filesystem_paths normalized via the A1 work-dir prefix rule",
];

function buildCrossRuntimeDiff({ addedFilesystemPaths = [], addedMcpTools = [] } = {}) {
  return {
    schema: RUNNER_CROSS_RUNTIME_DIFF_SCHEMA,
    base_run_id: "run_demo_openai_agents",
    head_run_id: "run_demo_gemini_google_genai",
    base_runtime: "s5_openai_agents",
    head_runtime: "gemini_google_genai",
    status: "clean",
    preconditions: {
      base_health_clean: true,
      head_health_clean: true,
      base_correlation_clean: true,
      head_correlation_clean: true,
      stable_tool_call_ids_required: true,
      stable_tool_call_ids_present: true,
      runtimes_distinct: true,
    },
    scope: {
      projection: "surface_set",
      uses_raw_telemetry: false,
      uses_proof_pack: false,
      per_binding_capability_values: false,
      cross_runtime: true,
    },
    canonicalization: {
      filesystem_paths: "work_dir_prefix_only",
      network_endpoints: "none",
      process_execs: "none",
      mcp_tools: "none",
      policy_decisions: "none",
    },
    surface: {
      filesystem_paths: {
        added: addedFilesystemPaths,
        removed: [],
        unchanged: ["<work>/policy-input.txt"],
      },
      network_endpoints: { added: [], removed: [], unchanged: [] },
      process_execs: { added: [], removed: [], unchanged: [] },
      mcp_tools: { added: addedMcpTools, removed: [], unchanged: ["read_file"] },
      policy_decisions: { added: [], removed: [], unchanged: ["allow:read_file"] },
    },
    binding_ids: { comparison: "out_of_scope_cross_runtime_v0" },
    policy_outcomes: { comparison: "out_of_scope_cross_runtime_v0" },
    sdk_metadata: {
      comparison: "side_band_provenance",
      base: { sdk_name: "@openai/agents", sdk_version: "0.11.4" },
      head: { sdk_name: "google-genai", sdk_version: "2.6.0" },
    },
    unbound: {
      filesystem_paths: [],
      network_endpoints: [],
      process_execs: [],
      mcp_tools: [],
      policy_decisions: [],
    },
    non_claims: [...REQUIRED_NON_CLAIMS],
    ambiguities: [],
    notes: [...REQUIRED_NOTES],
  };
}

// ---------------------------------------------------------------------------
// Main — write all fixtures
// ---------------------------------------------------------------------------

const clean = buildArchive({
  runId: "run_demo_clean",
  mcpTools: ["read_file"],
  filesystemPaths: ["/tmp/demo/work/input.txt"],
  policyDecisions: ["allow:read_file"],
});

const regression = buildArchive({
  runId: "run_demo_regression",
  // Candidate adds `write_file` as an MCP tool. Tier 2A v0 policy: added
  // `mcp_tools` => regression.
  mcpTools: ["read_file", "write_file"],
  filesystemPaths: [
    "/tmp/demo/work/input.txt",
    "/tmp/demo/work/output.txt",
  ],
  policyDecisions: ["allow:read_file", "allow:write_file"],
});

const cleanDiff = buildCrossRuntimeDiff();
const regressionDiff = buildCrossRuntimeDiff({
  // Cross-runtime regression: gemini-side gained a tool the openai-side did
  // not have.
  addedMcpTools: ["list_dir"],
  addedFilesystemPaths: ["<work>/gemini-extra-input.txt"],
});

writeFileSync(join(HERE, "clean.tar.gz"), clean);
writeFileSync(join(HERE, "regression.tar.gz"), regression);
writeFileSync(
  join(HERE, "cross-runtime-diff-clean.json"),
  JSON.stringify(cleanDiff, null, 2) + "\n",
);
writeFileSync(
  join(HERE, "cross-runtime-diff-regression.json"),
  JSON.stringify(regressionDiff, null, 2) + "\n",
);

console.log("Wrote:");
console.log(`  ${join(HERE, "clean.tar.gz")}`);
console.log(`  ${join(HERE, "regression.tar.gz")}`);
console.log(`  ${join(HERE, "cross-runtime-diff-clean.json")}`);
console.log(`  ${join(HERE, "cross-runtime-diff-regression.json")}`);
