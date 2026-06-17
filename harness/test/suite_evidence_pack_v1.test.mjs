import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  SUITE_EVIDENCE_PACK_SCHEMA_V1,
  verifyEvidencePack,
  computeManifestDigest,
  formatPackMarkdown,
} from "../dist/suite_evidence_pack.js";

const VALID = fileURLToPath(new URL("../fixtures/evidence-pack/valid-v1", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sha = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");

function mutated(fn) {
  const dir = mkdtempSync(join(tmpdir(), "evpackv1-"));
  const pack = join(dir, "pack");
  cpSync(VALID, pack, { recursive: true });
  fn(pack);
  return pack;
}
const readManifest = (p) => JSON.parse(readFileSync(join(p, "manifest.json"), "utf-8"));
const writeManifest = (p, m) => writeFileSync(join(p, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
const METArel = "external/github-artifact-attestation.meta.json";
const BUNrel = "external/github-artifact-attestation.bundle.json";
const readMeta = (p) => JSON.parse(readFileSync(join(p, METArel), "utf-8"));
const writeMeta = (p, m) => writeFileSync(join(p, METArel), JSON.stringify(m, null, 2) + "\n");
const readProv = (p) => JSON.parse(readFileSync(join(p, "provenance/recipe.provenance.json"), "utf-8"));
const writeProv = (p, x) => writeFileSync(join(p, "provenance/recipe.provenance.json"), JSON.stringify(x, null, 2) + "\n");
// v1-aware reseal: recompute every file digest, subject.digest, the bundle->meta source_digest, and
// the manifest digest (which includes external_evidence for v1).
function reseal(p, m) {
  for (const e of [...m.source_of_truth, ...m.projections, ...(m.external_evidence ?? [])]) {
    e.digest = sha(readFileSync(join(p, e.path)));
  }
  m.subject.digest = m.source_of_truth.find((e) => e.role === "assay_carrier").digest;
  const meta = (m.external_evidence ?? []).find((e) => e.role === "external_attestation_metadata");
  const bundle = (m.external_evidence ?? []).find((e) => e.role === "external_attestation_bundle");
  if (meta && bundle) bundle.source_digest = meta.digest;
  m.manifest.digest = computeManifestDigest(m);
  writeManifest(p, m);
  writeFileSync(join(p, "evidence.sha256"), m.manifest.digest + "\n");
}
const codes = (p) => verifyEvidencePack(p).errors.map((e) => e.code);
const bundleEntry = (m) => m.external_evidence.find((e) => e.role === "external_attestation_bundle");

test("schema constant", () => assert.equal(SUITE_EVIDENCE_PACK_SCHEMA_V1, "suite.evidence_pack.v1"));

test("the committed v1 golden verifies", () => {
  const r = verifyEvidencePack(VALID);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.manifest.schema, "suite.evidence_pack.v1");
  assert.equal(bundleEntry(r.manifest).binding.to, "recipe_provenance.release_asset.digest");
});

test("external_evidence is part of the v1 manifest digest", () => {
  const m = readManifest(VALID);
  const tampered = JSON.parse(JSON.stringify(m));
  bundleEntry(tampered).subject_digest = "sha256:" + "0".repeat(64);
  assert.notEqual(computeManifestDigest(tampered), m.manifest.digest);
});

// --- v0/v1 gate ---
test("external_evidence on a v0 schema is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.schema = "suite.evidence_pack.v0"; reseal(pack, m); });
  assert.ok(codes(p).includes("PACK_EXTERNAL_ON_V0"));
});
test("a v1 pack with no external_evidence is rejected", () => {
  const p = mutated((pack) => {
    rmSync(join(pack, BUNrel)); rmSync(join(pack, METArel));
    const m = readManifest(pack); m.external_evidence = []; reseal(pack, m);
  });
  assert.ok(codes(p).includes("PACK_EXTERNAL_MISSING"));
});

// --- cardinality / roles ---
test("a second bundle entry is rejected (cardinality)", () => {
  const p = mutated((pack) => {
    cpSync(join(pack, BUNrel), join(pack, "external/dup.bundle.json"));
    const m = readManifest(pack); const b = bundleEntry(m);
    m.external_evidence.push({ ...b, path: "external/dup.bundle.json" });
    reseal(pack, m);
  });
  assert.ok(codes(p).includes("PACK_EXTERNAL_ROLE_CARDINALITY"));
});
test("an unknown external role is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); m.external_evidence.find((e) => e.role === "external_attestation_metadata").role = "weird"; reseal(pack, m); });
  assert.ok(codes(p).includes("PACK_EXTERNAL_ROLE_UNKNOWN"));
});

// --- digests / file integrity (generic checks apply to external files too) ---
test("a tampered bundle file is rejected", () => {
  const p = mutated((pack) => appendFileSync(join(pack, BUNrel), "\n"));
  assert.ok(codes(p).includes("PACK_FILE_DIGEST_MISMATCH"));
});
test("meta.bundle.digest != bundle file digest is rejected", () => {
  const p = mutated((pack) => { const meta = readMeta(pack); meta.bundle.digest = "sha256:" + "1".repeat(64); writeMeta(pack, meta); reseal(pack, readManifest(pack)); });
  assert.ok(codes(p).includes("PACK_EXTERNAL_META_MISMATCH"));
});

// --- subject coherence + decode ---
test("meta.retrieval.artifact_digest != subject_digest is rejected", () => {
  const p = mutated((pack) => { const meta = readMeta(pack); meta.retrieval.artifact_digest = "sha256:" + "2".repeat(64); writeMeta(pack, meta); reseal(pack, readManifest(pack)); });
  assert.ok(codes(p).includes("PACK_EXTERNAL_SUBJECT_MISMATCH"));
});
test("a subject_digest not attested by the bundle is rejected (offline decode)", () => {
  const p = mutated((pack) => {
    const fake = "sha256:" + "3".repeat(64);
    const m = readManifest(pack); bundleEntry(m).subject_digest = fake;
    const meta = readMeta(pack); meta.retrieval.artifact_digest = fake; writeMeta(pack, meta);
    reseal(pack, m);
  });
  assert.ok(codes(p).includes("PACK_EXTERNAL_SUBJECT_DECODE"));
});
test("a non-DSSE / wrong payloadType bundle is rejected", () => {
  const p = mutated((pack) => {
    const b = JSON.parse(readFileSync(join(pack, BUNrel), "utf-8"));
    b.dsseEnvelope.payloadType = "application/vnd.something+json";
    writeFileSync(join(pack, BUNrel), JSON.stringify(b, null, 2) + "\n");
    reseal(pack, readManifest(pack));
  });
  assert.ok(codes(p).includes("PACK_EXTERNAL_BUNDLE_SHAPE"));
});

// --- media type / flags / provider / non_claims ---
test("a non-v0.3 media type is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); bundleEntry(m).media_type = "application/vnd.dev.sigstore.bundle.v9+json"; reseal(pack, m); });
  assert.ok(codes(p).includes("PACK_EXTERNAL_MEDIA_TYPE"));
});
test("signature_trust_verified_by_harness=true is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); bundleEntry(m).signature_trust_verified_by_harness = true; reseal(pack, m); });
  assert.ok(codes(p).includes("PACK_EXTERNAL_VERIFY_FLAG"));
});
test("provider != github is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); bundleEntry(m).provider = "evilhub"; reseal(pack, m); });
  assert.ok(codes(p).includes("PACK_EXTERNAL_PROVIDER_UNSUPPORTED"));
});
test("empty meta.non_claims is rejected", () => {
  const p = mutated((pack) => { const meta = readMeta(pack); meta.non_claims = []; writeMeta(pack, meta); reseal(pack, readManifest(pack)); });
  assert.ok(codes(p).includes("PACK_EXTERNAL_NON_CLAIMS_MISSING"));
});

