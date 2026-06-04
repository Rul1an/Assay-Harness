import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCoverageGateSarif,
  buildCoverageProjection,
  COVERAGE_ANNOTATION_SCHEMA,
  evaluateClaim,
  foldCoverageFleet,
  formatCoverageFleet,
  formatCoverageGate,
  formatCoverageReport,
  gateCoverageClaims,
  parseClaimSpec,
  validateCoverageAnnotation,
} from "../dist/runner_coverage.js";

// ---------------------------------------------------------------------------
// Fixture — a realistic coverage annotation
// ---------------------------------------------------------------------------

function buildAnnotation(overrides = {}) {
  return {
    schema: COVERAGE_ANNOTATION_SCHEMA,
    source_report_schema: "assay.runner.runtime_drift.v0.2",
    claim_cells: [
      {
        schema: "assay.observability.claim_class_cell.v0",
        claim_type: "measured_filesystem_paths_touched_drift",
        artifact_role: "joined_artifacts",
        claim_strength: "partial",
        claim_basis: "measured",
      },
      {
        schema: "assay.observability.claim_class_cell.v0",
        claim_type: "exhaustive_filesystem_paths_touched_equality",
        artifact_role: "joined_artifacts",
        claim_strength: "weak",
        claim_basis: "derived",
      },
      {
        schema: "assay.observability.claim_class_cell.v0",
        claim_type: "measured_network_endpoints_drift",
        artifact_role: "none",
        claim_strength: "absent",
        claim_basis: "measured",
      },
    ],
    blocked_claims: [
      {
        claim_type: "bounded_negative_claim",
        requested_claim: "no_filesystem_paths_touched_effect_beyond_observed",
        decision: "blocked",
        reason: "completeness is open_syscall_only; blind spots: rename, unlink",
      },
    ],
    classification_caveats: [],
    ...overrides,
  };
}

function validAnnotation() {
  const v = validateCoverageAnnotation(buildAnnotation());
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  return v.annotation;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validateCoverageAnnotation accepts a well-formed annotation", () => {
  const v = validateCoverageAnnotation(buildAnnotation());
  assert.equal(v.valid, true);
  assert.equal(v.annotation.claim_cells.length, 3);
});

test("validateCoverageAnnotation rejects wrong schema", () => {
  const v = validateCoverageAnnotation(buildAnnotation({ schema: "other.v0" }));
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "COVERAGE_ANNOTATION_BAD_SCHEMA"));
});

test("validateCoverageAnnotation rejects non-array claim_cells", () => {
  const v = validateCoverageAnnotation(buildAnnotation({ claim_cells: {} }));
  assert.equal(v.valid, false);
});

// ---------------------------------------------------------------------------
// parseClaimSpec
// ---------------------------------------------------------------------------

test("parseClaimSpec parses TYPE:DIMENSION", () => {
  const p = parseClaimSpec("positive:network_endpoints");
  assert.deepEqual([p.ok, p.claim_type, p.dimension], [true, "positive", "network_endpoints"]);
});

test("parseClaimSpec rejects missing colon and bad type", () => {
  assert.equal(parseClaimSpec("positive").ok, false);
  assert.equal(parseClaimSpec("nope:x").ok, false);
  assert.equal(parseClaimSpec("positive:").ok, false);
});

// ---------------------------------------------------------------------------
// evaluateClaim (the honesty gate)
// ---------------------------------------------------------------------------

test("positive permitted on a measured partial cell", () => {
  const r = evaluateClaim(validAnnotation(), "positive", "filesystem_paths_touched");
  assert.equal(r.permitted, true);
});

test("positive blocked when measured is absent", () => {
  const r = evaluateClaim(validAnnotation(), "positive", "network_endpoints");
  assert.equal(r.permitted, false);
});

test("positive blocked when no cell exists", () => {
  const r = evaluateClaim(validAnnotation(), "positive", "process_execs");
  assert.equal(r.permitted, false);
});

test("exhaustive blocked when coverage-degraded to weak", () => {
  const r = evaluateClaim(validAnnotation(), "exhaustive", "filesystem_paths_touched");
  assert.equal(r.permitted, false);
});

