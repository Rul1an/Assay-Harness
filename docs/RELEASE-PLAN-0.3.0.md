# Release Plan — Assay Harness 0.3.0

> **Status:** release prep
> **Target repo:** `Rul1an/Assay-Harness`
> **Companion Assay line:** prepared Assay `v3.7.0`

---

## Purpose

Prepare Assay Harness `v0.3.0` as the companion release for the first
three-family Assay evidence-portability line.

This release proves that Harness can keep carrying Trust Basis diffs generically
across eval, runtime decision, and inventory/provenance receipt claim families
without learning Promptfoo, OpenFeature, or CycloneDX semantics.

## Version Advice

`0.3.0` is the right pre-1.0 minor release because the public recipe surface and
compatibility target expand beyond the `0.2.0` Promptfoo/Trust Basis bridge.

This is still a compatibility release, not a new semantic layer.

## Compatibility Target

- Assay release line: prepared `v3.7.0`
- Trust Basis diff schema: `assay.trust-basis.diff.v1`
- Trust Card schema: v5
- Trust Basis surface: 10 frozen claims
- Claim families carried by recipes: eval, decision, inventory

Once Assay `v3.7.0` is tagged, release notes should replace release-prep wording
with the exact minimum Assay tag.

## Pre-Release Checks

- [ ] `npm test` from `harness/`
- [ ] `npm run typecheck` from `harness/`
- [ ] Promptfoo recipe against a compatible Assay `v3.7.0` binary
- [ ] OpenFeature recipe against a compatible Assay `v3.7.0` binary
- [ ] CycloneDX ML-BOM recipe against a compatible Assay `v3.7.0` binary
- [ ] `git diff --check`

## Boundary

Harness gate/report behavior must remain claim-family agnostic. Promptfoo,
OpenFeature, and CycloneDX may differ by fixture inputs and Assay importer
commands only.

Harness must not parse Promptfoo JSONL, OpenFeature JSONL, CycloneDX BOMs, or
Assay receipt payloads. It must not compare assertion values, flag decisions,
model versions, dataset refs, or domain-specific metadata.

## Tagging

Tag only after the release-prep PR is merged and required checks pass:

```bash
git tag v0.3.0
git push origin v0.3.0
```
