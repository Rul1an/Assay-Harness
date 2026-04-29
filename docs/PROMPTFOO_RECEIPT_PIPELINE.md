# Promptfoo Receipt Pipeline Recipe

Promptfoo makes AI behavior testable in CI. Assay turns selected outcomes into
portable, reviewable evidence receipts. Assay Harness gates and projects the
resulting Trust Basis diff.

This recipe is not a Promptfoo integration or partnership claim. It is a
copyable pipeline over existing Assay and Assay Harness contracts.

## Artifact Chain

```text
Promptfoo CLI JSONL
  -> assay evidence import promptfoo-jsonl
  -> Assay evidence bundle
  -> assay trust-basis generate
  -> Trust Basis JSON
  -> assay trust-basis diff
  -> assay.trust-basis.diff.v1
  -> assay-harness trust-basis report
```

For this recipe, the canonical outputs are the Trust Basis JSON files and raw
`assay.trust-basis.diff.v1` JSON. Markdown and JUnit are projections only.

On the post-P45b Assay Trust Basis surface, supported Promptfoo receipt bundles
can make `external_eval_receipt_boundary_visible` visible. Decision and
inventory receipt claims stay absent for this recipe unless those receipt
families are present in the Assay bundle.

## Run The Recipe

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-promptfoo-receipt-pipeline.sh \
    --case nonregression \
    --out-dir /tmp/assay-promptfoo-receipt-pipeline \
    --overwrite
```

For the Trust Basis regression fixture case:

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-promptfoo-receipt-pipeline.sh \
    --case trust-basis-regression-fixture \
    --out-dir /tmp/assay-promptfoo-receipt-boundary-regression \
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
  baseline.results.jsonl
  baseline.evidence.tar.gz
  baseline.verify.txt
  baseline.trust-basis.json
candidate/
  candidate.results.jsonl
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
Trust Basis fixture rather than a freshly imported Promptfoo JSONL path. This
keeps the regression example focused on Trust Basis boundary loss, not on
Promptfoo assertion failure semantics. In that case, `candidate.trust-basis.json`
comes from the fixture and `candidate.results.jsonl`,
`candidate.evidence.tar.gz`, and `candidate.verify.txt` are not produced.

That distinction is intentional: a failing Promptfoo assertion still produces
an external eval receipt, while a Trust Basis regression is about losing the
receipt boundary itself.

## Boundary

Assay Harness does not parse Promptfoo JSONL, inspect receipt payloads, or
decide whether an assertion outcome is true. Harness consumes the Trust Basis
diff contract that Assay emits and projects it for CI review without
reinterpreting its semantics.
