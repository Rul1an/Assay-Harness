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
  compareRunnerArchivesCapabilitySurface,
  formatRunnerCompareResult,
} from "../dist/runner_compare.js";

// ---------------------------------------------------------------------------
// Minimal ustar+gzip writer (mirrors runner_archive.test.mjs; duplicated to
// keep the two test files independent — Tier 1 tests cover the writer's
// own correctness, this file uses it as a fixture builder only).
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

// ---------------------------------------------------------------------------
// Fixture builder — Tier-1-clean archive with custom capability-surface.
// ---------------------------------------------------------------------------

function buildArchive({
  runId,
  capabilitySurface,
} = {}) {
  const observationHealth = {
    schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
    run_id: runId,
    platform: "linux",
    kernel_layer: "complete",
    ringbuf_drops: 0,
    policy_layer: "present",
    sdk_layer: "self_reported",
    cgroup_correlation: "clean",
    notes: ["tier2a_test"],
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
    filesystem_paths: capabilitySurface.filesystem_paths ?? [],
    network_endpoints: capabilitySurface.network_endpoints ?? [],
    process_execs: capabilitySurface.process_execs ?? [],
    mcp_tools: capabilitySurface.mcp_tools ?? [],
    policy_decisions: capabilitySurface.policy_decisions ?? [],
  };

  const fileBytes = new Map();
  fileBytes.set(
    RUNNER_OBSERVATION_HEALTH_PATH,
    Buffer.from(JSON.stringify(observationHealth, null, 2), "utf8"),
  );
  fileBytes.set(
    RUNNER_CORRELATION_REPORT_PATH,
    Buffer.from(JSON.stringify(correlationReport, null, 2), "utf8"),
  );
  fileBytes.set(
    RUNNER_CAPABILITY_SURFACE_PATH,
    Buffer.from(JSON.stringify(surface, null, 2), "utf8"),
  );
  fileBytes.set("events.ndjson", Buffer.from("", "utf8"));
  fileBytes.set("layers/kernel.ndjson", Buffer.from("", "utf8"));
  fileBytes.set("layers/policy.ndjson", Buffer.from("", "utf8"));
  fileBytes.set("layers/sdk.ndjson", Buffer.from("", "utf8"));

  const files = {};
  for (const [path, bytes] of fileBytes) {
    files[path] = {
      path,
      sha256: `sha256:${sha256Hex(bytes)}`,
      bytes: bytes.byteLength,
    };
  }

  const manifest = {
    schema: RUNNER_ARCHIVE_MANIFEST_SCHEMA,
    run_id: runId,
    files,
  };

  const entries = [
    [RUNNER_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest, null, 2), "utf8")],
  ];
  for (const [path, bytes] of fileBytes) entries.push([path, bytes]);
  return buildTarGz(entries);
}

function writeArchive(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

// ---------------------------------------------------------------------------
// Tier 2A — capability-surface diff regression policy
// ---------------------------------------------------------------------------

test("compare returns no regressions when both archives have identical surfaces", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-noreg-"));
  const surface = {
    filesystem_paths: ["/tmp/work/input.txt"],
    network_endpoints: [],
    process_execs: [],
    mcp_tools: ["read_file"],
    policy_decisions: ["allow:read_file"],
  };
  const baseline = writeArchive(
    dir,
    "baseline.tar.gz",
    buildArchive({ runId: "rid_baseline", capabilitySurface: surface }),
  );
  const candidate = writeArchive(
    dir,
    "candidate.tar.gz",
    buildArchive({ runId: "rid_candidate", capabilitySurface: surface }),
  );
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.mode, "runner_archive");
  assert.equal(result.tier, "capability_surface_diff");
  assert.equal(result.tier1_clean, true);
  assert.equal(result.has_regressions, false);
  assert.deepEqual(result.regression_reasons, []);
  assert.match(result.summary, /No Runner capability regressions/);
  // unchanged populated even if added/removed are empty
  assert.deepEqual(result.capability_surface.filesystem_paths.unchanged, ["/tmp/work/input.txt"]);
});

