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
