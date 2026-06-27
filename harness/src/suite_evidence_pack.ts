/**
 * Evidence Pack — `suite.evidence_pack.v0`.
 *
 * A deterministic, digest-bound bundle of a proven carrier recipe: it BINDS raw
 * Assay carrier bytes, Harness projections, the suite compatibility matrix, and
 * recipe provenance by digest. It creates no new evidence, approves no policy, and
 * does not replace Plimsoll. VSA-shaped, not a SLSA VSA.
 *
 * v0 carries the proven inventory recipe only. Source-of-truth (carrier, matrix,
 * provenance) is separated from lossy projections (Markdown). The manifest digest is
 * deterministic over the evidence content (volatile metadata excluded, arrays sorted),
 * and `verify` enforces path safety + a coherence invariant so a pack cannot be
 * internally consistent by digest while lying about where the evidence came from.
 */

import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, copyFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve, sep, join, basename } from "node:path";
import { canonicalize, validateSuiteCompatibility } from "./suite_compatibility.js";
import { RECIPE_PROVENANCE_SCHEMA, validateRecipeProvenance } from "./suite_recipe_provenance.js";
import { verifyExternalEvidenceV1 } from "./suite_evidence_pack_external.js";

export const SUITE_EVIDENCE_PACK_SCHEMA = "suite.evidence_pack.v0";
/** v1 = strict superset of v0: all v0 invariants PLUS exactly one external attestation bundle +
 *  metadata, bound to the release asset the recipe consumed. v0 stays frozen (no external_evidence). */
export const SUITE_EVIDENCE_PACK_SCHEMA_V1 = "suite.evidence_pack.v1";
const KNOWN_PACK_SCHEMAS: readonly string[] = [SUITE_EVIDENCE_PACK_SCHEMA, SUITE_EVIDENCE_PACK_SCHEMA_V1];

export const KNOWN_SOURCE_ROLES: readonly string[] = ["assay_carrier", "suite_matrix", "recipe_provenance"];
export const KNOWN_PROJECTION_ROLES: readonly string[] = ["harness_markdown", "json_review", "junit", "sarif"];
export const EXTERNAL_ATTESTATION_SOURCE_SCHEMA = "suite.external_attestation_source.v0";
// v1 external evidence: exactly one bundle + one metadata entry.
const EXTERNAL_BUNDLE_ROLE = "external_attestation_bundle";
const EXTERNAL_META_ROLE = "external_attestation_metadata";
const KNOWN_BINDING_TARGETS: readonly string[] = [
  "none",
  "recipe_provenance.assay.binary_digest",
  "recipe_provenance.release_asset.digest",
];
// Pin to the v0.3 Sigstore bundle family (version not hard-pinned within v0.3); prefix-only is unsafe.
const SIGSTORE_V03_MEDIA = /^application\/vnd\.dev\.sigstore\.bundle\.v0\.3(\.\d+)?\+json$/;
const SHA256_HEX = /^sha256:[0-9a-f]{64}$/;

// Non-claims are per subject carrier (builder content only; the verifier only checks they are
// non-empty strings). Inventory keeps its exact original set (its golden pack stays byte-identical);
// supply_chain gets supply-chain-appropriate non-claims (no inventory "shadow MCP servers" line).
const INVENTORY_NON_CLAIMS: readonly string[] = [
  "does not approve carrier semantics",
  "does not prove policy compliance",
  "does not prove provider trust",
  "does not prove runtime truth",
  "does not prove absence of shadow MCP servers outside scanned coverage",
  "does not replace Plimsoll policy-aware review",
  "projections are point-in-time renderings bound by digest, not faithful re-derivations",
];
const SUPPLY_CHAIN_NON_CLAIMS: readonly string[] = [
  "does not approve carrier semantics",
  "does not prove policy compliance",
  "does not prove provider trust",
  "does not prove runtime truth",
  "does not prove supply-chain safety, nor verify Sigstore/Rekor inclusion or issuer identity",
  "a packed policy_result: pass is a producer/consumer recipe outcome, not a safety or approval verdict",
  "does not replace Plimsoll policy-aware review",
  "projections are point-in-time renderings bound by digest, not faithful re-derivations",
];
function nonClaimsFor(carrierSchema: string): readonly string[] {
  return carrierSchema === "assay.supply_chain_conformance.v0" ? SUPPLY_CHAIN_NON_CLAIMS : INVENTORY_NON_CLAIMS;
}

