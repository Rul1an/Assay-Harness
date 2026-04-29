import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertClaimLevel,
  FAMILY_CLAIM_IDS,
  writeFakeReceiptAssay,
} from "./support/trust_basis_recipe_helpers.mjs";

const repoRoot = join(process.cwd(), "..");
const recipe = join(repoRoot, "demo", "run-cyclonedx-mlbom-model-receipt-pipeline.sh");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "assay-harness-p44-recipe-"));
}

function runRecipe(args) {
  return spawnSync("bash", [recipe, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("CycloneDX ML-BOM recipe writes non-regression artifact chain under output root", () => {
  const dir = tempDir();
  const assayBin = join(dir, "assay");
  const outDir = join(dir, "out");
  writeFakeReceiptAssay(assayBin, {
    bundleLabel: "CycloneDX ML-BOM model",
    importerCommand: "cyclonedx-mlbom-model",
    verifiedClaimId: FAMILY_CLAIM_IDS.inventory,
  });

  const result = runRecipe([
    "--case",
    "nonregression",
    "--out-dir",
    outDir,
    "--assay-bin",
    assayBin,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(outDir, "baseline", "baseline.cdx.json")), true);
  assert.equal(existsSync(join(outDir, "candidate", "candidate.cdx.json")), true);
  assert.equal(existsSync(join(outDir, "baseline", "baseline.evidence.tar.gz")), true);
  assert.equal(existsSync(join(outDir, "candidate", "candidate.evidence.tar.gz")), true);
  assert.equal(existsSync(join(outDir, "baseline", "baseline.trust-basis.json")), true);
  assert.equal(existsSync(join(outDir, "candidate", "candidate.trust-basis.json")), true);
  assert.equal(existsSync(join(outDir, "trust-basis-summary.md")), true);
  assert.equal(existsSync(join(outDir, "junit-trust-basis.xml")), true);
  assertClaimLevel(
    join(outDir, "candidate", "candidate.trust-basis.json"),
    FAMILY_CLAIM_IDS.inventory,
    "verified",
  );
  assertClaimLevel(
    join(outDir, "candidate", "candidate.trust-basis.json"),
    FAMILY_CLAIM_IDS.decision,
    "absent",
  );
  const diff = JSON.parse(readFileSync(join(outDir, "trust-basis.diff.json"), "utf8"));
  assert.equal(diff.summary.has_regressions, false);
  assert.equal(diff.summary.unchanged_claim_count, 10);
});

test("CycloneDX ML-BOM recipe maps Trust Basis regression to recipe exit 1", () => {
  const dir = tempDir();
  const assayBin = join(dir, "assay");
  const outDir = join(dir, "out");
  writeFakeReceiptAssay(assayBin, {
    bundleLabel: "CycloneDX ML-BOM model",
    importerCommand: "cyclonedx-mlbom-model",
    verifiedClaimId: FAMILY_CLAIM_IDS.inventory,
  });

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
  assert.equal(diff.summary.unchanged_claim_count, 9);
  assert.equal(diff.regressed_claims[0]?.claim_id, FAMILY_CLAIM_IDS.inventory);
  assert.equal(existsSync(join(outDir, "baseline", "baseline.evidence.tar.gz")), true);
  assert.equal(existsSync(join(outDir, "candidate", "candidate.evidence.tar.gz")), false);
  assert.match(readFileSync(join(outDir, "junit-trust-basis.xml"), "utf8"), /failures="1"/);
  assert.match(result.stdout, /candidate bundle: n\/a \(Trust Basis fixture case\)/);
});

test("CycloneDX ML-BOM recipe refuses to overwrite an output root by default", () => {
  const dir = tempDir();
  const assayBin = join(dir, "assay");
  const outDir = join(dir, "out");
  const sentinel = join(outDir, "sentinel.txt");
  writeFakeReceiptAssay(assayBin, {
    bundleLabel: "CycloneDX ML-BOM model",
    importerCommand: "cyclonedx-mlbom-model",
    verifiedClaimId: FAMILY_CLAIM_IDS.inventory,
  });
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

test("CycloneDX ML-BOM recipe refuses dangerous overwrite paths", () => {
  const dir = tempDir();
  const assayBin = join(dir, "assay");
  writeFakeReceiptAssay(assayBin, {
    bundleLabel: "CycloneDX ML-BOM model",
    importerCommand: "cyclonedx-mlbom-model",
    verifiedClaimId: FAMILY_CLAIM_IDS.inventory,
  });

  const result = runRecipe([
    "--case",
    "nonregression",
    "--out-dir",
    "/",
    "--assay-bin",
    assayBin,
    "--overwrite",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing dangerous --out-dir/);
});

test("CycloneDX ML-BOM recipe rejects output roots that look like options", () => {
  const dir = tempDir();
  const assayBin = join(dir, "assay");
  writeFakeReceiptAssay(assayBin, {
    bundleLabel: "CycloneDX ML-BOM model",
    importerCommand: "cyclonedx-mlbom-model",
    verifiedClaimId: FAMILY_CLAIM_IDS.inventory,
  });

  const result = runRecipe([
    "--case",
    "nonregression",
    "--out-dir",
    "-dangerous",
    "--assay-bin",
    assayBin,
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /must not begin with -/);
});
