/**
 * Trust Card compatibility validator — Assay release compatibility (T1b).
 *
 * Validates the canonical `trustcard.json` artifact emitted by Assay's
 * `trust-card generate` subcommand against upstream v6.0.0 invariants
 * and compares claims with the paired Trust Basis artifact.
 *
 * Upstream contract:
 * - schema_version: 5 (integer, not string; no top-level schema string URI)
 * - non_goals: 3 frozen strings in exact order
 * - claims: 10 frozen claim IDs, exact keys { id, level, source, boundary, note } where note is required string | null
 * - enums: 4 levels (snake_case), 8 sources (snake_case), 9 boundaries (kebab-case)
 */

export const TRUST_CARD_SCHEMA_VERSION = 5;

export const TRUST_CARD_NON_GOALS = Object.freeze([
  "No aggregate trust score",
  "No safe/unsafe badge",
  "No correctness guarantees beyond stated claim boundaries",
]);

export const TRUST_CARD_CLAIM_IDS = Object.freeze([
  "bundle_verified",
  "signing_evidence_present",
  "provenance_backed_claims_present",
  "delegation_context_visible",
  "authorization_context_visible",
  "containment_degradation_observed",
  "external_eval_receipt_boundary_visible",
  "external_decision_receipt_boundary_visible",
  "external_inventory_receipt_boundary_visible",
  "applied_pack_findings_present",
]);

export const TRUST_CARD_LEVELS = Object.freeze([
  "verified",
  "self_reported",
  "inferred",
  "absent",
]);

export const TRUST_CARD_SOURCES = Object.freeze([
  "bundle_verification",
  "bundle_proof_surface",
  "canonical_decision_evidence",
  "canonical_event_presence",
  "external_evidence_receipt",
  "external_decision_receipt",
  "external_inventory_receipt",
  "pack_execution_results",
]);

export const TRUST_CARD_BOUNDARIES = Object.freeze([
  "bundle-wide",
  "supported-delegated-flows-only",
  "supported-auth-projected-flows-only",
  "supported-containment-fallback-paths-only",
  "supported-external-eval-receipt-events-only",
  "supported-external-decision-receipt-events-only",
  "supported-external-inventory-receipt-events-only",
  "proof-surfaces-only",
  "pack-execution-only",
]);

const FROZEN_CLAIM_IDS_SET = new Set<string>(TRUST_CARD_CLAIM_IDS);
const FROZEN_LEVELS_SET = new Set<string>(TRUST_CARD_LEVELS);
const FROZEN_SOURCES_SET = new Set<string>(TRUST_CARD_SOURCES);
const FROZEN_BOUNDARIES_SET = new Set<string>(TRUST_CARD_BOUNDARIES);
const ALLOWED_CARD_TOP_KEYS = new Set<string>(["schema_version", "claims", "non_goals"]);
const ALLOWED_BASIS_TOP_KEYS = new Set<string>(["claims"]);
const ALLOWED_CLAIM_KEYS = new Set<string>(["id", "level", "source", "boundary", "note"]);

export interface TrustCardCompatError {
  code: string;
  message: string;
  path?: string;
}

export interface TrustCardCompatResult {
  valid: boolean;
  claimsParity: boolean;
  errors: TrustCardCompatError[];
}

export interface TrustCardClaim {
  id: string;
  level: string;
  source: string;
  boundary: string;
  note: string | null;
}