test("added filesystem_path counts as a regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-fs-"));
  const baseline = writeArchive(
    dir,
    "baseline.tar.gz",
    buildArchive({
      runId: "rid_b",
      capabilitySurface: { filesystem_paths: ["/tmp/work/a.txt"] },
    }),
  );
  const candidate = writeArchive(
    dir,
    "candidate.tar.gz",
    buildArchive({
      runId: "rid_c",
      capabilitySurface: {
        filesystem_paths: ["/tmp/work/a.txt", "/tmp/work/b.txt"],
      },
    }),
  );
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.has_regressions, true);
  assert.ok(
    result.regression_reasons.some((r) => r.startsWith("filesystem_paths_added")),
    `expected filesystem_paths_added in ${JSON.stringify(result.regression_reasons)}`,
  );
  assert.deepEqual(result.capability_surface.filesystem_paths.added, ["/tmp/work/b.txt"]);
});

test("added network_endpoint counts as a regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-net-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: { network_endpoints: [] },
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc", capabilitySurface: { network_endpoints: ["api.example.com:443"] },
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.has_regressions, true);
  assert.ok(result.regression_reasons.some((r) => r.startsWith("network_endpoints_added")));
});

test("added process_exec counts as a regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-proc-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: { process_execs: [] },
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc", capabilitySurface: { process_execs: ["/usr/bin/ls"] },
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.has_regressions, true);
  assert.ok(result.regression_reasons.some((r) => r.startsWith("process_execs_added")));
});

test("added mcp_tool counts as a regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-tool-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: { mcp_tools: ["read_file"] },
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc", capabilitySurface: { mcp_tools: ["read_file", "write_file"] },
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.has_regressions, true);
  assert.ok(result.regression_reasons.some((r) => r.startsWith("mcp_tools_added")));
});

test("new allow:* policy_decision counts as a regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-allow-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: { policy_decisions: ["allow:read_file"] },
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc", capabilitySurface: { policy_decisions: ["allow:read_file", "allow:write_file"] },
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.has_regressions, true);
  assert.ok(result.regression_reasons.some((r) => r === "policy_allow_decisions_added:1"));
});

test("new deny:* policy_decision is report-only (NOT a regression)", () => {
  // Tier-2A refinement C: new deny:* decisions typically reflect newly
  // visible blocked behaviour, not added capability surface. They go into
  // the diff as `added` but do NOT trigger a regression.
  const dir = mkdtempSync(join(tmpdir(), "tier2a-deny-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: { policy_decisions: ["allow:read_file"] },
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc", capabilitySurface: { policy_decisions: ["allow:read_file", "deny:write_file"] },
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.has_regressions, false);
  // The added deny is still surfaced in the diff for visibility.
  assert.deepEqual(result.capability_surface.policy_decisions.added, ["deny:write_file"]);
  // No regression_reasons because deny additions are report-only.
  assert.equal(result.regression_reasons.length, 0);
});

test("removed entries are reported but do NOT count as regressions", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-remove-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: {
      filesystem_paths: ["/tmp/work/a.txt", "/tmp/work/b.txt"],
      mcp_tools: ["read_file", "list_dir"],
    },
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc", capabilitySurface: {
      filesystem_paths: ["/tmp/work/a.txt"],
      mcp_tools: ["read_file"],
    },
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.has_regressions, false);
  assert.deepEqual(result.capability_surface.filesystem_paths.removed, ["/tmp/work/b.txt"]);
  assert.deepEqual(result.capability_surface.mcp_tools.removed, ["list_dir"]);
});

test("mixed added + removed: regression flag follows added only", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-mixed-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: {
      filesystem_paths: ["/tmp/work/a.txt", "/tmp/work/b.txt"],
    },
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc", capabilitySurface: {
      filesystem_paths: ["/tmp/work/a.txt", "/tmp/work/c.txt"],
    },
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.has_regressions, true);
  assert.deepEqual(result.capability_surface.filesystem_paths.added, ["/tmp/work/c.txt"]);
  assert.deepEqual(result.capability_surface.filesystem_paths.removed, ["/tmp/work/b.txt"]);
});

// ---------------------------------------------------------------------------
// Tier-1 prerequisite: Tier-2A must skip when either side fails Tier 1
// ---------------------------------------------------------------------------

test("Tier-2A skips with regression flag when baseline is invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-bad-"));
  const baseline = join(dir, "baseline.tar.gz");
  writeFileSync(baseline, "not a gzip stream");
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc", capabilitySurface: {},
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.tier1_clean, false);
  assert.equal(result.has_regressions, true);
  assert.ok(result.regression_reasons.includes("tier1_validation_failed"));
  assert.equal(result.capability_surface, undefined);
  assert.match(result.summary, /baseline failed Tier 1/);
});

