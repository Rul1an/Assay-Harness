/**
 * Recipe provenance — `suite.recipe_provenance.v0`.
 *
 * Verification-summary evidence (NOT a SLSA provenance predicate) describing a
 * carrier-recipe run: which released producer emitted the carrier, under which
 * command, against which committed fixture, in which hosted run, and the result.
 * Emitted by the hermetic recipe and bundled by the Evidence Pack.
 */

export const RECIPE_PROVENANCE_SCHEMA = "suite.recipe_provenance.v0";

export interface RecipeProvenance {
  schema: string;
  recipe: string;
  hosted_run: string;
  runner_os: string;
  hosted: boolean;
  ambient_scan: boolean;
  assay: { version: string; binary_digest: string; command: string };
  fixture: { path: string; digest: string };
  artifact: { path: string; digest: string };
  harness: { version: string; command: string };
  result: { exit_code: number; classification: string };
}

export interface ProvenanceError {
  code: string;
  message: string;
  path?: string;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Shape validation. The Evidence Pack's verify layers the v0 result constraints on top. */
export function validateRecipeProvenance(raw: unknown): { valid: boolean; errors: ProvenanceError[] } {
  const errors: ProvenanceError[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: [{ code: "PROVENANCE_NOT_OBJECT", message: "recipe provenance must be a JSON object" }] };
  }
  const p = raw as Record<string, unknown>;
  if (p.schema !== RECIPE_PROVENANCE_SCHEMA) {
    errors.push({
      code: "PROVENANCE_SCHEMA_MISMATCH",
      message: `schema must be ${RECIPE_PROVENANCE_SCHEMA}; got ${p.schema === undefined ? "(missing)" : JSON.stringify(p.schema)}`,
      path: "schema",
    });
  }
  for (const f of ["recipe", "hosted_run", "runner_os"]) {
    if (!nonEmptyString(p[f])) errors.push({ code: "PROVENANCE_FIELD_INVALID", message: `${f} must be a non-empty string`, path: f });
  }
  if (typeof p.hosted !== "boolean") errors.push({ code: "PROVENANCE_FIELD_INVALID", message: "hosted must be a boolean", path: "hosted" });
  if (typeof p.ambient_scan !== "boolean") errors.push({ code: "PROVENANCE_FIELD_INVALID", message: "ambient_scan must be a boolean", path: "ambient_scan" });

  const obj = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

  const assay = obj(p.assay);
  if (!assay || !nonEmptyString(assay.version) || !nonEmptyString(assay.binary_digest) || !nonEmptyString(assay.command)) {
    errors.push({ code: "PROVENANCE_FIELD_INVALID", message: "assay must be { version, binary_digest, command }", path: "assay" });
  }
  for (const sub of ["fixture", "artifact"]) {
    const o = obj(p[sub]);
    if (!o || !nonEmptyString(o.path) || !nonEmptyString(o.digest)) {
      errors.push({ code: "PROVENANCE_FIELD_INVALID", message: `${sub} must be { path, digest }`, path: sub });
    }
  }
  const harness = obj(p.harness);
  if (!harness || !nonEmptyString(harness.version) || !nonEmptyString(harness.command)) {
    errors.push({ code: "PROVENANCE_FIELD_INVALID", message: "harness must be { version, command }", path: "harness" });
  }
  const result = obj(p.result);
  if (!result || typeof result.exit_code !== "number" || !nonEmptyString(result.classification)) {
    errors.push({ code: "PROVENANCE_FIELD_INVALID", message: "result must be { exit_code, classification }", path: "result" });
  }
  return { valid: errors.length === 0, errors };
}
