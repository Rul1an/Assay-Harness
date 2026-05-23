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

// ---------------------------------------------------------------------------
// Constants (pinned to Rul1an/assay@main contract)
// ---------------------------------------------------------------------------

export const RUNNER_CROSS_RUNTIME_DIFF_SCHEMA =
  "assay.runner.cross_runtime_diff.v0";

/**
 * The marker value v0 requires on the `binding_ids.comparison` and
 * `policy_outcomes.comparison` fields. Per the cross-runtime v0 contract,
 * binding ids are not cross-runtime comparable and policy outcomes are
 * out of scope for cross-runtime diff. Any other value at this position
 * is a contract failure on the diff itself.
 */
export const RUNNER_CROSS_RUNTIME_OUT_OF_SCOPE_MARKER =
  "out_of_scope_cross_runtime_v0";

/**
 * The marker value v0 requires on `sdk_metadata.comparison`. SDK metadata
 * is reported only as side-band runtime provenance and must not be
 * interpreted as a capability surface diff.
 */
export const RUNNER_CROSS_RUNTIME_SDK_METADATA_MARKER =
  "side_band_provenance";

// ---------------------------------------------------------------------------
// Types — mirror the cross-runtime diff v0 shape exactly
// ---------------------------------------------------------------------------

export interface CrossRuntimeCategoryDiff {
  added: string[];
  removed: string[];
  unchanged: string[];
}

export interface CrossRuntimeSurface {
  filesystem_paths: CrossRuntimeCategoryDiff;
  network_endpoints: CrossRuntimeCategoryDiff;
  process_execs: CrossRuntimeCategoryDiff;
  mcp_tools: CrossRuntimeCategoryDiff;
  policy_decisions: CrossRuntimeCategoryDiff;
}

export interface CrossRuntimeSdkSide {
  sdk_name: string;
  sdk_version: string;
}

export interface CrossRuntimeDiff {
  schema: string;
  base_run_id: string;
  head_run_id: string;
  base_runtime: string;
  head_runtime: string;
  status: string;
  preconditions: Record<string, unknown>;
  scope: Record<string, unknown>;
  canonicalization: Record<string, unknown>;
  surface: CrossRuntimeSurface;
  binding_ids: { comparison: string };
  policy_outcomes: { comparison: string };
  sdk_metadata: {
    comparison: string;
    base: CrossRuntimeSdkSide;
    head: CrossRuntimeSdkSide;
  };
  unbound: Record<string, unknown>;
  non_claims: string[];
  ambiguities: string[];
  notes: string[];
}

export interface CrossRuntimeValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface CrossRuntimeValidation {
  valid: boolean;
  errors: CrossRuntimeValidationError[];
  diff?: CrossRuntimeDiff;
}

export interface CrossRuntimeReport {
  diff_path: string;
  validation: CrossRuntimeValidation;
  /**
   * `true` when at least one surface category has a non-empty `added`
   * list. Tier 3A renders this in the report status line; Tier 3C `gate`
   * (future) will translate the same signal into exit code 6.
   */
  has_added_capability: boolean;
  /**
   * Counts of `added` entries per surface category. The same set the
   * regression line is derived from. Useful for JSON consumers that want
   * the regression summary without re-summing `added` arrays.
   */
  added_counts: {
    filesystem_paths: number;
    network_endpoints: number;
    process_execs: number;
    mcp_tools: number;
    policy_decisions: number;
  };
  /**
   * `true` iff `sdk_metadata.base.sdk_name + sdk_version` differs from
   * `head.sdk_name + sdk_version`. Recorded as side-band only — never a
   * regression.
   */
  sdk_metadata_changed: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

function isCategoryDiff(value: unknown): value is CrossRuntimeCategoryDiff {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    isStringArray(v.added) && isStringArray(v.removed) && isStringArray(v.unchanged)
  );
}

