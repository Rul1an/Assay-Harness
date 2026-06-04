/**
 * Tier 3 — claim support report & gate. Consumer-only.
 *
 * Consumes a claim-assertions document plus an
 * `assay.coverage_aware_drift.annotation.v0` coverage annotation, and answers,
 * per asserted claim: does the independently observed evidence support THIS
 * claim at THIS strength, and if not, what is the strongest claim the evidence
 * supports? Outcomes: `supported`, `degraded`, `blocked`, `not_evaluable`.
 *
 * It speaks the open-core vocabulary directly — `claim_kind` ∈
 * {positive, exhaustive, bounded_negative}, open-core dimension names
 * (`filesystem_paths_touched`, `network_endpoints`, …), `claim_strength` ∈
 * {strong, partial, weak, absent}, `claim_basis` ∈
 * {measured, reported, derived, inferred}. No second vocabulary, no mapping.
 *
 * Boundary: consumer-only. It reuses the annotation shape and the claim-class
 * semantics already shipped (it does not define new ones), adds no Runner
 * capture, consults no attestation (observed support is the ceiling), and keeps
 * no state. `value`/`effect_class` on a claim are ADVISORY — they are not
 * independently verified here; support is evaluated at dimension granularity.
 */

import { existsSync, readFileSync } from "node:fs";

import {
  COVERAGE_MEASURED_DIMENSIONS,
  loadCoverageAnnotation,
  type CoverageAnnotation,
} from "./runner_coverage.js";

export const CLAIM_ASSERTIONS_SCHEMA = "assay.harness.claim_assertions.v0";

export const CLAIM_KINDS: readonly string[] = ["positive", "exhaustive", "bounded_negative"];
const STRENGTH_RANK: Record<string, number> = { absent: 0, weak: 1, partial: 2, strong: 3 };
const BASIS_RANK: Record<string, number> = { inferred: 0, reported: 1, derived: 2, measured: 3 };

export type ClaimDecision = "supported" | "degraded" | "blocked" | "not_evaluable";

export interface ClaimAssertion {
  id?: string;
  dimension?: string;
  claim_kind?: string;
  effect_class?: string; // advisory, not verified
  value?: string; // advisory, not verified
  required_strength?: string;
  required_basis?: string;
}

export interface ClaimResult {
  id: string;
  dimension: string;
  claim_kind: string;
  required_strength: string;
  required_basis: string;
  decision: ClaimDecision;
  reason: string;
  observed: { strength?: string; basis?: string } | null;
}

function cellsByType(annotation: CoverageAnnotation): Map<string, { claim_strength?: string; claim_basis?: string }> {
  const m = new Map<string, { claim_strength?: string; claim_basis?: string }>();
  for (const c of annotation.claim_cells) m.set(c.claim_type, c);
  return m;
}

function blockedSet(annotation: CoverageAnnotation): Set<string> {
  return new Set(annotation.blocked_claims.map((b) => b.requested_claim).filter(Boolean) as string[]);
}

function rank(table: Record<string, number>, v: string | undefined): number {
  return v !== undefined && v in table ? table[v] : -1;
}

function evaluatePositive(
  annotation: CoverageAnnotation,
  dim: string,
  reqStrength: string,
  reqBasis: string,
): { decision: ClaimDecision; reason: string; observed: ClaimResult["observed"] } {
  const cell = cellsByType(annotation).get(`measured_${dim}_drift`);
  if (!cell) {
    return { decision: "not_evaluable", reason: "no_observed_evidence_for_dimension", observed: null };
  }
  const observed = { strength: cell.claim_strength, basis: cell.claim_basis };
  if (cell.claim_strength === "absent") {
    return { decision: "blocked", reason: "observed_absent_contradicts_positive_claim", observed };
  }
  const meetsStrength = rank(STRENGTH_RANK, cell.claim_strength) >= rank(STRENGTH_RANK, reqStrength);
  const meetsBasis = rank(BASIS_RANK, cell.claim_basis) >= rank(BASIS_RANK, reqBasis);
  if (meetsStrength && meetsBasis) {
    return { decision: "supported", reason: "observed_supports_required", observed };
  }
  return {
    decision: "degraded",
    reason: meetsStrength ? "observed_basis_below_required" : "observed_strength_below_required",
    observed,
  };
}

function evaluateExhaustive(
  annotation: CoverageAnnotation,
  dim: string,
): { decision: ClaimDecision; reason: string; observed: ClaimResult["observed"] } {
  // Follows the existing coverage gate, no extra semantics: an exhaustive claim
  // is allowed only when the descriptor allows it (cell strength `partial`); a
  // coverage-degraded `weak` cell degrades; `absent` blocks; missing is not
  // evaluable.
  const cell = cellsByType(annotation).get(`exhaustive_${dim}_equality`);
  if (!cell) {
    return { decision: "not_evaluable", reason: "no_exhaustive_cell_for_dimension", observed: null };
  }
  const observed = { strength: cell.claim_strength, basis: cell.claim_basis };
  switch (cell.claim_strength) {
    case "partial":
      return { decision: "supported", reason: "coverage_allows_exhaustive", observed };
    case "weak":
      return { decision: "degraded", reason: "exhaustive_degraded_by_coverage", observed };
    default:
      return { decision: "blocked", reason: "coverage_cannot_support_exhaustive", observed };
  }
}

