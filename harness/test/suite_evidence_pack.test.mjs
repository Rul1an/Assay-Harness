import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync, mkdirSync, appendFileSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  SUITE_EVIDENCE_PACK_SCHEMA,
  verifyEvidencePack,
  computeManifestDigest,
  formatPackMarkdown,
} from "../dist/suite_evidence_pack.js";
import { computeMatrixDigest } from "../dist/suite_compatibility.js";

const VALID = fileURLToPath(new URL("../fixtures/evidence-pack/valid", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// Copy the committed valid pack to a throwaway dir, run a mutation, return the dir.
function mutated(fn) {
  const dir = mkdtempSync(join(tmpdir(), "evpack-"));
  const pack = join(dir, "pack");
  cpSync(VALID, pack, { recursive: true });
  fn(pack);
  return pack;
}
const readManifest = (pack) => JSON.parse(readFileSync(join(pack, "manifest.json"), "utf-8"));
const writeManifest = (pack, m) => writeFileSync(join(pack, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
// Recompute every file digest + the manifest digest, so a content change isolates the semantic error.
function reseal(pack, m) {
  for (const e of [...m.source_of_truth, ...m.projections]) {
    e.digest = "sha256:" + createHash("sha256").update(readFileSync(join(pack, e.path))).digest("hex");
  }
  m.subject.digest = m.source_of_truth.find((e) => e.role === "assay_carrier").digest;
  m.manifest.digest = computeManifestDigest(m);
  writeManifest(pack, m);
  writeFileSync(join(pack, "evidence.sha256"), m.manifest.digest + "\n");
}
const codes = (pack) => verifyEvidencePack(pack).errors.map((e) => e.code);
const readProv = (pack) => JSON.parse(readFileSync(join(pack, "provenance/recipe.provenance.json"), "utf-8"));
const writeProv = (pack, p) => writeFileSync(join(pack, "provenance/recipe.provenance.json"), JSON.stringify(p, null, 2) + "\n");
const matrixPath = (pack) => join(pack, "suite/suite.compatibility.v0.json");
const readMatrix = (pack) => JSON.parse(readFileSync(matrixPath(pack), "utf-8"));
const writeMatrix = (pack, m) => writeFileSync(matrixPath(pack), JSON.stringify(m, null, 2) + "\n");
// Recompute the matrix's OWN internal rows-digest so a row mutation isolates the coherence
// error instead of tripping SUITE_DIGEST_MISMATCH (-> PACK_MATRIX_INVALID).
function resealMatrix(pack) {
  const m = readMatrix(pack);
  m.manifest.digest = computeMatrixDigest({ carrier_rows: m.carrier_rows, recipe_rows: m.recipe_rows });
  writeMatrix(pack, m);
}
const INV = "assay.mcp_server_inventory.v0";
const invRow = (m) => m.carrier_rows.find((r) => r.carrier === INV);
const BOGUS = (n) => "sha256:" + String(n).repeat(64).slice(0, 64);

test("schema constant", () => {
  assert.equal(SUITE_EVIDENCE_PACK_SCHEMA, "suite.evidence_pack.v0");
});

test("the committed valid pack verifies", () => {
  const r = verifyEvidencePack(VALID);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.manifest.subject.carrier, "assay.mcp_server_inventory.v0");
});

// --- integrity ---
test("manifest digest mismatch is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.manifest.digest = "sha256:dead"; writeManifest(pack, m); });
  assert.ok(codes(p).includes("PACK_DIGEST_MISMATCH"));
});
test("projection byte tamper is rejected", () => {
  const p = mutated((pack) => appendFileSync(join(pack, "harness/inventory.review.md"), "\ntampered\n"));
  assert.ok(codes(p).includes("PACK_FILE_DIGEST_MISMATCH"));
});
test("a missing listed file is rejected", () => {
  const p = mutated((pack) => rmSync(join(pack, "harness/inventory.review.md")));
  assert.ok(codes(p).includes("PACK_FILE_MISSING"));
});
test("an unlisted file is rejected (strict)", () => {
  const p = mutated((pack) => writeFileSync(join(pack, "sneaky.txt"), "x"));
  assert.ok(codes(p).includes("PACK_UNLISTED_FILE"));
});

// --- path safety (P1) ---
test("a path-traversal source path is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.source_of_truth[0].path = "../escape.json"; writeManifest(pack, m); });
  assert.ok(codes(p).includes("PACK_PATH_UNSAFE"));
});
test("an absolute source path is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.source_of_truth[0].path = "/tmp/escape.json"; writeManifest(pack, m); });
  assert.ok(codes(p).includes("PACK_PATH_UNSAFE"));
});
test("a duplicate path entry is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.source_of_truth.push({ ...m.source_of_truth[0] }); writeManifest(pack, m); });
  assert.ok(codes(p).includes("PACK_PATH_DUPLICATE"));
});