export interface SourceEntry { role: string; path: string; schema?: string; digest: string }
export interface ProjectionEntry { role: string; path: string; lossy: boolean; source_digest: string; digest: string }
export interface PrivateReview { role: string; available: boolean; digest?: string; visibility?: string }
/** External cross-check evidence (v1): a GitHub artifact-attestation bundle + its metadata. Not an
 *  Assay carrier and not a lossy projection — a third, explicitly-external category. */
export interface ExternalEvidenceEntry {
  role: string;
  provider?: string;
  format?: string;
  path: string;
  digest: string;
  media_type?: string;
  subject_digest?: string;
  signature_trust_verified_by_harness?: boolean;
  binding?: { to: string };
  source_digest?: string;
}
export interface PackManifest {
  schema: string;
  created_at?: string;
  producer: { tool: string; version: string };
  subject: { kind: string; carrier: string; assay_version: string; digest: string };
  source_of_truth: SourceEntry[];
  projections: ProjectionEntry[];
  optional_private_reviews: PrivateReview[];
  external_evidence?: ExternalEvidenceEntry[];
  non_claims: string[];
  manifest: { canonicalization: string; digest: string };
}

export interface PackError { code: string; message: string; path?: string }
// `coherence_binding` is an internal verify-result observable (NOT a manifest/schema field): it records
// which coherence target the recipe_provenance bound to when the pack is coherent — so tests can prove a
// pack passed via the intended branch (carrier-row vs recipe-row), never the wrong one. null = coherence
// did not establish a binding (error path, or verification short-circuited before the cross-check).
export interface PackVerifyResult { valid: boolean; errors: PackError[]; manifest?: PackManifest; coherence_binding?: "carrier_row_bound" | "recipe_row_bound" | null }

// ---------------------------------------------------------------------------
// Digest (deterministic over evidence content; volatile metadata excluded; arrays sorted)
// ---------------------------------------------------------------------------

function sha256(buf: Buffer | string): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

const byRole = (a: { role: string }, b: { role: string }) => a.role.localeCompare(b.role);
const byRolePath = (a: { role: string; path: string }, b: { role: string; path: string }) =>
  a.role.localeCompare(b.role) || a.path.localeCompare(b.path);

/** sha256 over JCS({schema, subject, source_of_truth, projections, optional_private_reviews,
 *  non_claims [, external_evidence (v1 only)]}) — excluding created_at/producer (volatile) and
 *  manifest itself. Arrays are sorted so identical evidence in any input order yields the same
 *  digest. external_evidence is in the core ONLY for v1, so a v0 pack's digest is unchanged (the
 *  H-next-3 golden is byte-identical) and a v0 pack can never collide with a v1 digest. */
export function computeManifestDigest(m: PackManifest): string {
  const core: Record<string, unknown> = {
    schema: m.schema,
    subject: m.subject,
    source_of_truth: [...m.source_of_truth].sort(byRole),
    projections: [...m.projections].sort(byRolePath),
    optional_private_reviews: [...m.optional_private_reviews].sort(byRole),
    non_claims: m.non_claims,
  };
  if (m.schema === SUITE_EVIDENCE_PACK_SCHEMA_V1) {
    core.external_evidence = [...(m.external_evidence ?? [])].sort(byRolePath);
  }
  return sha256(canonicalize(core));
}

// ---------------------------------------------------------------------------
// Build (`evidence-pack create`)
// ---------------------------------------------------------------------------

export interface PackInputs {
  carrierPath: string;
  suiteMatrixPath: string;
  provenancePath: string;
  markdownPath: string;
  harnessVersion: string;
  createdAt?: string;
  /** v1: when both are provided, the pack binds an external GitHub attestation bundle as
   *  cross-check evidence. The binding is auto-derived (release-asset when the attested subject
   *  equals provenance.release_asset.digest; otherwise none) — never fake-bound. */
  externalBundlePath?: string;
  externalMetaPath?: string;
}

