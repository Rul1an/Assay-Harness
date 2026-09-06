import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateTrustCardCompatibility } from "../dist/trust_card_compat.js";
import { computeMatrixDigest, validateSuiteCompatibility } from "../dist/suite_compatibility.js";

const FIXTURE_DIR = new URL("../fixtures/suite-compatibility/trust-card-v6/", import.meta.url);
const RECORD_PATH = fileURLToPath(new URL("trust-card-compatibility.record.json", FIXTURE_DIR));
const CARD_PATH = fileURLToPath(new URL("trustcard.json", FIXTURE_DIR));
const BASIS_PATH = fileURLToPath(new URL("paired.trust-basis.json", FIXTURE_DIR));
const BUNDLE_PATH = fileURLToPath(new URL("bundle.evidence.tar.gz", FIXTURE_DIR));
const DIAGNOSTIC_PATH = fileURLToPath(new URL("diagnostic.json", FIXTURE_DIR));
const MATRIX_PATH = fileURLToPath(new URL("../suite-compatibility.json", import.meta.url));

function sha256(buf) {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

function loadCheckedInEvidence() {
  assert.ok(existsSync(RECORD_PATH), `record fixture must exist at ${RECORD_PATH}`);
  assert.ok(existsSync(CARD_PATH), `trustcard.json must exist at ${CARD_PATH}`);
  assert.ok(existsSync(BASIS_PATH), `paired.trust-basis.json must exist at ${BASIS_PATH}`);
  assert.ok(existsSync(BUNDLE_PATH), `bundle.evidence.tar.gz must exist at ${BUNDLE_PATH}`);
  assert.ok(existsSync(DIAGNOSTIC_PATH), `diagnostic.json must exist at ${DIAGNOSTIC_PATH}`);

  const record = JSON.parse(readFileSync(RECORD_PATH, "utf8"));
  const cardBytes = readFileSync(CARD_PATH);
  const basisBytes = readFileSync(BASIS_PATH);
  const bundleBytes = readFileSync(BUNDLE_PATH);
  const diagnosticBytes = readFileSync(DIAGNOSTIC_PATH);
  const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));

  return { record, cardBytes, basisBytes, bundleBytes, diagnosticBytes, matrix };
}

/**
 * Shared semantic and byte verification function for the hosted Trust Card compatibility record.
 */