test("Tier-2A reports capability_surface_unavailable when payload is missing", () => {
  // Build an archive that's Tier-1-clean but lacks capability-surface.json
  // entirely. Simulating: manifest knows about the file? No — manifest
  // would then require it. Construct a manifest that does NOT list
  // capability-surface.json, so Tier 1 stays clean but validation has no
  // capability_surface payload.
  const dir = mkdtempSync(join(tmpdir(), "tier2a-nocap-"));

  function buildMinimalArchive(runId) {
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
    const fileBytes = new Map();
    fileBytes.set(
      RUNNER_OBSERVATION_HEALTH_PATH,
      Buffer.from(JSON.stringify(observationHealth), "utf8"),
    );
    fileBytes.set(
      RUNNER_CORRELATION_REPORT_PATH,
      Buffer.from(JSON.stringify(correlationReport), "utf8"),
    );
    const files = {};
    for (const [path, bytes] of fileBytes) {
      files[path] = {
        path,
        sha256: `sha256:${sha256Hex(bytes)}`,
        bytes: bytes.byteLength,
      };
    }
    const manifest = {
      schema: RUNNER_ARCHIVE_MANIFEST_SCHEMA,
      run_id: runId,
      files,
    };
    const entries = [
      [RUNNER_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest), "utf8")],
    ];
    for (const [p, b] of fileBytes) entries.push([p, b]);
    return buildTarGz(entries);
  }

  const baseline = writeArchive(dir, "b.tar.gz", buildMinimalArchive("rb"));
  const candidate = writeArchive(dir, "c.tar.gz", buildMinimalArchive("rc"));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.tier1_clean, true);
  assert.equal(result.has_regressions, true);
  assert.ok(result.regression_reasons.includes("capability_surface_unavailable"));
});

// ---------------------------------------------------------------------------
// Formatter output discipline
// ---------------------------------------------------------------------------

test("formatRunnerCompareResult emits added/removed in markdown but no unchanged section", () => {
  // Tier-2A refinement D: markdown view omits `unchanged` to keep reviewer
  // output focused; JSON consumers can still read `unchanged`.
  const dir = mkdtempSync(join(tmpdir(), "tier2a-fmt-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: {
      filesystem_paths: ["/tmp/work/keep.txt", "/tmp/work/old.txt"],
    },
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc", capabilitySurface: {
      filesystem_paths: ["/tmp/work/keep.txt", "/tmp/work/new.txt"],
    },
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  const md = formatRunnerCompareResult(result);
  assert.match(md, /# Runner Capability-Surface Diff \(Tier 2A\)/);
  assert.match(md, /## Filesystem Paths/);
  assert.match(md, /Added:[\s\S]*new\.txt/);
  assert.match(md, /Removed.*not blocking.*old\.txt/s);
  // The unchanged entry should not appear with the literal word "Unchanged"
  // in the markdown output.
  assert.doesNotMatch(md, /Unchanged/);
  // Regression reasons section appears for the regression case.
  assert.match(md, /## Regression Reasons/);
});

test("formatRunnerCompareResult OK status omits the regression-reasons section", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-fmt-ok-"));
  const surface = { filesystem_paths: ["/tmp/work/a.txt"], mcp_tools: ["read_file"] };
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({ runId: "rb", capabilitySurface: surface }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({ runId: "rc", capabilitySurface: surface }));
  const md = formatRunnerCompareResult(
    compareRunnerArchivesCapabilitySurface(baseline, candidate),
  );
  assert.doesNotMatch(md, /## Regression Reasons/);
  assert.match(md, /\*\*Status:\*\* OK/);
});

// ---------------------------------------------------------------------------
// PR #60 review regression coverage
// ---------------------------------------------------------------------------

import { validateRunnerArchive } from "../dist/runner_archive.js";

/**
 * Build an archive whose capability-surface.json carries the right schema
 * string but a custom shape (the validator's runtime shape guard should
 * reject it). The manifest still hashes the on-disk bytes correctly, so
 * Tier 1 manifest validation stays clean.
 */
function buildArchiveWithRawCapabilitySurface(runId, rawSurface) {
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
  const fileBytes = new Map();
  fileBytes.set(
    RUNNER_OBSERVATION_HEALTH_PATH,
    Buffer.from(JSON.stringify(observationHealth), "utf8"),
  );
  fileBytes.set(
    RUNNER_CORRELATION_REPORT_PATH,
    Buffer.from(JSON.stringify(correlationReport), "utf8"),
  );
  fileBytes.set(
    RUNNER_CAPABILITY_SURFACE_PATH,
    Buffer.from(JSON.stringify(rawSurface), "utf8"),
  );
  const files = {};
  for (const [path, bytes] of fileBytes) {
    files[path] = {
      path,
      sha256: `sha256:${sha256Hex(bytes)}`,
      bytes: bytes.byteLength,
    };
  }
  const manifest = {
    schema: RUNNER_ARCHIVE_MANIFEST_SCHEMA,
    run_id: runId,
    files,
  };
  const entries = [
    [RUNNER_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest), "utf8")],
  ];
  for (const [p, b] of fileBytes) entries.push([p, b]);
  return buildTarGz(entries);
}

test("P1 — capability-surface with missing required category is rejected with SHAPE_INVALID", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-p1-missing-"));
  const archivePath = writeArchive(
    dir,
    "missing.tar.gz",
    buildArchiveWithRawCapabilitySurface("rid_missing", {
      schema: RUNNER_CAPABILITY_SURFACE_SCHEMA,
      run_id: "rid_missing",
      // filesystem_paths missing entirely
      network_endpoints: [],
      process_execs: [],
      mcp_tools: [],
      policy_decisions: [],
    }),
  );
  const result = validateRunnerArchive(archivePath);
  // Manifest is still valid; the shape error is an artifact_parse_error.
  assert.equal(result.manifest_valid, true);
  assert.equal(result.capability_surface, undefined);
  const codes = result.artifact_parse_errors.map((e) => e.code);
  assert.ok(
    codes.includes("CAPABILITY_SURFACE_SHAPE_INVALID"),
    `expected CAPABILITY_SURFACE_SHAPE_INVALID in ${codes}`,
  );
});

