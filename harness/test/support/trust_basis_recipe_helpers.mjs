import { strict as assert } from "node:assert";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

export const TRUST_BASIS_CLAIMS = [
  {
    id: "bundle_verified",
    source: "bundle_verification",
    boundary: "bundle-wide",
  },
  {
    id: "signing_evidence_present",
    source: "bundle_proof_surface",
    boundary: "proof-surfaces-only",
  },
  {
    id: "provenance_backed_claims_present",
    source: "bundle_proof_surface",
    boundary: "proof-surfaces-only",
  },
  {
    id: "delegation_context_visible",
    source: "canonical_decision_evidence",
    boundary: "supported-delegated-flows-only",
  },
  {
    id: "authorization_context_visible",
    source: "canonical_decision_evidence",
    boundary: "supported-auth-projected-flows-only",
  },
  {
    id: "containment_degradation_observed",
    source: "canonical_event_presence",
    boundary: "supported-containment-fallback-paths-only",
  },
  {
    id: "external_eval_receipt_boundary_visible",
    source: "external_evidence_receipt",
    boundary: "supported-external-eval-receipt-events-only",
  },
  {
    id: "external_decision_receipt_boundary_visible",
    source: "external_decision_receipt",
    boundary: "supported-external-decision-receipt-events-only",
  },
  {
    id: "external_inventory_receipt_boundary_visible",
    source: "external_inventory_receipt",
    boundary: "supported-external-inventory-receipt-events-only",
  },
  {
    id: "applied_pack_findings_present",
    source: "pack_execution_results",
    boundary: "pack-execution-only",
  },
];

export const FAMILY_CLAIM_IDS = {
  eval: "external_eval_receipt_boundary_visible",
  decision: "external_decision_receipt_boundary_visible",
  inventory: "external_inventory_receipt_boundary_visible",
};

export function assertClaimLevel(trustBasisPath, claimId, expectedLevel) {
  const trustBasis = JSON.parse(readFileSync(trustBasisPath, "utf8"));
  const claim = trustBasis.claims.find((candidate) => candidate.id === claimId);

  assert.ok(claim, `expected Trust Basis claim ${claimId}`);
  assert.equal(claim.level, expectedLevel);
}

export function writeFakeReceiptAssay(
  path,
  { bundleLabel, importerCommand, verifiedClaimId },
) {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const trustBasisClaims = ${JSON.stringify(TRUST_BASIS_CLAIMS, null, 2)};
const verifiedClaimId = ${JSON.stringify(verifiedClaimId)};
const importerCommand = ${JSON.stringify(importerCommand)};
const bundleLabel = ${JSON.stringify(bundleLabel)};
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function writeJson(outPath, value) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(value, null, 2) + "\\n");
}
function trustBasis() {
  return {
    claims: trustBasisClaims.map((claim) => ({
      ...claim,
      level: claim.id === "bundle_verified" || claim.id === verifiedClaimId ? "verified" : "absent",
      note: null,
    })),
  };
}
function diffReport(hasRegression) {
  const regressed = hasRegression
    ? [{ diff_class: "regressed", claim_id: verifiedClaimId, baseline_level: "verified", candidate_level: "absent" }]
    : [];
  const improved = [];
  const removed = [];
  const added = [];
  const metadataChanges = [];
  const unchangedClaimCount =
    trustBasisClaims.length -
    regressed.length -
    improved.length -
    removed.length -
    added.length -
    metadataChanges.length;
  return {
    schema: "assay.trust-basis.diff.v1",
    claim_identity: "claim.id",
    level_order: ["absent", "inferred", "self_reported", "verified"],
    summary: {
      regressed_claims: regressed.length,
      improved_claims: improved.length,
      removed_claims: removed.length,
      added_claims: added.length,
      metadata_changes: metadataChanges.length,
      unchanged_claim_count: unchangedClaimCount,
      has_regressions: hasRegression,
    },
    regressed_claims: regressed,
    improved_claims: improved,
    removed_claims: removed,
    added_claims: added,
    metadata_changes: metadataChanges,
    unchanged_claim_count: unchangedClaimCount,
  };
}
if (args.includes("--help")) process.exit(0);
if (args[0] === "evidence" && args[1] === "import" && args[2] === importerCommand) {
  const input = argValue("--input");
  const out = argValue("--bundle-out");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "fake " + bundleLabel + " bundle from " + input + "\\n");
  process.exit(0);
}
if (args[0] === "evidence" && args[1] === "verify") {
  if (!fs.existsSync(args[2])) process.exit(2);
  process.stdout.write("verified\\n");
  process.exit(0);
}
if (args[0] === "trust-basis" && args[1] === "generate") {
  writeJson(argValue("--out"), trustBasis());
  process.exit(0);
}
if (args[0] === "trust-basis" && args[1] === "diff") {
  const candidate = JSON.parse(fs.readFileSync(args[3], "utf8"));
  const familyClaim = candidate.claims.find((claim) => claim.id === verifiedClaimId);
  if (!familyClaim) {
    process.stderr.write("candidate Trust Basis is missing expected claim: " + verifiedClaimId + "\\n");
    process.exit(2);
  }
  const hasRegression = familyClaim.level === "absent";
  process.stdout.write(JSON.stringify(diffReport(hasRegression), null, 2) + "\\n");
  process.exit(hasRegression && args.includes("--fail-on-regression") ? 1 : 0);
}
process.stderr.write("unexpected fake assay args: " + args.join(" ") + "\\n");
process.exit(2);
`,
    "utf8",
  );
  chmodSync(path, 0o755);
}
