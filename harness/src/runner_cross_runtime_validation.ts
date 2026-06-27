/** Cross-runtime diff v0 validation contract. */

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

/**
 * v0 clean diff invariants — exact values mirrored from the Runner-side
 * JSON Schema 2020-12 sidecar at
 * `Rul1an/assay/docs/reference/runner/schema/cross-runtime-diff-v0-clean.schema.json`.
 *
 * The clean output shape is strictly frozen: `status` must be `"clean"`,
 * `scope` and `canonicalization` and `preconditions` carry fixed values
 * (not just shapes), and the diff must come from two distinct qualified
 * runtimes. A consumer that claims A1+B3+C1 enforcement implements these
 * invariants; otherwise it should downgrade its claim to "shape preview".
 * Harness chooses strict enforcement.
 */

/** Allowed runtime identifiers per the v0 clean schema. */
export const RUNNER_CROSS_RUNTIME_RUNTIMES: readonly string[] = [
  "s5_openai_agents",
  "gemini_google_genai",
];

/** Required status string on a clean diff. */
const CLEAN_STATUS = "clean";

/** Required `preconditions` keys, each required to be `true`. */
const CLEAN_PRECONDITIONS_KEYS: readonly string[] = [
  "base_health_clean",
  "head_health_clean",
  "base_correlation_clean",
  "head_correlation_clean",
  "stable_tool_call_ids_required",
  "stable_tool_call_ids_present",
  "runtimes_distinct",
];

/** Required `scope` exact values. */
const CLEAN_SCOPE: Record<string, boolean | string> = {
  projection: "surface_set",
  uses_raw_telemetry: false,
  uses_proof_pack: false,
  per_binding_capability_values: false,
  cross_runtime: true,
};

/** Required `canonicalization` exact values (A1 work-dir prefix rule). */
const CLEAN_CANONICALIZATION: Record<string, string> = {
  filesystem_paths: "work_dir_prefix_only",
  network_endpoints: "none",
  process_execs: "none",
  mcp_tools: "none",
  policy_decisions: "none",
};

/** Required `non_claims` codes, in this exact order. */
export const RUNNER_CROSS_RUNTIME_REQUIRED_NON_CLAIMS: readonly string[] = [
  "cross_runtime_no_acceptability_judgment",
  "cross_runtime_no_declared_capability_input",
  "cross_runtime_no_derived_binding_identity",
  "cross_runtime_no_filename_semantic_equivalence",
  "cross_runtime_no_sdk_capability_equivalence",
];

/** Required `notes` strings, in this exact order. */
export const RUNNER_CROSS_RUNTIME_REQUIRED_NOTES: readonly string[] = [
  "cross_runtime_diff_binding_ids_out_of_scope: binding ids are not cross-runtime comparable in v0; required only for within-runtime correlation",
  "cross_runtime_diff_sdk_metadata_side_band: sdk metadata reported as side-band runtime provenance, not capability surface",
  "cross_runtime_diff_work_dir_prefix_canonicalized: filesystem_paths normalized via the A1 work-dir prefix rule",
];

/**
 * The five surface and `unbound` categories. Used by both the clean
 * shape check and the empty-unbound-arrays invariant.
 */
