/**
 * Tier 3A — consume Assay-Runner cross-runtime diff JSON for reviewer
 * projection.
 *
 * Scope (Rul1an/Assay-Harness#58 Tier 3 plan):
 *
 *   Tier 3A is **consumer**, not semantic owner. The Runner side
 *   (`Rul1an/assay`, `crates/assay-runner-schema/` + the cross-runtime
 *   contract docs) defines `assay.runner.cross_runtime_diff.v0` and its
 *   A1+B3+C1 canonicalisation, scope, and non-claim rules. Harness reads
 *   that artefact, validates its frozen shape, and projects it into
 *   reviewer-friendly output.
 *
 * Tier 3A explicitly does NOT:
 *   - compute its own cross-runtime diff
 *   - orchestrate archive pairs (that is Tier 3B, deferred until demand)
 *   - claim that two runtimes are semantically equivalent (`non_claims`
 *     on the diff itself enumerates the limits and Harness must not
 *     contradict them)
 *   - interpret `binding_ids` or `policy_outcomes` beyond the
 *     out-of-scope marker (per v0 contract, those comparisons are
 *     `out_of_scope_cross_runtime_v0`)
 *   - turn `sdk_metadata` into a capability regression (it is
 *     `side_band_provenance`; metadata churn is reported as a side-band
 *     note, never as a regression)
 *
 * Regression semantics in Tier 3A:
 *
 *   - The report renders a "RUNNER CROSS-RUNTIME REGRESSION" status line
 *     when any of `surface.{filesystem_paths,network_endpoints,
 *     process_execs,mcp_tools,policy_decisions}.added` is non-empty.
 *   - Removed entries are reported but never marked as a regression
 *     (matches the within-runtime Tier-2A semantics that removed
 *     capability surface is a change, not a regression).
 *   - Tier 3A's `report` verb is informational only — exit codes are
 *     0 on success, 2 on config error, 3 on invalid diff. Gating exit
 *     codes (regression -> 6) are reserved for the future Tier 3C
 *     `gate` verb.
 *
 * This module does no archive I/O, no JSON Schema 2020-12 validation
 * (the AJV dependency would be a runtime cost; Harness validates shape
 * with explicit TypeScript guards instead), and never throws on
 * structurally invalid input — it returns a structured validation
 * result so the CLI maps errors to stable exit codes.
 */

import { existsSync, readFileSync } from "node:fs";
import { validateCrossRuntimeDiff } from "./runner_cross_runtime_validation.js";
import type { CrossRuntimeDiff, CrossRuntimeReport } from "./runner_cross_runtime_validation.js";

export {
  RUNNER_CROSS_RUNTIME_DIFF_SCHEMA,
  RUNNER_CROSS_RUNTIME_OUT_OF_SCOPE_MARKER,
  RUNNER_CROSS_RUNTIME_REQUIRED_NON_CLAIMS,
  RUNNER_CROSS_RUNTIME_REQUIRED_NOTES,
  RUNNER_CROSS_RUNTIME_RUNTIMES,
  RUNNER_CROSS_RUNTIME_SDK_METADATA_MARKER,
  validateCrossRuntimeDiff,
} from "./runner_cross_runtime_validation.js";
export type {
  CrossRuntimeCategoryDiff,
  CrossRuntimeDiff,
  CrossRuntimeReport,
  CrossRuntimeSdkSide,
  CrossRuntimeSurface,
  CrossRuntimeValidation,
  CrossRuntimeValidationError,
} from "./runner_cross_runtime_validation.js";

// ---------------------------------------------------------------------------
// Report construction
// ---------------------------------------------------------------------------

/**
 * Read a cross-runtime-diff JSON file from disk, validate it, and
 * produce a `CrossRuntimeReport`. Does not throw on structurally invalid
 * input; the caller maps `validation.errors` to exit codes.
 *
 * Throws only on filesystem errors (path not found is handled by the
 * caller via `existsSync` first; permission errors and similar propagate).
 */