function categoryShapeError(
  path: string,
  value: unknown,
): CrossRuntimeValidationError | null {
  if (!value || typeof value !== "object") {
    return {
      code: "CROSS_RUNTIME_CATEGORY_SHAPE_INVALID",
      message: `${path} must be an object with string-array fields`,
      path,
    };
  }
  const v = value as Record<string, unknown>;
  for (const k of ["added", "removed", "unchanged"] as const) {
    if (!isStringArray(v[k])) {
      return {
        code: "CROSS_RUNTIME_CATEGORY_SHAPE_INVALID",
        message: `${path}.${k} must be an array of strings`,
        path: `${path}.${k}`,
      };
    }
  }
  return null;
}

/**
 * Validate a parsed cross-runtime-diff JSON payload against the v0
 * contract shape. Returns a structured result with `errors[]` and the
 * parsed diff (only when `valid === true`).
 *
 * Strict checks performed:
 *
 * - `schema === "assay.runner.cross_runtime_diff.v0"`
 * - `base_runtime`, `head_runtime`, `base_run_id`, `head_run_id`, `status`
 *   are non-empty strings
 * - `surface.<category>` is `{added, removed, unchanged}` of string arrays
 *   for all five categories
 * - `binding_ids.comparison === "out_of_scope_cross_runtime_v0"`
 * - `policy_outcomes.comparison === "out_of_scope_cross_runtime_v0"`
 * - `sdk_metadata.comparison === "side_band_provenance"`
 * - `sdk_metadata.base.sdk_name + sdk_version` and `.head.*` are strings
 *
 * Loosely validated (presence + object-shape, not field-by-field):
 *
 * - `preconditions`, `scope`, `canonicalization`, `unbound` are objects.
 *   The v0 contract has many fields here; Tier 3A consumes them as
 *   pass-through and lets the Runner side own their semantics.
 *
 * `non_claims`, `ambiguities`, `notes` must be string arrays.
 */
