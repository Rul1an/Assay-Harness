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

function sha256Prefixed(bytes) {
  // Matches the on-the-wire format produced by Rul1an/assay's runner core,
  // see `crates/assay-runner-core/src/archive.rs::sha256_prefixed`.
  return `sha256:${sha256Hex(bytes)}`;
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
  extraFiles = null, // map of in-archive path -> bytes; not listed in manifest
  digestFormatOverride = null, // string path -> raw-hex (no sha256: prefix)
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
    const rawHex = sha256Hex(bytes);
    files[path] = {
      path,
      // Real Runner archives use `sha256:<hex>`. Tests use the same format
      // so the validator's digest-format check exercises the production path.
      sha256:
        digestFormatOverride && digestFormatOverride === path
          ? rawHex
          : `sha256:${rawHex}`,
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
  // Extra files NOT listed in the manifest, used to test that the validator
  // rejects archive content that the manifest does not account for.
  if (extraFiles) {
    for (const [path, bytes] of Object.entries(extraFiles)) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
      entries.push([path, buf]);
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

test("detectInputMode classifies any .tar.gz by extension (validator surfaces content errors)", () => {
  // detectInputMode is purely extension-based so that corrupted or non-Runner
  // .tar.gz files still route to validateRunnerArchive (which then surfaces
  // a structural error with the documented exit code), instead of being
  // misclassified as 'unknown' and falling back to config_error.
  const dir = mkdtempSync(join(tmpdir(), "runner-detect-"));
  const fakeManifest = Buffer.from(
    JSON.stringify({ schema: "some.other.schema.v0", run_id: "x", files: {} }),
    "utf8",
  );
  const archive = buildTarGz([[RUNNER_MANIFEST_PATH, fakeManifest]]);
  const archivePath = writeArchive(dir, "fake.tar.gz", archive);
  assert.equal(detectInputMode(archivePath), "runner_archive");
  // Validator catches the content problem.
  const v = validateRunnerArchive(archivePath);
  assert.equal(v.recognised, false);
  assert.equal(v.manifest_errors[0].code, "MANIFEST_SCHEMA_MISMATCH");
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
  assert.deepEqual(result.manifest_errors, []);
  assert.deepEqual(result.artifact_parse_errors, []);
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
  const codes = result.manifest_errors.map((e) => e.code);
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
  const codes = result.manifest_errors.map((e) => e.code);
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
  assert.equal(result.manifest_errors[0].code, "MANIFEST_SCHEMA_MISMATCH");
});

test("validateRunnerArchive surfaces a non-gzip file as ARCHIVE_UNREADABLE", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-validate-"));
  const path = join(dir, "notgzip.tar.gz");
  writeFileSync(path, "definitely not a gzip stream");
  const result = validateRunnerArchive(path);
  assert.equal(result.recognised, false);
  assert.equal(result.manifest_valid, false);
  assert.equal(result.manifest_errors[0].code, "ARCHIVE_UNREADABLE");
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

// ---------------------------------------------------------------------------
// Regression coverage for review findings on PR #59
// ---------------------------------------------------------------------------

test("validateRunnerArchive accepts real-style sha256: prefixed digests (PR #59 P1)", () => {
  // Sanity check that the fixture builder uses `sha256:<hex>` and the
  // validator accepts that format. This pins the on-the-wire format
  // produced by Rul1an/assay's runner core
  // (`crates/assay-runner-core/src/archive.rs::sha256_prefixed`). Pre-fix
  // the validator compared against raw hex and would reject every real
  // archive.
  const dir = mkdtempSync(join(tmpdir(), "runner-prefix-"));
  const archivePath = writeArchive(dir, "clean.tar.gz", buildCleanArchive());
  const result = validateRunnerArchive(archivePath);
  assert.equal(result.manifest_valid, true);
  // Spot-check one entry's recorded digest carries the prefix.
  const someDigest = Object.values(result.manifest.files)[0].sha256;
  assert.ok(someDigest.startsWith("sha256:"), `expected sha256: prefix, got ${someDigest}`);
});

test("validateRunnerArchive rejects raw-hex digest (missing sha256: prefix)", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-prefix-"));
  const archivePath = writeArchive(
    dir,
    "rawhex.tar.gz",
    buildCleanArchive({ digestFormatOverride: RUNNER_OBSERVATION_HEALTH_PATH }),
  );
  const result = validateRunnerArchive(archivePath);
  assert.equal(result.manifest_valid, false);
  const codes = result.manifest_errors.map((e) => e.code);
  assert.ok(
    codes.includes("MANIFEST_ENTRY_DIGEST_FORMAT_INVALID"),
    `expected MANIFEST_ENTRY_DIGEST_FORMAT_INVALID in ${codes}`,
  );
});

test("validateRunnerArchive flags an extra archive file not listed in manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-extra-"));
  const archivePath = writeArchive(
    dir,
    "extra.tar.gz",
    buildCleanArchive({ extraFiles: { "extra/secret.txt": "not in manifest" } }),
  );
  const result = validateRunnerArchive(archivePath);
  assert.equal(result.manifest_valid, false);
  const codes = result.manifest_errors.map((e) => e.code);
  assert.ok(
    codes.includes("FILE_NOT_IN_MANIFEST"),
    `expected FILE_NOT_IN_MANIFEST in ${codes}`,
  );
});

