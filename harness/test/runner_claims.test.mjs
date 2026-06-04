import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildClaimReport,
  CLAIM_ASSERTIONS_SCHEMA,
  evaluateClaim,
  validateClaims,
} from "../dist/runner_claims.js";
import {
  COVERAGE_ANNOTATION_SCHEMA,
  validateCoverageAnnotation,
} from "../dist/runner_coverage.js";

function annotation() {
  return validateCoverageAnnotation({
    schema: COVERAGE_ANNOTATION_SCHEMA,
    claim_cells: [
      { claim_type: "measured_filesystem_paths_touched_drift", claim_strength: "strong", claim_basis: "measured" },
      { claim_type: "measured_network_endpoints_drift", claim_strength: "partial", claim_basis: "measured" },
      { claim_type: "exhaustive_filesystem_paths_touched_equality", claim_strength: "partial", claim_basis: "derived" },
      { claim_type: "exhaustive_network_endpoints_equality", claim_strength: "weak", claim_basis: "derived" },
    ],
    blocked_claims: [
      { claim_type: "bounded_negative_claim", requested_claim: "no_network_endpoints_effect_beyond_observed", decision: "blocked", reason: "connect_only" },
    ],
  }).annotation;
}

function claim(overrides) {
  return { id: "c", required_strength: "strong", required_basis: "measured", ...overrides };
}

function decide(c) {
  return evaluateClaim(annotation(), c);
}

// --- outcomes across the three open-core claim kinds -----------------------

test("positive supported when observed meets required", () => {
  const r = decide(claim({ id: "fs", dimension: "filesystem_paths_touched", claim_kind: "positive" }));
  assert.equal(r.decision, "supported");
});

test("positive degraded when observed weaker", () => {
  const r = decide(claim({ id: "net", dimension: "network_endpoints", claim_kind: "positive" }));
  assert.equal(r.decision, "degraded");
  assert.equal(r.reason, "observed_strength_below_required");
});

test("positive blocked when observed absent", () => {
  const ann = validateCoverageAnnotation({
    schema: COVERAGE_ANNOTATION_SCHEMA,
    claim_cells: [{ claim_type: "measured_process_execs_drift", claim_strength: "absent", claim_basis: "measured" }],
    blocked_claims: [],
  }).annotation;
  const r = evaluateClaim(ann, claim({ dimension: "process_execs", claim_kind: "positive", required_strength: "partial" }));
  assert.equal(r.decision, "blocked");
});

test("positive not_evaluable when no cell", () => {
  const r = decide(claim({ dimension: "process_execs", claim_kind: "positive" }));
  assert.equal(r.decision, "not_evaluable");
  assert.equal(r.reason, "no_observed_evidence_for_dimension");
});

test("exhaustive supported (partial) / degraded (weak) / not_evaluable (missing)", () => {
  assert.equal(decide(claim({ dimension: "filesystem_paths_touched", claim_kind: "exhaustive" })).decision, "supported");
  assert.equal(decide(claim({ dimension: "network_endpoints", claim_kind: "exhaustive" })).decision, "degraded");
  assert.equal(decide(claim({ dimension: "process_execs", claim_kind: "exhaustive" })).decision, "not_evaluable");
});

test("bounded_negative blocked under coverage / not_evaluable for unknown dim", () => {
  assert.equal(decide(claim({ dimension: "network_endpoints", claim_kind: "bounded_negative" })).decision, "blocked");
  assert.equal(decide(claim({ dimension: "not_a_dim", claim_kind: "bounded_negative" })).decision, "not_evaluable");
});

test("invalid required level is not_evaluable, never a silent pass", () => {
  const r = decide(claim({ dimension: "filesystem_paths_touched", claim_kind: "positive", required_strength: "super" }));
  assert.equal(r.decision, "not_evaluable");
  assert.equal(r.reason, "invalid_required_level");
});

test("unknown claim kind is not_evaluable", () => {
  assert.equal(decide(claim({ dimension: "filesystem_paths_touched", claim_kind: "whatever" })).decision, "not_evaluable");
});

// --- report aggregation + non-claims ---------------------------------------

test("report fails when any claim blocked/not_evaluable; advisory non-claim present", () => {
  const claims = [
    claim({ id: "a", dimension: "filesystem_paths_touched", claim_kind: "positive" }),
    claim({ id: "b", dimension: "network_endpoints", claim_kind: "bounded_negative" }),
  ];
  const rep = buildClaimReport(claims, annotation(), false);
  assert.equal(rep.passed, false);
  assert.ok(rep.non_claims.includes("claim_value_and_effect_class_are_advisory_not_verified"));
  // deterministic sort by id
  assert.deepEqual(rep.results.map((r) => r.id), ["a", "b"]);
});

