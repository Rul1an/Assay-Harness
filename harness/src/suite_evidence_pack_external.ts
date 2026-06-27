import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PackError, PackManifest } from "./suite_evidence_pack.js";

const EXTERNAL_BUNDLE_ROLE = "external_attestation_bundle";
const EXTERNAL_META_ROLE = "external_attestation_metadata";
const EXTERNAL_ATTESTATION_SOURCE_SCHEMA = "suite.external_attestation_source.v0";
const KNOWN_BINDING_TARGETS: readonly string[] = [
  "none",
  "recipe_provenance.assay.binary_digest",
  "recipe_provenance.release_asset.digest",
];
const SIGSTORE_V03_MEDIA = /^application\/vnd\.dev\.sigstore\.bundle\.v0\.3(\.\d+)?\+json$/;
const SHA256_HEX = /^sha256:[0-9a-f]{64}$/;

function readJson(packRoot: string, rel: string): unknown {
  return JSON.parse(readFileSync(resolve(packRoot, rel), "utf-8"));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Verify the v1 external GitHub attestation: exactly one bundle + one metadata; digests + media
 *  type; harness-posture flags; the offline in-toto subject decode (read the claim, NOT the
 *  signature); and the binding to the release asset the recipe consumed. The Harness never checks
 *  the attestation's signature / trusted-root / transparency-log. */
export function verifyExternalEvidenceV1(
  packDir: string,
  manifest: PackManifest,
  digestCleanExternal: Set<string>,
  provReleaseAssetDigest: string | undefined,
  errors: PackError[],
): void {
  const ext = manifest.external_evidence ?? [];
  if (ext.length === 0) {
    errors.push({ code: "PACK_EXTERNAL_MISSING", message: "v1 pack requires external_evidence (one bundle + one metadata)", path: "external_evidence" });
    return;
  }
  const bundles = ext.filter((e) => e.role === EXTERNAL_BUNDLE_ROLE);
  const metas = ext.filter((e) => e.role === EXTERNAL_META_ROLE);
  const knownRoles = new Set([EXTERNAL_BUNDLE_ROLE, EXTERNAL_META_ROLE]);
  for (const e of ext) {
    if (!knownRoles.has(e.role)) errors.push({ code: "PACK_EXTERNAL_ROLE_UNKNOWN", message: `unknown external_evidence role: ${e.role}`, path: e.path });
  }
  if (bundles.length !== 1) errors.push({ code: "PACK_EXTERNAL_ROLE_CARDINALITY", message: `v1 requires exactly one ${EXTERNAL_BUNDLE_ROLE}`, path: "external_evidence" });
  if (metas.length !== 1) errors.push({ code: "PACK_EXTERNAL_ROLE_CARDINALITY", message: `v1 requires exactly one ${EXTERNAL_META_ROLE}`, path: "external_evidence" });
  if (bundles.length !== 1 || metas.length !== 1) return;
  const bundle = bundles[0];
  const meta = metas[0];

  // provider, flags, binding-enum (cheap, no file reads)
  if (bundle.provider !== "github" || meta.provider !== "github") {
    errors.push({ code: "PACK_EXTERNAL_PROVIDER_UNSUPPORTED", message: `v1 supports provider "github" only`, path: "external_evidence" });
  }
  if (bundle.signature_trust_verified_by_harness !== false) {
    errors.push({ code: "PACK_EXTERNAL_VERIFY_FLAG", message: "signature_trust_verified_by_harness must be false (v1 does not verify trust)", path: "external_evidence" });
  }
  const bindTo = bundle.binding?.to;
  if (typeof bindTo !== "string" || !KNOWN_BINDING_TARGETS.includes(bindTo)) {
    errors.push({ code: "PACK_EXTERNAL_BINDING_UNKNOWN", message: `binding.to must be one of ${KNOWN_BINDING_TARGETS.join(" / ")}`, path: "external_evidence" });
  }
  if (typeof bundle.subject_digest !== "string" || !SHA256_HEX.test(bundle.subject_digest)) {
    errors.push({ code: "PACK_EXTERNAL_SUBJECT_MISMATCH", message: "external bundle subject_digest must be sha256:<64-hex>", path: "external_evidence" });
  }
  // projection-style source: the bundle entry's source_digest is its describing meta entry.
  if (bundle.source_digest !== meta.digest) {
    errors.push({ code: "PACK_EXTERNAL_NO_SOURCE", message: "bundle source_digest must equal the metadata entry digest", path: bundle.path });
  }
  if (typeof bundle.media_type !== "string" || !SIGSTORE_V03_MEDIA.test(bundle.media_type)) {
    errors.push({ code: "PACK_EXTERNAL_MEDIA_TYPE", message: "media_type must be the v0.3 Sigstore bundle family", path: bundle.path });
  }

  // The remaining checks re-read the bundle + meta, so run them only when both are digest-clean.
  if (!digestCleanExternal.has(EXTERNAL_BUNDLE_ROLE) || !digestCleanExternal.has(EXTERNAL_META_ROLE)) return;
  let bundleDoc: Record<string, unknown>, metaDoc: Record<string, unknown>;
  try {
    bundleDoc = readJson(packDir, bundle.path) as Record<string, unknown>;
    metaDoc = readJson(packDir, meta.path) as Record<string, unknown>;
  } catch (e) {
    errors.push({ code: "PACK_EXTERNAL_CROSSCHECK_FAILED", message: `cannot read external bundle/meta: ${(e as Error).message}`, path: bundle.path });
    return;
  }

  // meta shape + coherence with the manifest entry.
  if (metaDoc.schema !== EXTERNAL_ATTESTATION_SOURCE_SCHEMA) {
    errors.push({ code: "PACK_EXTERNAL_META_MISMATCH", message: `meta.schema must be ${EXTERNAL_ATTESTATION_SOURCE_SCHEMA}`, path: meta.path });
  }
  const mRetrieval = isRecord(metaDoc.retrieval) ? metaDoc.retrieval : {};
  const mBundle = isRecord(metaDoc.bundle) ? metaDoc.bundle : {};
  const mVerif = isRecord(metaDoc.verification) ? metaDoc.verification : {};
  if (mBundle.digest !== bundle.digest) {
    errors.push({ code: "PACK_EXTERNAL_META_MISMATCH", message: "meta.bundle.digest != bundle file digest", path: meta.path });
  }
  if (mBundle.media_type !== bundle.media_type) {
    errors.push({ code: "PACK_EXTERNAL_MEDIA_TYPE", message: "meta.bundle.media_type != manifest media_type", path: meta.path });
  }
  if (mRetrieval.artifact_digest !== bundle.subject_digest) {
    errors.push({ code: "PACK_EXTERNAL_SUBJECT_MISMATCH", message: "meta.retrieval.artifact_digest != external subject_digest", path: meta.path });
  }
  if (mVerif.signature_trust_verified_by_harness !== false || mVerif.subject_decoded_by_harness !== true || mVerif.external_cross_check_only !== true) {
    errors.push({ code: "PACK_EXTERNAL_VERIFY_FLAG", message: "meta.verification must be signature_trust=false / subject_decoded=true / cross_check_only=true", path: meta.path });
  }
  if (!Array.isArray(metaDoc.non_claims) || metaDoc.non_claims.length === 0) {
    errors.push({ code: "PACK_EXTERNAL_NON_CLAIMS_MISSING", message: "meta.non_claims must be a non-empty array", path: meta.path });
  }

  // bundle media type matches its own field.
  if (bundleDoc.mediaType !== bundle.media_type) {
    errors.push({ code: "PACK_EXTERNAL_MEDIA_TYPE", message: "bundle.mediaType != manifest media_type", path: bundle.path });
  }

  // Offline subject-decode (integrity, NOT signature verification): the in-toto Statement must
  // attest the declared subject. Bundle is multi-subject, so "some subject" is correct.
  const dsse = isRecord(bundleDoc.dsseEnvelope) ? bundleDoc.dsseEnvelope : undefined;
  if (!dsse || dsse.payloadType !== "application/vnd.in-toto+json" || typeof dsse.payload !== "string") {
    errors.push({ code: "PACK_EXTERNAL_BUNDLE_SHAPE", message: "bundle must be a DSSE in-toto envelope", path: bundle.path });
    return;
  }
  let stmt: Record<string, unknown>;
  try {
    stmt = JSON.parse(Buffer.from(dsse.payload, "base64").toString("utf-8")) as Record<string, unknown>;
  } catch {
    errors.push({ code: "PACK_EXTERNAL_SUBJECT_DECODE", message: "DSSE payload is not base64 JSON", path: bundle.path });
    return;
  }
  if (typeof stmt._type !== "string" || !Array.isArray(stmt.subject)) {
    errors.push({ code: "PACK_EXTERNAL_SUBJECT_DECODE", message: "payload is not an in-toto Statement", path: bundle.path });
    return;
  }
  const wantHex = (bundle.subject_digest ?? "").slice("sha256:".length);
  const subjectHit = (stmt.subject as Array<Record<string, unknown>>).some((s) => {
    const d = isRecord(s.digest) ? s.digest : {};
    return typeof d.sha256 === "string" && d.sha256 === wantHex && /^[0-9a-f]{64}$/.test(d.sha256);
  });
  if (!subjectHit) {
    errors.push({ code: "PACK_EXTERNAL_SUBJECT_DECODE", message: "declared subject_digest not found among the bundle's attested subjects", path: bundle.path });
  }

  // Binding: only release-asset binding ties to the pack; assay.binary_digest is NEVER equated with
  // the attested subject (GitHub attested the release asset, not the extracted binary).
  if (bindTo === "recipe_provenance.release_asset.digest") {
    if (provReleaseAssetDigest === undefined) {
      errors.push({ code: "PACK_EXTERNAL_BINDING_MISMATCH", message: "binding to release_asset requires provenance.release_asset.digest (absent or provenance not clean)", path: "external_evidence" });
    } else if (provReleaseAssetDigest !== bundle.subject_digest) {
      errors.push({ code: "PACK_EXTERNAL_BINDING_MISMATCH", message: "external subject_digest != provenance.release_asset.digest", path: "external_evidence" });
    }
  }
}
