import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  formatTrustBasisGateSummary,
  runTrustBasisGate,
  TrustBasisGateError,
} from "../dist/trust_basis_gate.js";

function writeTrustBasis(path) {
  writeFileSync(
    path,
    JSON.stringify(
      {
        claims: [
          {
            id: "external_eval_receipt_boundary_visible",
            level: "verified",
            source: "external_evidence_receipt",
            boundary: "supported-external-eval-receipt-events-only",
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function writeFakeAssay(path) {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const candidate = process.argv[5] || "";
const isRegression = candidate.includes("regression");
const summary = {
  regressed_claims: isRegression ? 1 : 0,
  improved_claims: 0,
  removed_claims: 0,
  added_claims: 0,
  metadata_changes: candidate.includes("metadata") ? 1 : 0,
  unchanged_claim_count: isRegression ? 0 : 1,
  has_regressions: isRegression,
};
process.stdout.write(JSON.stringify({
  schema: "assay.trust-basis.diff.v1",
  claim_identity: "claim.id",
  level_order: ["absent", "inferred", "self_reported", "verified"],
  summary,
  regressed_claims: [],
  improved_claims: [],
  removed_claims: [],
  added_claims: [],
  metadata_changes: [],
  unchanged_claim_count: summary.unchanged_claim_count,
}, null, 2) + "\\n");
process.exit(isRegression ? 1 : 0);
`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "assay-harness-trust-basis-gate-"));
  const baseline = join(dir, "baseline.trust-basis.json");
  const candidate = join(dir, "candidate.trust-basis.json");
  const assayBin = join(dir, "assay");
  writeTrustBasis(baseline);
  writeTrustBasis(candidate);
  writeFakeAssay(assayBin);
  return { dir, baseline, candidate, assayBin };
}

test("trust basis gate writes the raw diff artifact on success", () => {
  const { dir, baseline, candidate, assayBin } = fixtureDir();
  const out = join(dir, "trust-basis.diff.json");

  const result = runTrustBasisGate({ baseline, candidate, out, assayBin });

  assert.equal(result.hasRegressions, false);
  assert.equal(result.assayExitCode, 0);
  assert.equal(result.report.schema, "assay.trust-basis.diff.v1");
  assert.equal(existsSync(out), true);
  const expectedRawDiff = JSON.stringify(
    {
      schema: "assay.trust-basis.diff.v1",
      claim_identity: "claim.id",
      level_order: ["absent", "inferred", "self_reported", "verified"],
      summary: {
        regressed_claims: 0,
        improved_claims: 0,
        removed_claims: 0,
        added_claims: 0,
        metadata_changes: 0,
        unchanged_claim_count: 1,
        has_regressions: false,
      },
      regressed_claims: [],
      improved_claims: [],
      removed_claims: [],
      added_claims: [],
      metadata_changes: [],
      unchanged_claim_count: 1,
    },
    null,
    2,
  ) + "\n";
  assert.equal(readFileSync(out, "utf8"), expectedRawDiff);
});

test("trust basis gate preserves diff artifact when Assay reports a regression", () => {
  const { dir, baseline, assayBin } = fixtureDir();
  const candidate = join(dir, "candidate-regression.trust-basis.json");
  const out = join(dir, "trust-basis.diff.json");
  writeTrustBasis(candidate);

  const result = runTrustBasisGate({ baseline, candidate, out, assayBin });

  assert.equal(result.hasRegressions, true);
  assert.equal(result.assayExitCode, 1);
  assert.equal(result.report.summary.regressed_claims, 1);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).summary.has_regressions, true);
});

test("trust basis gate treats metadata-only drift as non-regression", () => {
  const { dir, baseline, assayBin } = fixtureDir();
  const candidate = join(dir, "candidate-metadata.trust-basis.json");
  const out = join(dir, "trust-basis.diff.json");
  writeTrustBasis(candidate);

  const result = runTrustBasisGate({ baseline, candidate, out, assayBin });
  const summary = formatTrustBasisGateSummary(result, out);

  assert.equal(result.hasRegressions, false);
  assert.equal(result.report.summary.metadata_changes, 1);
  assert.match(summary, /metadata changes: 1/);
});

test("trust basis gate rejects missing canonical inputs before invoking Assay", () => {
  const { dir, candidate, assayBin } = fixtureDir();
  const out = join(dir, "trust-basis.diff.json");

  assert.throws(
    () =>
      runTrustBasisGate({
        baseline: join(dir, "missing.trust-basis.json"),
        candidate,
        out,
        assayBin,
      }),
    (error) =>
      error instanceof TrustBasisGateError &&
      error.kind === "config_error" &&
      error.message.includes("baseline Trust Basis file not found"),
  );
});

test("CLI trust-basis gate maps Assay regression to Harness regression exit", () => {
  const { dir, baseline, assayBin } = fixtureDir();
  const candidate = join(dir, "candidate-regression.trust-basis.json");
  const out = join(dir, "trust-basis.diff.json");
  writeTrustBasis(candidate);

  const cli = join(process.cwd(), "dist", "cli.js");
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "trust-basis",
      "gate",
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      "--out",
      out,
      "--assay-bin",
      assayBin,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 6);
  assert.match(result.stdout, /regressed: 1/);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).summary.has_regressions, true);
});