const SURFACE_CATEGORIES: readonly string[] = [
  "filesystem_paths",
  "network_endpoints",
  "process_execs",
  "mcp_tools",
  "policy_decisions",
];

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
    const arr = v[k];
    if (!isStringArray(arr)) {
      return {
        code: "CROSS_RUNTIME_CATEGORY_SHAPE_INVALID",
        message: `${path}.${k} must be an array of strings`,
        path: `${path}.${k}`,
      };
    }
    // v0 clean schema requires `uniqueItems` within each list.
    if (new Set(arr).size !== arr.length) {
      return {
        code: "CROSS_RUNTIME_CATEGORY_DUPLICATES",
        message: `${path}.${k} must not contain duplicate entries (v0 clean schema: uniqueItems)`,
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
  // status: v0 clean output is strictly "clean". Partial/failed shapes are
  // out of scope for this consumer; the Runner-side schema sidecar covers
  // only the clean variant.
  if (typeof d.status === "string" && d.status !== CLEAN_STATUS) {
    errors.push({
      code: "CROSS_RUNTIME_STATUS_NOT_CLEAN",
      message: `status must equal ${JSON.stringify(CLEAN_STATUS)} for v0 clean diff (partial/failed shapes are out of scope); got ${JSON.stringify(d.status)}`,
      path: "status",
    });
  }
  // runtime identifiers: enum + must be distinct (the schema's `not.anyOf`
  // clause forbids same-runtime diffs).
  if (typeof d.base_runtime === "string" && !RUNNER_CROSS_RUNTIME_RUNTIMES.includes(d.base_runtime)) {
    errors.push({
      code: "CROSS_RUNTIME_RUNTIME_UNKNOWN",
      message: `base_runtime must be one of ${JSON.stringify(RUNNER_CROSS_RUNTIME_RUNTIMES)} for v0; got ${JSON.stringify(d.base_runtime)}`,
      path: "base_runtime",
    });
  }
  if (typeof d.head_runtime === "string" && !RUNNER_CROSS_RUNTIME_RUNTIMES.includes(d.head_runtime)) {
    errors.push({
      code: "CROSS_RUNTIME_RUNTIME_UNKNOWN",
      message: `head_runtime must be one of ${JSON.stringify(RUNNER_CROSS_RUNTIME_RUNTIMES)} for v0; got ${JSON.stringify(d.head_runtime)}`,
      path: "head_runtime",
    });
  }
  if (
    typeof d.base_runtime === "string" &&
    typeof d.head_runtime === "string" &&
    d.base_runtime === d.head_runtime
  ) {
    errors.push({
      code: "CROSS_RUNTIME_RUNTIMES_NOT_DISTINCT",
      message: `base_runtime and head_runtime must differ (v0 contract forbids same-runtime diffs); both are ${JSON.stringify(d.base_runtime)}`,
      path: "base_runtime",
    });
  }
  // preconditions: object with all 7 keys strictly === true.
  if (!d.preconditions || typeof d.preconditions !== "object" || Array.isArray(d.preconditions)) {
    errors.push({
      code: "CROSS_RUNTIME_FIELD_INVALID",
      message: "preconditions must be an object",
      path: "preconditions",
    });
  } else {
    const pc = d.preconditions as Record<string, unknown>;
    for (const k of CLEAN_PRECONDITIONS_KEYS) {
      if (pc[k] !== true) {
        errors.push({
          code: "CROSS_RUNTIME_PRECONDITION_NOT_TRUE",
          message: `preconditions.${k} must be \`true\` for v0 clean diff; got ${
            k in pc ? JSON.stringify(pc[k]) : "(missing)"
          }`,
          path: `preconditions.${k}`,
        });
      }
    }
  }
  // scope: each of the 5 keys must equal its v0-clean const.
  if (!d.scope || typeof d.scope !== "object" || Array.isArray(d.scope)) {
    errors.push({
      code: "CROSS_RUNTIME_FIELD_INVALID",
      message: "scope must be an object",
      path: "scope",
    });
  } else {
    const sc = d.scope as Record<string, unknown>;
    for (const [k, expected] of Object.entries(CLEAN_SCOPE)) {
      if (sc[k] !== expected) {
        errors.push({
          code: "CROSS_RUNTIME_SCOPE_VALUE_INVALID",
          message: `scope.${k} must equal ${JSON.stringify(expected)} for v0 clean diff; got ${
            k in sc ? JSON.stringify(sc[k]) : "(missing)"
          }`,
          path: `scope.${k}`,
        });
      }
    }
  }
  // canonicalization: A1 work-dir prefix rule on filesystem_paths, "none"
  // elsewhere. Anything else means the diff is not v0-clean (e.g.
  // a tampered or future-format archive comparison).
  if (
    !d.canonicalization ||
    typeof d.canonicalization !== "object" ||
    Array.isArray(d.canonicalization)
  ) {
    errors.push({
      code: "CROSS_RUNTIME_FIELD_INVALID",
      message: "canonicalization must be an object",
      path: "canonicalization",
    });
  } else {
    const cn = d.canonicalization as Record<string, unknown>;
    for (const [k, expected] of Object.entries(CLEAN_CANONICALIZATION)) {
      if (cn[k] !== expected) {
        errors.push({
          code: "CROSS_RUNTIME_CANONICALIZATION_INVALID",
          message: `canonicalization.${k} must equal ${JSON.stringify(expected)} for v0 clean diff (A1 work-dir prefix rule); got ${
            k in cn ? JSON.stringify(cn[k]) : "(missing)"
          }`,
          path: `canonicalization.${k}`,
        });
      }
    }
  }
  // unbound: v0 clean requires empty arrays per category (the projector
  // resolves all bound surfaces and unbound items are only emitted in
  // non-clean variants, which are not v0 clean and not supported here).
  if (!d.unbound || typeof d.unbound !== "object" || Array.isArray(d.unbound)) {
    errors.push({
      code: "CROSS_RUNTIME_FIELD_INVALID",
      message: "unbound must be an object",
      path: "unbound",
    });
  } else {
    const ub = d.unbound as Record<string, unknown>;
    for (const cat of SURFACE_CATEGORIES) {
      const val = ub[cat];
      if (!Array.isArray(val) || val.length !== 0) {
        errors.push({
          code: "CROSS_RUNTIME_UNBOUND_NOT_EMPTY",
          message: `unbound.${cat} must be an empty array for v0 clean diff; got ${
            cat in ub ? JSON.stringify(val) : "(missing)"
          }`,
          path: `unbound.${cat}`,
        });
      }
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
  // ambiguities: v0 clean schema requires the literal empty array.
  if (!Array.isArray(d.ambiguities) || d.ambiguities.length !== 0) {
    errors.push({
      code: "CROSS_RUNTIME_AMBIGUITIES_NOT_EMPTY",
      message: `ambiguities must be an empty array for v0 clean diff; got ${
        "ambiguities" in d ? JSON.stringify(d.ambiguities) : "(missing)"
      }`,
      path: "ambiguities",
    });
  }
  // non_claims: 5 exact codes in fixed order. A consumer that does not
  // enforce this would silently allow Runner-side overclaiming (e.g.
  // dropping "cross_runtime_no_sdk_capability_equivalence" would invite
  // downstream callers to read the diff as SDK-capability-equivalent).
  const ncRaw = d.non_claims;
  if (!isStringArray(ncRaw)) {
    errors.push({
      code: "CROSS_RUNTIME_NON_CLAIMS_INVALID",
      message: "non_claims must be an array of strings",
      path: "non_claims",
    });
  } else if (
    ncRaw.length !== RUNNER_CROSS_RUNTIME_REQUIRED_NON_CLAIMS.length ||
    RUNNER_CROSS_RUNTIME_REQUIRED_NON_CLAIMS.some((c, i) => ncRaw[i] !== c)
  ) {
    errors.push({
      code: "CROSS_RUNTIME_NON_CLAIMS_INVALID",
      message: `non_claims must equal the v0 clean schema's fixed 5-string array in order: ${JSON.stringify(
        RUNNER_CROSS_RUNTIME_REQUIRED_NON_CLAIMS,
      )}; got ${JSON.stringify(ncRaw)}`,
      path: "non_claims",
    });
  }
  // notes: 3 exact strings in fixed order. The notes describe the
  // contract's invariants (out-of-scope binding ids, side-band SDK
  // metadata, A1 work-dir-prefix canonicalisation). Accepting other
  // notes weakens the v0 boundary.
  const nRaw = d.notes;
  if (!isStringArray(nRaw)) {
    errors.push({
      code: "CROSS_RUNTIME_NOTES_INVALID",
      message: "notes must be an array of strings",
      path: "notes",
    });
  } else if (
    nRaw.length !== RUNNER_CROSS_RUNTIME_REQUIRED_NOTES.length ||
    RUNNER_CROSS_RUNTIME_REQUIRED_NOTES.some((n, i) => nRaw[i] !== n)
  ) {
    errors.push({
      code: "CROSS_RUNTIME_NOTES_INVALID",
      message: `notes must equal the v0 clean schema's fixed 3-string array in order; got ${JSON.stringify(
        nRaw,
      )}`,
      path: "notes",
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, errors, diff: raw as CrossRuntimeDiff };
}