export function buildEvidencePack(inputs: PackInputs, outDir: string): PackManifest {
  const carrierBytes = readFileSync(inputs.carrierPath);
  const matrixBytes = readFileSync(inputs.suiteMatrixPath);
  const provBytes = readFileSync(inputs.provenancePath);
  const mdBytes = readFileSync(inputs.markdownPath);

  const carrier = JSON.parse(carrierBytes.toString("utf-8")) as { schema?: string };
  const prov = JSON.parse(provBytes.toString("utf-8")) as { assay?: { version?: string }; release_asset?: { digest?: string } };
  const carrierDigest = sha256(carrierBytes);

  for (const d of ["carriers", "suite", "provenance", "harness"]) mkdirSync(join(outDir, d), { recursive: true });
  const carrierRel = `carriers/${basename(inputs.carrierPath)}`;
  const matrixRel = "suite/suite.compatibility.v0.json";
  const provRel = "provenance/recipe.provenance.json";
  // Projection path is per-subject-carrier — builder layout only; the verifier is role+digest based,
  // never path-based (generalized from the inventory-only hardcode for the supply-chain pack).
  const mdRel =
    (carrier.schema ?? "") === "assay.supply_chain_conformance.v0"
      ? "harness/supply-chain.review.md"
      : "harness/inventory.review.md";
  copyFileSync(inputs.carrierPath, join(outDir, carrierRel));
  copyFileSync(inputs.suiteMatrixPath, join(outDir, matrixRel));
  copyFileSync(inputs.provenancePath, join(outDir, provRel));
  copyFileSync(inputs.markdownPath, join(outDir, mdRel));

  const manifest: PackManifest = {
    schema: SUITE_EVIDENCE_PACK_SCHEMA,
    created_at: inputs.createdAt,
    producer: { tool: "assay-harness", version: inputs.harnessVersion },
    subject: {
      kind: "assay_carrier_recipe",
      carrier: carrier.schema ?? "",
      assay_version: prov.assay?.version ?? "",
      digest: carrierDigest,
    },
    source_of_truth: [
      { role: "assay_carrier", path: carrierRel, schema: carrier.schema, digest: carrierDigest },
      { role: "suite_matrix", path: matrixRel, schema: "suite.compatibility.v0", digest: sha256(matrixBytes) },
      { role: "recipe_provenance", path: provRel, schema: RECIPE_PROVENANCE_SCHEMA, digest: sha256(provBytes) },
    ].sort(byRole),
    projections: [
      { role: "harness_markdown", path: mdRel, lossy: true, source_digest: carrierDigest, digest: sha256(mdBytes) },
    ].sort(byRolePath),
    optional_private_reviews: [{ role: "plimsoll_review_digest", available: false }],
    non_claims: [...nonClaimsFor(carrier.schema ?? "")],
    manifest: { canonicalization: "jcs/rfc8785", digest: "" },
  };

  // v1: bind an external GitHub attestation bundle as cross-check evidence.
  if (inputs.externalBundlePath && inputs.externalMetaPath) {
    const bundleBytes = readFileSync(inputs.externalBundlePath);
    const metaBytes = readFileSync(inputs.externalMetaPath);
    const meta = JSON.parse(metaBytes.toString("utf-8")) as {
      provider?: string;
      retrieval?: { artifact_digest?: string };
      bundle?: { media_type?: string };
    };
    mkdirSync(join(outDir, "external"), { recursive: true });
    const bundleRel = "external/github-artifact-attestation.bundle.json";
    const metaRel = "external/github-artifact-attestation.meta.json";
    copyFileSync(inputs.externalBundlePath, join(outDir, bundleRel));
    copyFileSync(inputs.externalMetaPath, join(outDir, metaRel));
    const subjectDigest = meta.retrieval?.artifact_digest ?? "";
    const metaDigest = sha256(metaBytes);
    // Bind to the release asset ONLY when the attested subject equals it — never fake-bind.
    const bindTo =
      prov.release_asset?.digest && prov.release_asset.digest === subjectDigest
        ? "recipe_provenance.release_asset.digest"
        : "none";
    manifest.schema = SUITE_EVIDENCE_PACK_SCHEMA_V1;
    manifest.external_evidence = [
      {
        role: EXTERNAL_BUNDLE_ROLE,
        provider: meta.provider ?? "github",
        format: "sigstore_bundle",
        path: bundleRel,
        digest: sha256(bundleBytes),
        media_type: meta.bundle?.media_type ?? "",
        subject_digest: subjectDigest,
        signature_trust_verified_by_harness: false,
        binding: { to: bindTo },
        source_digest: metaDigest,
      },
      { role: EXTERNAL_META_ROLE, provider: meta.provider ?? "github", path: metaRel, digest: metaDigest },
    ].sort(byRolePath);
  }

  manifest.manifest.digest = computeManifestDigest(manifest);
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(outDir, "evidence.sha256"), manifest.manifest.digest + "\n");
  return manifest;
}

// ---------------------------------------------------------------------------
// Verify (`evidence-pack verify`) — strict
// ---------------------------------------------------------------------------

