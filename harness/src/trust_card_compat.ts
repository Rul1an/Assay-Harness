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
 * - claims: 10 frozen claim IDs, exact keys { id, level, source, boundary, note? }
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
const ALLOWED_CLAIM_KEYS = new Set<string>(["id", "level", "source", "boundary", "note"]);

export interface TrustCardCompatError {
  code: string;
  message: string;
  path?: string;
}

export interface TrustCardCompatResult {
  valid: boolean;
  errors: TrustCardCompatError[];
}

export interface TrustCardClaim {
  id: string;
  level: string;
  source: string;
  boundary: string;
  note?: string | null;
}

export interface TrustCard {
  schema_version: number;
  claims: TrustCardClaim[];
  non_goals: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNote(note: unknown): string | null {
  if (note === undefined || note === null) return null;
  return String(note);
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

  if (!isPlainObject(card)) {
    return {
      valid: false,
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

  // Check claims array
  const cardClaimsById = new Map<string, TrustCardClaim>();

  if (!Array.isArray(card.claims)) {
    errors.push({
      code: "TRUST_CARD_CLAIMS_INVALID",
      message: "claims must be an array",
      path: "claims",
    });
  } else {
    if (card.claims.length !== TRUST_CARD_CLAIM_IDS.length) {
      errors.push({
        code: "TRUST_CARD_CLAIMS_INVALID",
        message: `claims must have exactly ${TRUST_CARD_CLAIM_IDS.length} items; got ${card.claims.length}`,
        path: "claims",
      });
    }

    const seenClaimIds = new Set<string>();

    for (let i = 0; i < card.claims.length; i++) {
      const claim = card.claims[i];
      const claimPath = `claims[${i}]`;

      if (!isPlainObject(claim)) {
        errors.push({
          code: "TRUST_CARD_CLAIM_FIELD_INVALID",
          message: `Claim at index ${i} must be a JSON object`,
          path: claimPath,
        });
        continue;
      }

      // Check for extra claim keys
      for (const k of Object.keys(claim)) {
        if (!ALLOWED_CLAIM_KEYS.has(k)) {
          errors.push({
            code: "TRUST_CARD_CLAIM_EXTRA_KEYS",
            message: `Unexpected key in claim at index ${i}: ${k}`,
            path: `${claimPath}.${k}`,
          });
        }
      }

      // id
      const id = claim.id;
      if (typeof id !== "string" || !FROZEN_CLAIM_IDS_SET.has(id)) {
        errors.push({
          code: "TRUST_CARD_CLAIM_UNKNOWN",
          message: `Unknown or invalid claim id at index ${i}: ${JSON.stringify(id)}`,
          path: `${claimPath}.id`,
        });
      } else if (seenClaimIds.has(id)) {
        errors.push({
          code: "TRUST_CARD_CLAIM_DUPLICATE",
          message: `Duplicate claim id at index ${i}: ${id}`,
          path: `${claimPath}.id`,
        });
      } else {
        seenClaimIds.add(id);
        cardClaimsById.set(id, claim as unknown as TrustCardClaim);
      }

      // level
      if (typeof claim.level !== "string" || !FROZEN_LEVELS_SET.has(claim.level)) {
        errors.push({
          code: "TRUST_CARD_CLAIM_FIELD_INVALID",
          message: `Invalid claim level at index ${i}: ${JSON.stringify(claim.level)}`,
          path: `${claimPath}.level`,
        });
      }

      // source
      if (typeof claim.source !== "string" || !FROZEN_SOURCES_SET.has(claim.source)) {
        errors.push({
          code: "TRUST_CARD_CLAIM_FIELD_INVALID",
          message: `Invalid claim source at index ${i}: ${JSON.stringify(claim.source)}`,
          path: `${claimPath}.source`,
        });
      }

      // boundary
      if (typeof claim.boundary !== "string" || !FROZEN_BOUNDARIES_SET.has(claim.boundary)) {
        errors.push({
          code: "TRUST_CARD_CLAIM_FIELD_INVALID",
          message: `Invalid claim boundary at index ${i}: ${JSON.stringify(claim.boundary)}`,
          path: `${claimPath}.boundary`,
        });
      }

      // note (optional string or null)
      if (claim.note !== undefined && claim.note !== null && typeof claim.note !== "string") {
        errors.push({
          code: "TRUST_CARD_CLAIM_FIELD_INVALID",
          message: `Claim note at index ${i} must be string or null if present; got ${typeof claim.note}`,
          path: `${claimPath}.note`,
        });
      }
    }

    // Check that all 10 frozen claim IDs are present
    for (const expectedId of TRUST_CARD_CLAIM_IDS) {
      if (!seenClaimIds.has(expectedId)) {
        errors.push({
          code: "TRUST_CARD_CLAIM_MISSING",
          message: `Required claim id missing from trust card: ${expectedId}`,
          path: `claims.${expectedId}`,
        });
      }
    }
  }

  // Validate paired Trust Basis claim parity if provided
  if (pairedBasis !== undefined) {
    if (!isPlainObject(pairedBasis)) {
      errors.push({
        code: "PAIRED_BASIS_INVALID",
        message: "Paired Trust Basis must be a JSON object",
      });
    } else if (!Array.isArray(pairedBasis.claims)) {
      errors.push({
        code: "PAIRED_BASIS_INVALID",
        message: "Paired Trust Basis claims must be an array",
        path: "claims",
      });
    } else {
      const basisClaimsById = new Map<string, TrustCardClaim>();

      for (let i = 0; i < pairedBasis.claims.length; i++) {
        const bClaim = pairedBasis.claims[i];
        if (isPlainObject(bClaim) && typeof bClaim.id === "string") {
          basisClaimsById.set(bClaim.id, bClaim as unknown as TrustCardClaim);
        }
      }

      // Compare card claims against paired basis claims
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
        if (normalizeNote(cClaim.note) !== normalizeNote(bClaim.note)) {
          errors.push({
            code: "PAIRED_BASIS_CLAIM_MISMATCH",
            message: `Claim ${id} note mismatch: card has ${JSON.stringify(cClaim.note)}, basis has ${JSON.stringify(bClaim.note)}`,
            path: `claims.${id}.note`,
          });
        }
      }

      // Ensure paired basis has no extra claims
      for (const [id] of basisClaimsById.entries()) {
        if (!cardClaimsById.has(id)) {
          errors.push({
            code: "PAIRED_BASIS_CLAIM_MISMATCH",
            message: `Claim ${id} present in paired Trust Basis but missing in Trust Card`,
            path: `claims.${id}`,
          });
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
