import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  checkHonestHealth,
  detectInputMode,
  RUNNER_ARCHIVE_MANIFEST_SCHEMA,
  RUNNER_CORRELATION_REPORT_PATH,
  RUNNER_CORRELATION_REPORT_SCHEMA,
  RUNNER_MANIFEST_PATH,
  RUNNER_OBSERVATION_HEALTH_PATH,
  RUNNER_OBSERVATION_HEALTH_SCHEMA,
  validateRunnerArchive,
} from "../dist/runner_archive.js";
import {
  compareRunnerArchivesTier1,
  formatRunnerCompareTier1Result,
} from "../dist/compare.js";

// ---------------------------------------------------------------------------
// Minimal in-test ustar tarball writer.
//
// Produces just enough of the tar format to exercise the harness's reader:
// regular-file entries (typeflag '0'), standard ustar headers, two
// trailing zero blocks. The deterministic-mode output of the Rust `tar`
// crate that Runner uses is compatible with this subset.
// ---------------------------------------------------------------------------

const BLOCK = 512;

/**
 * Build one 512-byte ustar header for a regular file.
 *
 * @param {string} name  in-archive path
 * @param {number} size  file size in bytes
 */
function buildHeader(name, size) {
  const header = Buffer.alloc(BLOCK);
  writeField(header, name, 0, 100);
  writeField(header, octal(0o644, 7) + "\0", 100, 8);
  writeField(header, octal(0, 7) + "\0", 108, 8);
  writeField(header, octal(0, 7) + "\0", 116, 8);
  writeField(header, octal(size, 11) + "\0", 124, 12);
  writeField(header, octal(0, 11) + "\0", 136, 12);
  // Checksum field starts as eight spaces; computed below.
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header[156] = 0x30; // typeflag '0' for regular file
  // ustar magic + version
  writeField(header, "ustar", 257, 6);
  header[262] = 0; // NUL terminator for magic
  header[263] = 0x30; header[264] = 0x30; // version "00"

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
  // remaining bytes in buf are already 0
}

function octal(n, width) {
  return n.toString(8).padStart(width, "0");
}

/**
 * Build a `.tar.gz` buffer from {path -> bytes} entries.
 */
function buildTarGz(entries) {
  const chunks = [];
  for (const [path, body] of entries) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    chunks.push(buildHeader(path, data.byteLength));
    chunks.push(data);
    const pad = (BLOCK - (data.byteLength % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK)); // two empty blocks = end of archive
  chunks.push(Buffer.alloc(BLOCK));
  const tarBuf = Buffer.concat(chunks);
  return gzipSync(tarBuf);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixture builder — synthesises a well-formed Runner archive in memory.
// ---------------------------------------------------------------------------

function buildCleanArchive({
  runId = "run_test_clean",
  observationHealthOverride = null,
  correlationReportOverride = null,
  omit = [], // array of paths to omit (to simulate missing files)
  corruptDigest = null, // string path whose digest will be flipped
} = {}) {
  const observationHealth = observationHealthOverride ?? {
    schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
    run_id: runId,
    platform: "linux",
    kernel_layer: "complete",
    ringbuf_drops: 0,
    policy_layer: "present",
    sdk_layer: "self_reported",
    cgroup_correlation: "clean",
    notes: ["test_fixture"],
  };
  const correlationReport = correlationReportOverride ?? {
    schema: RUNNER_CORRELATION_REPORT_SCHEMA,
    run_id: runId,
    status: "clean",
    bindings: [],
    ambiguities: [],
  };
  const capabilitySurface = {
    schema: "assay.runner.capability_surface.v0",
    run_id: runId,
    filesystem_paths: [],
    network_endpoints: [],
    process_execs: [],
    mcp_tools: [],
    policy_decisions: [],
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
    "capability-surface.json",
    Buffer.from(JSON.stringify(capabilitySurface, null, 2), "utf8"),
  );
  fileBytes.set("events.ndjson", Buffer.from("", "utf8"));
  fileBytes.set("layers/kernel.ndjson", Buffer.from("", "utf8"));
  fileBytes.set("layers/policy.ndjson", Buffer.from("", "utf8"));
  fileBytes.set("layers/sdk.ndjson", Buffer.from("", "utf8"));

  const files = {};
  for (const [path, bytes] of fileBytes) {
    files[path] = {
      path,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    };
  }

  const manifest = {
    schema: RUNNER_ARCHIVE_MANIFEST_SCHEMA,
    run_id: runId,
    files,
  };

  const entries = [];
  entries.push([
    RUNNER_MANIFEST_PATH,
    Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
  ]);
  for (const [path, bytes] of fileBytes) {
    if (omit.includes(path)) continue;
    if (corruptDigest === path) {
      // Flip the last byte so the digest no longer matches.
      const corrupted = Buffer.from(bytes);
      corrupted[corrupted.byteLength - 1] = corrupted[corrupted.byteLength - 1] ^ 0x01;
      entries.push([path, corrupted]);
    } else {
      entries.push([path, bytes]);
    }
  }

  return buildTarGz(entries);
}

function writeArchive(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

// ---------------------------------------------------------------------------
// detectInputMode (H6)
// ---------------------------------------------------------------------------

test("detectInputMode classifies a clean Runner archive as runner_archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-detect-"));
  const archivePath = writeArchive(dir, "clean.tar.gz", buildCleanArchive());
  assert.equal(detectInputMode(archivePath), "runner_archive");
});

