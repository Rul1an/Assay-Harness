# Assay Compatibility

Assay Harness consumes Assay artifacts. It does not define receipt semantics,
Trust Basis claim semantics, or Trust Card schemas itself.

## Current Compatibility Target

Assay Harness `v0.3.1` targets the released Assay `v3.8.0` contract line.
Later Assay binaries are compatible when they still emit the same Trust Basis
diff schema v1, Trust Card schema v5, and 10-claim Trust Basis surface.

| Contract | Expected surface |
|---|---|
| Trust Basis diff | `assay.trust-basis.diff.v1` |
| Trust Card schema | `schema_version = 5` |
| Trust Basis claim count | 10 frozen claims |
| Receipt families visible in Trust Basis | eval, decision, inventory |
| Receipt schema registry | Assay-owned; Harness does not validate receipt payloads |

Use Assay `v3.8.0` as the minimum exact tag for this compatibility line.

## Release-Binary Proof

The `Harness CI` workflow has a manual `workflow_dispatch` compatibility job.
It downloads the selected Assay release binary, verifies its checksum, and runs
the Promptfoo, OpenFeature, and CycloneDX recipes against that binary.

The default dispatch input is:

```text
assay_version = v3.8.0
```

This job is the proof-before-release check for Harness `v0.3.1`. The release
gate passed in
[`Harness CI` run 25105149901](https://github.com/Rul1an/Assay-Harness/actions/runs/25105149901)
before the `v0.3.1` tag.

## Harness Boundary

Harness gate/report behavior is claim-family agnostic. Promptfoo, OpenFeature,
and CycloneDX recipes differ only by their input fixtures and Assay importer
commands.

Harness must not parse Promptfoo JSONL, OpenFeature JSONL, CycloneDX BOMs, or
Assay receipt payloads. It must not compare model versions, flag decisions,
dataset refs, assertion values, or domain-specific metadata. It only preserves,
gates, and projects the raw Assay Trust Basis diff contract.

## Distribution Boundary

For this line, Assay Harness is a GitHub release and repository CLI. The npm
package metadata is used for local Node tooling and release bookkeeping; it is
not a claim that the Harness CLI is published to npm.