export function buildCrossRuntimeReport(diffPath: string): CrossRuntimeReport {
  const text = readFileSync(diffPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      diff_path: diffPath,
      validation: {
        valid: false,
        errors: [
          {
            code: "CROSS_RUNTIME_NOT_JSON",
            message: `${diffPath} is not valid JSON: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
      },
      has_added_capability: false,
      added_counts: {
        filesystem_paths: 0,
        network_endpoints: 0,
        process_execs: 0,
        mcp_tools: 0,
        policy_decisions: 0,
      },
      sdk_metadata_changed: false,
    };
  }
  const validation = validateCrossRuntimeDiff(parsed);
  const counts = {
    filesystem_paths: 0,
    network_endpoints: 0,
    process_execs: 0,
    mcp_tools: 0,
    policy_decisions: 0,
  };
  let sdkChanged = false;
  if (validation.valid && validation.diff) {
    const s = validation.diff.surface;
    counts.filesystem_paths = s.filesystem_paths.added.length;
    counts.network_endpoints = s.network_endpoints.added.length;
    counts.process_execs = s.process_execs.added.length;
    counts.mcp_tools = s.mcp_tools.added.length;
    counts.policy_decisions = s.policy_decisions.added.length;
    const sm = validation.diff.sdk_metadata;
    sdkChanged =
      sm.base.sdk_name !== sm.head.sdk_name ||
      sm.base.sdk_version !== sm.head.sdk_version;
  }
  const hasAdded = Object.values(counts).some((c) => c > 0);
  return {
    diff_path: diffPath,
    validation,
    has_added_capability: hasAdded,
    added_counts: counts,
    sdk_metadata_changed: sdkChanged,
  };
}

// ---------------------------------------------------------------------------
// Markdown formatter
// ---------------------------------------------------------------------------

/**
 * Render the Tier-3A report as reviewer markdown. Status line follows the
 * outcome class: TIER-3A INVALID DIFF when validation fails,
 * RUNNER CROSS-RUNTIME REGRESSION when any added capability surface is
 * non-empty, OK otherwise.
 *
 * SDK metadata is rendered as a side-band note when it differs across the
 * two sides; it never affects the status line.
 *
 * The formatter does not render `unchanged` lists per the Tier-2A
 * refinement-D rule (reviewer noise); JSON consumers can read the diff
 * directly.
 */
export function formatCrossRuntimeReport(report: CrossRuntimeReport): string {
  const lines: string[] = [];
  lines.push("# Runner Cross-Runtime Diff Report (Tier 3A)");
  lines.push("");
  let status: string;
  if (!report.validation.valid) {
    status = "TIER-3A INVALID DIFF";
  } else if (report.has_added_capability) {
    status = "RUNNER CROSS-RUNTIME REGRESSION";
  } else {
    status = "OK";
  }
  lines.push(`**Status:** ${status}`);
  lines.push(`**Diff file:** \`${report.diff_path}\``);
  lines.push("");
  lines.push(
    "> Tier 3A is a consumer of `assay.runner.cross_runtime_diff.v0`. It does NOT",
  );
  lines.push(
    "> compute its own cross-runtime diff and does NOT claim two runtimes are",
  );
  lines.push(
    "> semantically equivalent. The Runner side owns the cross-runtime semantics.",
  );
  lines.push("");

  if (!report.validation.valid) {
    lines.push("## Diff Validation Errors");
    lines.push("");
    for (const e of report.validation.errors) {
      lines.push(`- \`${e.code}\`${e.path ? ` (${e.path})` : ""}: ${e.message}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  const d = report.validation.diff as CrossRuntimeDiff;

  lines.push(`- Base runtime: \`${d.base_runtime}\` (run id \`${d.base_run_id}\`)`);
  lines.push(`- Head runtime: \`${d.head_runtime}\` (run id \`${d.head_run_id}\`)`);
  lines.push(`- Diff status (Runner-side): \`${d.status}\``);
  lines.push("");

  // Per-category section (added/removed only, per refinement D).
  for (const [label, key] of [
    ["Filesystem Paths", "filesystem_paths"],
    ["Network Endpoints", "network_endpoints"],
    ["Process Execs", "process_execs"],
    ["MCP Tools", "mcp_tools"],
    ["Policy Decisions", "policy_decisions"],
  ] as const) {
    const cat = d.surface[key];
    if (cat.added.length === 0 && cat.removed.length === 0) continue;
    lines.push(`## ${label}`);
    lines.push("");
    if (cat.added.length > 0) {
      lines.push("Added (cross-runtime regression):");
      for (const v of cat.added) lines.push(`- \`${v}\``);
    }
    if (cat.removed.length > 0) {
      lines.push("Removed (not blocking in v0):");
      for (const v of cat.removed) lines.push(`- \`${v}\``);
    }
    lines.push("");
  }

  if (report.sdk_metadata_changed) {
    lines.push("## SDK Metadata (side-band only)");
    lines.push("");
    lines.push(
      `- Base: \`${d.sdk_metadata.base.sdk_name}\` @ \`${d.sdk_metadata.base.sdk_version}\``,
    );
    lines.push(
      `- Head: \`${d.sdk_metadata.head.sdk_name}\` @ \`${d.sdk_metadata.head.sdk_version}\``,
    );
    lines.push(
      "> SDK metadata change is reported as runtime provenance and is NEVER",
    );
    lines.push("> treated as a capability regression in v0.");
    lines.push("");
  }

  if (d.non_claims.length > 0) {
    lines.push("## Non-Claims (carried from the diff)");
    lines.push("");
    for (const nc of d.non_claims) lines.push(`- \`${nc}\``);
    lines.push("");
  }
  if (d.ambiguities.length > 0) {
    lines.push("## Ambiguities (carried from the diff)");
    lines.push("");
    for (const a of d.ambiguities) lines.push(`- \`${a}\``);
    lines.push("");
  }
  if (d.notes.length > 0) {
    lines.push("## Notes (carried from the diff)");
    lines.push("");
    for (const n of d.notes) lines.push(`- \`${n}\``);
    lines.push("");
  }

  if (report.has_added_capability) {
    lines.push("## Regression Summary");
    lines.push("");
    for (const [k, v] of Object.entries(report.added_counts)) {
      if (v > 0) lines.push(`- \`${k}_added:${v}\``);
    }
    lines.push("");
    lines.push(
      "> v0 cross-runtime regression policy: added capability surface on any of",
    );
    lines.push(
      "> `filesystem_paths`, `network_endpoints`, `process_execs`, `mcp_tools`,",
    );
    lines.push(
      "> `policy_decisions` is treated as a regression line. Removed entries are",
    );
    lines.push(
      "> reported but never blocking. Tier 3A's `report` verb is informational;",
    );
    lines.push(
      "> exit-code gating is reserved for the future Tier 3C `gate` verb.",
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Convenience for the CLI
// ---------------------------------------------------------------------------

export interface CrossRuntimeReportLoadResult {
  ok: boolean;
  /** Set when the file did not exist. */
  not_found?: boolean;
  report?: CrossRuntimeReport;
}

export function loadCrossRuntimeReport(diffPath: string): CrossRuntimeReportLoadResult {
  if (!existsSync(diffPath)) {
    return { ok: false, not_found: true };
  }
  return { ok: true, report: buildCrossRuntimeReport(diffPath) };
}
