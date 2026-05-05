# Changelog

All notable changes to Assay Harness will be documented in this file.

## [Unreleased]

### Claude Agent SDK Adapter

- Tightened the Claude Agent SDK `can_use_tool` adapter after
  [`anthropics/claude-agent-sdk-python#844`](https://github.com/anthropics/claude-agent-sdk-python/issues/844):
  `tool_use_id` is now treated as required on that path, and missing or blank
  values are rejected instead of replaced with a placeholder audit id.

## [0.3.2] - 2026-04-29

This patch release records the post-Assay-`v3.9.0` compatibility proof for the
existing Assay Harness `v0.3.x` line.

### Compatibility

- Verified the existing `v0.3.1` three-family Trust Basis recipes against the
  released Assay `v3.9.0` binary in
  [`Harness CI` run 25131209377](https://github.com/Rul1an/Assay-Harness/actions/runs/25131209377).
- Updated the manual release-binary compatibility workflow default to
  `assay_version = v3.9.0`. Assay `v3.8.0` remains the minimum exact tag for
  this compatibility line.

## [0.3.1] - 2026-04-29

This compatibility release aligns Assay Harness with the Assay `v3.8.0`
release-contract line.

### Release Compatibility

- **Assay compatibility target**: docs now require Assay `>= v3.8.0` for this
  line. Harness still consumes `assay.trust-basis.diff.v1`, Trust Card schema
  v5, and the 10-claim eval / decision / inventory Trust Basis surface.
- **Real release-binary proof rail**: `Harness CI` now has a
  `workflow_dispatch` compatibility job that downloads a chosen Assay release
  binary, verifies its checksum, and runs the Promptfoo, OpenFeature, and
  CycloneDX recipes against it. At the time of the `v0.3.1` release, the
  default target was `v3.8.0`.
- **Recipe artifact preservation**: the compatibility job uploads recipe output
  roots containing raw Trust Basis diff JSON, Markdown summaries, and JUnit XML.

### Hygiene

- Promptfoo recipe output-root safety now matches the OpenFeature and CycloneDX
  recipes by refusing root, repo, harness, and home directory overwrite targets.
- README wording now separates generic evidence SARIF export from Trust Basis
  gate/report outputs. Trust Basis gate/report emits raw diff JSON, Markdown,
  and JUnit, not SARIF.
- Release docs explicitly keep this as a GitHub release / repository CLI line,
  not an npm publication claim.

## [0.3.0] - 2026-04-29

This companion release aligns Assay Harness with the released Assay `v3.7.0`
three-family evidence-portability line.

### Three-Family Trust Basis Compatibility

- **Compatibility refresh**: Trust Basis fixtures, recipe regression fixtures,
  and recipe tests target the released Assay `v3.7.0` surface:
  `assay.trust-basis.diff.v1`, Trust Card schema v5, 10 frozen claims, and the
  eval / decision / inventory receipt boundary claim families.
- **Claim-family agnostic gate/report path**: Promptfoo, OpenFeature, and
  CycloneDX recipes continue to use the same Harness Trust Basis gate/report
  layer. Harness does not add family-specific branching, report semantics, or
  gate semantics.
- **Recipe compatibility docs**: `docs/ASSAY_COMPATIBILITY.md` records Assay
  `v3.7.0` as the exact compatibility target for this release.

### Receipt Pipeline Recipes

- **Promptfoo**: recipe fixtures regress
  `external_eval_receipt_boundary_visible` for Trust Basis regression examples.
- **OpenFeature**: the decision receipt pipeline remains boolean
  `EvaluationDetails` only and now aligns with the decision receipt boundary
  claim.
- **CycloneDX ML-BOM**: the model-component receipt pipeline remains one
  selected `machine-learning-model` component only and now aligns with the
  inventory receipt boundary claim.

### Notes for Users

- This is a companion Harness release, not an Assay release. Use it with Assay
  `v3.7.0`, or a later binary that emits the same Trust Basis diff schema v1 /
  Trust Card schema v5 / 10-claim surface.
- This is not Promptfoo, OpenFeature, or CycloneDX integration or partnership
  support. These are copyable downstream recipes over existing Assay and Assay
  Harness contracts.

## [0.2.0] - 2026-04-27

This companion release makes the Trust Basis gate/report bridge and Promptfoo
receipt pipeline recipe release-ready above the Assay v3.6.0 evidence
portability line.

### Trust Basis CI Gate

- **Trust Basis regression gate**: `assay-harness trust-basis gate` delegates to
  `assay trust-basis diff --format json --fail-on-regression`, persists the raw
  `assay.trust-basis.diff.v1` artifact, and maps outcomes for CI without
  reimplementing Trust Basis semantics.
- **Trust Basis reporters**: `assay-harness trust-basis report` reads strict
  `assay.trust-basis.diff.v1` input and emits Markdown job-summary and minimal
  JUnit projections. The raw Assay diff JSON remains canonical; projections are
  views only.
- **Contract fixture bridge**: checked-in Trust Basis fixtures and raw Assay diff
  artifacts prove Harness consumes real Assay output rather than parallel local
  fixture semantics.

### Promptfoo Receipt Pipeline Recipe

- **Runnable recipe**: `demo/run-promptfoo-receipt-pipeline.sh` shows the full
  downstream path: Promptfoo CLI JSONL -> Assay receipts -> Trust Basis ->
  Harness gate/report.
- **Boundary discipline**: Harness still does not parse Promptfoo JSONL, inspect
  receipt payloads, or decide whether eval outcomes are true. Promptfoo remains
  the CI/eval runner; Assay owns artifact semantics; Harness owns CI
  orchestration and review projection.

### Notes for Users

- This release is a companion Harness release, not an Assay release. Use it with
  an Assay binary that includes `assay evidence import promptfoo-jsonl` and
  `assay trust-basis diff`.
- This is not a Promptfoo integration or partnership claim. It is a copyable
  downstream recipe over existing Assay and Assay Harness contracts.