// --- coherence (P1) ---
test("matrix vs provenance hosted_run mismatch is rejected", () => {
  const p = mutated((pack) => {
    const provPath = join(pack, "provenance/recipe.provenance.json");
    const prov = JSON.parse(readFileSync(provPath, "utf-8"));
    prov.hosted_run = "999999";
    writeFileSync(provPath, JSON.stringify(prov, null, 2) + "\n");
    reseal(pack, readManifest(pack));
  });
  assert.ok(codes(p).includes("PACK_COHERENCE_MATRIX"));
});
test("metadata producer.version vs provenance.harness.version mismatch is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.producer.version = "9.9.9"; writeManifest(pack, m); });
  // producer is excluded from the digest, so no reseal needed; the cross-check catches it.
  assert.ok(codes(p).includes("PACK_METADATA_MISMATCH"));
});

// --- provenance (P2) ---
test("non-success / non-hermetic provenance is rejected", () => {
  const p = mutated((pack) => {
    const provPath = join(pack, "provenance/recipe.provenance.json");
    const prov = JSON.parse(readFileSync(provPath, "utf-8"));
    prov.result.exit_code = 1;
    writeFileSync(provPath, JSON.stringify(prov, null, 2) + "\n");
    reseal(pack, readManifest(pack));
  });
  assert.ok(codes(p).includes("PACK_PROVENANCE_NOT_HERMETIC_SUCCESS"));
});

// --- private reviews (P2) ---
test("optional_private_reviews available:true is unsupported in v0", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.optional_private_reviews[0].available = true; writeManifest(pack, m); });
  assert.ok(codes(p).includes("PACK_PRIVATE_REVIEW_UNSUPPORTED"));
});

// --- determinism (P2) ---
test("manifest digest is independent of array order", () => {
  const m = readManifest(VALID);
  const reordered = { ...m, source_of_truth: [...m.source_of_truth].reverse(), projections: [...m.projections].reverse() };
  assert.equal(computeManifestDigest(m), computeManifestDigest(reordered));
});

// --- projection ---
test("markdown summary surfaces source digests, never approval wording", () => {
  const md = formatPackMarkdown(readManifest(VALID));
  assert.match(md, /Assay Evidence Pack/);
  assert.match(md, /Source of truth/);
  for (const banned of [/\bapproved\b/i, /\bcompliant\b/i, /\bsafe\b/i, /\bcomplete\b/i, /\btrusted\b/i]) {
    assert.doesNotMatch(md, banned);
  }
});

// --- H-next-2 regression ---
test("the pack carries the real hermetic inventory proof", () => {
  const m = readManifest(VALID);
  const prov = JSON.parse(readFileSync(join(VALID, "provenance/recipe.provenance.json"), "utf-8"));
  assert.equal(prov.hosted_run, "27682711427");
  assert.equal(prov.ambient_scan, false);
  assert.equal(prov.hosted, true);
  assert.ok(prov.fixture.digest.startsWith("sha256:") && prov.artifact.digest.startsWith("sha256:"));
  assert.equal(m.subject.digest, prov.artifact.digest, "subject == provenance artifact (coherence)");
});

// --- CLI ---
test("CLI: verify valid -> 0; tampered -> 3; missing dir -> 3/2; json parses", () => {
  assert.equal(spawnSync(process.execPath, [CLI, "evidence-pack", "verify", VALID], { encoding: "utf8" }).status, 0);
  const t = mutated((pack) => appendFileSync(join(pack, "harness/inventory.review.md"), "x"));
  assert.equal(spawnSync(process.execPath, [CLI, "evidence-pack", "verify", t], { encoding: "utf8" }).status, 3);
  const r = spawnSync(process.execPath, [CLI, "evidence-pack", "verify", VALID, "--format", "json"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).valid, true);
});

// --- canonical digest rule (P3) ---
test("changing created_at does not change pack identity (still verifies)", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.created_at = "2999-01-01T00:00:00Z"; writeManifest(pack, m); });
  const r = verifyEvidencePack(p);
  // created_at is excluded from the digest, so no reseal is needed and the pack stays valid.
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});
test("evidence.sha256 sidecar mismatch is rejected even when manifest.digest is correct", () => {
  const p = mutated((pack) => writeFileSync(join(pack, "evidence.sha256"), BOGUS(7) + "\n"));
  assert.ok(codes(p).includes("PACK_DIGEST_MISMATCH"));
});