test("detectInputMode returns ndjson_evidence for .ndjson files", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-detect-"));
  const path = join(dir, "evidence.ndjson");
  writeFileSync(path, '{"type":"x"}\n');
  assert.equal(detectInputMode(path), "ndjson_evidence");
});

test("detectInputMode returns unknown for a .tar.gz with a non-Runner manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-detect-"));
  const fakeManifest = Buffer.from(
    JSON.stringify({ schema: "some.other.schema.v0", run_id: "x", files: {} }),
    "utf8",
  );
  const archive = buildTarGz([[RUNNER_MANIFEST_PATH, fakeManifest]]);
  const archivePath = writeArchive(dir, "fake.tar.gz", archive);
  assert.equal(detectInputMode(archivePath), "unknown");
});

test("detectInputMode returns unknown for unrecognised extensions", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-detect-"));
  const path = join(dir, "thing.txt");
  writeFileSync(path, "not an evidence file");
  assert.equal(detectInputMode(path), "unknown");
});

// ---------------------------------------------------------------------------
// validateRunnerArchive (H1)
// ---------------------------------------------------------------------------

test("validateRunnerArchive accepts a clean fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-validate-"));
  const archivePath = writeArchive(dir, "clean.tar.gz", buildCleanArchive());
  const result = validateRunnerArchive(archivePath);
  assert.equal(result.recognised, true);
  assert.equal(result.manifest_valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.manifest?.schema, RUNNER_ARCHIVE_MANIFEST_SCHEMA);
  assert.equal(result.manifest?.run_id, "run_test_clean");
  assert.equal(result.observation_health?.kernel_layer, "complete");
  assert.equal(result.correlation_report?.status, "clean");
});

test("validateRunnerArchive flags a missing file from the manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-validate-"));
  const archivePath = writeArchive(
    dir,
    "missing.tar.gz",
    buildCleanArchive({ omit: ["layers/sdk.ndjson"] }),
  );
  const result = validateRunnerArchive(archivePath);
  assert.equal(result.recognised, true);
  assert.equal(result.manifest_valid, false);
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes("FILE_MISSING"), `expected FILE_MISSING in ${codes}`);
});

