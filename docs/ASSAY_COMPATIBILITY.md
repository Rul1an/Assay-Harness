# Assay Compatibility

Assay Harness consumes Assay artifacts. It does not define receipt semantics,
Trust Basis claim semantics, or Trust Card schemas itself.

## Current Compatibility Target

This Harness branch targets the post-P45b Assay Trust Basis surface on `main`,
after the decision receipt boundary claim landed and before the next Assay
release tag has been cut.

| Contract | Expected surface |
|---|---|
| Trust Basis diff | `assay.trust-basis.diff.v1` |
| Trust Card schema | `schema_version = 5` |
| Trust Basis claim count | 10 frozen claims |
| Receipt families visible in Trust Basis | eval, decision, inventory |

Release prep should replace the post-P45b wording with the exact minimum Assay
tag once that tag exists. Until then, use an Assay binary built from `main`
after P45b, or any later release candidate that emits the same schema v5 /
10-claim Trust Basis surface.

## Harness Boundary

Harness gate/report behavior is claim-family agnostic. Promptfoo, OpenFeature,
and CycloneDX recipes differ only by their input fixtures and Assay importer
commands.

Harness must not parse Promptfoo JSONL, OpenFeature JSONL, CycloneDX BOMs, or
Assay receipt payloads. It must not compare model versions, flag decisions,
dataset refs, assertion values, or domain-specific metadata. It only preserves,
gates, and projects the raw Assay Trust Basis diff contract.
