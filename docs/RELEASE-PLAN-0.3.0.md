# Release Plan — Assay Harness 0.3.0

> **Status:** released on 2026-04-29
> **Target repo:** `Rul1an/Assay-Harness`
> **Companion Assay line:** Assay `v3.7.0`

---

## Purpose

Record Assay Harness `v0.3.0` as the companion release for the first
three-family Assay evidence-portability line.

This release proves that Harness can keep carrying Trust Basis diffs generically
across eval, runtime decision, and inventory/provenance receipt claim families
without learning Promptfoo, OpenFeature, or CycloneDX semantics.

## Version Advice

`0.3.0` is the right pre-1.0 minor release because the public recipe surface and
compatibility target expand beyond the `0.2.0` Promptfoo/Trust Basis bridge.

This is still a compatibility release, not a new semantic layer.

## Compatibility Target

- Assay release line: `v3.7.0`
- Trust Basis diff schema: `assay.trust-basis.diff.v1`
- Trust Card schema: v5
- Trust Basis surface: 10 frozen claims
- Claim families carried by recipes: eval, decision, inventory

Assay `v3.7.0` is the exact minimum Assay tag for this compatibility line.

## Pre-Release Checks

- [x] `npm test` from `harness/`
- [x] `npm run typecheck` from `harness/`
- [x] Promptfoo recipe against a compatible Assay `v3.7.0` binary
- [x] OpenFeature recipe against a compatible Assay `v3.7.0` binary
- [x] CycloneDX ML-BOM recipe against a compatible Assay `v3.7.0` binary
- [x] `git diff --check`

## Boundary

Harness gate/report behavior must remain claim-family agnostic. Promptfoo,
OpenFeature, and CycloneDX may differ by fixture inputs and Assay importer
commands only.

Harness must not parse Promptfoo JSONL, OpenFeature JSONL, CycloneDX BOMs, or
Assay receipt payloads. It must not compare assertion values, flag decisions,
model versions, dataset refs, or domain-specific metadata.

## Tagging

Tag pushed on 2026-04-29:

```bash
git tag v0.3.0
git push origin v0.3.0
```
