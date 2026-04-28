# OpenFeature Decision Receipt Pipeline Recipe

OpenFeature can surface application-facing flag evaluation details at runtime.
Assay turns selected boolean `EvaluationDetails` outcomes into portable,
reviewable decision receipts. Assay Harness gates and projects the resulting
Trust Basis diff.

This first recipe is boolean-only and uses one bounded
`EvaluationDetails<boolean>` input path.

This recipe is not an OpenFeature integration or partnership claim. It is a
copyable pipeline over existing Assay and Assay Harness contracts.

## Artifact Chain

```text
OpenFeature EvaluationDetails JSONL
  -> assay evidence import openfeature-details
  -> Assay evidence bundle
  -> assay trust-basis generate
  -> Trust Basis JSON
  -> assay trust-basis diff
  -> assay.trust-basis.diff.v1
  -> assay-harness trust-basis report
```

For this recipe, the canonical outputs are the Trust Basis JSON files and raw
`assay.trust-basis.diff.v1` JSON. Markdown and JUnit are projections only.

## Run The Recipe

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-openfeature-decision-receipt-pipeline.sh \
    --case nonregression \
    --out-dir /tmp/assay-openfeature-decision-receipt-pipeline \
    --overwrite
```

For the Trust Basis regression fixture case:

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-openfeature-decision-receipt-pipeline.sh \
    --case trust-basis-regression-fixture \
    --out-dir /tmp/assay-openfeature-decision-boundary-regression \
    --overwrite
```

Exit codes:

- `0`: no Trust Basis regressions
- `1`: Trust Basis regressions are present
- `2+`: recipe, configuration, tool, input, or runtime error

The recipe preserves the existing gate-vs-error split from the underlying
Assay and Assay Harness commands.

## Output Layout

All generated files live under the explicit `--out-dir`:

```text
baseline/
  baseline.openfeature-details.jsonl
  baseline.evidence.tar.gz
  baseline.verify.txt
  baseline.trust-basis.json
candidate/
  candidate.openfeature-details.jsonl
  candidate.evidence.tar.gz
  candidate.verify.txt
  candidate.trust-basis.json
reports/
  trust-basis-gate.stdout.txt
  trust-basis-gate.stderr.txt
  trust-basis-report.stdout.txt
  trust-basis-report.stderr.txt
trust-basis.diff.json
trust-basis-summary.md
junit-trust-basis.xml
```

In the `trust-basis-regression-fixture` case, the candidate uses a checked-in
Trust Basis fixture rather than a freshly imported OpenFeature JSONL path. This
keeps the regression example focused on Trust Basis artifact loss, not on
OpenFeature flag decision semantics. In that case,
`candidate.trust-basis.json` comes from the fixture and
`candidate.openfeature-details.jsonl`, `candidate.evidence.tar.gz`, and
`candidate.verify.txt` are not produced.

This means the `nonregression` path is end-to-end, while the regression path is
intentionally a Trust Basis fixture path.

That distinction is intentional: a false flag value, fallback, or bounded
`error_code` can still produce an OpenFeature decision receipt. A Trust Basis
regression is about losing the artifact boundary itself.

## Boundary

P42 is boolean `EvaluationDetails` only. The input rows must already be bounded
for Assay's `openfeature-details` importer. They do not include provider
configuration, evaluation context, targeting keys, rules, user identifiers,
flag metadata, provider metadata, or `error_message`. For v1, `error_message`
is discovery-only and never part of the canonical receipt path.

The recipe treats OpenFeature `EvaluationDetails` as a bounded decision
surface, not as application, provider, or targeting truth.

Assay Harness does not parse OpenFeature JSONL, inspect decision receipt
payloads, or decide whether a flag evaluation was correct. Harness consumes the
Trust Basis diff contract that Assay emits and projects it for CI review
without reinterpreting its semantics.

P42 does not add a decision-specific Trust Basis claim. It proves that
OpenFeature decision receipts created by Assay are bundleable, verifiable,
Trust Basis-readable, and usable by the existing Harness gate/report layer.
