# Release Plan — Assay Harness 0.3.1

> **Status:** proposed
> **Companion Assay line:** Assay `v3.8.0`
> **Purpose:** compatibility proof and release-truth sync after Assay receipt schema registry

## Goal

Record Assay Harness `v0.3.1` as the compatibility release for the Assay
`v3.8.0` contract line.

This is a patch release because it adds release-truth, docs, CI compatibility
proof, and recipe safety hardening only. It does not add Harness CLI surface,
report semantics, Trust Basis semantics, or family-specific gate behavior.

## Compatibility Target

- Assay release line: `v3.8.0`
- Trust Basis diff schema: `assay.trust-basis.diff.v1`
- Trust Card schema: v5
- Trust Basis claim surface: 10 frozen claims
- Claim-visible receipt families: eval, decision, inventory

Harness does not validate Assay receipt payloads or JSON Schemas. The receipt
schema registry is owned by Assay; Harness consumes only Trust Basis artifacts
and the raw Trust Basis diff contract.

## Release Gate

Before tagging `v0.3.1`, run the manual `Harness CI` compatibility job with:

```text
assay_version = v3.8.0
```

The job must download the release binary, verify its checksum, and run:

- Promptfoo non-regression recipe: exit 0
- Promptfoo Trust Basis regression fixture recipe: exit 1
- OpenFeature non-regression recipe: exit 0
- OpenFeature Trust Basis regression fixture recipe: exit 1
- CycloneDX non-regression recipe: exit 0
- CycloneDX Trust Basis regression fixture recipe: exit 1

Each recipe output root must include:

- `trust-basis.diff.json`
- `trust-basis-summary.md`
- `junit-trust-basis.xml`

## Boundary

This release does not add Promptfoo, OpenFeature, CycloneDX, or Assay receipt
parsing to Harness.

It does not compare assertion values, flag decisions, model versions, dataset
refs, model cards, provider metadata, or domain-specific payloads.

Trust Basis recipe outputs remain raw diff JSON plus Markdown and JUnit
projections. They do not emit SARIF. Generic evidence export can still emit
SARIF for evidence findings.

## Distribution

For this line, Assay Harness is distributed as a GitHub release and repository
CLI. The `harness/package.json` version is release bookkeeping, not an npm
publication claim.

## Tagging

After the Assay `v3.8.0` release exists, this branch is merged, and the
compatibility workflow is green:

```bash
git tag v0.3.1
git push origin v0.3.1
```
