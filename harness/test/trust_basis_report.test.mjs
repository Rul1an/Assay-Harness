import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  formatTrustBasisJUnit,
  formatTrustBasisSummaryMarkdown,
  runTrustBasisReport,
  TrustBasisReportError,
} from "../dist/trust_basis_report.js";

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), "assay-harness-trust-basis-report-"));
}

function diffReport(overrides = {}) {
  const summaryOverrides = overrides.summary ?? {};
  const topLevelOverrides = { ...overrides };
  delete topLevelOverrides.summary;
  const summary = {
    regressed_claims: 0,
    improved_claims: 0,
    removed_claims: 0,
    added_claims: 0,
    metadata_changes: 0,
    unchanged_claim_count: 1,
    has_regressions: false,
    ...summaryOverrides,
  };
  return {
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
    ...topLevelOverrides,
  };
}

function writeDiff(path, report) {
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}

test("trust basis reporter projects metadata-only drift without JUnit failures", () => {
  const dir = fixtureDir();
  const diff = join(dir, "trust-basis.diff.json");
  const summaryOut = join(dir, "summary.md");
  const junitOut = join(dir, "junit.xml");
  writeDiff(
    diff,
    diffReport({
      summary: { metadata_changes: 1, unchanged_claim_count: 0 },
      metadata_changes: [
        {
          diff_class: "metadata_changed",
          claim_id: "external_eval_receipt_boundary_visible",
          baseline_level: "verified",
          candidate_level: "verified",
        },
      ],
    }),
  );

  const result = runTrustBasisReport({ diff, summaryOut, junitOut });

  assert.equal(result.report.summary.has_regressions, false);
  assert.match(readFileSync(summaryOut, "utf8"), /\*\*Status:\*\* OK/);
  assert.match(readFileSync(summaryOut, "utf8"), /Metadata changes \| 1 \| no/);
  assert.match(readFileSync(junitOut, "utf8"), /failures="0"/);
  assert.match(readFileSync(junitOut, "utf8"), /<testsuites>/);
});

test("trust basis reporter maps regressions and removals to JUnit failures", () => {
  const report = diffReport({
    summary: { regressed_claims: 1, removed_claims: 1, unchanged_claim_count: 0, has_regressions: true },
    regressed_claims: [
      {
        diff_class: "regressed",
        claim_id: "z_claim",
        baseline_level: "verified",
        candidate_level: "absent",
      },
    ],
    removed_claims: [
      {
        diff_class: "removed",
        claim_id: "a_claim",
        baseline_level: "verified",
        candidate_level: null,
      },
    ],
  });

  const junit = formatTrustBasisJUnit(report);
  const firstA = junit.indexOf("removed_claims.a_claim");
  const firstZ = junit.indexOf("regressed_claims.z_claim");

  assert.match(junit, /failures="2"/);
  assert.match(junit, /<testsuites>/);
  assert.match(junit, /<testsuite name="assay.trust-basis.diff" tests="2" failures="2" errors="0" skipped="0" time="0">/);
  assert.match(junit, /<failure message="a_claim: verified -&gt; absent">/);
  assert.ok(firstA > -1 && firstZ > -1 && firstA < firstZ, "testcases should be deterministic");
});

