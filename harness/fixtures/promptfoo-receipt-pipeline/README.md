# Promptfoo Receipt Pipeline Fixtures

These are recipe-level inputs for P38. They are intentionally tiny and are not
the canonical Promptfoo shape contract.

- `baseline.results.jsonl` is a passing Promptfoo-style assertion row.
- `candidate-nonregression.results.jsonl` is a failing assertion row that still
  produces an Assay external eval receipt. This must not become a Trust Basis
  regression by itself.
- `candidate-trust-basis-regression-fixture.trust-basis.json` models the
  separate fixture-only case where the candidate Trust Basis has lost the
  external eval receipt boundary.

Assay owns Promptfoo JSONL parsing and receipt semantics. Harness uses these
files only to prove recipe orchestration and gate/report projection.