export function verifyTrustCardHostedRecord({
  record,
  cardBytes,
  basisBytes,
  bundleBytes,
  diagnosticBytes,
  matrix,
  bypassSemanticValidation = false,
}) {
  // 1. Exact byte integrity check against member declarations
  const cardDigest = sha256(cardBytes);
  assert.equal(cardDigest, record.members.trust_card.digest, "card digest mismatch");
  assert.equal(cardBytes.length, record.members.trust_card.size_bytes, "card size mismatch");

  const basisDigest = sha256(basisBytes);
  assert.equal(basisDigest, record.members.paired_basis.digest, "paired basis digest mismatch");
  assert.equal(basisBytes.length, record.members.paired_basis.size_bytes, "paired basis size mismatch");

  const bundleDigest = sha256(bundleBytes);
  assert.equal(bundleDigest, record.members.bundle.digest, "bundle digest mismatch");
  assert.equal(bundleBytes.length, record.members.bundle.size_bytes, "bundle size mismatch");

  const diagnosticDigest = sha256(diagnosticBytes);
  assert.equal(diagnosticDigest, record.members.diagnostic.digest, "diagnostic digest mismatch");
  assert.equal(diagnosticBytes.length, record.members.diagnostic.size_bytes, "diagnostic size mismatch");

  // 2. Strict JSON parsing
  const card = JSON.parse(cardBytes.toString("utf8"));
  const basis = JSON.parse(basisBytes.toString("utf8"));
  const diag = JSON.parse(diagnosticBytes.toString("utf8"));

  // 3. Shared semantic validation
  let validation = { valid: true, claimsParity: true, errors: [] };
  if (!bypassSemanticValidation) {
    validation = validateTrustCardCompatibility(card, basis);
    assert.equal(validation.valid, true, `shared semantic validation failed: ${JSON.stringify(validation.errors)}`);
    assert.equal(validation.claimsParity, true, "shared claims parity validation failed");
    assert.equal(validation.errors.length, 0, "expected zero validation errors");
  }

  // 4. Diagnostic consistency against actual members and validation results
  assert.equal(diag.schema, "assay.trust_card_compat_diagnostic.v1");
  assert.equal(diag.valid, validation.valid, "diagnostic valid flag must match semantic validation");
  assert.equal(diag.claims_parity, validation.claimsParity, "diagnostic claims_parity must match semantic validation");
  assert.equal(diag.bundle.sha256, bundleDigest, "diagnostic bundle digest mismatch");
  assert.equal(diag.bundle.bytes, bundleBytes.length, "diagnostic bundle bytes mismatch");
  assert.equal(diag.paired_basis.sha256, basisDigest, "diagnostic paired_basis digest mismatch");
  assert.equal(diag.paired_basis.bytes, basisBytes.length, "diagnostic paired_basis bytes mismatch");
  assert.equal(diag.trust_card.sha256, cardDigest, "diagnostic trust_card digest mismatch");
  assert.equal(diag.trust_card.bytes, cardBytes.length, "diagnostic trust_card bytes mismatch");
  assert.equal(diag.trust_card.schema_version, 5);
  assert.equal(diag.trust_card.claim_count, 10);
  assert.deepEqual(diag.errors, []);

  // 5. Authoritative record metadata bindings
  assert.equal(record.schema, "suite.trust_card_compatibility_record.v0");
  assert.equal(record.hosted_run, "34054714155");
  assert.equal(record.job_id, "101544394501");
  assert.equal(record.job_name, "Assay Release Compatibility Recipes");
  assert.equal(record.step_number, 7);
  assert.equal(record.step_name, "Measure released Assay Trust Card compatibility");
  assert.equal(record.measured_head, "fc013f84d38dd60fb241ad55831865b4cac58214");
  assert.equal(record.workflow, ".github/workflows/harness-ci.yml");
  assert.equal(record.runner_os, "ubuntu-latest");
  assert.equal(record.hosted, true);
  assert.equal(record.ambient_scan, false);

  assert.equal(record.assay.version, "v6.0.0");
  assert.equal(record.assay.release_peel, "7df13b3f8767b4227b412fc104c319eb1c5e6aae");
  assert.equal(record.assay.binary_digest_proven_by_artifact, false);

  assert.equal(record.release_asset.path, "assay-v6.0.0-x86_64-unknown-linux-gnu.tar.gz");
  assert.equal(record.release_asset.digest, "sha256:71f0854b469da9fc71fff21565f3880fa0eb2a014dad490302dd3f8282ec7190");

  assert.equal(record.archive.artifact_id, "9995607013");
  assert.equal(record.archive.size_bytes, 60097);
  assert.equal(record.archive.digest, "sha256:e9b16e3a26b2ade6531ca0ad7c502322267494c03fefdaca4b7ad084b5f00efc");

  // Non-claims
  assert.equal(record.non_claims.binary_digest_proven, false);
  assert.equal(record.non_claims.enforcement_health_v6_proven, false);
  assert.equal(record.non_claims.cross_binary_corroboration, false);
  assert.equal(record.non_claims.origin_authentication, false);

  // 6. Cross-binding against matrix recipe row
  const row = matrix.recipe_rows.find((r) => r.recipe === record.recipe);
  assert.ok(row, `matrix must contain recipe row matching ${record.recipe}`);
  assert.equal(row.support_mode, "recipe");
  assert.equal(row.backing, "public-only");
  assert.equal(row.proof.end_to_end, "proven");
  assert.equal(row.proof.hosted_run, record.hosted_run);
  assert.equal(row.proof.artifact_digest, record.archive.digest);
  assert.equal(row.proof.assay_version, "v6.0.0");
  assert.equal(row.emits.producer, "assay");
  assert.equal(row.emits.min_version, "v6.0.0");
  assert.equal(row.consumes.consumer, "harness");
  assert.equal(row.consumes.min_version, "v0.10.3");

  const computedMatrixDigest = computeMatrixDigest(matrix);
  assert.equal(matrix.manifest.digest, computedMatrixDigest, "matrix manifest digest must match computeMatrixDigest");

  return { validation, record, row };
}

test("positive control: verified hosted record, exact member bytes, and shared semantic validation pass", () => {
  const env = loadCheckedInEvidence();
  const res = verifyTrustCardHostedRecord(env);
  assert.equal(res.validation.valid, true);
  assert.equal(res.validation.claimsParity, true);
});

test("discriminating control (a): mutated card bytes without digest update fail byte integrity check", () => {
  const env = loadCheckedInEvidence();
  const tamperedCard = Buffer.concat([env.cardBytes, Buffer.from(" ")]);
  assert.throws(
    () => verifyTrustCardHostedRecord({ ...env, cardBytes: tamperedCard }),
    /card digest mismatch|card size mismatch/,
  );
});

