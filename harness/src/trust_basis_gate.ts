import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TrustBasisGateArgs {
  baseline: string;
  candidate: string;
  out: string;
  assayBin?: string;
}

export interface TrustBasisDiffSummary {
  regressed_claims: number;
  improved_claims: number;
  removed_claims: number;
  added_claims: number;
  metadata_changes: number;
  unchanged_claim_count: number;
  has_regressions: boolean;
}

export interface TrustBasisDiffReport {
  schema: "assay.trust-basis.diff.v1";
  claim_identity: "claim.id";
  summary: TrustBasisDiffSummary;
}

export interface TrustBasisGateResult {
  report: TrustBasisDiffReport;
  assayExitCode: number;
  hasRegressions: boolean;
}

export class TrustBasisGateError extends Error {
  readonly kind = "config_error";

  constructor(message: string) {
    super(message);
    this.name = "TrustBasisGateError";
  }
}

export function runTrustBasisGate(args: TrustBasisGateArgs): TrustBasisGateResult {
  validateInputFile("baseline", args.baseline);
  validateInputFile("candidate", args.candidate);
  if (!args.out) {
    throw new TrustBasisGateError("--out is required");
  }

  const assayBin = args.assayBin ?? "assay";
  const result = spawnSync(
    assayBin,
    [
      "trust-basis",
      "diff",
      args.baseline,
      args.candidate,
      "--format",
      "json",
      "--fail-on-regression",
    ],
    { encoding: "utf8" },
  );

  if (result.error) {
    throw new TrustBasisGateError(
      `failed to run ${assayBin}: ${result.error.message}`,
    );
  }

  const status = result.status;
  if (status !== 0 && status !== 1) {
    const stderr = result.stderr.trim();
    throw new TrustBasisGateError(
      stderr || `${assayBin} trust-basis diff exited with code ${status ?? "unknown"}`,
    );
  }

  const rawJson = result.stdout.trim();
  if (!rawJson) {
    throw new TrustBasisGateError("assay trust-basis diff produced no JSON output");
  }

  const report = parseTrustBasisDiffReport(rawJson);
  writeDiffArtifact(args.out, rawJson);

  return {
    report,
    assayExitCode: status,
    hasRegressions: status === 1 || report.summary.has_regressions,
  };
}

export function formatTrustBasisGateSummary(result: TrustBasisGateResult, outPath: string): string {
  const summary = result.report.summary;
  return [
    "[trust-basis-gate] schema: assay.trust-basis.diff.v1",
    `[trust-basis-gate] claim identity: ${result.report.claim_identity}`,
    `[trust-basis-gate] regressed: ${summary.regressed_claims}`,
    `[trust-basis-gate] removed: ${summary.removed_claims}`,
    `[trust-basis-gate] improved: ${summary.improved_claims}`,
    `[trust-basis-gate] added: ${summary.added_claims}`,
    `[trust-basis-gate] metadata changes: ${summary.metadata_changes}`,
    `[trust-basis-gate] unchanged: ${summary.unchanged_claim_count}`,
    `[trust-basis-gate] artifact: ${outPath}`,
  ].join("\n");
}

function validateInputFile(label: "baseline" | "candidate", path: string): void {
  if (!path || !existsSync(path)) {
    throw new TrustBasisGateError(
      `${label} Trust Basis file not found: ${path || "(none)"}`,
    );
  }
}

function writeDiffArtifact(outPath: string, rawJson: string): void {
  const outDir = dirname(outPath);
  if (outDir && outDir !== ".") {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(outPath, rawJson + "\n", "utf8");
}

function parseTrustBasisDiffReport(rawJson: string): TrustBasisDiffReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new TrustBasisGateError("assay trust-basis diff produced invalid JSON");
  }

  if (!isTrustBasisDiffReport(parsed)) {
    throw new TrustBasisGateError(
      "assay trust-basis diff output did not match assay.trust-basis.diff.v1",
    );
  }
  return parsed;
}

function isTrustBasisDiffReport(value: unknown): value is TrustBasisDiffReport {
  if (!value || typeof value !== "object") {
    return false;
  }
  const report = value as Record<string, unknown>;
  return (
    report.schema === "assay.trust-basis.diff.v1" &&
    report.claim_identity === "claim.id" &&
    isSummary(report.summary)
  );
}

function isSummary(value: unknown): value is TrustBasisDiffSummary {
  if (!value || typeof value !== "object") {
    return false;
  }
  const summary = value as Record<string, unknown>;
  return (
    isNonNegativeNumber(summary.regressed_claims) &&
    isNonNegativeNumber(summary.improved_claims) &&
    isNonNegativeNumber(summary.removed_claims) &&
    isNonNegativeNumber(summary.added_claims) &&
    isNonNegativeNumber(summary.metadata_changes) &&
    isNonNegativeNumber(summary.unchanged_claim_count) &&
    typeof summary.has_regressions === "boolean"
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
