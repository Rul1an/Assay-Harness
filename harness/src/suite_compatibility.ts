/**
 * Suite compatibility matrix — `suite.compatibility.v0`.
 *
 * A suite-contract artifact, NOT an Assay carrier and NOT a Plimsoll review. It
 * records the relationship between the repos/layers (Assay emits, Harness
 * consumes/projects/gates, Plimsoll reviews) and gates on its own internal
 * consistency, never on organization policy.
 *
 * SOTA grounding (June 2026):
 *  - VSA-shaped, not a SLSA VSA: each proven cell carries provenance over the
 *    compat-proof (the hosted run + a content anchor), the way a SLSA
 *    Verification Summary Attestation lets a downstream consumer trust a summary
 *    without re-evaluating raw evidence. We do NOT emit a signed VSA predicate.
 *  - Android VINTF/FCM style: compatibility is data + a drift gate, not a README.
 *  - Declared-vs-observed: every claim distinguishes `proven` (a hosted run +
 *    content anchor exists) from `declared` (documented intent, not proof).
 *    Absence of proof never reads as "works"; unknown is never clean.
 *
 * The matrix splits the proof claim in two, which is the load-bearing honesty:
 *  - `harness_consumption`: Harness can validate/gate/project the carrier shape
 *    (proven by this repo's test suite over real producer golden bytes).
 *  - `end_to_end`: the released Assay binary emitted the carrier AND Harness
 *    consumed it in a hosted run (the H-next-2 target). Today this is `declared`
 *    for the carrier family; only the established recipe rail is `proven`.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { registeredCarrierSchemas } from "./carrier_registry.js";

export const SUITE_COMPATIBILITY_SCHEMA = "suite.compatibility.v0";

export const KNOWN_PROOF_STATES: readonly string[] = [
  "proven",
  "declared",
  "not_applicable",
  "unsupported",
];
export const KNOWN_BACKINGS: readonly string[] = [
  "public-only",
  "private-consumer-backed",
  "descriptive-only",
];
export const KNOWN_CARRIER_MODES: readonly string[] = ["gating", "descriptive"];
export const RECIPE_MODE = "recipe";

/**
 * The suite wiring the matrix is expected to assert. The `--against-registry`
 * drift check confirms the matrix matches both this wiring and the live carrier
 * registry. Kept here (not derived from the registry) because the registry
 * adapter intentionally exposes only `schema` + `validate`; this is the small,
 * explicit coupling the drift gate verifies rather than hides.
 */
const SCHEMA_TO_VERB: Record<string, string> = {
  "assay.supply_chain_conformance.v0": "carrier supply-chain",
  "assay.render_safety_conformance.v0": "carrier render-safety",
  "assay.token_passthrough_conformance.v0": "carrier token-passthrough",
  "assay.enforcement_health.v1": "carrier enforcement-health",
  "assay.mcp_server_inventory.v0": "carrier inventory",
};
const DESCRIPTIVE_SCHEMAS = new Set<string>(["assay.mcp_server_inventory.v0"]);

const VERB_RE = /^carrier [a-z][a-z-]*$/;

export interface SuiteValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface CarrierRowProof {
  harness_consumption: string;
  end_to_end: string;
  hosted_run?: string | null;
  artifact_digest?: string | null;
  note?: string;
}

export interface RecipeRowProof {
  end_to_end: string;
  hosted_run?: string | null;
  artifact_digest?: string | null;
  run_date?: string;
  note?: string;
}

export interface CarrierRow {
  carrier: string;
  support_mode: string;
  backing: string;
  emits: { producer: string; min_version: string };
  consumes: { consumer: string; min_version: string; verb: string };
  // The public matrix names the private reviewer and that it is private, but never
  // its exact private version: a public artifact must not leak private-repo internals.
  reviews: { reviewer: string; availability: string; version_disclosure: string } | null;
  proof: CarrierRowProof;
  limits?: string[];
}

export interface RecipeRow {
  recipe: string;
  support_mode: string;
  backing: string;
  emits: { producer: string; min_version: string };
  consumes: { consumer: string; min_version: string };
  proof: RecipeRowProof;
}

