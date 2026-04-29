# Changelog

All notable changes to Assay Harness will be documented in this file.

## [Unreleased]

## [0.3.0] - 2026-04-29

This companion release prepares Assay Harness for the Assay `v3.7.0`
three-family evidence-portability line.

### Three-Family Trust Basis Compatibility

- **Compatibility refresh**: Trust Basis fixtures, recipe regression fixtures,
  and recipe tests now target the prepared Assay `v3.7.0` surface:
  `assay.trust-basis.diff.v1`, Trust Card schema v5, 10 frozen claims, and the
  eval / decision / inventory receipt boundary claim families.
- **Claim-family agnostic gate/report path**: Promptfoo, OpenFeature, and
  CycloneDX recipes continue to use the same Harness Trust Basis gate/report
  layer. Harness does not add family-specific branching, report semantics, or
  gate semantics.
- **Recipe compatibility docs**: `docs/ASSAY_COMPATIBILITY.md` records the
  release-prep boundary and should be tightened to the exact Assay `v3.7.0` tag
  once that tag is cut.

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

- This is a companion Harness release, not an Assay release. Use it with an
  Assay binary from the prepared `v3.7.0` release line, or a later binary that
  emits the same Trust Basis diff schema v1 / Trust Card schema v5 / 10-claim
  surface.
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