// --- binding ---
test("binding to release_asset that disagrees with provenance is rejected", () => {
  const p = mutated((pack) => { const pr = readProv(pack); pr.release_asset.digest = "sha256:" + "4".repeat(64); writeProv(pack, pr); reseal(pack, readManifest(pack)); });
  assert.ok(codes(p).includes("PACK_EXTERNAL_BINDING_MISMATCH"));
});
test("an unknown binding.to is rejected", () => {
  const p = mutated((pack) => { const m = readManifest(pack); bundleEntry(m).binding = { to: "recipe_provenance.evil" }; reseal(pack, m); });
  assert.ok(codes(p).includes("PACK_EXTERNAL_BINDING_UNKNOWN"));
});

// --- path safety on external/ ---
test("an unlisted file in external/ is rejected", () => {
  const p = mutated((pack) => writeFileSync(join(pack, "external/sneaky.txt"), "x"));
  assert.ok(codes(p).includes("PACK_UNLISTED_FILE"));
});

// external_evidence gets the SAME file discipline as pack artifacts (it joins allEntries) — proven
// directly on external entries, not only transitively via a source_of_truth entry.
test("an external entry with a traversal path is rejected (path safety on external)", () => {
  // No reseal: pathSafe rejects "../escape.json" before any read (stale digest co-occurs).
  const p = mutated((pack) => { const m = readManifest(pack); bundleEntry(m).path = "../escape.json"; writeManifest(pack, m); });
  assert.ok(codes(p).includes("PACK_PATH_UNSAFE"));
});
test("an external entry with an absolute path is rejected (path safety on external)", () => {
  const p = mutated((pack) => { const m = readManifest(pack); bundleEntry(m).path = "/tmp/escape.json"; writeManifest(pack, m); });
  assert.ok(codes(p).includes("PACK_PATH_UNSAFE"));
});
test("an external entry duplicating another entry's path is rejected (duplicate detection on external)", () => {
  const p = mutated((pack) => {
    const m = readManifest(pack);
    // point the metadata entry at the bundle's path -> two allEntries share one normalized path.
    m.external_evidence.find((e) => e.role === "external_attestation_metadata").path = bundleEntry(m).path;
    reseal(pack, m);
  });
  assert.ok(codes(p).includes("PACK_PATH_DUPLICATE"));
});

