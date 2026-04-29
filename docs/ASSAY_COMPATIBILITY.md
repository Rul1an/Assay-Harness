# Assay Compatibility

Assay Harness consumes Assay artifacts. It does not define receipt semantics,
Trust Basis claim semantics, or Trust Card schemas itself.

## Current Compatibility Target

This Harness release-prep branch targets the prepared Assay `v3.7.0` Trust Basis
release line. Until the Assay tag is cut, the compatible source of truth is the
Assay release-prep PR for `v3.7.0` plus any later commit that emits the same
schema v5 / 10-claim Trust Basis surface.

| Contract | Expected surface |
|---|---|
| Trust Basis diff | `assay.trust-basis.diff.v1` |
| Trust Card schema | `schema_version = 5` |
| Trust Basis claim count | 10 frozen claims |
| Receipt families visible in Trust Basis | eval, decision, inventory |

Once Assay `v3.7.0` is tagged, this document should be tightened from
release-prep language to an exact minimum tag. Until then, use an Assay binary
built from the `v3.7.0` release-prep branch or any later release candidate that
emits the same schema v5 / 10-claim Trust Basis surface.

## Harness Boundary

Harness gate/report behavior is claim-family agnostic. Promptfoo, OpenFeature,
and CycloneDX recipes differ only by their input fixtures and Assay importer
commands.

Harness must not parse Promptfoo JSONL, OpenFeature JSONL, CycloneDX BOMs, or
Assay receipt payloads. It must not compare model versions, flag decisions,
dataset refs, assertion values, or domain-specific metadata. It only preserves,
gates, and projects the raw Assay Trust Basis diff contract.
