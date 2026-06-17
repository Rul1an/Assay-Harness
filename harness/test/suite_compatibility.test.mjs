import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  SUITE_COMPATIBILITY_SCHEMA,
  validateSuiteCompatibility,
  computeMatrixDigest,
  driftAgainstRegistry,
  buildSuiteReport,
  loadSuiteReport,
  formatSuiteMarkdown,
} from "../dist/suite_compatibility.js";

const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/suite-compatibility/${name}`, import.meta.url));
// The canonical, checked-in suite asset (CI gates the real matrix, not a copy).
const ASSET = fileURLToPath(new URL("../suite-compatibility.json", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("schema constant is the frozen suite id", () => {
  assert.equal(SUITE_COMPATIBILITY_SCHEMA, "suite.compatibility.v0");
});

// ---------------------------------------------------------------------------
// Digest determinism (JCS over {carrier_rows, recipe_rows})
// ---------------------------------------------------------------------------

test("digest is stable across key order and changes when a row changes", () => {
  const a = { carrier_rows: [{ carrier: "x", support_mode: "gating", proof: { end_to_end: "declared" } }], recipe_rows: [] };
  // same content, different key order
  const b = { recipe_rows: [], carrier_rows: [{ proof: { end_to_end: "declared" }, support_mode: "gating", carrier: "x" }] };
  assert.equal(computeMatrixDigest(a), computeMatrixDigest(b), "same rows in any key order must hash identically");
  const c = { carrier_rows: [{ carrier: "x", support_mode: "gating", proof: { end_to_end: "proven" } }], recipe_rows: [] };
  assert.notEqual(computeMatrixDigest(a), computeMatrixDigest(c), "a changed row must change the digest");
});

// ---------------------------------------------------------------------------
// Matrix-only validation
// ---------------------------------------------------------------------------

test("real golden matrix validates", () => {
  const r = buildSuiteReport(ASSET);
  assert.equal(r.validation.valid, true, JSON.stringify(r.validation.errors));
  assert.equal(r.carrier_count, 5);
  assert.equal(r.recipe_count, 1);
  // honest split: the recipe rail + the inventory carrier (H-next-2) + the supply_chain
  // carrier (H-next-5a, released v3.28.0 emitter) are e2e-proven; three carriers remain
  // declared/pending behind their producer-emitter gaps.
  assert.equal(r.e2e_proven_count, 3);
  assert.equal(r.e2e_declared_count, 3);
});

test("wrong schema id is rejected", () => {
  const v = validateSuiteCompatibility({ schema: "suite.compatibility.v1", carrier_rows: [], recipe_rows: [], manifest: { digest: "x" } });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "SUITE_SCHEMA_MISMATCH"));
});

test("end_to_end=proven without hosted_run+artifact_digest is a contract error", () => {
  const r = buildSuiteReport(fixture("proven-without-proof.suite.json"));
  assert.equal(r.validation.valid, false);
  assert.ok(r.validation.errors.some((e) => e.code === "SUITE_PROVEN_WITHOUT_PROOF"));
});

test("unknown proof state is never clean", () => {
  const r = buildSuiteReport(fixture("unknown-state.suite.json"));
  assert.equal(r.validation.valid, false);
  assert.ok(r.validation.errors.some((e) => e.code === "SUITE_STATE_UNKNOWN"));
});

test("digest mismatch is a contract error", () => {
  const r = buildSuiteReport(fixture("digest-mismatch.suite.json"));
  assert.equal(r.validation.valid, false);
  assert.ok(r.validation.errors.some((e) => e.code === "SUITE_DIGEST_MISMATCH"));
});

test("unknown backing is rejected", () => {
  const v = validateSuiteCompatibility({
    schema: SUITE_COMPATIBILITY_SCHEMA,
    carrier_rows: [{ carrier: "x", support_mode: "gating", backing: "bogus", consumes: { verb: "carrier x" }, reviews: null, proof: { harness_consumption: "proven", end_to_end: "declared" } }],
    recipe_rows: [],
    manifest: { digest: "sha256:whatever" },
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "SUITE_BACKING_UNKNOWN"));
});

test("a declared carrier row without a machine-readable end_to_end_gap is rejected", () => {
  const r = buildSuiteReport(fixture("gap-missing.suite.json"));
  assert.equal(r.validation.valid, false);
  assert.ok(r.validation.errors.some((e) => e.code === "SUITE_GAP_REASON_INVALID"));
});

test("a proven carrier row needs hermetic-proof metadata, not just run+digest", () => {
  const r = buildSuiteReport(fixture("proven-thin.suite.json"));
  assert.equal(r.validation.valid, false, "run+digest alone is too thin for a carrier proof");
  assert.ok(r.validation.errors.some((e) => e.code === "SUITE_PROVEN_WITHOUT_PROOF"));
});

test("an ill-shaped proof_scope is rejected", () => {
  const v = validateSuiteCompatibility({
    schema: SUITE_COMPATIBILITY_SCHEMA,
    carrier_rows: [{
      carrier: "assay.mcp_server_inventory.v0", support_mode: "descriptive", backing: "private-consumer-backed",
      consumes: { verb: "carrier inventory" }, reviews: null,
      proof: { harness_consumption: "proven", end_to_end: "declared" },
      end_to_end_gap: { reason_code: "awaiting_hosted_recipe_run", owner: "harness" },
      proof_scope: { runner_os: "", hosted: "yes", ambient_scan: 1 },
    }],
    recipe_rows: [],
    manifest: { digest: "sha256:x" },
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "SUITE_PROOF_SCOPE_INVALID"));
});

test("inventory is hermetically e2e-proven; the declared carriers carry machine-readable gap reasons", () => {
  const m = buildSuiteReport(ASSET).validation.matrix;
  // inventory flipped to proven (H-next-2) and carries the full hermetic provenance,
  // no end_to_end_gap (it is no longer declared).
  const inv = m.carrier_rows.find((r) => r.carrier === "assay.mcp_server_inventory.v0");
  assert.equal(inv.proof.end_to_end, "proven");
  assert.ok(inv.proof.hosted_run && inv.proof.artifact_digest && inv.proof.assay_version && inv.proof.fixture_digest);
  assert.equal(inv.proof_scope.ambient_scan, false, "the proof must be fixture-scoped, not ambient");
  assert.equal(inv.end_to_end_gap, undefined);
  // a still-declared carrier keeps its machine-readable producer-gap reason.
  const rs = m.carrier_rows.find((r) => r.carrier === "assay.render_safety_conformance.v0");
  assert.equal(rs.proof.end_to_end, "declared");
  assert.equal(rs.end_to_end_gap.reason_code, "no_released_binary_emitter");
  assert.equal(rs.end_to_end_gap.owner, "assay");
});

test("supply_chain is hermetically e2e-proven by the released v3.28.0 emitter, and honestly not-clean", () => {
  const m = buildSuiteReport(ASSET).validation.matrix;
  const sc = m.carrier_rows.find((r) => r.carrier === "assay.supply_chain_conformance.v0");
  // proven via the released-binary recipe (H-next-5a): full hermetic provenance, no gap.
  assert.equal(sc.proof.end_to_end, "proven");
  assert.equal(sc.proof.harness_consumption, "proven");
  assert.equal(sc.end_to_end_gap, undefined);
  assert.ok(
    sc.proof.hosted_run && sc.proof.artifact_digest && sc.proof.assay_version && sc.proof.fixture_digest,
    "a proven carrier row needs hosted_run + artifact_digest + assay_version + fixture_digest",
  );
  // bound to the released v3.28.0 emitter, fixture-scoped (not ambient).
  assert.equal(sc.proof.assay_version, "v3.28.0");
  assert.equal(sc.proof_scope.hosted, true);
  assert.equal(sc.proof_scope.ambient_scan, false);
  // honesty: proven establishes producer->consumer compatibility, NOT a clean carrier.
  // The row documents that the carrier itself is not-clean (policy_result incomplete).
  assert.match(sc.proof.note, /not[ -]clean|incomplete/i);
});

test("reviews must not leak a private min_version in the public matrix", () => {
  const v = validateSuiteCompatibility({
    schema: SUITE_COMPATIBILITY_SCHEMA,
    carrier_rows: [{
      carrier: "x", support_mode: "gating", backing: "public-only",
      consumes: { verb: "carrier x" },
      reviews: { reviewer: "plimsoll", availability: "private", min_version: "0.13.0" },
      proof: { harness_consumption: "proven", end_to_end: "declared" },
      end_to_end_gap: { reason_code: "no_released_binary_emitter", owner: "assay" },
    }],
    recipe_rows: [],
    manifest: { digest: "sha256:x" },
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "SUITE_PRIVATE_VERSION_LEAK"));
});

test("the private version cannot be smuggled through version_disclosure either", () => {
  // Hardening: the leak rule enforces the disclosure VALUE, not just the key name.
  const v = validateSuiteCompatibility({
    schema: SUITE_COMPATIBILITY_SCHEMA,
    carrier_rows: [{
      carrier: "x", support_mode: "gating", backing: "public-only",
      consumes: { verb: "carrier x" },
      reviews: { reviewer: "plimsoll", availability: "private", version_disclosure: "0.13.0" },
      proof: { harness_consumption: "proven", end_to_end: "declared" },
      end_to_end_gap: { reason_code: "no_released_binary_emitter", owner: "assay" },
    }],
    recipe_rows: [],
    manifest: { digest: "sha256:x" },
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === "SUITE_PRIVATE_VERSION_LEAK"));
});

test("the seed asset names the private reviewer without exposing its version", () => {
  const m = buildSuiteReport(ASSET).validation.matrix;
  const reviewed = m.carrier_rows.filter((r) => r.reviews);
  assert.ok(reviewed.length > 0);
  for (const r of reviewed) {
    assert.equal(r.reviews.availability, "private");
    assert.equal(r.reviews.version_disclosure, "not_public");
    assert.equal(r.reviews.min_version, undefined, "no private version in the public matrix");
  }
});

// ---------------------------------------------------------------------------
// Drift vs the live carrier registry
// ---------------------------------------------------------------------------

test("golden has no registry drift", () => {
  const r = buildSuiteReport(ASSET);
  assert.deepEqual(driftAgainstRegistry(r.validation.matrix), []);
});

test("a registered carrier with no matrix row is registry drift", () => {
  const r = buildSuiteReport(fixture("drift-missing-row.suite.json"));
  assert.equal(r.validation.valid, true, "shape is valid; the gap is only visible against the registry");
  const drift = driftAgainstRegistry(r.validation.matrix);
  assert.ok(drift.some((e) => e.code === "SUITE_REGISTRY_DRIFT"));
});

test("a stale verb is caught only against the registry", () => {
  const r = buildSuiteReport(fixture("stale-verb.suite.json"));
  assert.equal(r.validation.valid, true);
  const drift = driftAgainstRegistry(r.validation.matrix);
  assert.ok(drift.some((e) => e.code === "SUITE_VERB_DRIFT"));
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

test("markdown renders declared as pending, never as approved/supported, with the non-claim", () => {
  const md = formatSuiteMarkdown(buildSuiteReport(ASSET));
  assert.match(md, /declared \/ pending/);
  assert.match(md, /not a SLSA VSA/);
  assert.match(md, /does not approve/);
  for (const banned of [/\bapproved\b/i, /\bsupported\b/i, /SLSA VSA compliant/i, /fully secure/i]) {
    assert.doesNotMatch(md, banned);
  }
});

test("loadSuiteReport reports not_found for a missing path", () => {
  assert.equal(loadSuiteReport("/nonexistent/x.json").not_found, true);
});

// ---------------------------------------------------------------------------
// CLI exit-code contract
// ---------------------------------------------------------------------------

function runCli(...cliArgs) {
  return spawnSync(process.execPath, [CLI, "suite", ...cliArgs], { encoding: "utf8" });
}

test("CLI suite check: golden clean=0; matrix-only ignores drift; --against-registry catches it", () => {
  assert.equal(runCli("check", "--matrix", ASSET).status, 0);
  assert.equal(runCli("check", "--matrix", ASSET, "--against-registry").status, 0);
  // shape-valid but registry-drifting fixtures: clean in matrix-only mode, 3 against the registry
  assert.equal(runCli("check", "--matrix", fixture("drift-missing-row.suite.json")).status, 0);
  assert.equal(runCli("check", "--matrix", fixture("drift-missing-row.suite.json"), "--against-registry").status, 3);
  assert.equal(runCli("check", "--matrix", fixture("stale-verb.suite.json")).status, 0);
  assert.equal(runCli("check", "--matrix", fixture("stale-verb.suite.json"), "--against-registry").status, 3);
});

test("CLI suite check: malformed/inconsistent -> 3; missing -> 2; bare verb -> 2", () => {
  assert.equal(runCli("check", "--matrix", fixture("proven-without-proof.suite.json")).status, 3);
  assert.equal(runCli("check", "--matrix", fixture("unknown-state.suite.json")).status, 3);
  assert.equal(runCli("check", "--matrix", fixture("digest-mismatch.suite.json")).status, 3);
  assert.equal(runCli("check", "--matrix", "/nonexistent/x.json").status, 2);
  assert.equal(runCli().status, 2);
});

test("CLI suite matrix: --format json emits only parseable JSON; bad format -> 2", () => {
  const r = runCli("matrix", "--matrix", ASSET, "--format", "json");
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.validation.matrix.schema, SUITE_COMPATIBILITY_SCHEMA);
  assert.equal(runCli("matrix", "--matrix", ASSET, "--format", "xml").status, 2);
});
