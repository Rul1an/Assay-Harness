import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  TRUST_CARD_BOUNDARIES,
  TRUST_CARD_CLAIM_IDS,
  TRUST_CARD_LEVELS,
  TRUST_CARD_NON_GOALS,
  TRUST_CARD_SCHEMA_VERSION,
  TRUST_CARD_SOURCES,
  validateTrustCardCompatibility,
} from "../dist/trust_card_compat.js";

function makeValidClaims() {
  return [
    {
      id: "bundle_verified",
      level: "verified",
      source: "bundle_verification",
      boundary: "bundle-wide",
      note: null,
    },
    {
      id: "signing_evidence_present",
      level: "absent",
      source: "bundle_proof_surface",
      boundary: "proof-surfaces-only",
      note: null,
    },
    {
      id: "provenance_backed_claims_present",
      level: "absent",
      source: "bundle_proof_surface",
      boundary: "proof-surfaces-only",
      note: null,
    },
    {
      id: "delegation_context_visible",
      level: "verified",
      source: "canonical_decision_evidence",
      boundary: "supported-delegated-flows-only",
      note: null,
    },
    {
      id: "authorization_context_visible",
      level: "absent",
      source: "canonical_decision_evidence",
      boundary: "supported-auth-projected-flows-only",
      note: null,
    },
    {
      id: "containment_degradation_observed",
      level: "verified",
      source: "canonical_event_presence",
      boundary: "supported-containment-fallback-paths-only",
      note: null,
    },
    {
      id: "external_eval_receipt_boundary_visible",
      level: "verified",
      source: "external_evidence_receipt",
      boundary: "supported-external-eval-receipt-events-only",
      note: "Promptfoo receipt boundary visible in the baseline run.",
    },
    {
      id: "external_decision_receipt_boundary_visible",
      level: "absent",
      source: "external_decision_receipt",
      boundary: "supported-external-decision-receipt-events-only",
      note: null,
    },
    {
      id: "external_inventory_receipt_boundary_visible",
      level: "absent",
      source: "external_inventory_receipt",
      boundary: "supported-external-inventory-receipt-events-only",
      note: null,
    },
    {
      id: "applied_pack_findings_present",
      level: "absent",
      source: "pack_execution_results",
      boundary: "pack-execution-only",
      note: null,
    },
  ];
}

function makeValidCard() {
  return {
    schema_version: 5,
    claims: makeValidClaims(),
    non_goals: [
      "No aggregate trust score",
      "No safe/unsafe badge",
      "No correctness guarantees beyond stated claim boundaries",
    ],
  };
}

function makeValidPairedBasis() {
  return {
    claims: makeValidClaims(),
  };
}

test("constants match upstream Assay v6.0.0 freeze", () => {
  assert.equal(TRUST_CARD_SCHEMA_VERSION, 5);
  assert.equal(TRUST_CARD_CLAIM_IDS.length, 10);
  assert.equal(TRUST_CARD_NON_GOALS.length, 3);
  assert.deepEqual(TRUST_CARD_NON_GOALS, [
    "No aggregate trust score",
    "No safe/unsafe badge",
    "No correctness guarantees beyond stated claim boundaries",
  ]);
  assert.equal(TRUST_CARD_LEVELS.length, 4);
  assert.equal(TRUST_CARD_SOURCES.length, 8);
  assert.equal(TRUST_CARD_BOUNDARIES.length, 9);
});

