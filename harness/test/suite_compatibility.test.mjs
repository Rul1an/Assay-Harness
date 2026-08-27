import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { load as loadYaml } from "js-yaml";
import {
  SUITE_COMPATIBILITY_SCHEMA,
  validateSuiteCompatibility,
  computeMatrixDigest,
  deriveGenerated,
  parseAssayReleaseTag,
  driftAgainstRegistry,
  buildSuiteReport,
  loadSuiteReport,
  formatSuiteMarkdown,
} from "../dist/suite_compatibility.js";

const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/suite-compatibility/${name}`, import.meta.url));
// The canonical, checked-in suite asset (CI gates the real matrix, not a copy).
const ASSET = fileURLToPath(new URL("../suite-compatibility.json", import.meta.url));
const PACKAGE = fileURLToPath(new URL("../package.json", import.meta.url));
const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/harness-ci.yml", import.meta.url));
const COMPAT_DOC = fileURLToPath(new URL("../../docs/ASSAY_COMPATIBILITY.md", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const READONLY_GENERATE_CHECK = "npx tsx src/cli.ts suite generate --matrix suite-compatibility.json --check";

function isReadOnlyGenerateCheck(run) {
  return (
    typeof run === "string" &&
    run.includes("suite generate") &&
    run.includes("suite-compatibility.json") &&
    /(?:^|\s)--check(?:\s|$)/.test(run) &&
    !/--check=/.test(run)
  );
}

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
  assert.equal(r.recipe_count, 2);
  // honest split: the release-compat recipe rail + the inventory carrier (H-next-2) + the
  // supply_chain carrier (A5a-2, v3.28.0 valid-not-clean) + the supply-chain DSSE clean/pass
  // recipe row (A5a-3, v3.29.0) are e2e-proven; three carriers remain declared/pending behind
  // their producer-emitter gaps.
  assert.equal(r.e2e_proven_count, 4);
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
  assert.ok(inv, "inventory carrier row must exist");
  assert.equal(inv.proof.end_to_end, "proven");
  assert.ok(inv.proof.hosted_run && inv.proof.artifact_digest && inv.proof.assay_version && inv.proof.fixture_digest);
  assert.equal(inv.proof_scope.ambient_scan, false, "the proof must be fixture-scoped, not ambient");
  assert.equal(inv.end_to_end_gap, undefined);
  // a still-declared carrier keeps its machine-readable producer-gap reason.
  const rs = m.carrier_rows.find((r) => r.carrier === "assay.render_safety_conformance.v0");
  assert.ok(rs, "render_safety carrier row must exist");
  assert.equal(rs.proof.end_to_end, "declared");
  assert.equal(rs.end_to_end_gap.reason_code, "no_released_binary_emitter");
  assert.equal(rs.end_to_end_gap.owner, "assay");
});

test("supply_chain is hermetically e2e-proven by the released v3.28.0 emitter, and honestly not-clean", () => {
  const m = buildSuiteReport(ASSET).validation.matrix;
  const sc = m.carrier_rows.find((r) => r.carrier === "assay.supply_chain_conformance.v0");
  assert.ok(sc, "supply_chain carrier row must exist");
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

test("A5a-3 appends a clean/pass DSSE recipe row and preserves the A5a-2 carrier-row proof", () => {
  const m = buildSuiteReport(ASSET).validation.matrix;
  const recipe = m.recipe_rows.find((r) => r.recipe === "supply-chain DSSE clean/pass recipe");
  assert.ok(recipe, "the clean/pass DSSE recipe row must exist");
  assert.equal(recipe.support_mode, "recipe");
  assert.equal(recipe.proof.end_to_end, "proven");
  // a proven recipe row needs hosted_run + artifact_digest (the emitted carrier digest); the full
  // four-digest chain lives in the recipe_provenance sidecar, not the row.
  assert.ok(recipe.proof.hosted_run, "recipe row needs a hosted_run");
  assert.match(recipe.proof.artifact_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(recipe.emits.min_version, "v3.29.0");
  // public wording: policy_result pass / passed=true, never "clean supply-chain" / "secure".
  assert.match(recipe.proof.note, /policy_result=pass|passed=true/);
  assert.doesNotMatch(recipe.proof.note, /clean supply.?chain|secure|verified supply/i);

  // A5a-2 preservation: the carrier-row proof is STILL the v3.28.0 valid-not-clean one (its
  // artifact_digest differs from the clean/pass recipe's emitted carrier — it was not overwritten).
  const sc = m.carrier_rows.find((r) => r.carrier === "assay.supply_chain_conformance.v0");
  assert.equal(sc.proof.assay_version, "v3.28.0", "A5a-2 carrier proof must be preserved");
  assert.notEqual(
    sc.proof.artifact_digest,
    recipe.proof.artifact_digest,
    "the carrier-row proof must not become the clean/pass proof",
  );
  // the carrier note keeps the A5a-2 record AND gains the sober pass-recipe append (the only diff).
  assert.match(sc.proof.note, /incomplete.*not-clean/i);
  assert.match(
    sc.proof.note,
    /Additionally, a v3\.29\.0 DSSE recipe row proves a policy_result: pass carrier consumed by Harness with passed=true\./,
  );
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

test("CLI suite matrix: --format json stays complete + parseable above the 8KB pipe buffer", () => {
  // Regression: the matrix JSON exceeds the ~8KB stdout pipe buffer. The command must drain stdout
  // before exiting (process.exitCode, not process.exit) — else a piped reader gets truncated JSON
  // while the command still exits 0, which is artifact-contract poison for machine-readable output.
  const r = runCli("matrix", "--matrix", ASSET, "--format", "json");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length > 8192, `matrix JSON must exceed the 8KB pipe buffer to guard the flush; got ${r.stdout.length} bytes`);
  assert.doesNotThrow(() => JSON.parse(r.stdout), "piped stdout must be complete, parseable JSON (not truncated)");
});

// ---------------------------------------------------------------------------
// Generated projection (one derivation path; digest-invariant)
// ---------------------------------------------------------------------------

const PINNED_LAST_VERIFIED = "v3.28.0";
const PINNED_VERIFIED_ON = "2026-06-17";

function committedMatrix() {
  return JSON.parse(readFileSync(ASSET, "utf8"));
}

function harnessPackageVersion() {
  const version = JSON.parse(readFileSync(PACKAGE, "utf8")).version;
  assert.equal(typeof version, "string");
  assert.ok(version.length > 0);
  return version;
}

function stageGeneratedWorkspace(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "suite-generated-"));
  const matrix = committedMatrix();
  const pkg = JSON.parse(readFileSync(PACKAGE, "utf8"));
  mutate({ matrix, pkg });
  const matrixPath = join(dir, "suite-compatibility.json");
  writeFileSync(matrixPath, JSON.stringify(matrix, null, 2) + "\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  return { dir, matrixPath };
}

test("deriveGenerated is the single rule: package version + max proof.assay_version + alias equality", () => {
  const matrix = committedMatrix();
  const expected = deriveGenerated({
    harnessVersion: harnessPackageVersion(),
    carrier_rows: matrix.carrier_rows,
    recipe_rows: matrix.recipe_rows,
    verifiedOn: matrix.generated.verified_on,
  });
  assert.equal(expected.harness_version, harnessPackageVersion());
  assert.equal(expected.last_verified_assay, PINNED_LAST_VERIFIED);
  assert.equal(expected.assay_default, expected.last_verified_assay, "deprecated assay_default alias must equal last_verified_assay");
  assert.equal(expected.verified_on, PINNED_VERIFIED_ON);
  assert.notEqual(expected.verified_on, new Date().toISOString().slice(0, 10), "verified_on is a historical event date, never today");
});

test("deriveGenerated takes the highest proof.assay_version across carrier and recipe rows", () => {
  const derived = deriveGenerated({
    harnessVersion: "1.2.3",
    carrier_rows: [{ proof: { assay_version: "v3.9.0" } }, { proof: { assay_version: "v3.27.0" } }],
    recipe_rows: [{ proof: { assay_version: "v3.28.0" } }],
    verifiedOn: "2020-01-01",
  });
  assert.equal(derived.last_verified_assay, "v3.28.0");
  assert.equal(derived.assay_default, "v3.28.0");
  assert.equal(derived.harness_version, "1.2.3");
  assert.equal(derived.verified_on, "2020-01-01");
});

test("committed generated matches deriveGenerated (harness_version + last-verified + alias)", () => {
  const matrix = committedMatrix();
  const expected = deriveGenerated({
    harnessVersion: harnessPackageVersion(),
    carrier_rows: matrix.carrier_rows,
    recipe_rows: matrix.recipe_rows,
    verifiedOn: matrix.generated.verified_on,
  });
  assert.deepEqual(matrix.generated, expected);
  assert.equal(matrix.generated.last_verified_assay, matrix.generated.assay_default);
});

test("changing only generated leaves computeMatrixDigest and matrix validation unchanged", () => {
  const matrix = committedMatrix();
  const digestBefore = computeMatrixDigest(matrix);
  const validationBefore = validateSuiteCompatibility(matrix);
  assert.equal(validationBefore.valid, true, JSON.stringify(validationBefore.errors));
  matrix.generated = {
    harness_version: "9.9.9",
    last_verified_assay: "v9.9.9",
    assay_default: "v9.9.9",
    verified_on: "1999-01-01",
  };
  assert.equal(computeMatrixDigest(matrix), digestBefore);
  const validationAfter = validateSuiteCompatibility(matrix);
  assert.equal(validationAfter.valid, true, JSON.stringify(validationAfter.errors));
});

test("CLI suite generate --check is clean on the committed matrix and never rewrites", () => {
  const before = readFileSync(ASSET);
  const r = runCli("generate", "--matrix", ASSET, "--check");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(ASSET), before);
});

test("CLI suite generate --check fails when committed harness_version or last-verified alias drifts", () => {
  for (const mutate of [
    (matrix) => {
      matrix.generated.harness_version = "0.0.0-drift";
    },
    (matrix) => {
      matrix.generated.last_verified_assay = "v0.0.0";
    },
    (matrix) => {
      matrix.generated.assay_default = "v0.0.0";
    },
  ]) {
    const { matrixPath } = stageGeneratedWorkspace(({ matrix }) => mutate(matrix));
    const before = readFileSync(matrixPath);
    const r = runCli("generate", "--matrix", matrixPath, "--check");
    assert.equal(r.status, 3, r.stderr);
    assert.deepEqual(readFileSync(matrixPath), before, "--check must never rewrite");
  }
});

test("CLI suite generate --check fails when sibling package.json version drifts", () => {
  const { matrixPath } = stageGeneratedWorkspace(({ pkg }) => {
    pkg.version = "9.9.9-package-drift";
  });
  const before = readFileSync(matrixPath);
  const r = runCli("generate", "--matrix", matrixPath, "--check");
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(readFileSync(matrixPath), before, "--check must never rewrite");
});

test("CLI suite generate --check fails when the highest proof.assay_version moves until generated follows", () => {
  const { matrixPath } = stageGeneratedWorkspace(({ matrix }) => {
    matrix.carrier_rows[0].proof.assay_version = "v9.9.9";
  });
  const drifted = runCli("generate", "--matrix", matrixPath, "--check");
  assert.equal(drifted.status, 3, drifted.stderr);

  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  matrix.generated.last_verified_assay = "v9.9.9";
  matrix.generated.assay_default = "v9.9.9";
  writeFileSync(matrixPath, JSON.stringify(matrix, null, 2) + "\n");
  const followed = runCli("generate", "--matrix", matrixPath, "--check");
  assert.equal(followed.status, 0, followed.stderr);
});

test("CLI suite generate no-op on a clean projection is byte-stable and digest-invariant", () => {
  const { matrixPath } = stageGeneratedWorkspace(() => {});
  const before = readFileSync(matrixPath);
  const digestBefore = computeMatrixDigest(JSON.parse(before.toString("utf8")));
  const r = runCli("generate", "--matrix", matrixPath);
  assert.equal(r.status, 0, r.stderr);
  const after = readFileSync(matrixPath);
  assert.deepEqual(after, before);
  const parsed = JSON.parse(after.toString("utf8"));
  assert.equal(computeMatrixDigest(parsed), digestBefore);
  assert.equal(validateSuiteCompatibility(parsed).valid, true);
});

test("Harness CI invokes read-only suite generate --check (removing it must fail this guard)", () => {
  const workflowText = readFileSync(WORKFLOW, "utf8");
  const workflow = loadYaml(workflowText);
  assert.equal(typeof workflow, "object");
  const runs = Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).map((step) => step.run).filter((run) => typeof run === "string"),
  );
  const invocation = runs.find(isReadOnlyGenerateCheck);
  assert.ok(
    invocation,
    "harness-ci.yml must invoke `suite generate --matrix suite-compatibility.json --check` in a job step run, not a comment",
  );
  assert.equal(invocation.trim(), READONLY_GENERATE_CHECK);
  assert.doesNotMatch(invocation, /--check=/);
});

test("workflow generate --check guard rejects the --check=true write-mode spelling", () => {
  const workflowText = readFileSync(WORKFLOW, "utf8");
  assert.ok(isReadOnlyGenerateCheck(READONLY_GENERATE_CHECK));
  assert.equal(
    isReadOnlyGenerateCheck(READONLY_GENERATE_CHECK.replace(/(?:^|\s)--check(?:\s|$)/, " --check=true")),
    false,
    "replacing --check with --check=true must fail the read-only invocation guard",
  );
  const mutated = workflowText.replace(
    /npx tsx src\/cli\.ts suite generate --matrix suite-compatibility\.json --check\b/,
    "npx tsx src/cli.ts suite generate --matrix suite-compatibility.json --check=true",
  );
  const workflow = loadYaml(mutated);
  const runs = Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).map((step) => step.run).filter((run) => typeof run === "string"),
  );
  assert.equal(runs.find(isReadOnlyGenerateCheck), undefined);
});

test("CLI suite generate rejects non-exact --check spellings on a drifted matrix without rewriting", () => {
  const spellings = [
    ["--check=true"],
    ["--check", "true"],
    ["--chek"],
    ["--check-only"],
  ];
  for (const extra of spellings) {
    const { matrixPath } = stageGeneratedWorkspace(({ matrix }) => {
      matrix.generated.harness_version = "0.0.0-DRIFTED";
    });
    const before = readFileSync(matrixPath);
    const r = runCli("generate", "--matrix", matrixPath, ...extra);
    assert.equal(r.status, 2, `${extra.join(" ")} must be config_error: ${r.stderr}`);
    assert.deepEqual(readFileSync(matrixPath), before, `${extra.join(" ")} must not rewrite`);
  }
});

test("ASSAY_COMPATIBILITY.md does not overclaim last_verified_assay as the last version a row proved", () => {
  const docs = readFileSync(COMPAT_DOC, "utf8");
  assert.doesNotMatch(docs, /the last Assay version a row actually proved/i);
  assert.match(docs, /explicitly recorded/);
  assert.match(docs, /may predate later row runs/i);
});

const EXACT_RELEASE_TAGS = ["v0.8.0", "v3.9.0", "v3.27.0", "v3.28.0", "v9.9.9"];
const OVERFLOW_RELEASE_TAG = `v${"9".repeat(400)}.0.0`;
const MALFORMED_RELEASE_TAGS = [
  "garbage",
  "v999junk",
  "v3.x.9",
  "v3.28.0-rc.1",
  "3.28.0",
  "v3.28",
  "V3.28.0",
  "v01.2.3",
  "v1.02.3",
  "v1.2.03",
  OVERFLOW_RELEASE_TAG,
];

test("parseAssayReleaseTag accepts only vMAJOR.MINOR.PATCH and is the shared exact-tag rule", () => {
  for (const tag of EXACT_RELEASE_TAGS) {
    const parsed = parseAssayReleaseTag(tag);
    assert.ok(parsed, `exact tag ${tag} must parse`);
    const [, major, minor, patch] = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    assert.deepEqual(parsed, [Number(major), Number(minor), Number(patch)]);
  }
  for (const tag of MALFORMED_RELEASE_TAGS) {
    assert.equal(parseAssayReleaseTag(tag), null, `non-exact tag ${tag} must be rejected`);
  }
  assert.equal(parseAssayReleaseTag(null), null);
  assert.equal(parseAssayReleaseTag(328), null);
});

test("deriveGenerated refuses malformed proof.assay_version instead of emitting it", () => {
  for (const tag of MALFORMED_RELEASE_TAGS) {
    assert.throws(
      () =>
        deriveGenerated({
          harnessVersion: "0.10.2",
          carrier_rows: [{ proof: { assay_version: tag } }],
          recipe_rows: [],
          verifiedOn: PINNED_VERIFIED_ON,
        }),
      /assay_version|release.?tag|invalid/i,
      `deriveGenerated must not emit ${tag}`,
    );
  }
});

test("validateSuiteCompatibility rejects a present non-exact proof.assay_version", () => {
  for (const tag of ["v3.28.0-rc.1", "v01.2.3", "v1.02.3", "v1.2.03", OVERFLOW_RELEASE_TAG]) {
    const matrix = committedMatrix();
    matrix.carrier_rows[0].proof.assay_version = tag;
    matrix.manifest.digest = computeMatrixDigest(matrix);
    const v = validateSuiteCompatibility(matrix);
    assert.equal(v.valid, false, `validation must reject ${tag}`);
    assert.ok(
      v.errors.some((e) => e.code === "SUITE_ASSAY_VERSION_INVALID" && e.path?.includes("assay_version")),
      JSON.stringify(v.errors),
    );
  }
});

test("CLI suite generate --check cannot pass when generated mirrors a malformed proof.assay_version", () => {
  for (const tag of ["garbage", "v999junk", "v3.x.9", "v3.28.0-rc.1", "v01.2.3", "v1.02.3", "v1.2.03", OVERFLOW_RELEASE_TAG]) {
    const { matrixPath } = stageGeneratedWorkspace(({ matrix }) => {
      matrix.carrier_rows[0].proof.assay_version = tag;
      matrix.generated.last_verified_assay = tag;
      matrix.generated.assay_default = tag;
    });
    const before = readFileSync(matrixPath);
    const r = runCli("generate", "--matrix", matrixPath, "--check");
    assert.notEqual(r.status, 0, `--check must not pass for mirrored ${tag}: ${r.stderr}`);
    assert.equal(r.status, 3, r.stderr);
    assert.deepEqual(readFileSync(matrixPath), before, "--check must never rewrite");
  }
});