test("bounded_negative blocked by descriptor", () => {
  const r = evaluateClaim(validAnnotation(), "bounded_negative", "filesystem_paths_touched");
  assert.equal(r.permitted, false);
});

test("bounded_negative not evaluable for a non-measured dimension", () => {
  const r = evaluateClaim(validAnnotation(), "bounded_negative", "tool_calls");
  assert.equal(r.permitted, false);
  assert.match(r.detail, /non-measured/);
});

test("bounded_negative permitted when measured and unblocked", () => {
  const r = evaluateClaim(validAnnotation(), "bounded_negative", "network_endpoints");
  assert.equal(r.permitted, true);
});

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

test("gate passes when all asserted claims are permitted", () => {
  const res = gateCoverageClaims(validAnnotation(), ["positive:filesystem_paths_touched"]);
  assert.equal(res.ok, true);
  assert.equal(res.gate.passed, true);
});

test("gate fails when any asserted claim is blocked", () => {
  const res = gateCoverageClaims(validAnnotation(), [
    "positive:filesystem_paths_touched",
    "positive:network_endpoints",
    "exhaustive:filesystem_paths_touched",
  ]);
  assert.equal(res.gate.passed, false);
  assert.equal(res.gate.results[0].permitted, true);
  assert.equal(res.gate.results[1].permitted, false);
});

test("gate reports a bad claim spec as a config error (ok=false)", () => {
  const res = gateCoverageClaims(validAnnotation(), ["bogus:x"]);
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------------------
// projection + formatting
// ---------------------------------------------------------------------------

test("buildCoverageProjection sorts cells and blocked claims deterministically", () => {
  const p = buildCoverageProjection(validAnnotation());
  const types = p.claim_cells.map((c) => c.claim_type);
  assert.deepEqual(types, [...types].sort((a, b) => a.localeCompare(b)));
  assert.equal(p.blocked_claims.length, 1);
});

test("formatCoverageReport markdown contains the strength x basis table", () => {
  const out = formatCoverageReport(buildCoverageProjection(validAnnotation()), "markdown");
  assert.match(out, /Claim cells \(strength × basis\)/);
  assert.match(out, /measured_filesystem_paths_touched_drift \| partial \| measured/);
});

test("formatCoverageGate text ends with PASS/FAIL", () => {
  const pass = gateCoverageClaims(validAnnotation(), ["positive:filesystem_paths_touched"]).gate;
  assert.match(formatCoverageGate(pass, "text").trim(), /PASS$/);
  const fail = gateCoverageClaims(validAnnotation(), ["positive:network_endpoints"]).gate;
  assert.match(formatCoverageGate(fail, "text").trim(), /FAIL$/);
});

test("SARIF lists only blocked claims as error results", () => {
  const gate = gateCoverageClaims(validAnnotation(), [
    "positive:filesystem_paths_touched",
    "positive:network_endpoints",
  ]).gate;
  const sarif = buildCoverageGateSarif(gate);
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].results.length, 1);
  assert.equal(sarif.runs[0].results[0].level, "error");
});

// ---------------------------------------------------------------------------
// Fleet fold
// ---------------------------------------------------------------------------

test("foldCoverageFleet floor is the weakest level across runs", () => {
  // run A: filesystem partial; run B: filesystem missing (no positive cell).
  const runA = buildAnnotation({
    claim_cells: [
      {
        claim_type: "measured_filesystem_paths_touched_drift",
        claim_strength: "partial",
        claim_basis: "measured",
      },
    ],
    blocked_claims: [],
  });
  const runB = buildAnnotation({
    claim_cells: [
      {
        claim_type: "measured_network_endpoints_drift",
        claim_strength: "partial",
        claim_basis: "measured",
      },
    ],
    blocked_claims: [],
  });
  const a = validateCoverageAnnotation(runA).annotation;
  const b = validateCoverageAnnotation(runB).annotation;
  const summary = foldCoverageFleet([a, b]);
  assert.equal(summary.run_count, 2);
  // filesystem observed in one run, missing in the other -> floor missing.
  assert.equal(
    summary.dimensions.filesystem_paths_touched.fleet_positive_floor,
    "missing",
  );
  // network observed at partial in run B only, missing in run A -> floor missing.
  assert.equal(summary.dimensions.network_endpoints.fleet_positive_floor, "missing");
});

