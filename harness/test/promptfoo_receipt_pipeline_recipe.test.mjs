import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repoRoot = join(process.cwd(), "..");
const recipe = join(repoRoot, "demo", "run-promptfoo-receipt-pipeline.sh");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "assay-harness-p38-recipe-"));
}

function writeFakeAssay(path) {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function writeJson(path, value) {
  fs.mkdirSync(require("node:path").dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\\n");
}
function trustBasis(level) {
  return { claims: [{ id: "external_eval_receipt_boundary_visible", level, source: "external_evidence_receipt", boundary: "supported-external-eval-receipt-events-only" }] };
}
function diffReport(hasRegression) {
  const regressed = hasRegression ? [{ diff_class: "regressed", claim_id: "external_eval_receipt_boundary_visible", baseline_level: "verified", candidate_level: "absent" }] : [];
  return {
    schema: "assay.trust-basis.diff.v1",
    claim_identity: "claim.id",
    level_order: ["absent", "inferred", "self_reported", "verified"],
    summary: { regressed_claims: regressed.length, improved_claims: 0, removed_claims: 0, added_claims: 0, metadata_changes: 0, unchanged_claim_count: hasRegression ? 0 : 1, has_regressions: hasRegression },
    regressed_claims: regressed,
    improved_claims: [],
    removed_claims: [],
    added_claims: [],
    metadata_changes: [],
    unchanged_claim_count: hasRegression ? 0 : 1,
  };
}
if (args.includes("--help")) process.exit(0);
if (args[0] === "evidence" && args[1] === "import" && args[2] === "promptfoo-jsonl") {
  const input = argValue("--input");
  const out = argValue("--bundle-out");
  fs.mkdirSync(require("node:path").dirname(out), { recursive: true });
  fs.writeFileSync(out, "fake bundle from " + input + "\\n");
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
  const external = candidate.claims.find((claim) => claim.id === "external_eval_receipt_boundary_visible");
  const hasRegression = external?.level === "absent";
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

test("Promptfoo receipt recipe writes non-regression artifact chain under output root", () => {
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
  assert.equal(existsSync(join(outDir, "baseline", "baseline.evidence.tar.gz")), true);
  assert.equal(existsSync(join(outDir, "candidate", "candidate.evidence.tar.gz")), true);
  assert.equal(existsSync(join(outDir, "baseline", "baseline.trust-basis.json")), true);
  assert.equal(existsSync(join(outDir, "candidate", "candidate.trust-basis.json")), true);
  assert.equal(existsSync(join(outDir, "trust-basis-summary.md")), true);
  assert.equal(existsSync(join(outDir, "junit-trust-basis.xml")), true);
  assert.equal(JSON.parse(readFileSync(join(outDir, "trust-basis.diff.json"), "utf8")).summary.has_regressions, false);
});

test("Promptfoo receipt recipe maps Trust Basis regression to recipe exit 1", () => {
  const dir = tempDir();
  const assayBin = join(dir, "assay");
  const outDir = join(dir, "out");
  writeFakeAssay(assayBin);

  const result = runRecipe([
    "--case",
    "boundary-regression",
    "--out-dir",
    outDir,
    "--assay-bin",
    assayBin,
  ]);

  assert.equal(result.status, 1, result.stderr);
  const diff = JSON.parse(readFileSync(join(outDir, "trust-basis.diff.json"), "utf8"));
  assert.equal(diff.summary.has_regressions, true);
  assert.equal(diff.regressed_claims[0]?.claim_id, "external_eval_receipt_boundary_visible");
  assert.equal(existsSync(join(outDir, "baseline", "baseline.evidence.tar.gz")), true);
  assert.equal(existsSync(join(outDir, "candidate", "candidate.evidence.tar.gz")), false);
  assert.match(readFileSync(join(outDir, "junit-trust-basis.xml"), "utf8"), /failures="1"/);
});

test("Promptfoo receipt recipe refuses to overwrite an output root by default", () => {
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