test("validateRunnerArchive separates artifact_parse_errors from manifest_errors (PR #59 Copilot)", () => {
  // An archive whose observation-health.json schema string is wrong: the
  // manifest + digests are still valid (we recompute the digest after
  // overriding the parsed JSON in-band? No — easier path: build a fixture
  // whose observation-health body has the wrong schema string, and pin
  // both byte count and digest against that bad body. The validator
  // should report a non-empty artifact_parse_errors but keep
  // manifest_valid === true because manifest + digests still line up.
  const dir = mkdtempSync(join(tmpdir(), "runner-split-"));
  const archivePath = writeArchive(
    dir,
    "wrongobsschema.tar.gz",
    buildCleanArchive({
      observationHealthOverride: {
        // valid JSON, wrong schema string
        schema: "wrong.observation_health.schema.v9",
        run_id: "rid",
        platform: "linux",
        kernel_layer: "complete",
        ringbuf_drops: 0,
        policy_layer: "present",
        sdk_layer: "self_reported",
        cgroup_correlation: "clean",
        notes: [],
      },
    }),
  );
  const result = validateRunnerArchive(archivePath);
  // Manifest itself is fine — the body still hashes correctly against
  // whatever bytes we wrote.
  assert.equal(result.manifest_valid, true);
  assert.deepEqual(result.manifest_errors, []);
  // The artifact parse error is captured separately.
  const parseCodes = result.artifact_parse_errors.map((e) => e.code);
  assert.ok(
    parseCodes.includes("OBSERVATION_HEALTH_SCHEMA_MISMATCH"),
    `expected OBSERVATION_HEALTH_SCHEMA_MISMATCH in ${parseCodes}`,
  );
  // observation_health stays undefined.
  assert.equal(result.observation_health, undefined);
});

test("checkHonestHealth allow_degraded does NOT bypass structural failures (PR #59 P2)", () => {
  // Force a structural failure (manifest invalid) and verify that
  // allow_degraded leaves passed === false. Pre-fix the gate would have
  // returned passed === true, contradicting validation.manifest_valid.
  const dir = mkdtempSync(join(tmpdir(), "runner-struct-"));
  const archivePath = writeArchive(
    dir,
    "missing.tar.gz",
    buildCleanArchive({ omit: [RUNNER_OBSERVATION_HEALTH_PATH] }),
  );
  const validation = validateRunnerArchive(archivePath);
  assert.equal(validation.manifest_valid, false);
  const verdict = checkHonestHealth(validation, { allow_degraded: true });
  assert.equal(verdict.passed, false);
  assert.ok(verdict.structural_reasons.length > 0);
});

test("checkHonestHealth allow_degraded bypasses ONLY measurement-health reasons", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-mh-"));
  const archivePath = writeArchive(
    dir,
    "drops.tar.gz",
    buildCleanArchive({
      observationHealthOverride: {
        schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
        run_id: "rid",
        platform: "linux",
        kernel_layer: "complete",
        ringbuf_drops: 5,
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
  assert.equal(verdict.structural_reasons.length, 0);
  assert.ok(verdict.measurement_health_reasons.some((r) => r.startsWith("ringbuf_drops_nonzero")));
});

test("checkHonestHealth without allow_degraded fails on measurement-health reason", () => {
  // Sanity: same fixture as above, but without allow_degraded the gate
  // fails because there is still a measurement_health reason.
  const dir = mkdtempSync(join(tmpdir(), "runner-mh-"));
  const archivePath = writeArchive(
    dir,
    "drops.tar.gz",
    buildCleanArchive({
      observationHealthOverride: {
        schema: RUNNER_OBSERVATION_HEALTH_SCHEMA,
        run_id: "rid",
        platform: "linux",
        kernel_layer: "complete",
        ringbuf_drops: 5,
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
  assert.equal(verdict.structural_reasons.length, 0);
  assert.ok(verdict.measurement_health_reasons.length > 0);
});