test("validateRunnerArchive flags a digest mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-validate-"));
  // observation-health.json is non-empty in the fixture, so a one-bit flip
  // produces a real digest mismatch (corrupting an empty layer ndjson would
  // be a no-op since the buffer has no last byte to flip).
  const archivePath = writeArchive(
    dir,
    "corrupt.tar.gz",
    buildCleanArchive({ corruptDigest: RUNNER_OBSERVATION_HEALTH_PATH }),
  );
  const result = validateRunnerArchive(archivePath);
  assert.equal(result.recognised, true);
  assert.equal(result.manifest_valid, false);
  const codes = result.errors.map((e) => e.code);
  assert.ok(
    codes.includes("FILE_DIGEST_MISMATCH"),
    `expected FILE_DIGEST_MISMATCH in ${codes}`,
  );
});

test("validateRunnerArchive rejects a manifest with the wrong schema string", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-validate-"));
  const fakeManifest = Buffer.from(
    JSON.stringify({
      schema: "not.the.runner.manifest.v0",
      run_id: "x",
      files: {},
    }),
    "utf8",
  );
  const archive = buildTarGz([[RUNNER_MANIFEST_PATH, fakeManifest]]);
  const archivePath = writeArchive(dir, "wrongschema.tar.gz", archive);
  const result = validateRunnerArchive(archivePath);
  assert.equal(result.recognised, false);
  assert.equal(result.manifest_valid, false);
  assert.equal(result.errors[0].code, "MANIFEST_SCHEMA_MISMATCH");
});

test("validateRunnerArchive surfaces a non-gzip file as ARCHIVE_UNREADABLE", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-validate-"));
  const path = join(dir, "notgzip.tar.gz");
  writeFileSync(path, "definitely not a gzip stream");
  const result = validateRunnerArchive(path);
  assert.equal(result.recognised, false);
  assert.equal(result.manifest_valid, false);
  assert.equal(result.errors[0].code, "ARCHIVE_UNREADABLE");
});

// ---------------------------------------------------------------------------
// checkHonestHealth (H2)
// ---------------------------------------------------------------------------

test("checkHonestHealth passes on a clean validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-health-"));
  const archivePath = writeArchive(dir, "clean.tar.gz", buildCleanArchive());
  const validation = validateRunnerArchive(archivePath);
  const verdict = checkHonestHealth(validation);
  assert.equal(verdict.passed, true);
  assert.deepEqual(verdict.reasons, []);
});

test("checkHonestHealth fails on degraded kernel_layer", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-health-"));
  const archivePath = writeArchive(
    dir,
    "degraded.tar.gz",
    buildCleanArchive({
      observationHealthOverride: {
        schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
        run_id: "run_test_degraded",
        platform: "linux",
        kernel_layer: "degraded",
        ringbuf_drops: 0,
        policy_layer: "present",
        sdk_layer: "self_reported",
        cgroup_correlation: "clean",
        notes: [],
      },
    }),
  );
  const validation = validateRunnerArchive(archivePath);
  const verdict = checkHonestHealth(validation);
  assert.equal(verdict.passed, false);
  assert.ok(
    verdict.reasons.some((r) => r.startsWith("kernel_layer_not_complete")),
    `expected kernel_layer_not_complete in ${JSON.stringify(verdict.reasons)}`,
  );
});

test("checkHonestHealth fails on non-zero ringbuf_drops", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-health-"));
  const archivePath = writeArchive(
    dir,
    "drops.tar.gz",
    buildCleanArchive({
      observationHealthOverride: {
        schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
        run_id: "run_test_drops",
        platform: "linux",
        kernel_layer: "complete",
        ringbuf_drops: 7,
        policy_layer: "present",
        sdk_layer: "self_reported",
        cgroup_correlation: "clean",
        notes: [],
      },
    }),
  );
  const validation = validateRunnerArchive(archivePath);
  const verdict = checkHonestHealth(validation);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.reasons.some((r) => r.startsWith("ringbuf_drops_nonzero")));
});

