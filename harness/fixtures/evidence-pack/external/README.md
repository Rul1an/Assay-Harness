# External attestation fixture (H-next-4)

A real, public GitHub artifact-attestation bundle, pinned for the Evidence Pack's external
cross-check (H-next-4). This directory carries **inputs to a future `suite.evidence_pack.v1`
fixture**; it is not itself a pack and the v1 verifier does not exist yet (lands in a later slice).

## What it is

- `github-artifact-attestation.bundle.json` — the Sigstore bundle GitHub produced for the
  `Rul1an/assay` **v3.27.0** release, fetched by subject digest. Pinned bytes:
  `sha256:8b2cdebbfe55b0910d7b38bafaf96e27acfd0cb78ef7dfc3abb0f752c366b552`.
- `github-artifact-attestation.meta.json` — `suite.external_attestation_source.v0`: how it was
  retrieved, the bundle digest/media-type, the harness-verification posture, and explicit non-claims.

## Subject and binding

The bundle is **multi-subject** (one build-provenance attestation covers all v3.27.0 release assets).
The recorded subject is the x86_64 linux tarball:

```
assay-v3.27.0-x86_64-unknown-linux-gnu.tar.gz
sha256:079492e5b5840accabd3c685fbc9cdfbccb324fc32e39490ec8cca39758072bc
```

That digest equals `recipe_provenance.release_asset.digest` — the tarball the hermetic inventory
recipe downloads and verifies (via its published `.sha256`) before extracting the binary. So a v1
Evidence Pack can bind this attestation to the release asset the proof actually consumed, via
`binding.to = recipe_provenance.release_asset.digest`.

GitHub attested the **release asset (tarball)**, not the extracted binary. `assay.binary_digest`
(`sha256:52a30b3f…`) stays a separate provenance field and is never equated with the attested subject.

## Posture (what the Harness does and does not do)

- Included / digest-bound; the in-toto subject is decoded (read) for integrity.
- Signature, trusted-root, and transparency-log (Rekor) trust are **NOT** checked by the Harness.
- Not an Assay carrier, not policy approval, not artifact-safety proof.

## Re-acquisition (not run in CI verify)

```bash
gh api repos/Rul1an/assay/attestations/sha256:079492e5b5840accabd3c685fbc9cdfbccb324fc32e39490ec8cca39758072bc \
  | jq '.attestations[0].bundle' > github-artifact-attestation.bundle.json   # pretty-print to pin
```

Predicate: `https://slsa.dev/provenance/v1`; builder: the `Rul1an/assay` `release.yml` workflow at the
`v3.27.0` tag. Source repo is public (public-good Sigstore root), so no token is required.
