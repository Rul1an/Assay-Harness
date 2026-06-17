import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// H-next-4a: validate the SHAPE of the pinned, real GitHub artifact-attestation fixture (and its
// meta). No verifier here — the suite.evidence_pack.v1 verifier lands in a later slice. These tests
// pin the assumptions that verifier will rely on, against real GitHub-sourced bytes.

const dir = fileURLToPath(new URL("../fixtures/evidence-pack/external/", import.meta.url));
const bundleBytes = readFileSync(dir + "github-artifact-attestation.bundle.json");
const bundle = JSON.parse(bundleBytes.toString("utf-8"));
const meta = JSON.parse(readFileSync(dir + "github-artifact-attestation.meta.json", "utf-8"));
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const V03 = /^application\/vnd\.dev\.sigstore\.bundle\.v0\.3(\.\d+)?\+json$/;

test("meta is suite.external_attestation_source.v0 / github", () => {
  assert.equal(meta.schema, "suite.external_attestation_source.v0");
  assert.equal(meta.provider, "github");
  assert.equal(meta.retrieval.repo_visibility, "public");
});

test("bundle file digest matches the pinned meta.bundle.digest", () => {
  const got = "sha256:" + createHash("sha256").update(bundleBytes).digest("hex");
  assert.equal(got, meta.bundle.digest);
  assert.equal(got, "sha256:8b2cdebbfe55b0910d7b38bafaf96e27acfd0cb78ef7dfc3abb0f752c366b552");
});

test("media type is the v0.3 Sigstore family and matches the bundle", () => {
  assert.match(bundle.mediaType, V03);
  assert.equal(meta.bundle.media_type, bundle.mediaType);
});

test("bundle is a DSSE in-toto envelope", () => {
  assert.ok(bundle.dsseEnvelope, "dsseEnvelope present");
  assert.equal(bundle.dsseEnvelope.payloadType, "application/vnd.in-toto+json");
});

test("payload decodes to an in-toto Statement v1 with SLSA provenance", () => {
  const stmt = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf-8"));
  assert.equal(stmt._type, "https://in-toto.io/Statement/v1");
  assert.equal(stmt.predicateType, "https://slsa.dev/provenance/v1");
  assert.ok(Array.isArray(stmt.subject) && stmt.subject.length > 0);
});

test("the recorded subject digest is present in the bundle's subjects (64-hex)", () => {
  assert.match(meta.retrieval.artifact_digest, SHA256);
  const want = meta.retrieval.artifact_digest.slice("sha256:".length);
  const stmt = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf-8"));
  const hit = stmt.subject.some((s) => s.digest && s.digest.sha256 === want);
  assert.ok(hit, "recorded subject digest must be one of the bundle's attested subjects");
});

test("recorded subject equals the release-asset bind target (the tarball the recipe consumes)", () => {
  assert.equal(meta.retrieval.artifact_digest, "sha256:079492e5b5840accabd3c685fbc9cdfbccb324fc32e39490ec8cca39758072bc");
});

test("verification posture: signature trust NOT verified, subject decoded, cross-check only", () => {
  assert.equal(meta.verification.signature_trust_verified_by_harness, false);
  assert.equal(meta.verification.subject_decoded_by_harness, true);
  assert.equal(meta.verification.external_cross_check_only, true);
});

test("non_claims are present and never assert trust/approval", () => {
  assert.ok(Array.isArray(meta.non_claims) && meta.non_claims.length > 0);
  const joined = meta.non_claims.join(" ").toLowerCase();
  assert.ok(joined.includes("not") || joined.includes("does not"));
  // The bundle attests the release asset, not the extracted binary — the meta must say so.
  assert.ok(meta.non_claims.some((c) => /not the extracted binary/i.test(c)));
});
