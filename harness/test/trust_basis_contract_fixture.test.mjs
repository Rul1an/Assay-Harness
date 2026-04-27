import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTrustBasisGate } from "../dist/trust_basis_gate.js";
import {
  formatTrustBasisJUnit,
  runTrustBasisReport,
} from "../dist/trust_basis_report.js";

const fixtureRoot = join(process.cwd(), "fixtures", "trust-basis");
const baseline = join(fixtureRoot, "baseline.trust-basis.json");
const candidateNonregression = join(fixtureRoot, "candidate-nonregression.trust-basis.json");
const candidateRegression = join(fixtureRoot, "candidate-regression.trust-basis.json");
const nonregressionDiff = join(fixtureRoot, "nonregression.trust-basis.diff.json");
const regressionDiff = join(fixtureRoot, "regression.trust-basis.diff.json");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "assay-harness-p37-contract-"));
}

function writeFixtureAssay(path, fixturePath, exitCode) {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
process.stdout.write(fs.readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
process.exit(${exitCode});
`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

test("contract fixture non-regression projects metadata-only drift without blocking", () => {
  const dir = tempDir();
  const summaryOut = join(dir, "summary.md");
  const junitOut = join(dir, "junit.xml");

  const result = runTrustBasisReport({
    diff: nonregressionDiff,
    summaryOut,
    junitOut,
  });
  const junit = readFileSync(junitOut, "utf8");

  assert.equal(result.report.schema, "assay.trust-basis.diff.v1");
  assert.equal(result.report.summary.has_regressions, false);
  assert.equal(result.report.summary.metadata_changes, 1);
  assert.equal(result.report.summary.unchanged_claim_count, 7);
  assert.match(readFileSync(summaryOut, "utf8"), /Metadata changes \| 1 \| no/);
  assert.match(junit, /failures="0"/);
  assert.match(junit, /metadata_changes.external_eval_receipt_boundary_visible/);
});

test("contract fixture regression projects blocking JUnit failure", () => {
  const result = runTrustBasisReport({ diff: regressionDiff });
  const junit = formatTrustBasisJUnit(result.report);

  assert.equal(result.report.summary.has_regressions, true);
  assert.equal(result.report.summary.regressed_claims, 1);
  assert.equal(result.report.regressed_claims[0]?.claim_id, "external_eval_receipt_boundary_visible");
  assert.match(junit, /failures="1"/);
  assert.match(junit, /regressed_claims.external_eval_receipt_boundary_visible/);
});

test("gate consumes checked-in raw Assay diff bytes without reinterpretation", () => {
  const dir = tempDir();
  const assayBin = join(dir, "assay");
  const out = join(dir, "trust-basis.diff.json");
  writeFixtureAssay(assayBin, regressionDiff, 1);

  const result = runTrustBasisGate({
    baseline,
    candidate: candidateRegression,
    out,
    assayBin,
  });

  assert.equal(result.hasRegressions, true);
  assert.equal(result.assayExitCode, 1);
  assert.equal(readFileSync(out, "utf8"), readFileSync(regressionDiff, "utf8"));
});

test("gate preserves non-regression Assay diff bytes", () => {
  const dir = tempDir();
  const assayBin = join(dir, "assay");
  const out = join(dir, "trust-basis.diff.json");
  writeFixtureAssay(assayBin, nonregressionDiff, 0);

  const result = runTrustBasisGate({
    baseline,
    candidate: candidateNonregression,
    out,
    assayBin,
  });

  assert.equal(result.hasRegressions, false);
  assert.equal(result.assayExitCode, 0);
  assert.equal(readFileSync(out, "utf8"), readFileSync(nonregressionDiff, "utf8"));
});

const maybeAssayTest = process.env.ASSAY_BIN ? test : test.skip;

maybeAssayTest("ASSAY_BIN regenerates checked-in Trust Basis diff fixtures byte-for-byte", () => {
  const assayBin = process.env.ASSAY_BIN;
  const cases = [
    {
      candidate: candidateNonregression,
      expected: nonregressionDiff,
    },
    {
      candidate: candidateRegression,
      expected: regressionDiff,
    },
  ];

  for (const fixture of cases) {
    const result = spawnSync(
      assayBin,
      [
        "trust-basis",
        "diff",
        baseline,
        fixture.candidate,
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, readFileSync(fixture.expected, "utf8"));
  }
});