test("valid card and paired basis pass validation", () => {
  const card = makeValidCard();
  const basis = makeValidPairedBasis();
  const result = validateTrustCardCompatibility(card, basis);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("valid card without paired basis passes validation", () => {
  const card = makeValidCard();
  const result = validateTrustCardCompatibility(card);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("refuses non-object card", () => {
  for (const invalid of [null, undefined, "not an object", 42, [makeValidCard()]]) {
    const result = validateTrustCardCompatibility(invalid);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_NOT_OBJECT"));
  }
});

test("refuses invalid schema_version: number 4, string '5', null, float 5.5", () => {
  for (const badVersion of [4, 6, "5", null, undefined, 5.5, NaN]) {
    const card = { ...makeValidCard(), schema_version: badVersion };
    const result = validateTrustCardCompatibility(card);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.code === "TRUST_CARD_SCHEMA_INVALID"),
      `expected TRUST_CARD_SCHEMA_INVALID for ${String(badVersion)}`,
    );
  }
});

test("refuses card with unexpected top-level extra keys", () => {
  const card = { ...makeValidCard(), extra_key: "forbidden", trust_score: 99 };
  const result = validateTrustCardCompatibility(card);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_EXTRA_KEYS"));
});

test("refuses invalid non_goals: modified, reordered, missing or extra", () => {
  // Reordered
  const reordered = {
    ...makeValidCard(),
    non_goals: [
      "No safe/unsafe badge",
      "No aggregate trust score",
      "No correctness guarantees beyond stated claim boundaries",
    ],
  };
  let result = validateTrustCardCompatibility(reordered);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_NON_GOALS_INVALID"));

  // Modified text
  const modified = {
    ...makeValidCard(),
    non_goals: [
      "No aggregate trust score",
      "No safe/unsafe badge",
      "Modified non-goal claim",
    ],
  };
  result = validateTrustCardCompatibility(modified);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_NON_GOALS_INVALID"));

  // Wrong count
  const missingOne = {
    ...makeValidCard(),
    non_goals: ["No aggregate trust score", "No safe/unsafe badge"],
  };
  result = validateTrustCardCompatibility(missingOne);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_NON_GOALS_INVALID"));
});

test("refuses claims array with wrong count, missing, duplicate, or unknown claim", () => {
  // Missing claim (9 claims)
  const nineClaims = { ...makeValidCard(), claims: makeValidClaims().slice(1) };
  let result = validateTrustCardCompatibility(nineClaims);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.code === "TRUST_CARD_CLAIMS_INVALID" || e.code === "TRUST_CARD_CLAIM_MISSING",
    ),
  );

  // Duplicate claim ID
  const dupClaims = makeValidClaims();
  dupClaims[1] = { ...dupClaims[0] };
  const duplicate = { ...makeValidCard(), claims: dupClaims };
  result = validateTrustCardCompatibility(duplicate);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_CLAIM_DUPLICATE"));

  // Unknown claim ID
  const unknownClaims = makeValidClaims();
  unknownClaims[0] = { ...unknownClaims[0], id: "unknown_synthetic_claim" };
  const unknown = { ...makeValidCard(), claims: unknownClaims };
  result = validateTrustCardCompatibility(unknown);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_CLAIM_UNKNOWN"));
});

test("refuses claim with invalid level, source, or boundary enum values", () => {
  // Invalid level
  const badLevel = makeValidClaims();
  badLevel[0] = { ...badLevel[0], level: "guaranteed" };
  let result = validateTrustCardCompatibility({ ...makeValidCard(), claims: badLevel });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_CLAIM_FIELD_INVALID"));

  // Invalid source
  const badSource = makeValidClaims();
  badSource[0] = { ...badSource[0], source: "magic_oracle" };
  result = validateTrustCardCompatibility({ ...makeValidCard(), claims: badSource });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_CLAIM_FIELD_INVALID"));

  // Invalid boundary: snake_case instead of kebab-case (e.g. "bundle_wide")
  const badBoundary = makeValidClaims();
  badBoundary[0] = { ...badBoundary[0], boundary: "bundle_wide" };
  result = validateTrustCardCompatibility({ ...makeValidCard(), claims: badBoundary });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_CLAIM_FIELD_INVALID"));

  // Invalid note (non-string, non-null)
  const badNote = makeValidClaims();
  badNote[0] = { ...badNote[0], note: 12345 };
  result = validateTrustCardCompatibility({ ...makeValidCard(), claims: badNote });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_CLAIM_FIELD_INVALID"));
});

test("refuses claim with extra unknown properties", () => {
  const extraProps = makeValidClaims();
  extraProps[0] = { ...extraProps[0], extra_score: 100 };
  const result = validateTrustCardCompatibility({ ...makeValidCard(), claims: extraProps });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_CLAIM_EXTRA_KEYS"));
});

test("refuses paired basis with differing claims (described as differing claims, not bundle mismatch)", () => {
  const card = makeValidCard();

  // Differing level
  const differingLevelBasis = makeValidPairedBasis();
  differingLevelBasis.claims[0] = { ...differingLevelBasis.claims[0], level: "absent" };
  let result = validateTrustCardCompatibility(card, differingLevelBasis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "PAIRED_BASIS_CLAIM_MISMATCH"));

  // Differing source
  const differingSourceBasis = makeValidPairedBasis();
  differingSourceBasis.claims[0] = {
    ...differingSourceBasis.claims[0],
    source: "canonical_decision_evidence",
  };
  result = validateTrustCardCompatibility(card, differingSourceBasis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "PAIRED_BASIS_CLAIM_MISMATCH"));

  // Differing boundary
  const differingBoundaryBasis = makeValidPairedBasis();
  differingBoundaryBasis.claims[0] = {
    ...differingBoundaryBasis.claims[0],
    boundary: "proof-surfaces-only",
  };
  result = validateTrustCardCompatibility(card, differingBoundaryBasis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "PAIRED_BASIS_CLAIM_MISMATCH"));

  // Differing note
  const differingNoteBasis = makeValidPairedBasis();
  differingNoteBasis.claims[6] = {
    ...differingNoteBasis.claims[6],
    note: "Different note text from paired basis.",
  };
  result = validateTrustCardCompatibility(card, differingNoteBasis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "PAIRED_BASIS_CLAIM_MISMATCH"));

  // Missing claim in basis
  const missingClaimBasis = { claims: makeValidClaims().slice(1) };
  result = validateTrustCardCompatibility(card, missingClaimBasis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "PAIRED_BASIS_CLAIM_MISMATCH"));
});