test("foldCoverageFleet floor is the weakest observed when all runs observe", () => {
  const strong = validateCoverageAnnotation(
    buildAnnotation({
      claim_cells: [
        { claim_type: "measured_process_execs_drift", claim_strength: "strong", claim_basis: "measured" },
      ],
      blocked_claims: [],
    }),
  ).annotation;
  const absent = validateCoverageAnnotation(
    buildAnnotation({
      claim_cells: [
        { claim_type: "measured_process_execs_drift", claim_strength: "absent", claim_basis: "measured" },
      ],
      blocked_claims: [],
    }),
  ).annotation;
  const summary = foldCoverageFleet([strong, absent]);
  assert.equal(summary.dimensions.process_execs.fleet_positive_floor, "absent");
  assert.equal(summary.dimensions.process_execs.runs_observed, 2);
});

test("formatCoverageFleet markdown reports floor and blocked counts", () => {
  const out = formatCoverageFleet(foldCoverageFleet([validAnnotation()]), "markdown");
  assert.match(out, /Coverage fleet summary over 1 run/);
  assert.match(out, /positive floor:/);
});

// ---------------------------------------------------------------------------
// CLI exit-code contract
// ---------------------------------------------------------------------------

function writeAnnotation(dir, obj) {
  const p = join(dir, "annotation.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

function runCli(args) {
  return spawnSync("node", ["dist/cli.js", ...args], { encoding: "utf8" });
}

test("CLI: coverage report exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-"));
  const p = writeAnnotation(dir, buildAnnotation());
  const r = runCli(["runner", "coverage", "report", "--annotation", p]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Coverage annotation projection/);
});

test("CLI: coverage gate exits 0 when permitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-"));
  const p = writeAnnotation(dir, buildAnnotation());
  const r = runCli([
    "runner",
    "coverage",
    "gate",
    "--annotation",
    p,
    "--assert-claim",
    "positive:filesystem_paths_touched",
  ]);
  assert.equal(r.status, 0);
});

test("CLI: coverage gate exits 6 when a claim is blocked", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-"));
  const p = writeAnnotation(dir, buildAnnotation());
  const r = runCli([
    "runner",
    "coverage",
    "gate",
    "--annotation",
    p,
    "--assert-claim",
    "positive:network_endpoints",
  ]);
  assert.equal(r.status, 6);
});

test("CLI: coverage gate exits 2 with no claims", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-"));
  const p = writeAnnotation(dir, buildAnnotation());
  const r = runCli(["runner", "coverage", "gate", "--annotation", p]);
  assert.equal(r.status, 2);
});

test("CLI: coverage report exits 3 on invalid annotation", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-"));
  const p = writeAnnotation(dir, { schema: "wrong.v0", claim_cells: [], blocked_claims: [] });
  const r = runCli(["runner", "coverage", "report", "--annotation", p]);
  assert.equal(r.status, 3);
});

test("CLI: coverage report exits 2 when file missing", () => {
  const r = runCli(["runner", "coverage", "report", "--annotation", "/nonexistent/x.json"]);
  assert.equal(r.status, 2);
});

test("CLI: coverage fleet over a dir exits 0 and prints a summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-fleet-"));
  writeFileSync(join(dir, "run-01.json"), JSON.stringify(buildAnnotation()));
  writeFileSync(join(dir, "run-02.json"), JSON.stringify(buildAnnotation()));
  const r = runCli(["runner", "coverage", "fleet", "--dir", dir]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Coverage fleet summary over 2 run/);
});

test("CLI: coverage fleet exits 2 with no inputs", () => {
  const r = runCli(["runner", "coverage", "fleet"]);
  assert.equal(r.status, 2);
});