// Artifact-contract path safety (not policy): a listed path must be relative, POSIX, with no
// `..`, no symlink, and resolve strictly inside the pack root.
function pathSafe(packRoot: string, rel: string, errors: PackError[]): boolean {
  if (typeof rel !== "string" || rel.length === 0) {
    errors.push({ code: "PACK_PATH_UNSAFE", message: `path must be a non-empty string`, path: rel });
    return false;
  }
  if (isAbsolute(rel) || rel.includes("\\") || rel.split("/").includes("..")) {
    errors.push({ code: "PACK_PATH_UNSAFE", message: `path must be relative POSIX with no ".." (got ${JSON.stringify(rel)})`, path: rel });
    return false;
  }
  const abs = resolve(packRoot, rel);
  const rootResolved = resolve(packRoot);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    errors.push({ code: "PACK_PATH_UNSAFE", message: `path escapes the pack root: ${rel}`, path: rel });
    return false;
  }
  try {
    if (lstatSync(abs).isSymbolicLink()) {
      errors.push({ code: "PACK_PATH_UNSAFE", message: `path is a symlink: ${rel}`, path: rel });
      return false;
    }
    // realpath escape (a parent symlink) -> outside root. Separator-aware so a sibling
    // directory like `<root>_evil` cannot satisfy a bare string-prefix check.
    const realRoot = realpathSync(rootResolved);
    const realAbs = realpathSync(abs);
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) {
      errors.push({ code: "PACK_PATH_UNSAFE", message: `path resolves outside the pack root: ${rel}`, path: rel });
      return false;
    }
  } catch {
    // missing file is reported by the file-existence check, not here.
  }
  return true;
}