test("claims comparison is order-insensitive across arrays when all ten IDs match", () => {
  const card = makeValidCard();
  // Reverse the basis claims order
  const reversedBasis = {
    claims: [...makeValidClaims()].reverse(),
  };
  const result = validateTrustCardCompatibility(card, reversedBasis);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("refuses claim with missing note property (F8)", () => {
  const badClaims = makeValidClaims();
  delete badClaims[0].note;
  const result = validateTrustCardCompatibility({ ...makeValidCard(), claims: badClaims });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.code === "TRUST_CARD_CLAIM_FIELD_INVALID" && e.path === "claims[0].note",
    ),
  );
});

test("refuses paired basis with unexpected top-level extra keys (F9)", () => {
  const card = makeValidCard();
  const badBasis = {
    ...makeValidPairedBasis(),
    schema_version: 99,
    injected: "anything",
  };
  const result = validateTrustCardCompatibility(card, badBasis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "PAIRED_BASIS_EXTRA_KEYS"));
});

test("refuses paired basis with duplicate claim id (F9)", () => {
  const card = makeValidCard();
  const dupBasisClaims = makeValidClaims();
  dupBasisClaims[1] = { ...dupBasisClaims[0] };
  const result = validateTrustCardCompatibility(card, { claims: dupBasisClaims });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "PAIRED_BASIS_CLAIM_DUPLICATE"));
});

test("refuses paired basis when note type differs without coercion (F9)", () => {
  const cardClaims = makeValidClaims();
  cardClaims[0] = { ...cardClaims[0], note: "5" };
  const card = { ...makeValidCard(), claims: cardClaims };

  const basisClaims = makeValidClaims();
  basisClaims[0] = { ...basisClaims[0], note: 5 };
  const basis = { claims: basisClaims };

  const result = validateTrustCardCompatibility(card, basis);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.code === "TRUST_CARD_CLAIM_FIELD_INVALID" || e.code === "PAIRED_BASIS_CLAIM_MISMATCH",
    ),
  );
});

test("refuses paired basis with missing note property (F9)", () => {
  const card = makeValidCard();
  const basisClaims = makeValidClaims();
  delete basisClaims[0].note;
  const result = validateTrustCardCompatibility(card, { claims: basisClaims });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.code === "PAIRED_BASIS_CLAIM_FIELD_INVALID" && e.path === "paired_basis.claims[0].note",
    ),
  );
});

test("claimsParity is true when claim levels match even if card schema is invalid (G3)", () => {
  const invalidSchemaCard = {
    ...makeValidCard(),
    schema_version: 4,
  };
  const matchingBasis = makeValidPairedBasis();
  const result = validateTrustCardCompatibility(invalidSchemaCard, matchingBasis);
  assert.equal(result.valid, false, "overall validation must fail due to schema_version");
  assert.ok(result.errors.some((e) => e.code === "TRUST_CARD_SCHEMA_INVALID"));
  assert.equal(result.claimsParity, true, "claimsParity must remain true when claim levels match");
});

test("refuses positive claimsParity when card claims array is empty (H2)", () => {
  const emptyClaimsCard = {
    ...makeValidCard(),
    claims: [],
  };
  const matchingBasis = makeValidPairedBasis();
  const result = validateTrustCardCompatibility(emptyClaimsCard, matchingBasis);
  assert.equal(result.valid, false);
  assert.equal(result.claimsParity, false, "empty claims cannot yield positive claimsParity");
});

test("refuses positive claimsParity when a card claim has invalid level (H2)", () => {
  const invalidClaimCard = makeValidCard();
  invalidClaimCard.claims[0].level = "not_a_valid_level";
  const matchingBasis = makeValidPairedBasis();
  const result = validateTrustCardCompatibility(invalidClaimCard, matchingBasis);
  assert.equal(result.valid, false);
  assert.equal(result.claimsParity, false, "invalid claim level cannot yield positive claimsParity");
});