export interface SuiteCompatibility {
  schema: string;
  generated?: Record<string, unknown>;
  carrier_rows: CarrierRow[];
  recipe_rows: RecipeRow[];
  manifest: { canonicalization: string; digest: string };
}

export interface SuiteValidation {
  valid: boolean;
  errors: SuiteValidationError[];
  matrix?: SuiteCompatibility;
}

// ---------------------------------------------------------------------------
// Canonicalization + digest (RFC 8785 / JCS over a restricted value profile:
// string / integer / boolean / null / array / object — no floats, matching the
// rest of the suite's hashing discipline).
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error("non-integer numbers are outside the canonical value profile");
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  throw new Error(`unsupported value type in canonicalization: ${typeof value}`);
}

/**
 * The matrix digest is `sha256` over JCS-canonicalized `{carrier_rows,
 * recipe_rows}` ONLY — excluding `generated` (date churn) and `manifest` itself.
 * Same rows in any key order produce the same digest; a changed row changes it.
 */
export function computeMatrixDigest(rows: { carrier_rows: unknown; recipe_rows: unknown }): string {
  const subject = { carrier_rows: rows.carrier_rows ?? [], recipe_rows: rows.recipe_rows ?? [] };
  return "sha256:" + createHash("sha256").update(canonicalize(subject), "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Validation (matrix-only: shape, enums, proof fields, verb format, digest)
// ---------------------------------------------------------------------------

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validateProof(
  proof: unknown,
  path: string,
  errors: SuiteValidationError[],
  opts: { requireHarnessConsumption: boolean },
): void {
  if (typeof proof !== "object" || proof === null || Array.isArray(proof)) {
    errors.push({ code: "SUITE_PROOF_INVALID", message: `${path}.proof must be an object`, path: `${path}.proof` });
    return;
  }
  const p = proof as Record<string, unknown>;
  const fields = opts.requireHarnessConsumption ? ["harness_consumption", "end_to_end"] : ["end_to_end"];
  for (const f of fields) {
    if (!KNOWN_PROOF_STATES.includes(p[f] as string)) {
      errors.push({
        code: "SUITE_STATE_UNKNOWN",
        message: `${path}.proof.${f} must be one of ${JSON.stringify(KNOWN_PROOF_STATES)}; got ${JSON.stringify(p[f])}`,
        path: `${path}.proof.${f}`,
      });
    }
  }
  // A `proven` end-to-end claim must carry its evidence: a hosted run and a
  // content anchor (sha256:<emitted-carrier> or git:<proved-commit>). Absence of
  // either is treated as an unbacked claim, not as success.
  if (p.end_to_end === "proven" && !(nonEmptyString(p.hosted_run) && nonEmptyString(p.artifact_digest))) {
    errors.push({
      code: "SUITE_PROVEN_WITHOUT_PROOF",
      message: `${path}.proof.end_to_end is "proven" but hosted_run and artifact_digest are not both present`,
      path: `${path}.proof`,
    });
  }
}

function validateCarrierRow(row: unknown, path: string, errors: SuiteValidationError[]): void {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    errors.push({ code: "SUITE_ROW_INVALID", message: `${path} must be an object`, path });
    return;
  }
  const r = row as Record<string, unknown>;
  if (!nonEmptyString(r.carrier)) {
    errors.push({ code: "SUITE_ROW_INVALID", message: `${path}.carrier must be a non-empty string`, path: `${path}.carrier` });
  }
  if (!KNOWN_CARRIER_MODES.includes(r.support_mode as string)) {
    errors.push({ code: "SUITE_MODE_UNKNOWN", message: `${path}.support_mode must be one of ${JSON.stringify(KNOWN_CARRIER_MODES)}; got ${JSON.stringify(r.support_mode)}`, path: `${path}.support_mode` });
  }
  if (!KNOWN_BACKINGS.includes(r.backing as string)) {
    errors.push({ code: "SUITE_BACKING_UNKNOWN", message: `${path}.backing must be one of ${JSON.stringify(KNOWN_BACKINGS)}; got ${JSON.stringify(r.backing)}`, path: `${path}.backing` });
  }
  const consumes = r.consumes as Record<string, unknown> | undefined;
  if (typeof consumes !== "object" || consumes === null || !VERB_RE.test(consumes.verb as string)) {
    errors.push({ code: "SUITE_VERB_INVALID", message: `${path}.consumes.verb must match "carrier <name>"; got ${JSON.stringify(consumes?.verb)}`, path: `${path}.consumes.verb` });
  }
  if (r.reviews !== null && (typeof r.reviews !== "object" || Array.isArray(r.reviews))) {
    errors.push({ code: "SUITE_ROW_INVALID", message: `${path}.reviews must be an object or null`, path: `${path}.reviews` });
  }
  // Public-private boundary: the matrix may name the private reviewer and that it is
  // private, but must NOT carry its exact private version (a public-repo leak). Forbid
  // `reviews.min_version`, and enforce the *value* of the disclosure, not just the key
  // name: a private reviewer must disclose exactly `not_public`, so the version cannot
  // be smuggled back through `version_disclosure` (or any free-form value).
  if (r.reviews !== null && typeof r.reviews === "object" && !Array.isArray(r.reviews)) {
    const reviews = r.reviews as Record<string, unknown>;
    if ("min_version" in reviews) {
      errors.push({ code: "SUITE_PRIVATE_VERSION_LEAK", message: `${path}.reviews must not expose a private min_version in the public matrix; use version_disclosure`, path: `${path}.reviews.min_version` });
    }
    if (reviews.availability === "private" && reviews.version_disclosure !== "not_public") {
      errors.push({
        code: "SUITE_PRIVATE_VERSION_LEAK",
        message: `${path}.reviews.version_disclosure must be "not_public" when availability is "private" (got ${JSON.stringify(reviews.version_disclosure)})`,
        path: `${path}.reviews.version_disclosure`,
      });
    }
  }
  if (r.limits !== undefined && !(Array.isArray(r.limits) && r.limits.every((x) => typeof x === "string"))) {
    errors.push({ code: "SUITE_ROW_INVALID", message: `${path}.limits must be an array of strings`, path: `${path}.limits` });
  }
  validateProof(r.proof, path, errors, { requireHarnessConsumption: true });
}

function validateRecipeRow(row: unknown, path: string, errors: SuiteValidationError[]): void {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    errors.push({ code: "SUITE_ROW_INVALID", message: `${path} must be an object`, path });
    return;
  }
  const r = row as Record<string, unknown>;
  if (!nonEmptyString(r.recipe)) {
    errors.push({ code: "SUITE_ROW_INVALID", message: `${path}.recipe must be a non-empty string`, path: `${path}.recipe` });
  }
  if (r.support_mode !== RECIPE_MODE) {
    errors.push({ code: "SUITE_MODE_UNKNOWN", message: `${path}.support_mode must be "${RECIPE_MODE}"; got ${JSON.stringify(r.support_mode)}`, path: `${path}.support_mode` });
  }
  if (!KNOWN_BACKINGS.includes(r.backing as string)) {
    errors.push({ code: "SUITE_BACKING_UNKNOWN", message: `${path}.backing must be one of ${JSON.stringify(KNOWN_BACKINGS)}; got ${JSON.stringify(r.backing)}`, path: `${path}.backing` });
  }
  validateProof(r.proof, path, errors, { requireHarnessConsumption: false });
}