// --- coherence invariant: the 6 explicit negatives (P4) ---
test("coherence: provenance.artifact.digest != carrier bytes -> fail", () => {
  const p = mutated((pack) => { const pr = readProv(pack); pr.artifact.digest = BOGUS(0); writeProv(pack, pr); reseal(pack, readManifest(pack)); });
  assert.ok(codes(p).includes("PACK_COHERENCE_BYTES"));
});
test("coherence: manifest.subject.digest != carrier bytes -> fail", () => {
  const p = mutated((pack) => {
    const m = readManifest(pack);
    m.subject.digest = BOGUS(3);
    // subject is in the digest; recompute manifest.digest directly so this isolates the
    // coherence failure (reseal would overwrite subject.digest from the carrier source).
    m.manifest.digest = computeManifestDigest(m);
    writeManifest(pack, m);
    writeFileSync(join(pack, "evidence.sha256"), m.manifest.digest + "\n");
  });
  assert.ok(codes(p).includes("PACK_COHERENCE_BYTES"));
});
test("coherence: matrix row artifact_digest != provenance -> fail", () => {
  const p = mutated((pack) => { const m = readMatrix(pack); invRow(m).proof.artifact_digest = BOGUS(1); writeMatrix(pack, m); resealMatrix(pack); reseal(pack, readManifest(pack)); });
  assert.ok(codes(p).includes("PACK_COHERENCE_MATRIX"));
});
test("coherence: matrix fixture_digest != provenance.fixture.digest -> fail", () => {
  const p = mutated((pack) => { const pr = readProv(pack); pr.fixture.digest = BOGUS(2); writeProv(pack, pr); reseal(pack, readManifest(pack)); });
  assert.ok(codes(p).includes("PACK_COHERENCE_MATRIX"));
});
test("coherence: matrix proof_scope.ambient_scan != provenance.ambient_scan -> fail", () => {
  const p = mutated((pack) => { const m = readMatrix(pack); invRow(m).proof_scope.ambient_scan = true; writeMatrix(pack, m); resealMatrix(pack); reseal(pack, readManifest(pack)); });
  assert.ok(codes(p).includes("PACK_COHERENCE_MATRIX"));
});
test("coherence: matrix end_to_end not proven -> fail", () => {
  const p = mutated((pack) => { const m = readMatrix(pack); invRow(m).proof.end_to_end = "declared"; invRow(m).end_to_end_gap = { reason_code: "no_released_binary_emitter", owner: "harness" }; writeMatrix(pack, m); resealMatrix(pack); reseal(pack, readManifest(pack)); });
  assert.ok(codes(p).includes("PACK_COHERENCE_MATRIX"));
});

// --- path safety: symlinks + unknown role (P5) ---
test("a listed path that is a symlink is rejected", () => {
  const p = mutated((pack) => {
    rmSync(join(pack, "harness/inventory.review.md"));
    symlinkSync("../carriers/assay.mcp_server_inventory.v0.json", join(pack, "harness/inventory.review.md"));
  });
  assert.ok(codes(p).includes("PACK_PATH_UNSAFE"));
});
test("an unlisted symlink in the pack is rejected (not skipped as a non-file)", () => {
  const p = mutated((pack) => symlinkSync("../carriers/assay.mcp_server_inventory.v0.json", join(pack, "harness/sneaky.link")));
  assert.ok(codes(p).includes("PACK_UNLISTED_FILE"));
});
test("an unknown source role is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.source_of_truth.find((e) => e.role === "suite_matrix").role = "exotic_role"; reseal(pack, m); });
  assert.ok(codes(p).includes("PACK_ROLE_UNKNOWN"));
});

// --- hollow-pack + malformed-manifest holes (CodeRabbit Critical/Major) ---
test("a contentless pack (empty evidence roles) cannot pass by digest alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "evpack-"));
  const pack = join(dir, "pack");
  mkdirSync(pack, { recursive: true });
  const m = {
    schema: "suite.evidence_pack.v0",
    producer: { tool: "assay-harness", version: "0.8.0" },
    subject: { kind: "assay_carrier_recipe", carrier: INV, assay_version: "v3.27.0", digest: BOGUS(0) },
    source_of_truth: [],
    projections: [],
    optional_private_reviews: [{ role: "plimsoll_review_digest", available: false }],
    non_claims: [],
    manifest: { canonicalization: "jcs/rfc8785", digest: "" },
  };
  m.manifest.digest = computeManifestDigest(m);
  writeFileSync(join(pack, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  writeFileSync(join(pack, "evidence.sha256"), m.manifest.digest + "\n");
  const r = verifyEvidencePack(pack);
  assert.equal(r.valid, false);
  assert.ok(r.errors.map((e) => e.code).includes("PACK_ROLE_MISSING"));
});
test("a malformed manifest (non-array source_of_truth) fails closed without throwing", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.source_of_truth = "x"; writeManifest(pack, m); });
  let r;
  assert.doesNotThrow(() => { r = verifyEvidencePack(p); });
  assert.equal(r.valid, false);
  assert.ok(r.errors.map((e) => e.code).includes("PACK_MANIFEST_SHAPE"));
});

// --- source/projection separation: the two remaining negatives (P6) ---
test("a projection whose source_digest resolves to no source is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.projections[0].source_digest = BOGUS(9); reseal(pack, m); });
  assert.ok(codes(p).includes("PACK_PROJECTION_NO_SOURCE"));
});
test("a projection with no source_digest is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); delete m.projections[0].source_digest; reseal(pack, m); });
  assert.ok(codes(p).includes("PACK_PROJECTION_NO_SOURCE"));
});
