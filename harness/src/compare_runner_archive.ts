/** Runner archive Tier-1 comparison helpers. */

import {
  checkHonestHealth,
  HonestHealthOptions,
  RunnerArchiveValidation,
  RunnerValidationError,
  validateRunnerArchive,
} from "./runner_archive.js";

// ---------------------------------------------------------------------------
// Runner archive Tier-1 comparison (H6 + H1 + H2)
//
// Phase 2D Tier 1 scope (see Rul1an/Assay-Harness#58): recognise a pair of
// Assay-Runner measured-run archives, validate each archive's manifest and
// per-file digests, and apply the honest-health gate. No structural diff
// across archives is performed; capability-surface diff and per-layer
// regression projection are Tier 2.
// ---------------------------------------------------------------------------

/** Per-side Tier-1 validation summary inside a Runner-mode compare result. */
export interface RunnerArchiveSideStatus {
  archive: string;
  recognised: boolean;
  manifest_valid: boolean;
  honest_health_passed: boolean;
  honest_health_reasons: string[];
  /** Strict H1 errors (archive/manifest/file-set/digest). */
  manifest_errors: RunnerValidationError[];
  /**
   * Secondary parse errors for `observation-health.json` and
   * `correlation-report.json`. These do NOT make the manifest invalid;
   * they cause the honest-health gate to fail with a missing-or-malformed
   * reason.
   */
  artifact_parse_errors: RunnerValidationError[];
  run_id?: string;
}

/**
 * Result of a Tier-1 comparison of two Runner archives.
 *
 * Tier 1 only confirms that both archives parse, both manifests verify, and
 * both pass the honest-health gate. `tier2_diff_implemented` is always
 * `false` at Tier 1; a future Tier-2 PR will replace this with structural
 * surface/layer diff fields.
 *
 * `has_regressions` is true when **either** side fails manifest validation
 * or fails the honest-health gate (with `allow_degraded` not set on that
 * side). It does NOT compare the two archives against each other.
 */
export interface RunnerCompareTier1Result {
  mode: "runner_archive";
  baseline: RunnerArchiveSideStatus;
  candidate: RunnerArchiveSideStatus;
  tier2_diff_implemented: false;
  has_regressions: boolean;
  summary: string;
}

function buildSideStatus(
  archivePath: string,
  validation: RunnerArchiveValidation,
  options: HonestHealthOptions,
): RunnerArchiveSideStatus {
  const health = checkHonestHealth(validation, options);
  return {
    archive: archivePath,
    recognised: validation.recognised,
    manifest_valid: validation.manifest_valid,
    honest_health_passed: health.passed,
    honest_health_reasons: health.reasons,
    manifest_errors: validation.manifest_errors,
    artifact_parse_errors: validation.artifact_parse_errors,
    run_id: validation.manifest?.run_id,
  };
}

export function compareRunnerArchivesTier1(
  baselinePath: string,
  candidatePath: string,
  options: HonestHealthOptions = {},
): RunnerCompareTier1Result {
  const baselineValidation = validateRunnerArchive(baselinePath);
  const candidateValidation = validateRunnerArchive(candidatePath);

  const baseline = buildSideStatus(baselinePath, baselineValidation, options);
  const candidate = buildSideStatus(candidatePath, candidateValidation, options);

  const baselineClean =
    baseline.recognised && baseline.manifest_valid && baseline.honest_health_passed;
  const candidateClean =
    candidate.recognised && candidate.manifest_valid && candidate.honest_health_passed;

  const parts: string[] = [];
  if (!baseline.recognised) parts.push("baseline not recognised as Runner archive");
  else if (!baseline.manifest_valid) parts.push("baseline manifest/digest invalid");
  else if (!baseline.honest_health_passed) parts.push("baseline honest-health degraded");
  if (!candidate.recognised) parts.push("candidate not recognised as Runner archive");
  else if (!candidate.manifest_valid) parts.push("candidate manifest/digest invalid");
  else if (!candidate.honest_health_passed) parts.push("candidate honest-health degraded");

  const tier1Clean = baselineClean && candidateClean;
  const summary = tier1Clean
    ? "TIER-1 OK: both Runner archives validated and honest-health clean; structural diff is Tier 2 (not implemented in this version)"
    : `TIER-1 FAIL: ${parts.join("; ")}`;

  return {
    mode: "runner_archive",
    baseline,
    candidate,
    tier2_diff_implemented: false,
    has_regressions: !tier1Clean,
    summary,
  };
}

export function formatRunnerCompareTier1Result(
  result: RunnerCompareTier1Result,
): string {
  const lines: string[] = [];
  lines.push("# Runner Archive Comparison (Tier 1)");
  lines.push("");
  lines.push(`**Status:** ${result.has_regressions ? "TIER-1 FAIL" : "TIER-1 OK"}`);
  lines.push(`**Summary:** ${result.summary}`);
  lines.push("");
  lines.push(
    "> Tier 1 validates each archive's manifest, digests, and honest-health.",
  );
  lines.push(
    "> Structural diff (capability surface, per-layer regressions) is Tier 2 and",
  );
  lines.push("> is not implemented in this version.");
  lines.push("");

  for (const side of [
    { label: "Baseline", status: result.baseline },
    { label: "Candidate", status: result.candidate },
  ]) {
    lines.push(`## ${side.label}`);
    lines.push("");
    lines.push(`- Archive: \`${side.status.archive}\``);
    lines.push(`- Recognised: ${side.status.recognised ? "yes" : "no"}`);
    lines.push(`- Manifest valid: ${side.status.manifest_valid ? "yes" : "no"}`);
    if (side.status.run_id) {
      lines.push(`- Run id: \`${side.status.run_id}\``);
    }
    lines.push(
      `- Honest health: ${side.status.honest_health_passed ? "passed" : "failed"}`,
    );
    if (side.status.manifest_errors.length > 0) {
      lines.push("- Manifest / digest errors (H1):");
      for (const e of side.status.manifest_errors) {
        lines.push(`  - \`${e.code}\`${e.path ? ` (${e.path})` : ""}: ${e.message}`);
      }
    }
    if (side.status.artifact_parse_errors.length > 0) {
      lines.push("- Artifact parse errors (observation-health / correlation-report):");
      for (const e of side.status.artifact_parse_errors) {
        lines.push(`  - \`${e.code}\`${e.path ? ` (${e.path})` : ""}: ${e.message}`);
      }
    }
    if (side.status.honest_health_reasons.length > 0) {
      lines.push("- Honest-health reasons:");
      for (const r of side.status.honest_health_reasons) {
        lines.push(`  - \`${r}\``);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