test("allow_degraded passes supported+degraded but not blocked", () => {
  const degradedOnly = [claim({ id: "net", dimension: "network_endpoints", claim_kind: "positive" })];
  assert.equal(buildClaimReport(degradedOnly, annotation(), false).passed, false);
  assert.equal(buildClaimReport(degradedOnly, annotation(), true).passed, true);
  const withBlocked = [claim({ id: "bn", dimension: "network_endpoints", claim_kind: "bounded_negative" })];
  assert.equal(buildClaimReport(withBlocked, annotation(), true).passed, false);
});

test("validateClaims rejects wrong schema / non-array", () => {
  assert.equal(validateClaims({ schema: "x", claims: [] }).valid, false);
  assert.equal(validateClaims({ schema: CLAIM_ASSERTIONS_SCHEMA, claims: {} }).valid, false);
  assert.equal(validateClaims({ schema: CLAIM_ASSERTIONS_SCHEMA, claims: [] }).valid, true);
});

// --- CLI exit-code contract ------------------------------------------------

function writeJson(dir, name, obj) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

function annObj() {
  return {
    schema: COVERAGE_ANNOTATION_SCHEMA,
    claim_cells: [
      { claim_type: "measured_filesystem_paths_touched_drift", claim_strength: "strong", claim_basis: "measured" },
    ],
    blocked_claims: [
      { claim_type: "bounded_negative_claim", requested_claim: "no_network_endpoints_effect_beyond_observed", decision: "blocked", reason: "x" },
    ],
  };
}

function runCli(args) {
  return spawnSync("node", ["dist/cli.js", ...args], { encoding: "utf8" });
}

test("CLI: claims report exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "claims-"));
  const a = writeJson(dir, "ann.json", annObj());
  const c = writeJson(dir, "claims.json", {
    schema: CLAIM_ASSERTIONS_SCHEMA,
    claims: [{ id: "fs", dimension: "filesystem_paths_touched", claim_kind: "positive", required_strength: "strong", required_basis: "measured" }],
  });
  const r = runCli(["runner", "claims", "report", "--claims", c, "--annotation", a]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Claim support report/);
});

test("CLI: claims gate exits 0 when supported", () => {
  const dir = mkdtempSync(join(tmpdir(), "claims-"));
  const a = writeJson(dir, "ann.json", annObj());
  const c = writeJson(dir, "claims.json", {
    schema: CLAIM_ASSERTIONS_SCHEMA,
    claims: [{ id: "fs", dimension: "filesystem_paths_touched", claim_kind: "positive", required_strength: "strong", required_basis: "measured" }],
  });
  const r = runCli(["runner", "claims", "gate", "--claims", c, "--annotation", a]);
  assert.equal(r.status, 0);
});

test("CLI: claims gate exits 6 when a claim is blocked", () => {
  const dir = mkdtempSync(join(tmpdir(), "claims-"));
  const a = writeJson(dir, "ann.json", annObj());
  const c = writeJson(dir, "claims.json", {
    schema: CLAIM_ASSERTIONS_SCHEMA,
    claims: [{ id: "bn", dimension: "network_endpoints", claim_kind: "bounded_negative", required_strength: "strong", required_basis: "measured" }],
  });
  const r = runCli(["runner", "claims", "gate", "--claims", c, "--annotation", a]);
  assert.equal(r.status, 6);
});

test("CLI: claims gate exits 6 for not_evaluable even with --allow-degraded", () => {
  const dir = mkdtempSync(join(tmpdir(), "claims-"));
  const a = writeJson(dir, "ann.json", annObj());
  const c = writeJson(dir, "claims.json", {
    schema: CLAIM_ASSERTIONS_SCHEMA,
    claims: [{ id: "px", dimension: "process_execs", claim_kind: "positive", required_strength: "strong", required_basis: "measured" }],
  });
  const r = runCli(["runner", "claims", "gate", "--claims", c, "--annotation", a, "--allow-degraded"]);
  assert.equal(r.status, 6);
});

test("CLI: invalid claims schema exits 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "claims-"));
  const a = writeJson(dir, "ann.json", annObj());
  const c = writeJson(dir, "claims.json", { schema: "wrong", claims: [] });
  const r = runCli(["runner", "claims", "report", "--claims", c, "--annotation", a]);
  assert.equal(r.status, 3);
});

test("CLI: missing claims file exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "claims-"));
  const a = writeJson(dir, "ann.json", annObj());
  const r = runCli(["runner", "claims", "gate", "--claims", "/nope.json", "--annotation", a]);
  assert.equal(r.status, 2);
});