// --- v0 invariants still enforced on v1 ---
test("v1 still enforces coherence (carrier bytes vs provenance.artifact)", () => {
  const p = mutated((pack) => { const pr = readProv(pack); pr.artifact.digest = "sha256:" + "5".repeat(64); writeProv(pack, pr); reseal(pack, readManifest(pack)); });
  assert.ok(codes(p).includes("PACK_COHERENCE_BYTES"));
});
test("v1 still enforces manifest digest + path safety", () => {
  const dm = mutated((pack) => { const m = readManifest(pack); m.manifest.digest = "sha256:dead"; writeManifest(pack, m); });
  assert.ok(codes(dm).includes("PACK_DIGEST_MISMATCH"));
  // No reseal here: pathSafe rejects "../escape.json" before any file read (the digest goes stale,
  // so PACK_PATH_UNSAFE co-occurs with a digest mismatch — both prove v0 checks run on v1).
  const tp = mutated((pack) => { const m = readManifest(pack); m.source_of_truth[0].path = "../escape.json"; writeManifest(pack, m); });
  assert.ok(codes(tp).includes("PACK_PATH_UNSAFE"));
});

// --- projection wording ---
test("v1 projection surfaces the cross-check, never a positive trust claim", () => {
  const md = formatPackMarkdown(readManifest(VALID));
  assert.match(md, /External attestation cross-check/);
  assert.match(md, /Signature trust verified by Harness: no/);
  assert.match(md, /GitHub attested the release asset, not the extracted binary/);
  assert.doesNotMatch(md, /Signature trust verified by Harness: yes/);
  for (const banned of [/\btrusted\b/i, /\bapproved\b/i, /proven by GitHub/i, /supply chain safe/i]) {
    assert.doesNotMatch(md, banned);
  }
});

// --- CLI ---
test("CLI verify: v1 golden -> 0; tampered -> 3", () => {
  assert.equal(spawnSync(process.execPath, [CLI, "evidence-pack", "verify", VALID], { encoding: "utf8" }).status, 0);
  const t = mutated((pack) => appendFileSync(join(pack, BUNrel), "x"));
  assert.equal(spawnSync(process.execPath, [CLI, "evidence-pack", "verify", t], { encoding: "utf8" }).status, 3);
});
