/**
 * Tier 2A — capability-surface diff over two Tier-1-clean Runner archives.
 *
 * Scope (Rul1an/Assay-Harness#58, Tier 2A refinement):
 *
 *   - Reads two Runner archives that both pass Tier 1 (recognised,
 *     manifest_valid, honest_health.passed).
 *   - Diffs only the `assay.runner.capability_surface.v0` payload of each
 *     archive across the five v0 set categories.
 *   - Applies a conservative v0 regression policy: added entries in
 *     `filesystem_paths`, `network_endpoints`, `process_execs`, and
 *     `mcp_tools` count as regressions. For `policy_decisions`, only new
 *     `allow:*` decisions block; new `deny:*` decisions are report-only
 *     because they typically reflect newly visible blocked behaviour rather
 *     than added capability surface.
 *   - Does NOT reinterpret kernel telemetry, does NOT introduce new artifact
 *     semantics, and does NOT compare across runtimes. Cross-runtime diff
 *     consumption is Tier 2C and is deferred.
 *   - Tier 2B (per-layer reviewer projection) is a separate PR and is
 *     explanatory only — it does not extend the regression policy below.
 *
 * Tier 2A is **archive-only**: the layer ndjson streams are not consulted.
 * If a stricter or more granular regression signal is ever required, that
 * is a Tier 2B/2C question, not a v0 broadening here.
 */

import {
  checkHonestHealth,
  HonestHealthOptions,
  RunnerArchiveValidation,
  RunnerCapabilitySurface,
  RunnerValidationError,
  validateRunnerArchive,
} from "./runner_archive.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapabilityCategoryDiff {
  added: string[];
  removed: string[];
  /**
   * Entries present in both baseline and candidate. Always populated; the
   * markdown formatter omits this list to keep reviewer output focused on
   * `added` and `removed`. JSON consumers may use it.
   */
  unchanged: string[];
}

export interface CapabilitySurfaceDiff {
  filesystem_paths: CapabilityCategoryDiff;
  network_endpoints: CapabilityCategoryDiff;
  process_execs: CapabilityCategoryDiff;
  mcp_tools: CapabilityCategoryDiff;
  policy_decisions: CapabilityCategoryDiff;
}

/** Per-side Tier-1 summary, mirrored from compare.ts but expressed locally
 *  to avoid coupling runner_compare back to compare. */
export interface RunnerSideStatus {
  archive: string;
  recognised: boolean;
  manifest_valid: boolean;
  honest_health_passed: boolean;
  honest_health_reasons: string[];
  manifest_errors: RunnerValidationError[];
  artifact_parse_errors: RunnerValidationError[];
  run_id?: string;
}