test("checkHonestHealth fails on non-clean correlation status", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-health-"));
  const archivePath = writeArchive(
    dir,
    "partial.tar.gz",
    buildCleanArchive({
      correlationReportOverride: {
        schema: RUNNER_CORRELATION_REPORT_SCHEMA,
        run_id: "run_test_partial",
        status: "partial",
        bindings: [],
        ambiguities: ["one_unbound_tool_call"],
      },
    }),
  );
  const validation = validateRunnerArchive(archivePath);
  const verdict = checkHonestHealth(validation);
  assert.equal(verdict.passed, false);
  assert.ok(
    verdict.reasons.some((r) => r === "correlation_status_not_clean:partial"),
  );
});

test("checkHonestHealth with allow_degraded still surfaces reasons but passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-health-"));
  const archivePath = writeArchive(
    dir,
    "drops.tar.gz",
    buildCleanArchive({
      observationHealthOverride: {
        schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
        run_id: "run_test_drops",
        platform: "linux",
        kernel_layer: "complete",
        ringbuf_drops: 3,
        policy_layer: "present",
        sdk_layer: "self_reported",
        cgroup_correlation: "clean",
        notes: [],
      },
    }),
  );
  const validation = validateRunnerArchive(archivePath);
  const verdict = checkHonestHealth(validation, { allow_degraded: true });
  assert.equal(verdict.passed, true);
  assert.ok(verdict.reasons.some((r) => r.startsWith("ringbuf_drops_nonzero")));
});

// ---------------------------------------------------------------------------
// compareRunnerArchivesTier1 (H6 + H1 + H2 wired together)
// ---------------------------------------------------------------------------

test("compareRunnerArchivesTier1 reports TIER-1 OK when both archives are clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-compare-"));
  const baseline = writeArchive(dir, "baseline.tar.gz", buildCleanArchive({ runId: "run_baseline" }));
  const candidate = writeArchive(
    dir,
    "candidate.tar.gz",
    buildCleanArchive({ runId: "run_candidate" }),
  );
  const result = compareRunnerArchivesTier1(baseline, candidate);
  assert.equal(result.mode, "runner_archive");
  assert.equal(result.tier2_diff_implemented, false);
  assert.equal(result.has_regressions, false);
  assert.match(result.summary, /TIER-1 OK/);
  assert.equal(result.baseline.run_id, "run_baseline");
  assert.equal(result.candidate.run_id, "run_candidate");
});

test("compareRunnerArchivesTier1 fails when candidate is degraded", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-compare-"));
  const baseline = writeArchive(dir, "baseline.tar.gz", buildCleanArchive());
  const candidate = writeArchive(
    dir,
    "degraded-candidate.tar.gz",
    buildCleanArchive({
      observationHealthOverride: {
        schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
        run_id: "run_test_clean",
        platform: "linux",
        kernel_layer: "degraded",
        ringbuf_drops: 0,
        policy_layer: "present",
        sdk_layer: "self_reported",
        cgroup_correlation: "clean",
        notes: [],
      },
    }),
  );
  const result = compareRunnerArchivesTier1(baseline, candidate);
  assert.equal(result.has_regressions, true);
  assert.match(result.summary, /TIER-1 FAIL/);
  assert.equal(result.candidate.honest_health_passed, false);
  assert.equal(result.baseline.honest_health_passed, true);
});

test("formatRunnerCompareTier1Result emits markdown including run ids and tier-2 notice", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-format-"));
  const baseline = writeArchive(dir, "b.tar.gz", buildCleanArchive({ runId: "rid_b" }));
  const candidate = writeArchive(dir, "c.tar.gz", buildCleanArchive({ runId: "rid_c" }));
  const md = formatRunnerCompareTier1Result(
    compareRunnerArchivesTier1(baseline, candidate),
  );
  assert.match(md, /# Runner Archive Comparison \(Tier 1\)/);
  assert.match(md, /Structural diff.*Tier 2/);
  assert.match(md, /rid_b/);
  assert.match(md, /rid_c/);
});