export interface TrustCard {
  schema_version: number;
  claims: TrustCardClaim[];
  non_goals: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shared claim object validation for Trust Card claims and paired Trust Basis claims (F8, F9).
 */
function validateClaimObject(
  rawClaim: unknown,
  index: number,
  prefix: string,
  errors: TrustCardCompatError[],
): TrustCardClaim | null {
  const claimPath = `${prefix}[${index}]`;

  if (!isPlainObject(rawClaim)) {
    errors.push({
      code: prefix === "claims" ? "TRUST_CARD_CLAIM_FIELD_INVALID" : "PAIRED_BASIS_CLAIM_FIELD_INVALID",
      message: `Claim at index ${index} must be a JSON object`,
      path: claimPath,
    });
    return null;
  }

  const claim = rawClaim as Record<string, unknown>;

  // Check for unexpected extra keys in claim object
  for (const k of Object.keys(claim)) {
    if (!ALLOWED_CLAIM_KEYS.has(k)) {
      errors.push({
        code: prefix === "claims" ? "TRUST_CARD_CLAIM_EXTRA_KEYS" : "PAIRED_BASIS_CLAIM_EXTRA_KEYS",
        message: `Unexpected key in claim at index ${index}: ${k}`,
        path: `${claimPath}.${k}`,
      });
    }
  }

  // id
  const id = claim.id;
  if (typeof id !== "string" || !FROZEN_CLAIM_IDS_SET.has(id)) {
    errors.push({
      code: prefix === "claims" ? "TRUST_CARD_CLAIM_UNKNOWN" : "PAIRED_BASIS_CLAIM_UNKNOWN",
      message: `Unknown or invalid claim id at index ${index}: ${JSON.stringify(id)}`,
      path: `${claimPath}.id`,
    });
  }

  // level
  if (typeof claim.level !== "string" || !FROZEN_LEVELS_SET.has(claim.level)) {
    errors.push({
      code: prefix === "claims" ? "TRUST_CARD_CLAIM_FIELD_INVALID" : "PAIRED_BASIS_CLAIM_FIELD_INVALID",
      message: `Invalid claim level at index ${index}: ${JSON.stringify(claim.level)}`,
      path: `${claimPath}.level`,
    });
  }

  // source
  if (typeof claim.source !== "string" || !FROZEN_SOURCES_SET.has(claim.source)) {
    errors.push({
      code: prefix === "claims" ? "TRUST_CARD_CLAIM_FIELD_INVALID" : "PAIRED_BASIS_CLAIM_FIELD_INVALID",
      message: `Invalid claim source at index ${index}: ${JSON.stringify(claim.source)}`,
      path: `${claimPath}.source`,
    });
  }

  // boundary
  if (typeof claim.boundary !== "string" || !FROZEN_BOUNDARIES_SET.has(claim.boundary)) {
    errors.push({
      code: prefix === "claims" ? "TRUST_CARD_CLAIM_FIELD_INVALID" : "PAIRED_BASIS_CLAIM_FIELD_INVALID",
      message: `Invalid claim boundary at index ${index}: ${JSON.stringify(claim.boundary)}`,
      path: `${claimPath}.boundary`,
    });
  }

  // note: must be explicitly present and be string or null as emitted by Assay v6.0.0 (F8)
  if (!Object.hasOwn(claim, "note") || claim.note === undefined) {
    errors.push({
      code: prefix === "claims" ? "TRUST_CARD_CLAIM_FIELD_INVALID" : "PAIRED_BASIS_CLAIM_FIELD_INVALID",
      message: `Claim note at index ${index} must be present as string or null; property missing`,
      path: `${claimPath}.note`,
    });
  } else if (claim.note !== null && typeof claim.note !== "string") {
    errors.push({
      code: prefix === "claims" ? "TRUST_CARD_CLAIM_FIELD_INVALID" : "PAIRED_BASIS_CLAIM_FIELD_INVALID",
      message: `Claim note at index ${index} must be string or null; got ${typeof claim.note}`,
      path: `${claimPath}.note`,
    });
  }

  if (
    typeof id === "string" &&
    FROZEN_CLAIM_IDS_SET.has(id) &&
    typeof claim.level === "string" &&
    FROZEN_LEVELS_SET.has(claim.level) &&
    typeof claim.source === "string" &&
    FROZEN_SOURCES_SET.has(claim.source) &&
    typeof claim.boundary === "string" &&
    FROZEN_BOUNDARIES_SET.has(claim.boundary) &&
    Object.hasOwn(claim, "note") &&
    (claim.note === null || typeof claim.note === "string")
  ) {
    return {
      id,
      level: claim.level,
      source: claim.source,
      boundary: claim.boundary,
      note: claim.note as string | null,
    };
  }

  return null;
}

/**
 * Shared claims array validation: checks arrayness, exact count of 10, no duplicates, all 10 present (F8, F9).
 */
function validateClaimsArray(
  claims: unknown,
  prefix: string,
  errors: TrustCardCompatError[],
): Map<string, TrustCardClaim> | null {
  if (!Array.isArray(claims)) {
    errors.push({
      code: prefix === "claims" ? "TRUST_CARD_CLAIMS_INVALID" : "PAIRED_BASIS_INVALID",
      message: `${prefix} must be an array`,
      path: prefix,
    });
    return null;
  }

  if (claims.length !== TRUST_CARD_CLAIM_IDS.length) {
    errors.push({
      code: prefix === "claims" ? "TRUST_CARD_CLAIMS_INVALID" : "PAIRED_BASIS_INVALID",
      message: `${prefix} must have exactly ${TRUST_CARD_CLAIM_IDS.length} items; got ${claims.length}`,
      path: prefix,
    });
  }

  const claimsById = new Map<string, TrustCardClaim>();
  const seenIds = new Set<string>();

  for (let i = 0; i < claims.length; i++) {
    const rawClaim = claims[i];
    const rawId = isPlainObject(rawClaim) && typeof rawClaim.id === "string" ? rawClaim.id : undefined;

    if (rawId !== undefined && seenIds.has(rawId)) {
      errors.push({
        code: prefix === "claims" ? "TRUST_CARD_CLAIM_DUPLICATE" : "PAIRED_BASIS_CLAIM_DUPLICATE",
        message: `Duplicate claim id at index ${i}: ${rawId}`,
        path: `${prefix}[${i}].id`,
      });
    } else if (rawId !== undefined) {
      seenIds.add(rawId);
    }

    const validated = validateClaimObject(rawClaim, i, prefix, errors);
    if (validated && !claimsById.has(validated.id)) {
      claimsById.set(validated.id, validated);
    }
  }

  for (const expectedId of TRUST_CARD_CLAIM_IDS) {
    if (!seenIds.has(expectedId)) {
      errors.push({
        code: prefix === "claims" ? "TRUST_CARD_CLAIM_MISSING" : "PAIRED_BASIS_CLAIM_MISSING",
        message: `Required claim id missing from ${prefix}: ${expectedId}`,
        path: `${prefix}.${expectedId}`,
      });
    }
  }

  return claimsById;
}

/**
 * Validate a Trust Card artifact against the upstream schema version 5 contract,
 * optionally verifying claim parity against a paired Trust Basis artifact.
 */
export function validateTrustCardCompatibility(
  card: unknown,
  pairedBasis?: unknown,
): TrustCardCompatResult {
  const errors: TrustCardCompatError[] = [];

  // Root must be a plain JSON object
  if (!isPlainObject(card)) {
    return {
      valid: false,
      claimsParity: false,
      errors: [
        {
          code: "TRUST_CARD_NOT_OBJECT",
          message: "Trust card must be a JSON object",
        },
      ],
    };
  }

  // Reject unexpected top-level keys
  const topKeys = Object.keys(card);
  for (const k of topKeys) {
    if (!ALLOWED_CARD_TOP_KEYS.has(k)) {
      errors.push({
        code: "TRUST_CARD_EXTRA_KEYS",
        message: `Unexpected top-level key in trust card: ${k}`,
        path: k,
      });
    }
  }

  // Check schema_version: strictly integer 5
  if (
    typeof card.schema_version !== "number" ||
    !Number.isInteger(card.schema_version) ||
    card.schema_version !== TRUST_CARD_SCHEMA_VERSION
  ) {
    errors.push({
      code: "TRUST_CARD_SCHEMA_INVALID",
      message: `schema_version must be integer ${TRUST_CARD_SCHEMA_VERSION}; got ${JSON.stringify(card.schema_version)}`,
      path: "schema_version",
    });
  }

  // Check non_goals: array of 3 strings matching TRUST_CARD_NON_GOALS in exact order
  if (!Array.isArray(card.non_goals)) {
    errors.push({
      code: "TRUST_CARD_NON_GOALS_INVALID",
      message: "non_goals must be an array of strings",
      path: "non_goals",
    });
  } else {
    if (card.non_goals.length !== TRUST_CARD_NON_GOALS.length) {
      errors.push({
        code: "TRUST_CARD_NON_GOALS_INVALID",
        message: `non_goals must contain exactly ${TRUST_CARD_NON_GOALS.length} items; got ${card.non_goals.length}`,
        path: "non_goals",
      });
    } else {
      for (let i = 0; i < TRUST_CARD_NON_GOALS.length; i++) {
        if (card.non_goals[i] !== TRUST_CARD_NON_GOALS[i]) {
          errors.push({
            code: "TRUST_CARD_NON_GOALS_INVALID",
            message: `non_goals[${i}] mismatch: expected ${JSON.stringify(TRUST_CARD_NON_GOALS[i])}, got ${JSON.stringify(card.non_goals[i])}`,
            path: `non_goals[${i}]`,
          });
        }
      }
    }
  }

  // Check card claims array
  const cardClaimsById = validateClaimsArray(card.claims, "claims", errors);

  // Validate paired Trust Basis claim parity if provided
  let basisClaimsById: Map<string, TrustCardClaim> | null = null;
  if (pairedBasis !== undefined) {
    if (!isPlainObject(pairedBasis)) {
      errors.push({
        code: "PAIRED_BASIS_INVALID",
        message: "Paired Trust Basis must be a JSON object",
      });
    } else {
      // Reject extra top-level keys in paired basis (F9)
      for (const k of Object.keys(pairedBasis)) {
        if (!ALLOWED_BASIS_TOP_KEYS.has(k)) {
          errors.push({
            code: "PAIRED_BASIS_EXTRA_KEYS",
            message: `Unexpected top-level key in paired trust basis: ${k}`,
            path: k,
          });
        }
      }
      basisClaimsById = validateClaimsArray(pairedBasis.claims, "paired_basis.claims", errors);
    }

    // Compare card claims against paired basis claims (strict equality, no String coercion)
    if (cardClaimsById && basisClaimsById) {
      for (const [id, cClaim] of cardClaimsById.entries()) {
        const bClaim = basisClaimsById.get(id);
        if (!bClaim) {
          errors.push({
            code: "PAIRED_BASIS_CLAIM_MISMATCH",
            message: `Claim ${id} present in Trust Card but missing in paired Trust Basis`,
            path: `claims.${id}`,
          });
          continue;
        }

        if (cClaim.level !== bClaim.level) {
          errors.push({
            code: "PAIRED_BASIS_CLAIM_MISMATCH",
            message: `Claim ${id} level mismatch: card has ${JSON.stringify(cClaim.level)}, basis has ${JSON.stringify(bClaim.level)}`,
            path: `claims.${id}.level`,
          });
        }
        if (cClaim.source !== bClaim.source) {
          errors.push({
            code: "PAIRED_BASIS_CLAIM_MISMATCH",
            message: `Claim ${id} source mismatch: card has ${JSON.stringify(cClaim.source)}, basis has ${JSON.stringify(bClaim.source)}`,
            path: `claims.${id}.source`,
          });
        }
        if (cClaim.boundary !== bClaim.boundary) {
          errors.push({
            code: "PAIRED_BASIS_CLAIM_MISMATCH",
            message: `Claim ${id} boundary mismatch: card has ${JSON.stringify(cClaim.boundary)}, basis has ${JSON.stringify(bClaim.boundary)}`,
            path: `claims.${id}.boundary`,
          });
        }
        // Strict equality without coercion (F9)
        if (cClaim.note !== bClaim.note) {
          errors.push({
            code: "PAIRED_BASIS_CLAIM_MISMATCH",
            message: `Claim ${id} note mismatch: card has ${JSON.stringify(cClaim.note)}, basis has ${JSON.stringify(bClaim.note)}`,
            path: `claims.${id}.note`,
          });
        }
      }
    }
  }

  const hasBasisErrors = errors.some((e) => e.code.startsWith("PAIRED_BASIS_"));
  const hasCardClaimErrors =
    cardClaimsById === null ||
    cardClaimsById.size !== TRUST_CARD_CLAIM_IDS.length ||
    errors.some((e) => e.code.startsWith("TRUST_CARD_CLAIM"));
  const claimsParity =
    pairedBasis !== undefined && !hasBasisErrors && !hasCardClaimErrors;

  return {
    valid: errors.length === 0,
    claimsParity,
    errors,
  };
}