test("discriminating control (b): invalid card claim with recomputed member and diagnostic digests is rejected by shared semantic validator", () => {
  const env = loadCheckedInEvidence();
  const cardObj = JSON.parse(env.cardBytes.toString("utf8"));
  cardObj.claims[0].level = "INVALID_LEVEL";
  const mutatedCardBytes = Buffer.from(JSON.stringify(cardObj, null, 2), "utf8");

  const mutatedRecord = JSON.parse(JSON.stringify(env.record));
  mutatedRecord.members.trust_card.digest = sha256(mutatedCardBytes);
  mutatedRecord.members.trust_card.size_bytes = mutatedCardBytes.length;

  const diagObj = JSON.parse(env.diagnosticBytes.toString("utf8"));
  diagObj.trust_card.sha256 = mutatedRecord.members.trust_card.digest;
  diagObj.trust_card.bytes = mutatedRecord.members.trust_card.size_bytes;
  const mutatedDiagBytes = Buffer.from(JSON.stringify(diagObj, null, 2), "utf8");
  mutatedRecord.members.diagnostic.digest = sha256(mutatedDiagBytes);
  mutatedRecord.members.diagnostic.size_bytes = mutatedDiagBytes.length;

  assert.throws(
    () =>
      verifyTrustCardHostedRecord({
        ...env,
        record: mutatedRecord,
        cardBytes: mutatedCardBytes,
        diagnosticBytes: mutatedDiagBytes,
      }),
    /shared semantic validation failed/,
  );
});

test("discriminating control (c): mismatching paired basis claim with recomputed member digests fails claimsParity in shared semantic validator", () => {
  const env = loadCheckedInEvidence();
  const basisObj = JSON.parse(env.basisBytes.toString("utf8"));
  // Flip level on claim 0 to differ from card claim level
  basisObj.claims[0].level = basisObj.claims[0].level === "verified" ? "absent" : "verified";
  const mutatedBasisBytes = Buffer.from(JSON.stringify(basisObj, null, 2), "utf8");

  const mutatedRecord = JSON.parse(JSON.stringify(env.record));
  mutatedRecord.members.paired_basis.digest = sha256(mutatedBasisBytes);
  mutatedRecord.members.paired_basis.size_bytes = mutatedBasisBytes.length;

  const diagObj = JSON.parse(env.diagnosticBytes.toString("utf8"));
  diagObj.paired_basis.sha256 = mutatedRecord.members.paired_basis.digest;
  diagObj.paired_basis.bytes = mutatedRecord.members.paired_basis.size_bytes;
  const mutatedDiagBytes = Buffer.from(JSON.stringify(diagObj, null, 2), "utf8");
  mutatedRecord.members.diagnostic.digest = sha256(mutatedDiagBytes);
  mutatedRecord.members.diagnostic.size_bytes = mutatedDiagBytes.length;

  assert.throws(
    () =>
      verifyTrustCardHostedRecord({
        ...env,
        record: mutatedRecord,
        basisBytes: mutatedBasisBytes,
        diagnosticBytes: mutatedDiagBytes,
      }),
    /shared semantic validation failed|shared claims parity validation failed/,
  );
});

test("discriminating control (d): false claim of valid/parity in diagnostic or unhosted/skipped execution fails validation", () => {
  const env = loadCheckedInEvidence();

  // Subcase d1: diagnostic claims valid: false while validation passes
  const diagObj = JSON.parse(env.diagnosticBytes.toString("utf8"));
  diagObj.valid = false;
  const mutatedDiagBytes = Buffer.from(JSON.stringify(diagObj, null, 2), "utf8");
  const mutatedRecord1 = JSON.parse(JSON.stringify(env.record));
  mutatedRecord1.members.diagnostic.digest = sha256(mutatedDiagBytes);
  mutatedRecord1.members.diagnostic.size_bytes = mutatedDiagBytes.length;

  assert.throws(
    () =>
      verifyTrustCardHostedRecord({
        ...env,
        record: mutatedRecord1,
        diagnosticBytes: mutatedDiagBytes,
      }),
    /diagnostic valid flag must match semantic validation/,
  );

  // Subcase d2: unhosted record
  const unhostedRecord = JSON.parse(JSON.stringify(env.record));
  unhostedRecord.hosted = false;
  assert.throws(
    () => verifyTrustCardHostedRecord({ ...env, record: unhostedRecord }),
    /AssertionError/,
  );
});

