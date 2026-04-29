# CycloneDX ML-BOM Model Receipt Pipeline Recipe

CycloneDX ML-BOM can describe AI/ML inventory surfaces such as models,
datasets, dependencies, and provenance. Assay turns one selected
`machine-learning-model` component into a portable, reviewable inventory
receipt. Assay Harness gates and projects the resulting Trust Basis diff.

This first recipe is model-component-only. It uses one bounded
`components[]` entry selected by `type = "machine-learning-model"`.

This recipe is not a CycloneDX integration or partnership claim. It is a
copyable pipeline over existing Assay and Assay Harness contracts.

## Artifact Chain

```text
CycloneDX ML-BOM JSON
  -> assay evidence import cyclonedx-mlbom-model
  -> Assay evidence bundle
  -> assay evidence verify
  -> assay trust-basis generate
  -> Trust Basis JSON
  -> assay trust-basis diff
  -> assay.trust-basis.diff.v1
  -> assay-harness trust-basis report
```

For this recipe, the canonical outputs are the Trust Basis JSON files and raw
`assay.trust-basis.diff.v1` JSON. Markdown and JUnit are projections only.

On the released Assay v3.8.0-or-later Trust Basis surface, verified through
Assay v3.9.0, supported CycloneDX ML-BOM model receipt bundles can make
`external_inventory_receipt_boundary_visible` visible. Eval and decision receipt
claims stay absent for this recipe unless those receipt families are present in
the Assay bundle.

## Run The Recipe

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-cyclonedx-mlbom-model-receipt-pipeline.sh \
    --case nonregression \
    --out-dir /tmp/assay-cyclonedx-mlbom-model-receipt-pipeline \
    --overwrite
```

For the Trust Basis regression fixture case:

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-cyclonedx-mlbom-model-receipt-pipeline.sh \
    --case trust-basis-regression-fixture \
    --out-dir /tmp/assay-cyclonedx-mlbom-boundary-regression \
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
  baseline.cdx.json
  baseline.evidence.tar.gz
  baseline.verify.txt
  baseline.trust-basis.json
candidate/
  candidate.cdx.json
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
Trust Basis fixture rather than a freshly imported CycloneDX BOM path. This
keeps the regression example focused on Trust Basis artifact loss, not on
CycloneDX model inventory semantics. In that case, `candidate.trust-basis.json`
comes from the fixture and `candidate.cdx.json`, `candidate.evidence.tar.gz`,
and `candidate.verify.txt` are not produced.

This means the `nonregression` path is end-to-end, while the regression path is
intentionally a Trust Basis fixture path.

That distinction is intentional: a model version change, dataset-ref change,
or bounded model-card ref can still produce a CycloneDX inventory receipt. A
Trust Basis regression is about losing the artifact boundary itself.

## Boundary

P44 is one selected CycloneDX `machine-learning-model` component only. The BOM
input is handled by Assay's `cyclonedx-mlbom-model` importer. Harness does not
parse CycloneDX, inspect inventory receipt payloads, dereference refs, compare
model versions, or reason about dataset refs.

The recipe treats the selected CycloneDX model component as a bounded inventory
surface, not as model safety, license, vulnerability, dependency-graph,
dataset, model-card, or compliance truth.

Assay Harness consumes the Trust Basis diff contract that Assay emits and
projects it for CI review without reinterpreting its semantics.

P44 originally proved that CycloneDX model-component receipts created by Assay
were bundleable, verifiable, Trust Basis-readable, and usable by the existing
Harness gate/report layer. With the released Assay v3.8.0-or-later surface, the
same generic recipe can carry the inventory receipt boundary claim without
Harness learning CycloneDX semantics.