test("P1 — capability-surface with non-array category is rejected with SHAPE_INVALID", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-p1-nonarray-"));
  const archivePath = writeArchive(
    dir,
    "nonarray.tar.gz",
    buildArchiveWithRawCapabilitySurface("rid_nonarray", {
      schema: RUNNER_CAPABILITY_SURFACE_SCHEMA,
      run_id: "rid_nonarray",
      filesystem_paths: "not an array",
      network_endpoints: [],
      process_execs: [],
      mcp_tools: [],
      policy_decisions: [],
    }),
  );
  const result = validateRunnerArchive(archivePath);
  assert.equal(result.capability_surface, undefined);
  const codes = result.artifact_parse_errors.map((e) => e.code);
  assert.ok(codes.includes("CAPABILITY_SURFACE_SHAPE_INVALID"));
});

test("P1 — capability-surface with non-string elements is rejected with SHAPE_INVALID", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-p1-nonstr-"));
  const archivePath = writeArchive(
    dir,
    "nonstr.tar.gz",
    buildArchiveWithRawCapabilitySurface("rid_nonstr", {
      schema: RUNNER_CAPABILITY_SURFACE_SCHEMA,
      run_id: "rid_nonstr",
      filesystem_paths: [42, "ok"],
      network_endpoints: [],
      process_execs: [],
      mcp_tools: [],
      policy_decisions: [],
    }),
  );
  const result = validateRunnerArchive(archivePath);
  assert.equal(result.capability_surface, undefined);
  const codes = result.artifact_parse_errors.map((e) => e.code);
  assert.ok(codes.includes("CAPABILITY_SURFACE_SHAPE_INVALID"));
});

test("P1 — `runner compare` against a SHAPE_INVALID candidate does not throw and reports capability_surface_unavailable", () => {
  // End-to-end: shape-invalid capability-surface flows through Tier 2A as
  // a structured "capability surface unavailable" result, not a crash.
  const dir = mkdtempSync(join(tmpdir(), "tier2a-p1-e2e-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: { filesystem_paths: ["/tmp/work/a.txt"] },
  }));
  const candidate = writeArchive(
    dir,
    "c.tar.gz",
    buildArchiveWithRawCapabilitySurface("rc", {
      schema: RUNNER_CAPABILITY_SURFACE_SCHEMA,
      run_id: "rc",
      filesystem_paths: { wrong: "type" },
      network_endpoints: [],
      process_execs: [],
      mcp_tools: [],
      policy_decisions: [],
    }),
  );
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.tier1_clean, true);
  assert.equal(result.has_regressions, true);
  assert.equal(result.capability_surface, undefined);
  assert.ok(
    result.regression_reasons.includes("capability_surface_unavailable"),
    `expected capability_surface_unavailable in ${JSON.stringify(result.regression_reasons)}`,
  );
});

