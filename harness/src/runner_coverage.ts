/**
 * Tier 3 — consume Assay-Runner coverage-aware drift annotations for reviewer
 * projection (report) and CI enforcement (gate).
 *
 * Scope: this module is a **consumer**, not a semantic owner. The Runner /
 * comparator side (`Rul1an/assay`) defines
 * `assay.coverage_aware_drift.annotation.v0` (the sidecar emitted by the
 * cross-runtime comparator's `--coverage-annotation-out`) and the underlying
 * `assay.observability.claim_class_cell.v0` claim-class vocabulary. Harness
 * reads that sidecar, validates its frozen shape with explicit TypeScript
 * guards (the repo's deliberate "no AJV runtime cost" choice), and either
 * projects it (report) or mechanically permits/blocks asserted coverage claims
 * (gate).
 *
 * Honesty model (claim-class): every decision derives from
 * `claim_strength × claim_basis`. The gate never invents a claim and never
 * upgrades one — absence of a supporting cell blocks the claim.
 *
 *   - positive:DIM       permitted iff a `measured_<DIM>_drift` cell exists with
 *                        strength `strong` or `partial`.
 *   - exhaustive:DIM     permitted iff an `exhaustive_<DIM>_equality` cell is
 *                        allowed (strength `partial`); a coverage-degraded
 *                        `weak` cell or a missing cell is not.
 *   - bounded_negative:DIM permitted iff DIM is a measured dimension AND
 *                        `no_<DIM>_effect_beyond_observed` is not in
 *                        `blocked_claims`. On a reported/unknown dimension the
 *                        claim is not evaluable, so not permitted.
 *
 * This module does no archive I/O and never throws on structurally invalid
 * input — it returns a structured validation result so the CLI maps errors to
 * stable exit codes (2 config, 3 invalid shape, 6 blocked claim).
 */

import { existsSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants (pinned to Rul1an/assay contract)
// ---------------------------------------------------------------------------

export const COVERAGE_ANNOTATION_SCHEMA =
  "assay.coverage_aware_drift.annotation.v0";

export const COVERAGE_CLAIM_CELL_SCHEMA =
  "assay.observability.claim_class_cell.v0";

export const COVERAGE_ASSERTABLE_CLAIM_TYPES: readonly string[] = [
  "positive",
  "exhaustive",
  "bounded_negative",
];

/**
 * Measured (effect-bearing) drift dimensions. A bounded-negative claim is only
 * evaluable for one of these; on a reported/unknown dimension it is not
 * evaluable and therefore not permitted. Mirrors the open-core
 * coverage-claims-gate example.
 */
export const COVERAGE_MEASURED_DIMENSIONS: readonly string[] = [
  "filesystem_paths_touched",
  "kernel_file_operations",
  "network_endpoints",
  "process_execs",
];

// ---------------------------------------------------------------------------
// Shape (validated with explicit guards, not a schema validator)
// ---------------------------------------------------------------------------

export interface CoverageClaimCell {
  claim_type: string;
  claim_strength?: string;
  claim_basis?: string;
  artifact_role?: string;
}

export interface CoverageBlockedClaim {
  claim_type?: string;
  requested_claim?: string;
  decision?: string;
  reason?: string;
}

export interface CoverageAnnotation {
  schema: string;
  source_report_schema?: string;
  claim_cells: CoverageClaimCell[];
  blocked_claims: CoverageBlockedClaim[];
  classification_caveats?: unknown[];
}

export interface CoverageValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface CoverageValidation {
  valid: boolean;
  errors: CoverageValidationError[];
  annotation?: CoverageAnnotation;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateCoverageAnnotation(parsed: unknown): CoverageValidation {
  const errors: CoverageValidationError[] = [];
  if (!isRecord(parsed)) {
    return {
      valid: false,
      errors: [
        {
          code: "COVERAGE_ANNOTATION_NOT_OBJECT",
          message: "annotation must be a JSON object",
        },
      ],
    };
  }
  if (parsed.schema !== COVERAGE_ANNOTATION_SCHEMA) {
    errors.push({
      code: "COVERAGE_ANNOTATION_BAD_SCHEMA",
      message: `expected schema ${COVERAGE_ANNOTATION_SCHEMA}; got ${JSON.stringify(
        parsed.schema,
      )}`,
      path: "schema",
    });
  }
  const cells: CoverageClaimCell[] = [];
  if (!Array.isArray(parsed.claim_cells)) {
    errors.push({
      code: "COVERAGE_ANNOTATION_BAD_CLAIM_CELLS",
      message: "claim_cells must be an array",
      path: "claim_cells",
    });
  } else {
    parsed.claim_cells.forEach((c, i) => {
      if (!isRecord(c) || typeof c.claim_type !== "string") {
        errors.push({
          code: "COVERAGE_ANNOTATION_BAD_CLAIM_CELL",
          message: "each claim cell must have a string claim_type",
          path: `claim_cells[${i}]`,
        });
        return;
      }
      cells.push({
        claim_type: c.claim_type,
        claim_strength:
          typeof c.claim_strength === "string" ? c.claim_strength : undefined,
        claim_basis:
          typeof c.claim_basis === "string" ? c.claim_basis : undefined,
        artifact_role:
          typeof c.artifact_role === "string" ? c.artifact_role : undefined,
      });
    });
  }
  const blocked: CoverageBlockedClaim[] = [];
  if (!Array.isArray(parsed.blocked_claims)) {
    errors.push({
      code: "COVERAGE_ANNOTATION_BAD_BLOCKED_CLAIMS",
      message: "blocked_claims must be an array",
      path: "blocked_claims",
    });
  } else {
    parsed.blocked_claims.forEach((b, i) => {
      if (!isRecord(b)) {
        errors.push({
          code: "COVERAGE_ANNOTATION_BAD_BLOCKED_CLAIM",
          message: "each blocked claim must be an object",
          path: `blocked_claims[${i}]`,
        });
        return;
      }
      blocked.push({
        claim_type:
          typeof b.claim_type === "string" ? b.claim_type : undefined,
        requested_claim:
          typeof b.requested_claim === "string" ? b.requested_claim : undefined,
        decision: typeof b.decision === "string" ? b.decision : undefined,
        reason: typeof b.reason === "string" ? b.reason : undefined,
      });
    });
  }
  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return {
    valid: true,
    errors: [],
    annotation: {
      schema: parsed.schema as string,
      source_report_schema:
        typeof parsed.source_report_schema === "string"
          ? parsed.source_report_schema
          : undefined,
      claim_cells: cells,
      blocked_claims: blocked,
    },
  };
}

export interface CoverageAnnotationLoad {
  valid: boolean;
  not_found?: boolean;
  errors: CoverageValidationError[];
  annotation?: CoverageAnnotation;
}

export function loadCoverageAnnotation(path: string): CoverageAnnotationLoad {
  if (!existsSync(path)) {
    return { valid: false, not_found: true, errors: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      valid: false,
      errors: [
        {
          code: "COVERAGE_ANNOTATION_NOT_JSON",
          message: `${path} is not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
    };
  }
  const v = validateCoverageAnnotation(parsed);
  return { valid: v.valid, errors: v.errors, annotation: v.annotation };
}

// ---------------------------------------------------------------------------
// Claim evaluation (the honesty gate)
// ---------------------------------------------------------------------------

export interface ParsedClaimSpec {
  ok: boolean;
  claim_type?: string;
  dimension?: string;
  error?: string;
}

export function parseClaimSpec(spec: string): ParsedClaimSpec {
  const raw = String(spec).trim();
  const idx = raw.indexOf(":");
  if (idx < 0) {
    return { ok: false, error: `claim must be TYPE:DIMENSION, got "${raw}"` };
  }
  const claim_type = raw.slice(0, idx).trim();
  const dimension = raw.slice(idx + 1).trim();
  if (!COVERAGE_ASSERTABLE_CLAIM_TYPES.includes(claim_type)) {
    return {
      ok: false,
      error: `claim TYPE must be one of ${COVERAGE_ASSERTABLE_CLAIM_TYPES.join(
        "|",
      )}; got "${claim_type}"`,
    };
  }
  if (!dimension) {
    return { ok: false, error: `claim must have a non-empty dimension, got "${raw}"` };
  }
  return { ok: true, claim_type, dimension };
}

function cellsByType(annotation: CoverageAnnotation): Map<string, CoverageClaimCell> {
  const m = new Map<string, CoverageClaimCell>();
  for (const c of annotation.claim_cells) m.set(c.claim_type, c);
  return m;
}

export interface ClaimDecision {
  claim: string;
  permitted: boolean;
  detail: string;
}

export function evaluateClaim(
  annotation: CoverageAnnotation,
  claimType: string,
  dimension: string,
): { permitted: boolean; detail: string } {
  const cells = cellsByType(annotation);
  if (claimType === "positive") {
    const cell = cells.get(`measured_${dimension}_drift`);
    if (!cell) {
      return { permitted: false, detail: `no measured_${dimension}_drift cell (nothing observed)` };
    }
    const s = cell.claim_strength;
    if (s === "strong" || s === "partial") {
      return { permitted: true, detail: `measured positive is ${s}` };
    }
    return { permitted: false, detail: `measured positive is ${s ?? "unspecified"}` };
  }
  if (claimType === "exhaustive") {
    const cell = cells.get(`exhaustive_${dimension}_equality`);
    if (!cell) {
      return { permitted: false, detail: `no exhaustive_${dimension}_equality cell` };
    }
    if (cell.claim_strength === "partial") {
      return { permitted: true, detail: "exhaustive equality allowed (partial)" };
    }
    return {
      permitted: false,
      detail: `exhaustive equality is ${cell.claim_strength ?? "unspecified"} (degraded by coverage)`,
    };
  }
  if (claimType === "bounded_negative") {
    if (!COVERAGE_MEASURED_DIMENSIONS.includes(dimension)) {
      return {
        permitted: false,
        detail: `bounded-negative not evaluable for non-measured dimension "${dimension}"`,
      };
    }
    const blockedSet = new Set(
      annotation.blocked_claims.map((b) => b.requested_claim).filter(Boolean),
    );
    if (blockedSet.has(`no_${dimension}_effect_beyond_observed`)) {
      return { permitted: false, detail: "bounded-negative blocked by coverage descriptor" };
    }
    return { permitted: true, detail: "bounded-negative not blocked" };
  }
  return { permitted: false, detail: `unknown claim type "${claimType}"` };
}

export interface CoverageGateResult {
  passed: boolean;
  results: ClaimDecision[];
}

export function gateCoverageClaims(
  annotation: CoverageAnnotation,
  specs: string[],
): { ok: boolean; error?: string; gate?: CoverageGateResult } {
  const results: ClaimDecision[] = [];
  for (const spec of specs) {
    const parsed = parseClaimSpec(spec);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const { permitted, detail } = evaluateClaim(
      annotation,
      parsed.claim_type as string,
      parsed.dimension as string,
    );
    results.push({ claim: `${parsed.claim_type}:${parsed.dimension}`, permitted, detail });
  }
  return { ok: true, gate: { passed: results.every((r) => r.permitted), results } };
}

// ---------------------------------------------------------------------------
// Projection (report)
// ---------------------------------------------------------------------------

export interface CoverageReportProjection {
  schema: string;
  claim_cells: { claim_type: string; claim_strength: string; claim_basis: string }[];
  blocked_claims: { requested_claim: string; reason: string }[];
}

export function buildCoverageProjection(
  annotation: CoverageAnnotation,
): CoverageReportProjection {
  return {
    schema: annotation.schema,
    claim_cells: annotation.claim_cells
      .map((c) => ({
        claim_type: c.claim_type,
        claim_strength: c.claim_strength ?? "unspecified",
        claim_basis: c.claim_basis ?? "unspecified",
      }))
      .sort((a, b) => a.claim_type.localeCompare(b.claim_type)),
    blocked_claims: annotation.blocked_claims
      .map((b) => ({
        requested_claim: b.requested_claim ?? "(unknown)",
        reason: b.reason ?? "",
      }))
      .sort((a, b) => a.requested_claim.localeCompare(b.requested_claim)),
  };
}

export function formatCoverageReport(
  projection: CoverageReportProjection,
  format: string,
): string {
  if (format === "json") {
    return JSON.stringify(projection, null, 2);
  }
  const lines: string[] = ["# Coverage annotation projection", ""];
  lines.push("## Claim cells (strength × basis)", "");
  if (projection.claim_cells.length === 0) {
    lines.push("_none_");
  } else {
    lines.push("| claim_type | strength | basis |", "|---|---|---|");
    for (const c of projection.claim_cells) {
      lines.push(`| ${c.claim_type} | ${c.claim_strength} | ${c.claim_basis} |`);
    }
  }
  lines.push("", "## Blocked claims", "");
  if (projection.blocked_claims.length === 0) {
    lines.push("_none_");
  } else {
    for (const b of projection.blocked_claims) {
      lines.push(`- \`${b.requested_claim}\` — ${b.reason}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function formatCoverageGate(gate: CoverageGateResult, format: string): string {
  if (format === "json") {
    return JSON.stringify(gate, null, 2);
  }
  if (format === "sarif") {
    return JSON.stringify(buildCoverageGateSarif(gate), null, 2);
  }
  const lines: string[] = [];
  for (const r of gate.results) {
    lines.push(`[${r.permitted ? "PERMIT" : "BLOCK "}] ${r.claim}: ${r.detail}`);
  }
  lines.push(gate.passed ? "PASS" : "FAIL");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// SARIF 2.1.0 for blocked claims (SOTA: surface in code-scanning UIs)
// ---------------------------------------------------------------------------

export function buildCoverageGateSarif(gate: CoverageGateResult): unknown {
  const blocked = gate.results.filter((r) => !r.permitted);
  const results = blocked.map((r) => ({
    ruleId: `ASSAY-COVERAGE-CLAIM-BLOCKED`,
    level: "error",
    message: { text: `Coverage claim blocked: ${r.claim} — ${r.detail}` },
    properties: { claim: r.claim, "security-severity": "7.0" },
    partialFingerprints: { claim: r.claim },
  }));
  return {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "assay-harness",
            informationUri: "https://github.com/Rul1an/Assay-Harness",
            rules: [
              {
                id: "ASSAY-COVERAGE-CLAIM-BLOCKED",
                name: "CoverageClaimBlocked",
                shortDescription: {
                  text: "An asserted coverage claim is not supported by the annotation",
                },
              },
            ],
          },
        },
        results,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fleet summary — fold many annotations into one honesty posture
// ---------------------------------------------------------------------------

/**
 * Positive level ordering, weakest first. `missing` (a run with no positive
 * cell at all) is the weakest of all: if even one run cannot support a positive
 * claim, the fleet cannot support it everywhere, so the floor is `missing`.
 * This is what makes the floor an honest "supportable across every run" answer.
 */
const FLEET_FLOOR_ORDER: readonly string[] = ["missing", "absent", "weak", "partial", "strong"];

function weakerLevel(a: string, b: string): string {
  const ia = FLEET_FLOOR_ORDER.indexOf(a);
  const ib = FLEET_FLOOR_ORDER.indexOf(b);
  const sa = ia < 0 ? 0 : ia;
  const sb = ib < 0 ? 0 : ib;
  return sa <= sb ? a : b;
}

export interface CoverageFleetDimension {
  measured_positive: Record<string, number>;
  exhaustive_equality: Record<string, number>;
  bounded_negative_blocked: number;
  runs_observed: number;
  fleet_positive_floor: string;
}

export interface CoverageFleetSummary {
  schema: "assay.coverage_fleet_summary.v0";
  run_count: number;
  dimensions: Record<string, CoverageFleetDimension>;
}

function emptyFleetDimension(): CoverageFleetDimension {
  return {
    measured_positive: { strong: 0, partial: 0, weak: 0, absent: 0, missing: 0 },
    exhaustive_equality: { partial: 0, weak: 0, absent: 0, missing: 0 },
    bounded_negative_blocked: 0,
    runs_observed: 0,
    fleet_positive_floor: "missing",
  };
}

export function foldCoverageFleet(annotations: CoverageAnnotation[]): CoverageFleetSummary {
  const dims: Record<string, CoverageFleetDimension> = {};
  for (const d of COVERAGE_MEASURED_DIMENSIONS) dims[d] = emptyFleetDimension();
  // Track floor separately as nullable until the first run is folded in.
  const floor: Record<string, string | null> = {};
  for (const d of COVERAGE_MEASURED_DIMENSIONS) floor[d] = null;

  for (const annotation of annotations) {
    const cells = cellsByType(annotation);
    const blocked = new Set(
      annotation.blocked_claims.map((b) => b.requested_claim).filter(Boolean),
    );
    for (const dim of COVERAGE_MEASURED_DIMENSIONS) {
      const entry = dims[dim];
      const pos = cells.get(`measured_${dim}_drift`);
      const strength = pos?.claim_strength;
      let runLevel: string;
      if (strength && strength !== "missing" && strength in entry.measured_positive) {
        entry.measured_positive[strength] += 1;
        entry.runs_observed += 1;
        runLevel = strength;
      } else {
        entry.measured_positive.missing += 1;
        runLevel = "missing";
      }
      const cur = floor[dim];
      floor[dim] = cur === null ? runLevel : weakerLevel(cur, runLevel);

      const exh = cells.get(`exhaustive_${dim}_equality`);
      const es = exh?.claim_strength;
      if (es && es in entry.exhaustive_equality) {
        entry.exhaustive_equality[es] += 1;
      } else {
        entry.exhaustive_equality.missing += 1;
      }

      if (blocked.has(`no_${dim}_effect_beyond_observed`)) {
        entry.bounded_negative_blocked += 1;
      }
    }
  }
  for (const dim of COVERAGE_MEASURED_DIMENSIONS) {
    dims[dim].fleet_positive_floor = floor[dim] ?? "missing";
  }
  return {
    schema: "assay.coverage_fleet_summary.v0",
    run_count: annotations.length,
    dimensions: dims,
  };
}

export function formatCoverageFleet(summary: CoverageFleetSummary, format: string): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }
  const lines: string[] = [`# Coverage fleet summary over ${summary.run_count} run(s)`, ""];
  for (const dim of Object.keys(summary.dimensions).sort()) {
    const e = summary.dimensions[dim];
    const p = e.measured_positive;
    const dist = ["strong", "partial", "weak", "absent", "missing"]
      .map((k) => `${k}=${p[k]}`)
      .join(", ");
    lines.push(`${dim}:`);
    lines.push(`  positive floor: ${e.fleet_positive_floor}  (${dist})`);
    lines.push(`  bounded-negative blocked in ${e.bounded_negative_blocked} run(s)`);
  }
  return lines.join("\n") + "\n";
}
