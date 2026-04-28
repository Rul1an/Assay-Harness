import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repoRoot = join(process.cwd(), "..");
const recipe = join(repoRoot, "demo", "run-openfeature-decision-receipt-pipeline.sh");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "assay-harness-p42-recipe-"));
}

function writeFakeAssay(path) {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function writeJson(outPath, value) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(value, null, 2) + "\\n");
}
function trustBasis(level) {
  return {
    claims: [
      { id: "bundle_verified", level, source: "bundle_verification", boundary: "bundle-wide", note: null },
      { id: "signing_evidence_present", level: "absent", source: "bundle_proof_surface", boundary: "proof-surfaces-only", note: null },
      { id: "provenance_backed_claims_present", level: "absent", source: "bundle_proof_surface", boundary: "proof-surfaces-only", note: null },
      { id: "delegation_context_visible", level: "absent", source: "canonical_decision_evidence", boundary: "supported-delegated-flows-only", note: null },
      { id: "authorization_context_visible", level: "absent", source: "canonical_decision_evidence", boundary: "supported-auth-projected-flows-only", note: null },
      { id: "containment_degradation_observed", level: "absent", source: "canonical_event_presence", boundary: "supported-containment-fallback-paths-only", note: null },
      { id: "external_eval_receipt_boundary_visible", level: "absent", source: "external_evidence_receipt", boundary: "supported-external-eval-receipt-events-only", note: null },
      { id: "applied_pack_findings_present", level: "absent", source: "pack_execution_results", boundary: "pack-execution-only", note: null },
    ],
  };
}
function diffReport(hasRegression) {
  const regressed = hasRegression ? [{ diff_class: "regressed", claim_id: "bundle_verified", baseline_level: "verified", candidate_level: "absent" }] : [];
  return {
    schema: "assay.trust-basis.diff.v1",
    claim_identity: "claim.id",
    level_order: ["absent", "inferred", "self_reported", "verified"],
    summary: { regressed_claims: regressed.length, improved_claims: 0, removed_claims: 0, added_claims: 0, metadata_changes: 0, unchanged_claim_count: hasRegression ? 7 : 8, has_regressions: hasRegression },
    regressed_claims: regressed,
    improved_claims: [],
    removed_claims: [],
    added_claims: [],
    metadata_changes: [],
    unchanged_claim_count: hasRegression ? 7 : 8,
  };
}
if (args.includes("--help")) process.exit(0);
if (args[0] === "evidence" && args[1] === "import" && args[2] === "openfeature-details") {
  const input = argValue("--input");
  const out = argValue("--bundle-out");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "fake OpenFeature decision bundle from " + input + "\\n");
  process.exit(0);
}
if (args[0] === "evidence" && args[1] === "verify") {
  if (!fs.existsSync(args[2])) process.exit(2);
  process.stdout.write("verified\\n");
  process.exit(0);
}
if (args[0] === "trust-basis" && args[1] === "generate") {
  writeJson(argValue("--out"), trustBasis("verified"));
  process.exit(0);
}
if (args[0] === "trust-basis" && args[1] === "diff") {
  const candidate = JSON.parse(fs.readFileSync(args[3], "utf8"));
  const bundleClaim = candidate.claims.find((claim) => claim.id === "bundle_verified");
  const hasRegression = bundleClaim?.level === "absent";
  process.stdout.write(JSON.stringify(diffReport(hasRegression), null, 2) + "\\n");
  process.exit(hasRegression && args.includes("--fail-on-regression") ? 1 : 0);
}
process.stderr.write("unexpected fake assay args: " + args.join(" ") + "\\n");
process.exit(2);
`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

function runRecipe(args) {
  return spawnSync("bash", [recipe, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("OpenFeature decision recipe writes non-regression artifact chain under output root", () => {
  const dir = tempDir();
  const assayBin = join(dir, "assay");
  const outDir = join(dir, "out");
  writeFakeAssay(assayBin);

  const result = runRecipe([
    "--case",
    "nonregression",
    "--out-dir",
    outDir,
    "--assay-bin",
    assayBin,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(outDir, "baseline", "baseline.openfeature-details.jsonl")), true);
  assert.equal(existsSync(join(outDir, "candidate", "candidate.openfeature-details.jsonl")), true);
  assert.equal(existsSync(join(outDir, "baseline", "baseline.evidence.tar.gz")), true);
  assert.equal(existsSync(join(outDir, "candidate", "candidate.evidence.tar.gz")), true);
  assert.equal(existsSync(join(outDir, "baseline", "baseline.trust-basis.json")), true);
  assert.equal(existsSync(join(outDir, "candidate", "candidate.trust-basis.json")), true);
  assert.equal(existsSync(join(outDir, "trust-basis-summary.md")), true);
  assert.equal(existsSync(join(outDir, "junit-trust-basis.xml")), true);
  assert.equal(JSON.parse(readFileSync(join(outDir, "trust-basis.diff.json"), "utf8")).summary.has_regressions, false);
});

test("OpenFeature decision recipe maps Trust Basis regression to recipe exit 1", () => {
  const dir = tempDir();
  const assayBin = join(dir, "assay");
  const outDir = join(dir, "out");
  writeFakeAssay(assayBin);

  const result = runRecipe([
    "--case",
    "trust-basis-regression-fixture",
    "--out-dir",
    outDir,
    "--assay-bin",
    assayBin,
  ]);

  assert.equal(result.status, 1, result.stderr);
  const diff = JSON.parse(readFileSync(join(outDir, "trust-basis.diff.json"), "utf8"));
  assert.equal(diff.summary.has_regressions, true);
  assert.equal(diff.regressed_claims[0]?.claim_id, "bundle_verified");
  assert.equal(existsSync(join(outDir, "baseline", "baseline.evidence.tar.gz")), true);
  assert.equal(existsSync(join(outDir, "candidate", "candidate.evidence.tar.gz")), false);
  assert.match(readFileSync(join(outDir, "junit-trust-basis.xml"), "utf8"), /failures="1"/);
  assert.match(result.stdout, /candidate bundle: n\/a \(Trust Basis fixture case\)/);
});

test("OpenFeature decision recipe refuses to overwrite an output root by default", () => {
  const dir = tempDir();
  const assayBin = join(dir, "assay");
  const outDir = join(dir, "out");
  const sentinel = join(outDir, "sentinel.txt");
  writeFakeAssay(assayBin);
  mkdirSync(outDir);
  writeFileSync(sentinel, "keep", "utf8");

  const result = runRecipe([
    "--case",
    "nonregression",
    "--out-dir",
    outDir,
    "--assay-bin",
    assayBin,
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /already contains files/);
  assert.equal(readFileSync(sentinel, "utf8"), "keep");

  const overwriteResult = runRecipe([
    "--case",
    "nonregression",
    "--out-dir",
    outDir,
    "--assay-bin",
    assayBin,
    "--overwrite",
  ]);

  assert.equal(overwriteResult.status, 0, overwriteResult.stderr);
  assert.equal(existsSync(join(outDir, "trust-basis.diff.json")), true);
});