test("P2 — honest-health degraded archive returns tier1_clean=false (CLI will exit 3)", () => {
  // Tier-2A semantic: honest-health failure is Tier-1-not-clean, which the
  // CLI maps to exit 3 (artifact_contract), NOT exit 6. This test pins the
  // function-level contract; the CLI test below pins the routing.
  const dir = mkdtempSync(join(tmpdir(), "tier2a-p2-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: { filesystem_paths: ["/tmp/work/a.txt"] },
  }));
  // Build a candidate whose observation-health is degraded.
  function buildDegradedCandidate() {
    const observationHealth = {
      schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
      run_id: "rc",
      platform: "linux",
      kernel_layer: "degraded",
      ringbuf_drops: 0,
      policy_layer: "present",
      sdk_layer: "self_reported",
      cgroup_correlation: "clean",
      notes: [],
    };
    const correlationReport = {
      schema: RUNNER_CORRELATION_REPORT_SCHEMA,
      run_id: "rc",
      status: "clean",
      bindings: [],
      ambiguities: [],
    };
    const surface = {
      schema: RUNNER_CAPABILITY_SURFACE_SCHEMA,
      run_id: "rc",
      filesystem_paths: ["/tmp/work/a.txt"],
      network_endpoints: [],
      process_execs: [],
      mcp_tools: [],
      policy_decisions: [],
    };
    const fileBytes = new Map();
    fileBytes.set(
      RUNNER_OBSERVATION_HEALTH_PATH,
      Buffer.from(JSON.stringify(observationHealth), "utf8"),
    );
    fileBytes.set(
      RUNNER_CORRELATION_REPORT_PATH,
      Buffer.from(JSON.stringify(correlationReport), "utf8"),
    );
    fileBytes.set(
      RUNNER_CAPABILITY_SURFACE_PATH,
      Buffer.from(JSON.stringify(surface), "utf8"),
    );
    const files = {};
    for (const [p, b] of fileBytes) {
      files[p] = { path: p, sha256: `sha256:${sha256Hex(b)}`, bytes: b.byteLength };
    }
    const manifest = {
      schema: RUNNER_ARCHIVE_MANIFEST_SCHEMA,
      run_id: "rc",
      files,
    };
    const entries = [
      [RUNNER_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest), "utf8")],
    ];
    for (const [p, b] of fileBytes) entries.push([p, b]);
    return buildTarGz(entries);
  }
  const candidate = writeArchive(dir, "c.tar.gz", buildDegradedCandidate());
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  assert.equal(result.tier1_clean, false);
  assert.equal(result.has_regressions, true);
  assert.ok(result.regression_reasons.includes("tier1_validation_failed"));
});

// ---------------------------------------------------------------------------
// CLI exit-code routing tests (P2 + P3)
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { join as pathJoin } from "node:path";

const CLI_DIST = pathJoin(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..", "dist", "cli.js");

function runCli(args) {
  return spawnSync(process.execPath, [CLI_DIST, ...args], { encoding: "utf8" });
}

test("CLI P2 — `runner compare` exits 3 (artifact_contract) for honest-health degraded input", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-p2-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: { filesystem_paths: ["/tmp/work/a.txt"] },
  }));
  function buildDegraded() {
    const observationHealth = {
      schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
      run_id: "rc",
      platform: "linux",
      kernel_layer: "complete",
      ringbuf_drops: 9, // degraded
      policy_layer: "present",
      sdk_layer: "self_reported",
      cgroup_correlation: "clean",
      notes: [],
    };
    const correlationReport = {
      schema: RUNNER_CORRELATION_REPORT_SCHEMA,
      run_id: "rc",
      status: "clean",
      bindings: [],
      ambiguities: [],
    };
    const surface = {
      schema: RUNNER_CAPABILITY_SURFACE_SCHEMA,
      run_id: "rc",
      filesystem_paths: ["/tmp/work/a.txt"],
      network_endpoints: [],
      process_execs: [],
      mcp_tools: [],
      policy_decisions: [],
    };
    const fb = new Map();
    fb.set(RUNNER_OBSERVATION_HEALTH_PATH, Buffer.from(JSON.stringify(observationHealth), "utf8"));
    fb.set(RUNNER_CORRELATION_REPORT_PATH, Buffer.from(JSON.stringify(correlationReport), "utf8"));
    fb.set(RUNNER_CAPABILITY_SURFACE_PATH, Buffer.from(JSON.stringify(surface), "utf8"));
    const files = {};
    for (const [p, b] of fb) files[p] = { path: p, sha256: `sha256:${sha256Hex(b)}`, bytes: b.byteLength };
    const manifest = { schema: RUNNER_ARCHIVE_MANIFEST_SCHEMA, run_id: "rc", files };
    const entries = [[RUNNER_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest), "utf8")]];
    for (const [p, b] of fb) entries.push([p, b]);
    return buildTarGz(entries);
  }
  const candidate = writeArchive(dir, "c.tar.gz", buildDegraded());
  const out = runCli(["runner", "compare", "--baseline", baseline, "--candidate", candidate, "--format", "json"]);
  assert.equal(out.status, 3, `expected exit 3, got ${out.status}; stderr=${out.stderr}`);
});