function evaluateBoundedNegative(
  annotation: CoverageAnnotation,
  dim: string,
): { decision: ClaimDecision; reason: string; observed: ClaimResult["observed"] } {
  if (!COVERAGE_MEASURED_DIMENSIONS.includes(dim)) {
    return { decision: "not_evaluable", reason: "dimension_not_measured", observed: null };
  }
  if (blockedSet(annotation).has(`no_${dim}_effect_beyond_observed`)) {
    return { decision: "blocked", reason: "coverage_cannot_prove_absence", observed: null };
  }
  return { decision: "supported", reason: "bounded_negative_not_blocked", observed: null };
}

export function evaluateClaim(annotation: CoverageAnnotation, claim: ClaimAssertion): ClaimResult {
  const dim = claim.dimension ?? "";
  const kind = claim.claim_kind ?? "";
  const reqStrength = claim.required_strength ?? "strong";
  const reqBasis = claim.required_basis ?? "measured";
  let r: { decision: ClaimDecision; reason: string; observed: ClaimResult["observed"] };
  if (!(reqStrength in STRENGTH_RANK) || !(reqBasis in BASIS_RANK)) {
    // A typo in the required level must never silently pass.
    r = { decision: "not_evaluable", reason: "invalid_required_level", observed: null };
  } else if (kind === "positive") {
    r = evaluatePositive(annotation, dim, reqStrength, reqBasis);
  } else if (kind === "exhaustive") {
    r = evaluateExhaustive(annotation, dim);
  } else if (kind === "bounded_negative") {
    r = evaluateBoundedNegative(annotation, dim);
  } else {
    r = { decision: "not_evaluable", reason: "unknown_claim_kind", observed: null };
  }
  return {
    id: claim.id ?? "(unnamed)",
    dimension: dim,
    claim_kind: kind,
    required_strength: reqStrength,
    required_basis: reqBasis,
    decision: r.decision,
    reason: r.reason,
    observed: r.observed,
  };
}

export interface ClaimSupportReport {
  passed: boolean;
  allow_degraded: boolean;
  counts: Record<ClaimDecision, number>;
  results: ClaimResult[];
  non_claims: string[];
}

export interface ClaimsValidation {
  valid: boolean;
  error?: string;
  claims?: ClaimAssertion[];
}

export function validateClaims(parsed: unknown): ClaimsValidation {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { valid: false, error: "claims document must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== CLAIM_ASSERTIONS_SCHEMA) {
    return { valid: false, error: `expected schema ${CLAIM_ASSERTIONS_SCHEMA}; got ${JSON.stringify(obj.schema)}` };
  }
  if (!Array.isArray(obj.claims)) {
    return { valid: false, error: "claims must be an array" };
  }
  return { valid: true, claims: obj.claims as ClaimAssertion[] };
}

export function buildClaimReport(
  claims: ClaimAssertion[],
  annotation: CoverageAnnotation,
  allowDegraded: boolean,
): ClaimSupportReport {
  const results = claims.map((c) => evaluateClaim(annotation, c));
  results.sort((a, b) => a.id.localeCompare(b.id));
  const counts: Record<ClaimDecision, number> = { supported: 0, degraded: 0, blocked: 0, not_evaluable: 0 };
  for (const r of results) counts[r.decision] += 1;
  const passes = (r: ClaimResult): boolean =>
    r.decision === "supported" || (r.decision === "degraded" && allowDegraded);
  return {
    passed: results.every(passes),
    allow_degraded: allowDegraded,
    counts,
    results,
    non_claims: [
      "does_not_assert_complete_observation",
      "no_safe_or_unsafe_verdict",
      "observed_support_is_the_ceiling",
      "claim_value_and_effect_class_are_advisory_not_verified",
    ],
  };
}

export function formatClaimReport(report: ClaimSupportReport, format: string): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  const c = report.counts;
  const lines = [
    "# Claim support report",
    "",
    `**Result:** ${report.passed ? "PASS" : "FAIL"} (supported=${c.supported} degraded=${c.degraded} blocked=${c.blocked} not_evaluable=${c.not_evaluable}; allow_degraded=${report.allow_degraded})`,
    "",
    "| claim | kind | required | observed | decision | reason |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of report.results) {
    const obs = r.observed && r.observed.strength ? `${r.observed.strength}/${r.observed.basis}` : "—";
    lines.push(
      `| ${r.id} | ${r.claim_kind} | ${r.required_strength}/${r.required_basis} | ${obs} | ${r.decision} | \`${r.reason}\` |`,
    );
  }
  lines.push("", "_Observed support is the ceiling; no completeness claim, no safe/unsafe verdict._");
  return lines.join("\n") + "\n";
}

export interface ClaimsLoad {
  ok: boolean;
  not_found?: boolean;
  error?: string;
  claims?: ClaimAssertion[];
}

export function loadClaims(path: string): ClaimsLoad {
  if (!existsSync(path)) return { ok: false, not_found: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const v = validateClaims(parsed);
  if (!v.valid) return { ok: false, error: v.error };
  return { ok: true, claims: v.claims };
}

// Re-export so the CLI can load the annotation through one import.
export { loadCoverageAnnotation };