test("trust basis markdown summary includes bounded blocking claim lists", () => {
  const markdown = formatTrustBasisSummaryMarkdown(
    diffReport({
      summary: { regressed_claims: 1, unchanged_claim_count: 0, has_regressions: true },
      regressed_claims: [
        {
          diff_class: "regressed",
          claim_id: "external_eval_receipt_boundary_visible",
          baseline_level: "verified",
          candidate_level: "absent",
        },
      ],
    }),
    "trust-basis.diff.json",
  );

  assert.match(markdown, /\*\*Status:\*\* REGRESSION/);
  assert.match(markdown, /### Regressed Claims/);
  assert.match(markdown, /external_eval_receipt_boundary_visible/);
  assert.doesNotMatch(markdown, /"schema"/);
});

test("trust basis reporter rejects unknown diff schemas", () => {
  const dir = fixtureDir();
  const diff = join(dir, "trust-basis.diff.json");
  writeDiff(diff, { ...diffReport(), schema: "assay.trust-basis.diff.v2" });

  assert.throws(
    () => runTrustBasisReport({ diff }),
    (error) =>
      error instanceof TrustBasisReportError &&
      error.kind === "config_error" &&
      error.message.includes("unsupported schema"),
  );
});

test("trust basis reporter rejects malformed diff item levels", () => {
  const dir = fixtureDir();
  const diff = join(dir, "trust-basis.diff.json");
  writeDiff(
    diff,
    diffReport({
      summary: { regressed_claims: 1, unchanged_claim_count: 0, has_regressions: true },
      regressed_claims: [
        {
          diff_class: "regressed",
          claim_id: "external_eval_receipt_boundary_visible",
          baseline_level: { bad: true },
          candidate_level: "absent",
        },
      ],
    }),
  );

  assert.throws(
    () => runTrustBasisReport({ diff }),
    (error) =>
      error instanceof TrustBasisReportError &&
      error.kind === "config_error" &&
      error.message.includes("regressed_claims must contain valid diff items"),
  );
});

test("trust basis reporter rejects inconsistent summary counts", () => {
  const dir = fixtureDir();
  const diff = join(dir, "trust-basis.diff.json");
  writeDiff(
    diff,
    diffReport({
      summary: { regressed_claims: 2, unchanged_claim_count: 0, has_regressions: true },
      regressed_claims: [
        {
          diff_class: "regressed",
          claim_id: "external_eval_receipt_boundary_visible",
          baseline_level: "verified",
          candidate_level: "absent",
        },
      ],
    }),
  );

  assert.throws(
    () => runTrustBasisReport({ diff }),
    (error) =>
      error instanceof TrustBasisReportError &&
      error.kind === "config_error" &&
      error.message.includes("summary counts must match diff arrays"),
  );
});

test("trust basis reporter distinguishes read and parse failures", () => {
  const dir = fixtureDir();
  const missing = join(dir, "missing.json");
  const invalidJson = join(dir, "invalid.json");
  writeFileSync(invalidJson, "{not json", "utf8");

  assert.throws(
    () => runTrustBasisReport({ diff: missing }),
    (error) =>
      error instanceof TrustBasisReportError &&
      error.kind === "config_error" &&
      error.message.includes("Trust Basis diff file not found"),
  );
  assert.throws(
    () => runTrustBasisReport({ diff: invalidJson }),
    (error) =>
      error instanceof TrustBasisReportError &&
      error.kind === "config_error" &&
      error.message.includes("failed to parse Trust Basis diff JSON"),
  );
});

test("CLI trust-basis report writes markdown and JUnit projections without gating", () => {
  const dir = fixtureDir();
  const diff = join(dir, "trust-basis.diff.json");
  const summaryOut = join(dir, "summary.md");
  const junitOut = join(dir, "junit.xml");
  writeDiff(
    diff,
    diffReport({
      summary: { regressed_claims: 1, unchanged_claim_count: 0, has_regressions: true },
      regressed_claims: [
        {
          diff_class: "regressed",
          claim_id: "external_eval_receipt_boundary_visible",
          baseline_level: "verified",
          candidate_level: "absent",
        },
      ],
    }),
  );

  const cli = join(process.cwd(), "dist", "cli.js");
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "trust-basis",
      "report",
      "--diff",
      diff,
      "--summary-out",
      summaryOut,
      "--junit-out",
      junitOut,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  assert.equal(existsSync(summaryOut), true);
  assert.equal(existsSync(junitOut), true);
  assert.match(result.stdout, /schema: assay.trust-basis.diff.v1/);
});

test("CLI trust-basis report maps projection write failures to ci formatter exit", () => {
  const dir = fixtureDir();
  const diff = join(dir, "trust-basis.diff.json");
  const summaryOut = join(dir, "summary-as-directory");
  writeDiff(diff, diffReport());
  mkdirSync(summaryOut);

  const cli = join(process.cwd(), "dist", "cli.js");
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "trust-basis",
      "report",
      "--diff",
      diff,
      "--summary-out",
      summaryOut,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 7);
  assert.match(result.stderr, /\[ci_formatter\]/);
});