export interface RunnerCompareResult {
  mode: "runner_archive";
  tier: "capability_surface_diff";
  baseline: RunnerSideStatus;
  candidate: RunnerSideStatus;
  baseline_run_id?: string;
  candidate_run_id?: string;
  /** True only if both archives passed Tier 1. Tier 2 only runs when true. */
  tier1_clean: boolean;
  /** Present iff `tier1_clean` and both archives carry a capability surface. */
  capability_surface?: CapabilitySurfaceDiff;
  /**
   * Structured reasons that fired the regression flag. Each is of the form
   * `<category>_added:<count>` for the four hard-gated set categories, or
   * `policy_allow_decisions_added:<count>` for the policy-decision subset
   * that v0 treats as blocking. New `deny:*` policy decisions are
   * recorded only in `capability_surface.policy_decisions.added` and do
   * NOT appear here.
   */
  regression_reasons: string[];
  has_regressions: boolean;
  summary: string;
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

function diffStringSets(
  baseline: string[],
  candidate: string[],
): CapabilityCategoryDiff {
  // Deduplicate inputs first. The v0 capability_surface contract treats
  // each category as a deterministic set, but the differ should not amplify
  // duplicates from an upstream producer into false regressions. Diffs are
  // computed against the unique values; outputs are sorted for stable JSON
  // and reviewer markdown.
  const baseSet = new Set(baseline);
  const candSet = new Set(candidate);
  const added = [...candSet].filter((x) => !baseSet.has(x));
  const removed = [...baseSet].filter((x) => !candSet.has(x));
  const unchanged = [...baseSet].filter((x) => candSet.has(x));
  added.sort();
  removed.sort();
  unchanged.sort();
  return { added, removed, unchanged };
}

function diffCapabilitySurface(
  baseline: RunnerCapabilitySurface,
  candidate: RunnerCapabilitySurface,
): CapabilitySurfaceDiff {
  return {
    filesystem_paths: diffStringSets(
      baseline.filesystem_paths,
      candidate.filesystem_paths,
    ),
    network_endpoints: diffStringSets(
      baseline.network_endpoints,
      candidate.network_endpoints,
    ),
    process_execs: diffStringSets(baseline.process_execs, candidate.process_execs),
    mcp_tools: diffStringSets(baseline.mcp_tools, candidate.mcp_tools),
    policy_decisions: diffStringSets(
      baseline.policy_decisions,
      candidate.policy_decisions,
    ),
  };
}

// ---------------------------------------------------------------------------
// Regression policy
// ---------------------------------------------------------------------------

/**
 * Classify a `policy_decisions` entry by its `<decision>:<key>` prefix.
 * Entries that don't begin with `allow:` or `deny:` are out-of-contract for
 * v0 and treated as `other` (report-only, not a regression — they should
 * not exist in well-formed v0 archives and are surfaced through
 * `capability_surface.policy_decisions.added` for visibility).
 */
function policyDecisionKind(decision: string): "allow" | "deny" | "other" {
  if (decision.startsWith("allow:")) return "allow";
  if (decision.startsWith("deny:")) return "deny";
  return "other";
}

function computeRegressionReasons(diff: CapabilitySurfaceDiff): string[] {
  const reasons: string[] = [];
  if (diff.filesystem_paths.added.length > 0) {
    reasons.push(`filesystem_paths_added:${diff.filesystem_paths.added.length}`);
  }
  if (diff.network_endpoints.added.length > 0) {
    reasons.push(`network_endpoints_added:${diff.network_endpoints.added.length}`);
  }
  if (diff.process_execs.added.length > 0) {
    reasons.push(`process_execs_added:${diff.process_execs.added.length}`);
  }
  if (diff.mcp_tools.added.length > 0) {
    reasons.push(`mcp_tools_added:${diff.mcp_tools.added.length}`);
  }
  // policy_decisions: only new `allow:*` entries block. New `deny:*`
  // entries are report-only because they typically indicate that a newly
  // attempted operation was blocked — visible behaviour change, not a
  // capability-surface expansion.
  const allowAdded = diff.policy_decisions.added.filter(
    (d) => policyDecisionKind(d) === "allow",
  );
  if (allowAdded.length > 0) {
    reasons.push(`policy_allow_decisions_added:${allowAdded.length}`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Side status builder
// ---------------------------------------------------------------------------

function buildSideStatus(
  archivePath: string,
  validation: RunnerArchiveValidation,
  options: HonestHealthOptions,
): RunnerSideStatus {
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

function sideTier1Clean(side: RunnerSideStatus): boolean {
  return side.recognised && side.manifest_valid && side.honest_health_passed;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Validate both archives at Tier 1; if both clean, compute the
 * capability-surface diff and apply the v0 regression policy.
 *
 * If either side fails Tier 1, return early with `tier1_clean: false`,
 * `has_regressions: true`, and a summary that points at the failing
 * side(s). Tier 2 is not computed in that case because the input is not
 * trustworthy.
 *
 * If either side passes Tier 1 but does not carry a
 * `capability-surface.json` payload, the diff cannot be computed; the
 * result reports `capability_surface_unavailable` as a regression reason
 * so the caller surfaces it instead of silently passing.
 */
export function compareRunnerArchivesCapabilitySurface(
  baselinePath: string,
  candidatePath: string,
  options: HonestHealthOptions = {},
): RunnerCompareResult {
  const baselineValidation = validateRunnerArchive(baselinePath);
  const candidateValidation = validateRunnerArchive(candidatePath);
  const baseline = buildSideStatus(baselinePath, baselineValidation, options);
  const candidate = buildSideStatus(candidatePath, candidateValidation, options);

  const tier1Clean = sideTier1Clean(baseline) && sideTier1Clean(candidate);

  if (!tier1Clean) {
    const parts: string[] = [];
    if (!sideTier1Clean(baseline)) parts.push("baseline failed Tier 1");
    if (!sideTier1Clean(candidate)) parts.push("candidate failed Tier 1");
    return {
      mode: "runner_archive",
      tier: "capability_surface_diff",
      baseline,
      candidate,
      baseline_run_id: baseline.run_id,
      candidate_run_id: candidate.run_id,
      tier1_clean: false,
      regression_reasons: ["tier1_validation_failed"],
      has_regressions: true,
      summary: `TIER-2A SKIPPED: ${parts.join("; ")}`,
    };
  }

  // Both sides Tier-1 clean. capability_surface should be present; if it
  // isn't, the archive is well-formed but lacks the payload we need.
  const baseSurface = baselineValidation.capability_surface;
  const candSurface = candidateValidation.capability_surface;
  if (!baseSurface || !candSurface) {
    return {
      mode: "runner_archive",
      tier: "capability_surface_diff",
      baseline,
      candidate,
      baseline_run_id: baseline.run_id,
      candidate_run_id: candidate.run_id,
      tier1_clean: true,
      regression_reasons: ["capability_surface_unavailable"],
      has_regressions: true,
      summary:
        "TIER-2A SKIPPED: one or both archives lack a parseable capability-surface.json payload",
    };
  }

  const diff = diffCapabilitySurface(baseSurface, candSurface);
  const reasons = computeRegressionReasons(diff);
  const hasRegressions = reasons.length > 0;

  const summary = hasRegressions
    ? `RUNNER CAPABILITY REGRESSION: ${reasons.join(", ")}`
    : "No Runner capability regressions detected";

  return {
    mode: "runner_archive",
    tier: "capability_surface_diff",
    baseline,
    candidate,
    baseline_run_id: baseline.run_id,
    candidate_run_id: candidate.run_id,
    tier1_clean: true,
    capability_surface: diff,
    regression_reasons: reasons,
    has_regressions: hasRegressions,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Formatter (markdown)
// ---------------------------------------------------------------------------

/**
 * Render the Tier-2A result as reviewer markdown. The markdown view
 * deliberately omits the `unchanged` lists per Tier-2A refinement D — they
 * are noise in PR review context and are available in the JSON output for
 * callers that want them.
 *
 * For Tier-1-failing or missing-payload results, render a short
 * skip-explanation rather than an empty diff.
 */
export function formatRunnerCompareResult(result: RunnerCompareResult): string {
  const lines: string[] = [];
  // Status label is derived from the actual outcome class rather than
  // `has_regressions` alone, so Tier-1 failures and missing-payload
  // results are not mis-labelled as "RUNNER CAPABILITY REGRESSION" (they
  // are input-validation failures that exit `artifact_contract` (3)).
  const status = !result.tier1_clean || !result.capability_surface
    ? "TIER-2A SKIPPED"
    : result.has_regressions
      ? "RUNNER CAPABILITY REGRESSION"
      : "OK";
  lines.push("# Runner Capability-Surface Diff (Tier 2A)");
  lines.push("");
  lines.push(`**Status:** ${status}`);
  lines.push(`**Summary:** ${result.summary}`);
  lines.push("");
  if (result.baseline_run_id) {
    lines.push(`- Baseline run id: \`${result.baseline_run_id}\``);
  }
  if (result.candidate_run_id) {
    lines.push(`- Candidate run id: \`${result.candidate_run_id}\``);
  }
  lines.push(`- Baseline archive: \`${result.baseline.archive}\``);
  lines.push(`- Candidate archive: \`${result.candidate.archive}\``);
  lines.push("");

  if (!result.tier1_clean) {
    lines.push("## Tier 1 not clean");
    lines.push("");
    for (const side of [
      { label: "Baseline", status: result.baseline },
      { label: "Candidate", status: result.candidate },
    ]) {
      if (sideTier1Clean(side.status)) continue;
      lines.push(`### ${side.label}`);
      lines.push("");
      if (side.status.manifest_errors.length > 0) {
        lines.push("Manifest / digest errors:");
        for (const e of side.status.manifest_errors) {
          lines.push(`- \`${e.code}\`${e.path ? ` (${e.path})` : ""}: ${e.message}`);
        }
      }
      if (side.status.artifact_parse_errors.length > 0) {
        lines.push("Artifact parse errors:");
        for (const e of side.status.artifact_parse_errors) {
          lines.push(`- \`${e.code}\`${e.path ? ` (${e.path})` : ""}: ${e.message}`);
        }
      }
      if (side.status.honest_health_reasons.length > 0) {
        lines.push("Honest-health reasons:");
        for (const r of side.status.honest_health_reasons) {
          lines.push(`- \`${r}\``);
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  if (!result.capability_surface) {
    lines.push(
      "Capability surface unavailable — one or both archives do not carry a parseable `capability-surface.json` payload.",
    );
    return lines.join("\n");
  }

  // Markdown: `added` and `removed` only. JSON consumers see `unchanged`.
  const renderCategory = (label: string, key: keyof CapabilitySurfaceDiff) => {
    const diff = result.capability_surface![key];
    if (diff.added.length === 0 && diff.removed.length === 0) return;
    lines.push(`## ${label}`);
    lines.push("");
    if (diff.added.length > 0) {
      lines.push("Added:");
      for (const item of diff.added) {
        lines.push(`- \`${item}\``);
      }
    }
    if (diff.removed.length > 0) {
      lines.push("Removed (not blocking in v0):");
      for (const item of diff.removed) {
        lines.push(`- \`${item}\``);
      }
    }
    lines.push("");
  };

  renderCategory("Filesystem Paths", "filesystem_paths");
  renderCategory("Network Endpoints", "network_endpoints");
  renderCategory("Process Execs", "process_execs");
  renderCategory("MCP Tools", "mcp_tools");
  renderCategory("Policy Decisions", "policy_decisions");

  if (result.regression_reasons.length > 0) {
    lines.push("## Regression Reasons");
    lines.push("");
    for (const r of result.regression_reasons) {
      lines.push(`- \`${r}\``);
    }
    lines.push("");
    lines.push(
      "> v0 policy: added `filesystem_paths`, `network_endpoints`, `process_execs`, and `mcp_tools` are regressions. For `policy_decisions`, only new `allow:*` entries block; new `deny:*` entries are recorded as report-only changes (typically reflecting newly visible blocked behaviour rather than added capability surface).",
    );
    lines.push("");
  }

  return lines.join("\n");
}
