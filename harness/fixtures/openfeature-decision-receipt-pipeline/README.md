# OpenFeature Decision Receipt Pipeline Fixtures

These are recipe-level inputs for P42. They are intentionally tiny and are not
the canonical OpenFeature shape contract.

- `baseline.openfeature-details.jsonl` is a bounded boolean EvaluationDetails
  row with a true value.
- `candidate-nonregression.openfeature-details.jsonl` is a bounded boolean
  EvaluationDetails row with a fallback/error result that still produces an
  Assay decision receipt. This must not become a Trust Basis regression by
  itself.
- `candidate-trust-basis-regression-fixture.trust-basis.json` models the
  separate fixture-only case where the candidate Trust Basis has lost the
  external decision receipt boundary.

Assay owns OpenFeature JSONL parsing and receipt semantics. Harness uses these
files only to prove recipe orchestration and gate/report projection.

P42 stays boolean-only. These fixtures do not carry flag metadata, provider
metadata, evaluation context, targeting keys, rules, user identifiers, or
`error_message`.
