# Trust Basis Contract Fixtures

These fixtures lock the Assay to Assay Harness Trust Basis contract path:

```text
baseline/candidate Trust Basis JSON
  -> assay trust-basis diff --format json
  -> assay.trust-basis.diff.v1
  -> assay-harness trust-basis gate/report
```

## Source Of Truth

The canonical inputs are:

- `baseline.trust-basis.json`
- `candidate-nonregression.trust-basis.json`
- `candidate-regression.trust-basis.json`

The checked-in raw diff artifacts are generated from those inputs by Assay:

- `nonregression.trust-basis.diff.json`
- `regression.trust-basis.diff.json`

Markdown and JUnit outputs are derived projections only. The raw
`assay.trust-basis.diff.v1` JSON remains the contract artifact.

## Provenance

Generated with:

- Assay source: `Rul1an/assay`
- Assay commit: `1e225b0657f79873a704b9573eb602bb738d148f`
- Command surface: `assay trust-basis diff --format json`

## Regeneration

From this repo root:

```bash
ASSAY=/path/to/assay
$ASSAY trust-basis diff \
  harness/fixtures/trust-basis/baseline.trust-basis.json \
  harness/fixtures/trust-basis/candidate-nonregression.trust-basis.json \
  --format json \
  > harness/fixtures/trust-basis/nonregression.trust-basis.diff.json

$ASSAY trust-basis diff \
  harness/fixtures/trust-basis/baseline.trust-basis.json \
  harness/fixtures/trust-basis/candidate-regression.trust-basis.json \
  --format json \
  > harness/fixtures/trust-basis/regression.trust-basis.diff.json
```

The Harness test suite also includes an optional byte-for-byte regeneration
check. Set `ASSAY_BIN=/path/to/assay` before running `npm test`.

## Boundary

These fixtures do not introduce new Trust Basis semantics, Promptfoo parsing,
SARIF output, synthetic file/line anchors, or metadata-fail policy. They prove
that Harness consumes the current Assay diff contract without wrapping or
reinterpreting it.