test("CLI P2 — `runner compare` exits 0 for two clean identical archives", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-ok-"));
  const surface = { filesystem_paths: ["/tmp/work/a.txt"] };
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({ runId: "rb", capabilitySurface: surface }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({ runId: "rc", capabilitySurface: surface }));
  const out = runCli(["runner", "compare", "--baseline", baseline, "--candidate", candidate, "--format", "json"]);
  assert.equal(out.status, 0, `expected exit 0, got ${out.status}; stderr=${out.stderr}`);
});

test("CLI P2 — `runner compare` exits 6 for genuine capability regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-regression-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: { filesystem_paths: ["/tmp/work/a.txt"] },
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc",
    capabilitySurface: { filesystem_paths: ["/tmp/work/a.txt", "/tmp/work/b.txt"] },
  }));
  const out = runCli(["runner", "compare", "--baseline", baseline, "--candidate", candidate, "--format", "json"]);
  assert.equal(out.status, 6, `expected exit 6, got ${out.status}; stderr=${out.stderr}`);
});

test("CLI P3 — `runner compare` exits 2 when baseline has a non-archive extension", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-p3-"));
  const ndjsonPath = join(dir, "baseline.ndjson");
  writeFileSync(ndjsonPath, '{"type":"x"}\n');
  const archivePath = writeArchive(dir, "candidate.tar.gz", buildArchive({
    runId: "rc", capabilitySurface: {},
  }));
  const out = runCli(["runner", "compare", "--baseline", ndjsonPath, "--candidate", archivePath]);
  assert.equal(out.status, 2, `expected exit 2 (config_error) for non-archive baseline, got ${out.status}; stderr=${out.stderr}`);
  assert.match(out.stderr, /not a Runner archive/);
});

test("CLI P3 — `runner compare` exits 2 when candidate has a non-archive extension", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-p3b-"));
  const archivePath = writeArchive(dir, "baseline.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: {},
  }));
  const txtPath = join(dir, "candidate.txt");
  writeFileSync(txtPath, "not an archive");
  const out = runCli(["runner", "compare", "--baseline", archivePath, "--candidate", txtPath]);
  assert.equal(out.status, 2, `expected exit 2 (config_error) for non-archive candidate, got ${out.status}; stderr=${out.stderr}`);
  assert.match(out.stderr, /not a Runner archive/);
});

// ---------------------------------------------------------------------------
// PR #60 review (second pass): Copilot findings 2, 3, 4, 5
// ---------------------------------------------------------------------------

test("Copilot 2 — diffStringSets deduplicates inputs and does not inflate added counts", () => {
  // Build two surfaces with duplicate entries on each side. The diff
  // should treat each value as a set member, not a multiset member.
  const dir = mkdtempSync(join(tmpdir(), "tier2a-dedupe-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb",
    capabilitySurface: {
      filesystem_paths: ["/tmp/work/a.txt", "/tmp/work/a.txt", "/tmp/work/b.txt"],
    },
  }));
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc",
    capabilitySurface: {
      filesystem_paths: ["/tmp/work/a.txt", "/tmp/work/c.txt", "/tmp/work/c.txt"],
    },
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  // After dedupe: base = {a,b}, cand = {a,c}. So added={c}, removed={b}, unchanged={a}.
  assert.deepEqual(result.capability_surface.filesystem_paths.added, ["/tmp/work/c.txt"]);
  assert.deepEqual(result.capability_surface.filesystem_paths.removed, ["/tmp/work/b.txt"]);
  assert.deepEqual(result.capability_surface.filesystem_paths.unchanged, ["/tmp/work/a.txt"]);
  // Regression reason reflects the unique count, not the raw input length.
  assert.ok(result.regression_reasons.includes("filesystem_paths_added:1"));
});