export function validateSuiteCompatibility(raw: unknown): SuiteValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: [{ code: "SUITE_NOT_OBJECT", message: "suite compatibility matrix must be a JSON object" }] };
  }
  const m = raw as Record<string, unknown>;
  const errors: SuiteValidationError[] = [];

  if (m.schema !== SUITE_COMPATIBILITY_SCHEMA) {
    errors.push({
      code: "SUITE_SCHEMA_MISMATCH",
      message: `schema must be ${SUITE_COMPATIBILITY_SCHEMA}; got ${m.schema === undefined ? "(missing)" : JSON.stringify(m.schema)}`,
      path: "schema",
    });
  }

  const carrierRows = m.carrier_rows;
  if (!Array.isArray(carrierRows)) {
    errors.push({ code: "SUITE_ROWS_INVALID", message: "carrier_rows must be an array", path: "carrier_rows" });
  } else {
    carrierRows.forEach((row, i) => validateCarrierRow(row, `carrier_rows[${i}]`, errors));
  }

  const recipeRows = m.recipe_rows;
  if (!Array.isArray(recipeRows)) {
    errors.push({ code: "SUITE_ROWS_INVALID", message: "recipe_rows must be an array", path: "recipe_rows" });
  } else {
    recipeRows.forEach((row, i) => validateRecipeRow(row, `recipe_rows[${i}]`, errors));
  }

  if (typeof m.manifest !== "object" || m.manifest === null || Array.isArray(m.manifest)) {
    errors.push({ code: "SUITE_MANIFEST_INVALID", message: "manifest must be an object with a digest", path: "manifest" });
  } else {
    const declared = (m.manifest as Record<string, unknown>).digest;
    if (!nonEmptyString(declared)) {
      errors.push({ code: "SUITE_DIGEST_MISSING", message: "manifest.digest must be a non-empty string", path: "manifest.digest" });
    } else if (Array.isArray(carrierRows) && Array.isArray(recipeRows)) {
      try {
        const recomputed = computeMatrixDigest({ carrier_rows: carrierRows, recipe_rows: recipeRows });
        if (recomputed !== declared) {
          errors.push({
            code: "SUITE_DIGEST_MISMATCH",
            message: `manifest.digest does not match sha256(JCS(rows)); declared ${declared}, recomputed ${recomputed}`,
            path: "manifest.digest",
          });
        }
      } catch (e) {
        errors.push({ code: "SUITE_DIGEST_UNCOMPUTABLE", message: `cannot canonicalize rows: ${(e as Error).message}`, path: "manifest" });
      }
    }
  }

  return { valid: errors.length === 0, errors, matrix: errors.length === 0 ? (raw as SuiteCompatibility) : undefined };
}