test("discriminating control (e): altered version or hosted_run in matrix row fails adoption cross-binding even when matrix is rehashed", () => {
  const env = loadCheckedInEvidence();

  const mutatedMatrix = JSON.parse(JSON.stringify(env.matrix));
  const row = mutatedMatrix.recipe_rows.find((r) => r.recipe === env.record.recipe);
  row.proof.hosted_run = "99999999999";
  mutatedMatrix.manifest.digest = computeMatrixDigest(mutatedMatrix);

  // The rehashed matrix is internally valid
  const matrixValidation = validateSuiteCompatibility(mutatedMatrix);
  assert.equal(matrixValidation.valid, true, "rehashed matrix passes syntax/checksum validation");

  // But adoption binding against record fails
  assert.throws(
    () => verifyTrustCardHostedRecord({ ...env, matrix: mutatedMatrix }),
    /AssertionError/,
  );
});

test("discriminating control (f): bypassing shared semantic validator allows semantic corruption, proving validator invocation is load-bearing", () => {
  const env = loadCheckedInEvidence();

  // Create semantically invalid card with recomputed digests
  const cardObj = JSON.parse(env.cardBytes.toString("utf8"));
  cardObj.claims[0].level = "FORGED_LEVEL";
  const mutatedCardBytes = Buffer.from(JSON.stringify(cardObj, null, 2), "utf8");

  const mutatedRecord = JSON.parse(JSON.stringify(env.record));
  mutatedRecord.members.trust_card.digest = sha256(mutatedCardBytes);
  mutatedRecord.members.trust_card.size_bytes = mutatedCardBytes.length;

  const diagObj = JSON.parse(env.diagnosticBytes.toString("utf8"));
  diagObj.trust_card.sha256 = mutatedRecord.members.trust_card.digest;
  diagObj.trust_card.bytes = mutatedRecord.members.trust_card.size_bytes;
  const mutatedDiagBytes = Buffer.from(JSON.stringify(diagObj, null, 2), "utf8");
  mutatedRecord.members.diagnostic.digest = sha256(mutatedDiagBytes);
  mutatedRecord.members.diagnostic.size_bytes = mutatedDiagBytes.length;

  // With bypass, it does not throw (false-green)
  assert.doesNotThrow(() => {
    verifyTrustCardHostedRecord({
      ...env,
      record: mutatedRecord,
      cardBytes: mutatedCardBytes,
      diagnosticBytes: mutatedDiagBytes,
      bypassSemanticValidation: true,
    });
  });

  // Without bypass, shared semantic validator catches it RED
  assert.throws(() => {
    verifyTrustCardHostedRecord({
      ...env,
      record: mutatedRecord,
      cardBytes: mutatedCardBytes,
      diagnosticBytes: mutatedDiagBytes,
      bypassSemanticValidation: false,
    });
  }, /shared semantic validation failed/);
});

test("discriminating control (g): historical v5.4.0 enforcement-health, historical receipt rail, and declared render/token carriers remain frozen", () => {
  const env = loadCheckedInEvidence();
  const matrix = env.matrix;

  const eh = matrix.carrier_rows.find((r) => r.carrier === "assay.enforcement_health.v1");
  assert.ok(eh, "enforcement-health carrier row must exist");
  assert.equal(eh.proof.end_to_end, "proven");
  assert.equal(eh.proof.hosted_run, "33080407473");
  assert.equal(eh.proof.assay_version, "v5.4.0");

  const histRail = matrix.recipe_rows.find((r) => r.recipe === "established release-compatibility recipe rail");
  assert.ok(histRail, "historical release rail row must exist");
  assert.equal(histRail.proof.hosted_run, "27651437917");
  assert.equal(histRail.emits.min_version, "v3.27.0");

  const v6Receipt = matrix.recipe_rows.find((r) => r.recipe === "established release-compatibility recipe rail (v6.0.0)");
  assert.ok(v6Receipt, "v6 receipt rail row must exist");
  assert.equal(v6Receipt.proof.hosted_run, "33957799594");

  const renderSafety = matrix.carrier_rows.find((r) => r.carrier === "assay.render_safety_conformance.v0");
  assert.ok(renderSafety);
  assert.equal(renderSafety.proof.end_to_end, "declared");
  assert.equal(renderSafety.end_to_end_gap?.reason_code, "no_released_binary_emitter");

  const tokenPassthrough = matrix.carrier_rows.find((r) => r.carrier === "assay.token_passthrough_conformance.v0");
  assert.ok(tokenPassthrough);
  assert.equal(tokenPassthrough.proof.end_to_end, "declared");
  assert.equal(tokenPassthrough.end_to_end_gap?.reason_code, "live_proxy_only");
});