function readJson(packRoot: string, rel: string): unknown {
  return JSON.parse(readFileSync(resolve(packRoot, rel), "utf-8"));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function verifyEvidencePack(packDir: string): PackVerifyResult {
  const errors: PackError[] = [];
  let coherenceBinding: "carrier_row_bound" | "recipe_row_bound" | null = null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf-8"));
  } catch (e) {
    return { valid: false, errors: [{ code: "PACK_MANIFEST_UNREADABLE", message: `manifest.json: ${(e as Error).message}` }] };
  }
  if (!isRecord(parsed)) {
    return { valid: false, errors: [{ code: "PACK_MANIFEST_SHAPE", message: "manifest.json must be a JSON object", path: "manifest" }] };
  }
  const manifest = parsed as unknown as PackManifest;
  if (!KNOWN_PACK_SCHEMAS.includes(manifest.schema)) {
    errors.push({ code: "PACK_SCHEMA_MISMATCH", message: `schema must be one of ${KNOWN_PACK_SCHEMAS.join(" / ")}; got ${JSON.stringify(manifest.schema)}`, path: "schema" });
    return { valid: false, errors };
  }
  const isV1 = manifest.schema === SUITE_EVIDENCE_PACK_SCHEMA_V1;

  // Fail closed on a schema-matching but structurally malformed manifest (e.g.
  // `source_of_truth: "x"`, or an entry that is `null` / has a non-string path) before any
  // digest/`.map`/`.replace` work would throw on it.
  const arraysOk =
    Array.isArray(manifest.source_of_truth) &&
    Array.isArray(manifest.projections) &&
    Array.isArray(manifest.optional_private_reviews) &&
    Array.isArray(manifest.non_claims) &&
    (manifest.external_evidence === undefined || Array.isArray(manifest.external_evidence));
  const objsOk =
    isRecord(manifest.subject) && isRecord(manifest.producer) && isRecord(manifest.manifest);
  if (!arraysOk || !objsOk) {
    errors.push({ code: "PACK_MANIFEST_SHAPE", message: "source_of_truth/projections/optional_private_reviews/non_claims must be arrays and subject/producer/manifest objects", path: "manifest" });
    return { valid: false, errors, manifest };
  }
  // Entry-level shape: every array element must be a typed record before the loops below
  // dereference role/path/digest. (A missing source_digest is structural here, not the later
  // PACK_PROJECTION_NO_SOURCE which catches a present-but-unresolvable digest.)
  const sourcesOk = manifest.source_of_truth.every((e) =>
    isRecord(e) && typeof e.role === "string" && typeof e.path === "string" && typeof e.digest === "string" &&
    (e.schema === undefined || typeof e.schema === "string"));
  const projectionsOk = manifest.projections.every((e) =>
    isRecord(e) && typeof e.role === "string" && typeof e.path === "string" &&
    typeof e.lossy === "boolean" && typeof e.source_digest === "string" && typeof e.digest === "string");
  const reviewsOk = manifest.optional_private_reviews.every((e) =>
    isRecord(e) && typeof e.role === "string" && typeof e.available === "boolean" &&
    (e.digest === undefined || typeof e.digest === "string") &&
    (e.visibility === undefined || typeof e.visibility === "string"));
  const externalOk = (manifest.external_evidence ?? []).every((e) =>
    isRecord(e) && typeof e.role === "string" && typeof e.path === "string" && typeof e.digest === "string");
  if (!sourcesOk || !projectionsOk || !reviewsOk || !externalOk || !manifest.non_claims.every((x) => typeof x === "string")) {
    errors.push({ code: "PACK_MANIFEST_SHAPE", message: "manifest entry fields have invalid types", path: "manifest" });
    return { valid: false, errors, manifest };
  }

  // --- manifest digest + sidecar ---
  let recomputed = "";
  try {
    recomputed = computeManifestDigest(manifest);
    if (recomputed !== manifest.manifest?.digest) {
      errors.push({ code: "PACK_DIGEST_MISMATCH", message: `manifest.digest does not match recomputed; declared ${manifest.manifest?.digest}, recomputed ${recomputed}`, path: "manifest.digest" });
    }
  } catch (e) {
    errors.push({ code: "PACK_DIGEST_UNCOMPUTABLE", message: `cannot canonicalize manifest: ${(e as Error).message}` });
  }
  try {
    const sidecar = readFileSync(join(packDir, "evidence.sha256"), "utf-8").trim();
    if (sidecar !== manifest.manifest?.digest) {
      errors.push({ code: "PACK_DIGEST_MISMATCH", message: `evidence.sha256 sidecar does not match manifest.digest`, path: "evidence.sha256" });
    }
  } catch {
    errors.push({ code: "PACK_SIDECAR_MISSING", message: "evidence.sha256 sidecar is missing" });
  }

  // --- enums + per-entry path safety + file digests + duplicate paths ---
  const seen = new Set<string>();
  const allEntries: Array<{ role: string; path: string; digest: string; kind: "source" | "projection" | "external" }> = [
    ...(manifest.source_of_truth ?? []).map((e) => ({ role: e.role, path: e.path, digest: e.digest, kind: "source" as const })),
    ...(manifest.projections ?? []).map((e) => ({ role: e.role, path: e.path, digest: e.digest, kind: "projection" as const })),
    ...(manifest.external_evidence ?? []).map((e) => ({ role: e.role, path: e.path, digest: e.digest, kind: "external" as const })),
  ];
  const sourceDigests = new Set<string>();
  for (const e of manifest.source_of_truth ?? []) {
    if (!KNOWN_SOURCE_ROLES.includes(e.role)) errors.push({ code: "PACK_ROLE_UNKNOWN", message: `unknown source_of_truth role: ${e.role}`, path: e.path });
    sourceDigests.add(e.digest);
  }
  for (const e of manifest.projections ?? []) {
    if (!KNOWN_PROJECTION_ROLES.includes(e.role)) errors.push({ code: "PACK_ROLE_UNKNOWN", message: `unknown projection role: ${e.role}`, path: e.path });
    if (e.lossy !== true) errors.push({ code: "PACK_PROJECTION_INVALID", message: `projection ${e.path} must be lossy:true`, path: e.path });
    if (!sourceDigests.has(e.source_digest)) errors.push({ code: "PACK_PROJECTION_NO_SOURCE", message: `projection ${e.path} source_digest does not resolve to a source_of_truth digest`, path: e.path });
  }

  // v0 requires exactly the three evidence sources (each once) plus the Markdown projection,
  // so a contentless manifest cannot recompute a matching digest and silently skip every
  // coherence cross-check below (which is gated on all three sources being present).
  const sourceRoleCount = new Map<string, number>();
  for (const e of manifest.source_of_truth) sourceRoleCount.set(e.role, (sourceRoleCount.get(e.role) ?? 0) + 1);
  for (const role of KNOWN_SOURCE_ROLES) {
    const n = sourceRoleCount.get(role) ?? 0;
    if (n === 0) errors.push({ code: "PACK_ROLE_MISSING", message: `v0 pack requires a ${role} source_of_truth entry`, path: "source_of_truth" });
    else if (n > 1) errors.push({ code: "PACK_ROLE_DUPLICATE", message: `v0 pack must carry exactly one ${role} source_of_truth entry`, path: "source_of_truth" });
  }
  // v0 carries ONLY the digest-bound Harness Markdown projection — reject extra projections
  // (even known roles like junit/sarif) so an inventory pack stays Markdown-only per the DoR.
  const harnessMarkdownCount = manifest.projections.filter((p) => p.role === "harness_markdown").length;
  if (manifest.projections.length !== 1 || harnessMarkdownCount !== 1) {
    errors.push({ code: "PACK_PROJECTION_MISSING", message: `v0 pack requires exactly one projection (harness_markdown)`, path: "projections" });
  }
  // Source roles whose path was safe AND whose bytes matched the declared digest. Only these
  // are re-read for the coherence cross-check, so a tampered/unsafe source surfaces as its own
  // file/path error and is never read again to produce a (misleading) coherence verdict.
  const digestCleanSources = new Set<string>();
  const digestCleanExternal = new Set<string>();
  for (const e of allEntries) {
    const norm = e.path.replace(/\/+/g, "/");
    if (seen.has(norm)) { errors.push({ code: "PACK_PATH_DUPLICATE", message: `duplicate path entry: ${e.path}`, path: e.path }); continue; }
    seen.add(norm);
    if (!pathSafe(packDir, e.path, errors)) continue;
    try {
      const got = sha256(readFileSync(resolve(packDir, e.path)));
      if (got !== e.digest) errors.push({ code: "PACK_FILE_DIGEST_MISMATCH", message: `${e.path}: digest ${e.digest} != actual ${got}`, path: e.path });
      else if (e.kind === "source") digestCleanSources.add(e.role);
      else if (e.kind === "external") digestCleanExternal.add(e.role);
    } catch {
      errors.push({ code: "PACK_FILE_MISSING", message: `listed file missing or unreadable: ${e.path}`, path: e.path });
    }
  }

  // --- optional_private_reviews: v0 accepts only available:false ---
  for (const r of manifest.optional_private_reviews ?? []) {
    if (r.available === true) errors.push({ code: "PACK_PRIVATE_REVIEW_UNSUPPORTED", message: `optional_private_reviews ${r.role}: available:true is unsupported in v0`, path: "optional_private_reviews" });
  }

  // --- unlisted-file rejection (strict; no --allow-extra-files in v0) ---
  try {
    const allowed = new Set<string>(["manifest.json", "evidence.sha256", ...allEntries.map((e) => e.path.replace(/\/+/g, "/"))]);
    for (const f of readdirSync(packDir, { recursive: true }) as string[]) {
      const rel = String(f).split(sep).join("/");
      let st: ReturnType<typeof lstatSync> | undefined;
      try { st = lstatSync(resolve(packDir, rel)); } catch { st = undefined; }
      if (!st || st.isDirectory()) continue;
      // A regular file OR a symlink that is not explicitly listed is an unlisted artifact
      // (a *listed* symlink is already rejected by pathSafe). Don't let isFile() skip symlinks.
      if (!allowed.has(rel)) {
        errors.push({ code: "PACK_UNLISTED_FILE", message: `unlisted ${st.isSymbolicLink() ? "symlink" : "file"} in pack: ${rel}`, path: rel });
      }
    }
  } catch {
    /* an unreadable pack dir surfaces via the manifest read above */
  }

  // The cross-checks below re-read the source files, so run them only when all three required
  // sources are present, path-safe, and digest-clean — otherwise the byte/coherence checks
  // would read inconsistent (or unsafe) files. A failed source already surfaces its own error.
  const src = (role: string) => (manifest.source_of_truth ?? []).find((e) => e.role === role);
  const carrierSrc = src("assay_carrier"), matrixSrc = src("suite_matrix"), provSrc = src("recipe_provenance");
  // Require exactly one entry per required role: digestCleanSources is role-keyed, so without
  // the count gate a clean *duplicate* role could satisfy this while src(role) returns an
  // earlier entry that failed path/digest validation (and would then be re-read).
  const sourcesClean =
    !!carrierSrc && !!provSrc && !!matrixSrc &&
    sourceRoleCount.get("assay_carrier") === 1 &&
    sourceRoleCount.get("recipe_provenance") === 1 &&
    sourceRoleCount.get("suite_matrix") === 1 &&
    digestCleanSources.has("assay_carrier") &&
    digestCleanSources.has("recipe_provenance") &&
    digestCleanSources.has("suite_matrix");

  // Captured from the digest-clean provenance for the v1 external binding check below.
  let provReleaseAssetDigest: string | undefined;
  if (sourcesClean && carrierSrc && provSrc && matrixSrc) {
    try {
      const provRaw = readJson(packDir, provSrc.path) as Record<string, unknown>;
      const pv = validateRecipeProvenance(provRaw);
      if (!pv.valid) {
        errors.push({ code: "PACK_PROVENANCE_INVALID", message: `recipe provenance invalid (${pv.errors.map((x) => x.code).join(",")})`, path: provSrc.path });
      } else {
        const prov = provRaw as unknown as import("./suite_recipe_provenance.js").RecipeProvenance;
        provReleaseAssetDigest = prov.release_asset?.digest;
        // v0 provenance must prove exactly what H-next-2 proved.
        if (prov.result.exit_code !== 0 || prov.result.classification !== "success" || prov.hosted !== true || prov.ambient_scan !== false) {
          errors.push({ code: "PACK_PROVENANCE_NOT_HERMETIC_SUCCESS", message: `v0 provenance must be exit_code 0 / success / hosted:true / ambient_scan:false`, path: provSrc.path });
        }
        // Metadata cross-check (the non-digested manifest metadata must not lie).
        if (manifest.subject.assay_version !== prov.assay.version) errors.push({ code: "PACK_METADATA_MISMATCH", message: `subject.assay_version != provenance.assay.version`, path: "subject.assay_version" });
        if (manifest.producer.version !== prov.harness.version) errors.push({ code: "PACK_METADATA_MISMATCH", message: `producer.version != provenance.harness.version`, path: "producer.version" });
        // Coherence part 1: same bytes everywhere.
        const carrierFileDigest = sha256(readFileSync(resolve(packDir, carrierSrc.path)));
        const agree = [manifest.subject.digest, carrierSrc.digest, prov.artifact.digest, carrierFileDigest];
        if (new Set(agree).size !== 1) {
          errors.push({ code: "PACK_COHERENCE_BYTES", message: `carrier bytes / subject.digest / source digest / provenance.artifact.digest disagree`, path: "subject.digest" });
        }
        // Coherence part 2: the matrix's matching row must match the provenance proof.
        const matrix = readJson(packDir, matrixSrc.path) as Record<string, unknown>;
        const sv = validateSuiteCompatibility(matrix);
        if (!sv.valid) {
          errors.push({ code: "PACK_MATRIX_INVALID", message: `bundled suite matrix fails suite check (${sv.errors.map((x) => x.code).join(",")})`, path: matrixSrc.path });
        } else {
          const rows = (sv.matrix!.carrier_rows ?? []) as Array<Record<string, any>>;
          const row = rows.find((r) => r.carrier === manifest.subject.carrier);
          // Coherence TARGET SELECTION (generalized; digest checks, source roles, projection requirements,
          // and file/path safety below are unchanged). The recipe_provenance binds to EITHER the carrier
          // row's own proof (carrier-row-bound: same hosted_run) OR exactly one recipe_row (recipe-row-bound).
          if (!row) {
            errors.push({ code: "PACK_COHERENCE_MATRIX", message: `matrix has no row for subject carrier ${manifest.subject.carrier}`, path: "subject.carrier" });
          } else if ((row.proof ?? {}).hosted_run === prov.hosted_run) {
            // CARRIER-ROW-BOUND (e.g. inventory, A5a-2): the carrier row's OWN proof is this provenance,
            // so every proof field must match it.
            coherenceBinding = "carrier_row_bound";
            const p = row.proof ?? {};
            const ps = row.proof_scope ?? {};
            if (p.end_to_end !== "proven") errors.push({ code: "PACK_COHERENCE_MATRIX", message: `matrix row for ${manifest.subject.carrier} is not end_to_end=proven`, path: "matrix.row" });
            if (p.assay_version !== prov.assay.version) errors.push({ code: "PACK_COHERENCE_MATRIX", message: `matrix assay_version != provenance.assay.version`, path: "matrix.row.assay_version" });
            if (p.assay_binary_digest !== prov.assay.binary_digest) errors.push({ code: "PACK_COHERENCE_MATRIX", message: `matrix assay_binary_digest != provenance.assay.binary_digest`, path: "matrix.row.assay_binary_digest" });
            if (p.command !== prov.assay.command) errors.push({ code: "PACK_COHERENCE_MATRIX", message: `matrix command != provenance.assay.command`, path: "matrix.row.command" });
            if (p.artifact_digest !== prov.artifact.digest) errors.push({ code: "PACK_COHERENCE_MATRIX", message: `matrix artifact_digest != provenance.artifact.digest`, path: "matrix.row.artifact_digest" });
            if (p.fixture_digest !== prov.fixture.digest) errors.push({ code: "PACK_COHERENCE_MATRIX", message: `matrix fixture_digest != provenance.fixture.digest`, path: "matrix.row.fixture_digest" });
            // runner_os + hosted come from the schema-guaranteed proof_scope (validateCarrierRow
            // requires proof_scope.{runner_os,hosted,ambient_scan}), not the incidental proof.* copies.
            if (ps.runner_os !== prov.runner_os) errors.push({ code: "PACK_COHERENCE_MATRIX", message: `matrix proof_scope.runner_os != provenance.runner_os`, path: "matrix.row.proof_scope" });
            if (ps.hosted !== prov.hosted) errors.push({ code: "PACK_COHERENCE_MATRIX", message: `matrix proof_scope.hosted != provenance.hosted`, path: "matrix.row.proof_scope" });
            if (ps.ambient_scan !== prov.ambient_scan) errors.push({ code: "PACK_COHERENCE_MATRIX", message: `matrix proof_scope.ambient_scan != provenance.ambient_scan`, path: "matrix.row.proof_scope" });
          } else {
            // RECIPE-ROW-BOUND (e.g. A5a-3 clean/pass): the proof lives in a recipe_row, not the carrier
            // row. The carrier subject must STILL be a proven carrier row, and EXACTLY ONE recipe_row must
            // carry this provenance's proof — matched only by end_to_end/hosted_run/artifact_digest (never
            // note or recipe display name). artifact_digest == carrier digest (coherence part 1) binds the
            // recipe row to this carrier subject without a recipe-name map or schema field.
            const p = row.proof ?? {};
            if (p.end_to_end !== "proven") {
              errors.push({ code: "PACK_COHERENCE_MATRIX", message: `carrier row for ${manifest.subject.carrier} is not end_to_end=proven (a recipe-row-bound pack still requires a proven carrier subject)`, path: "matrix.row" });
            }
            const recipeRows = (sv.matrix!.recipe_rows ?? []) as Array<Record<string, any>>;
            const recipeMatches = recipeRows.filter((rr) => {
              const rp = (rr.proof ?? {}) as Record<string, any>;
              return rp.end_to_end === "proven" && rp.hosted_run === prov.hosted_run && rp.artifact_digest === prov.artifact.digest;
            });
            if (recipeMatches.length === 0) {
              errors.push({ code: "PACK_COHERENCE_MATRIX", message: `no carrier_row or recipe_row proof matches the recipe_provenance (hosted_run + artifact_digest)`, path: "matrix" });
            } else if (recipeMatches.length > 1) {
              errors.push({ code: "PACK_COHERENCE_AMBIGUOUS_RECIPE", message: `${recipeMatches.length} recipe_rows match the recipe_provenance (hosted_run + artifact_digest); the binding is ambiguous`, path: "matrix.recipe_rows" });
            } else {
              // exactly one match -> recipe_row_bound; coherent.
              coherenceBinding = "recipe_row_bound";
            }
          }
        }
        if (manifest.subject.carrier !== ((readJson(packDir, carrierSrc.path) as { schema?: string }).schema ?? "")) {
          errors.push({ code: "PACK_METADATA_MISMATCH", message: `subject.carrier != bundled carrier schema`, path: "subject.carrier" });
        }
      }
    } catch (e) {
      errors.push({ code: "PACK_CROSSCHECK_FAILED", message: `cross-check could not read bundled evidence: ${(e as Error).message}` });
    }
  }

  // External cross-check evidence: forbidden on v0, required + integrity-checked on v1.
  if (!isV1) {
    if ((manifest.external_evidence ?? []).length > 0) {
      errors.push({ code: "PACK_EXTERNAL_ON_V0", message: "external_evidence is unsupported on v0; use suite.evidence_pack.v1", path: "external_evidence" });
    }
  } else {
    verifyExternalEvidenceV1(packDir, manifest, digestCleanExternal, provReleaseAssetDigest, errors);
  }

  // A binding is only meaningful on a coherent pack; never report one alongside coherence errors.
  const binding = errors.length === 0 ? coherenceBinding : null;
  return { valid: errors.length === 0, errors, manifest, coherence_binding: binding };
}

// ---------------------------------------------------------------------------
// External attestation cross-check (v1) — integrity, NOT cryptographic trust
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export { formatPackMarkdown } from "./suite_evidence_pack_format.js";