/**
 * Drift vs the live Harness carrier registry. Pure-data cross-check, layered on
 * top of `validateSuiteCompatibility`. Fails only on internal inconsistency
 * (registry completeness, verb wiring, mode), never on organization policy.
 */
export function driftAgainstRegistry(matrix: SuiteCompatibility): SuiteValidationError[] {
  const errors: SuiteValidationError[] = [];
  const registered = new Set(registeredCarrierSchemas());
  const rowCarriers = new Set(matrix.carrier_rows.map((r) => r.carrier));

  for (const schema of registered) {
    if (!rowCarriers.has(schema)) {
      errors.push({ code: "SUITE_REGISTRY_DRIFT", message: `carrier ${schema} is registered in the Harness but has no matrix row`, path: "carrier_rows" });
    }
  }
  for (const carrier of rowCarriers) {
    if (!registered.has(carrier)) {
      errors.push({ code: "SUITE_REGISTRY_DRIFT", message: `matrix row ${carrier} has no registered Harness adapter`, path: "carrier_rows" });
    }
  }
  for (const row of matrix.carrier_rows) {
    const expectedVerb = SCHEMA_TO_VERB[row.carrier];
    if (expectedVerb && row.consumes?.verb !== expectedVerb) {
      errors.push({ code: "SUITE_VERB_DRIFT", message: `${row.carrier} verb should be "${expectedVerb}"; matrix says ${JSON.stringify(row.consumes?.verb)}`, path: "carrier_rows" });
    }
    if (registered.has(row.carrier)) {
      const expectedMode = DESCRIPTIVE_SCHEMAS.has(row.carrier) ? "descriptive" : "gating";
      if (row.support_mode !== expectedMode) {
        errors.push({ code: "SUITE_MODE_DRIFT", message: `${row.carrier} support_mode should be "${expectedMode}"; matrix says ${JSON.stringify(row.support_mode)}`, path: "carrier_rows" });
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Load + report
// ---------------------------------------------------------------------------

export interface SuiteReport {
  matrix_path: string;
  validation: SuiteValidation;
  carrier_count: number;
  recipe_count: number;
  e2e_proven_count: number;
  e2e_declared_count: number;
}

export function buildSuiteReport(matrixPath: string): SuiteReport {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(matrixPath, "utf-8"));
  } catch (e) {
    return {
      matrix_path: matrixPath,
      validation: { valid: false, errors: [{ code: "SUITE_NOT_JSON", message: `cannot parse matrix as JSON: ${(e as Error).message}` }] },
      carrier_count: 0,
      recipe_count: 0,
      e2e_proven_count: 0,
      e2e_declared_count: 0,
    };
  }
  const validation = validateSuiteCompatibility(raw);
  const m = validation.matrix;
  const carrierRows = m?.carrier_rows ?? [];
  const recipeRows = m?.recipe_rows ?? [];
  const allE2e = [...carrierRows.map((r) => r.proof?.end_to_end), ...recipeRows.map((r) => r.proof?.end_to_end)];
  return {
    matrix_path: matrixPath,
    validation,
    carrier_count: carrierRows.length,
    recipe_count: recipeRows.length,
    e2e_proven_count: allE2e.filter((s) => s === "proven").length,
    e2e_declared_count: allE2e.filter((s) => s === "declared").length,
  };
}

export interface SuiteLoadResult {
  ok: boolean;
  not_found?: boolean;
  report?: SuiteReport;
}

export function loadSuiteReport(matrixPath: string): SuiteLoadResult {
  try {
    readFileSync(matrixPath);
  } catch {
    return { ok: false, not_found: true };
  }
  return { ok: true, report: buildSuiteReport(matrixPath) };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function mdCell(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ").replaceAll("|", "\\|");
}

// `declared` renders as pending, never as a green/clean mark; `proven` reads as
// proven; the two must be visually distinct (no "supported", which reads as proven).
function e2eLabel(state: string): string {
  if (state === "proven") return "proven";
  if (state === "declared") return "declared / pending";
  return state;
}

export function formatSuiteSummary(report: SuiteReport): string {
  const v = report.validation;
  const status = v.valid ? "OK" : "INVALID";
  return (
    `[suite-compatibility] schema: ${SUITE_COMPATIBILITY_SCHEMA}\n` +
    `[suite-compatibility] status: ${status}\n` +
    `[suite-compatibility] carriers: ${report.carrier_count} (e2e proven=${report.e2e_proven_count}, declared/pending=${report.e2e_declared_count})\n` +
    `[suite-compatibility] recipes: ${report.recipe_count}`
  );
}

export function formatSuiteMarkdown(report: SuiteReport): string {
  const m = report.validation.matrix;
  const lines: string[] = [];
  lines.push("## Suite Compatibility Matrix");
  lines.push("");
  lines.push("VSA-shaped compatibility summary, not a SLSA VSA. The Harness validates");
  lines.push("this evidence and projects it; it does not approve carrier semantics or");
  lines.push("organization policy.");
  lines.push("");
  if (!m) {
    lines.push("Matrix did not validate; see contract errors.");
    return lines.join("\n");
  }
  lines.push("| Carrier | Mode | Backing | Harness consumption | Released-binary E2E | Last proof run | Limits |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of m.carrier_rows) {
    const run = r.proof.end_to_end === "proven" ? mdCell(r.proof.hosted_run ?? "—") : "—";
    const limits = r.limits && r.limits.length > 0 ? mdCell(r.limits.join("; ")) : "—";
    lines.push(
      `| \`${mdCell(r.carrier)}\` | ${mdCell(r.support_mode)} | ${mdCell(r.backing)} | ${mdCell(r.proof.harness_consumption)} | ${mdCell(e2eLabel(r.proof.end_to_end))} | ${run} | ${limits} |`,
    );
  }
  lines.push("");
  if (m.recipe_rows.length > 0) {
    lines.push("### Recipe rails (non-carrier)");
    lines.push("");
    lines.push("| Recipe | Backing | Released-binary E2E | Last proof run |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of m.recipe_rows) {
      const run = r.proof.end_to_end === "proven" ? mdCell(r.proof.hosted_run ?? "—") : "—";
      lines.push(`| ${mdCell(r.recipe)} | ${mdCell(r.backing)} | ${mdCell(e2eLabel(r.proof.end_to_end))} | ${run} |`);
    }
    lines.push("");
  }
  lines.push("`declared / pending` means Harness consumption is proven by this repo's tests");
  lines.push("but the released-binary end-to-end proof is still pending (tracked as H-next-2).");
  return lines.join("\n");
}
