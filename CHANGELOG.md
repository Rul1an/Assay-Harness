# Changelog

All notable changes to Assay Harness will be documented in this file.

## [Unreleased]

### OpenFeature Decision Receipt Pipeline Recipe

- **Runnable recipe**: `demo/run-openfeature-decision-receipt-pipeline.sh`
  shows the downstream path: OpenFeature boolean EvaluationDetails JSONL ->
  Assay decision receipts -> Trust Basis -> Harness gate/report.
- **Boundary discipline**: Harness does not parse OpenFeature JSONL, inspect
  decision receipt payloads, or decide whether flag evaluations are correct.
  P42 adds no decision-specific Trust Basis claim.

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