export function validateCrossRuntimeDiff(
  raw: unknown,
): CrossRuntimeValidation {
  const errors: CrossRuntimeValidationError[] = [];
  if (!raw || typeof raw !== "object") {
    return {
      valid: false,
      errors: [
        {
          code: "CROSS_RUNTIME_NOT_OBJECT",
          message: "cross-runtime diff payload must be a JSON object",
        },
      ],
    };
  }
  const d = raw as Record<string, unknown>;
  if (d.schema !== RUNNER_CROSS_RUNTIME_DIFF_SCHEMA) {
    return {
      valid: false,
      errors: [
        {
          code: "CROSS_RUNTIME_SCHEMA_MISMATCH",
          message: `Expected schema ${RUNNER_CROSS_RUNTIME_DIFF_SCHEMA}; got ${
            typeof d.schema === "string" ? JSON.stringify(d.schema) : "(missing)"
          }`,
        },
      ],
    };
  }
  for (const key of [
    "base_run_id",
    "head_run_id",
    "base_runtime",
    "head_runtime",
    "status",
  ] as const) {
    if (typeof d[key] !== "string" || (d[key] as string).length === 0) {
      errors.push({
        code: "CROSS_RUNTIME_FIELD_INVALID",
        message: `${key} must be a non-empty string`,
        path: key,
      });
    }
  }
  for (const k of ["preconditions", "scope", "canonicalization", "unbound"] as const) {
    if (!d[k] || typeof d[k] !== "object" || Array.isArray(d[k])) {
      errors.push({
        code: "CROSS_RUNTIME_FIELD_INVALID",
        message: `${k} must be an object`,
        path: k,
      });
    }
  }
  if (!d.surface || typeof d.surface !== "object" || Array.isArray(d.surface)) {
    errors.push({
      code: "CROSS_RUNTIME_SURFACE_MISSING",
      message: "surface must be an object containing the five v0 categories",
      path: "surface",
    });
  } else {
    const surface = d.surface as Record<string, unknown>;
    for (const cat of [
      "filesystem_paths",
      "network_endpoints",
      "process_execs",
      "mcp_tools",
      "policy_decisions",
    ] as const) {
      const e = categoryShapeError(`surface.${cat}`, surface[cat]);
      if (e) errors.push(e);
    }
  }
  // binding_ids: v0 requires out-of-scope marker. Any other value is a
  // contract violation on the diff itself.
  const bidComparison =
    d.binding_ids && typeof d.binding_ids === "object"
      ? (d.binding_ids as Record<string, unknown>).comparison
      : undefined;
  if (bidComparison !== RUNNER_CROSS_RUNTIME_OUT_OF_SCOPE_MARKER) {
    errors.push({
      code: "CROSS_RUNTIME_BINDING_IDS_MARKER_INVALID",
      message: `binding_ids.comparison must equal ${JSON.stringify(
        RUNNER_CROSS_RUNTIME_OUT_OF_SCOPE_MARKER,
      )} (v0 contract: binding ids are not cross-runtime comparable); got ${
        bidComparison === undefined ? "(missing)" : JSON.stringify(bidComparison)
      }`,
      path: "binding_ids.comparison",
    });
  }
  const poComparison =
    d.policy_outcomes && typeof d.policy_outcomes === "object"
      ? (d.policy_outcomes as Record<string, unknown>).comparison
      : undefined;
  if (poComparison !== RUNNER_CROSS_RUNTIME_OUT_OF_SCOPE_MARKER) {
    errors.push({
      code: "CROSS_RUNTIME_POLICY_OUTCOMES_MARKER_INVALID",
      message: `policy_outcomes.comparison must equal ${JSON.stringify(
        RUNNER_CROSS_RUNTIME_OUT_OF_SCOPE_MARKER,
      )} (v0 contract: policy outcomes are out of scope for cross-runtime diff); got ${
        poComparison === undefined ? "(missing)" : JSON.stringify(poComparison)
      }`,
      path: "policy_outcomes.comparison",
    });
  }
  // sdk_metadata: required side-band marker plus base + head provenance.
  if (!d.sdk_metadata || typeof d.sdk_metadata !== "object" || Array.isArray(d.sdk_metadata)) {
    errors.push({
      code: "CROSS_RUNTIME_SDK_METADATA_MISSING",
      message: "sdk_metadata must be an object with comparison/base/head fields",
      path: "sdk_metadata",
    });
  } else {
    const sm = d.sdk_metadata as Record<string, unknown>;
    if (sm.comparison !== RUNNER_CROSS_RUNTIME_SDK_METADATA_MARKER) {
      errors.push({
        code: "CROSS_RUNTIME_SDK_METADATA_MARKER_INVALID",
        message: `sdk_metadata.comparison must equal ${JSON.stringify(
          RUNNER_CROSS_RUNTIME_SDK_METADATA_MARKER,
        )}; got ${
          sm.comparison === undefined ? "(missing)" : JSON.stringify(sm.comparison)
        }`,
        path: "sdk_metadata.comparison",
      });
    }
    for (const side of ["base", "head"] as const) {
      const s = sm[side];
      if (!s || typeof s !== "object" || Array.isArray(s)) {
        errors.push({
          code: "CROSS_RUNTIME_SDK_METADATA_SIDE_INVALID",
          message: `sdk_metadata.${side} must be an object with sdk_name/sdk_version`,
          path: `sdk_metadata.${side}`,
        });
        continue;
      }
      const sObj = s as Record<string, unknown>;
      for (const key of ["sdk_name", "sdk_version"] as const) {
        if (typeof sObj[key] !== "string" || (sObj[key] as string).length === 0) {
          errors.push({
            code: "CROSS_RUNTIME_SDK_METADATA_FIELD_INVALID",
            message: `sdk_metadata.${side}.${key} must be a non-empty string`,
            path: `sdk_metadata.${side}.${key}`,
          });
        }
      }
    }
  }
  for (const k of ["non_claims", "ambiguities", "notes"] as const) {
    if (!isStringArray(d[k])) {
      errors.push({
        code: "CROSS_RUNTIME_FIELD_INVALID",
        message: `${k} must be an array of strings`,
        path: k,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, errors, diff: raw as CrossRuntimeDiff };
}

// ---------------------------------------------------------------------------
// Report construction
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

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

void isObject;