test("Copilot 4 — markdown status reads TIER-2A SKIPPED for Tier-1-fail (not REGRESSION)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier2a-status-fail-"));
  const baseline = join(dir, "baseline.tar.gz");
  writeFileSync(baseline, "not a gzip");
  const candidate = writeArchive(dir, "c.tar.gz", buildArchive({
    runId: "rc", capabilitySurface: {},
  }));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  const md = formatRunnerCompareResult(result);
  assert.match(md, /\*\*Status:\*\* TIER-2A SKIPPED/);
  assert.doesNotMatch(md, /\*\*Status:\*\* RUNNER CAPABILITY REGRESSION/);
});

test("Copilot 4 — markdown status reads TIER-2A SKIPPED for missing capability-surface", () => {
  // Build Tier-1-clean archives with no capability-surface in the manifest.
  const dir = mkdtempSync(join(tmpdir(), "tier2a-status-nocap-"));
  function buildMinimal(runId) {
    const obs = {
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
    const corr = {
      schema: RUNNER_CORRELATION_REPORT_SCHEMA,
      run_id: runId,
      status: "clean",
      bindings: [],
      ambiguities: [],
    };
    const fb = new Map();
    fb.set(RUNNER_OBSERVATION_HEALTH_PATH, Buffer.from(JSON.stringify(obs), "utf8"));
    fb.set(RUNNER_CORRELATION_REPORT_PATH, Buffer.from(JSON.stringify(corr), "utf8"));
    const files = {};
    for (const [p, b] of fb) files[p] = { path: p, sha256: `sha256:${sha256Hex(b)}`, bytes: b.byteLength };
    const manifest = { schema: RUNNER_ARCHIVE_MANIFEST_SCHEMA, run_id: runId, files };
    const entries = [[RUNNER_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest), "utf8")]];
    for (const [p, b] of fb) entries.push([p, b]);
    return buildTarGz(entries);
  }
  const baseline = writeArchive(dir, "b.tar.gz", buildMinimal("rb"));
  const candidate = writeArchive(dir, "c.tar.gz", buildMinimal("rc"));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  const md = formatRunnerCompareResult(result);
  assert.equal(result.tier1_clean, true);
  assert.equal(result.capability_surface, undefined);
  assert.match(md, /\*\*Status:\*\* TIER-2A SKIPPED/);
});

test("Copilot 5 — Tier-1-fail markdown includes artifact_parse_errors when present", () => {
  // Construct a candidate whose observation-health.json has a wrong schema
  // string. That makes Tier 1 honest-health gate fail (observation_health
  // is undefined) but the manifest_errors stay empty — instead the
  // artifact_parse_errors carry the actionable detail. The Tier-1-not-clean
  // markdown section must surface it.
  const dir = mkdtempSync(join(tmpdir(), "tier2a-md-parse-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildArchive({
    runId: "rb", capabilitySurface: {},
  }));
  function buildBadObsSchema(runId) {
    const obs = {
      schema: "wrong.observation.schema.v9",
      run_id: runId,
      platform: "linux",
      kernel_layer: "complete",
      ringbuf_drops: 0,
      policy_layer: "present",
      sdk_layer: "self_reported",
      cgroup_correlation: "clean",
      notes: [],
    };
    const corr = {
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
  const candidate = writeArchive(dir, "c.tar.gz", buildBadObsSchema("rc"));
  const result = compareRunnerArchivesCapabilitySurface(baseline, candidate);
  const md = formatRunnerCompareResult(result);
  assert.equal(result.tier1_clean, false);
  // Candidate side has at least one artifact_parse_error.
  assert.ok(result.candidate.artifact_parse_errors.length > 0);
  // Markdown must surface it.
  assert.match(md, /Artifact parse errors:/);
  assert.match(md, /OBSERVATION_HEALTH_SCHEMA_MISMATCH/);
});
