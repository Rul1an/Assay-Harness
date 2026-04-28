# P44 — CycloneDX ML-BOM Model Receipt Pipeline Recipe

> **Status:** implemented in the P44 recipe slice
> **Target repo:** `Rul1an/Assay-Harness`
> **Depends on:** Assay P43, Assay Harness P35-P42

---

## One-Line Goal

Document and prove a Harness recipe where one selected CycloneDX ML-BOM
`machine-learning-model` component becomes an Assay inventory receipt bundle,
then flows through Trust Basis, diff, gate, and report without Harness parsing
CycloneDX or receipt payloads.

P44 is a recipe over existing contracts. It is not a new semantic layer, not a
CycloneDX integration claim, and not an inventory-drift policy.

## Why This Slice Exists

Promptfoo proved eval outcome receipts. OpenFeature proved runtime decision
receipts. CycloneDX ML-BOM adds a third family: model inventory and provenance
receipts.

That matters because CycloneDX ML-BOM surfaces can be rich: model cards,
datasets, dependency graphs, pedigree, licenses, vulnerabilities, performance
metrics, and governance notes may all appear near the model component boundary.
Assay P43 deliberately reduces only one selected `machine-learning-model`
component into one portable inventory receipt. P44 shows that this new receipt
family can use the same Harness gate/report stack without widening Harness
responsibility.

## Artifact Chain

```text
CycloneDX ML-BOM JSON
  -> assay evidence import cyclonedx-mlbom-model
  -> Assay model-component receipt bundle
  -> assay evidence verify
  -> assay trust-basis generate
  -> Trust Basis JSON
  -> assay trust-basis diff
  -> assay.trust-basis.diff.v1
  -> assay-harness trust-basis gate/report
```

For this recipe, the canonical outputs are the Trust Basis JSON files and the
raw `assay.trust-basis.diff.v1` JSON. Markdown and JUnit are projections only.

## Boundary

Assay owns CycloneDX parsing, selected component reduction, source artifact
digests, evidence bundles, Trust Basis generation, and diff semantics.

Assay Harness owns orchestration, gate exit mapping, artifact preservation
inside the explicit output root, and CI-friendly projections.

Harness must not:

- parse CycloneDX BOMs,
- inspect inventory receipt payloads,
- compare model versions,
- compare dataset refs,
- infer license, vulnerability, pedigree, safety, or compliance posture,
- dereference BOM refs or model-card refs,
- decide whether the model component is approved, safe, complete, or current.

P44 does not add an inventory-specific Trust Basis claim. It proves that
CycloneDX model-component receipts created by Assay are bundleable,
verifiable, Trust Basis-readable, and usable by the existing Harness
gate/report layer.

## Fixture Strategy

Harness fixtures are intentionally tiny recipe-level inputs. They are not the
canonical CycloneDX ML-BOM shape contract.

The non-regression path imports both baseline and candidate BOMs through Assay.
The candidate may change bounded model-component fields, such as version or
dataset refs, without becoming a Harness regression. P44 does not define
inventory-drift semantics.

The regression path is a Trust Basis fixture path. The candidate uses a
checked-in Trust Basis artifact that models a lost artifact boundary. This is
intentionally not a freshly imported CycloneDX path.

## Acceptance Criteria

P44 is done when:

- `demo/run-cyclonedx-mlbom-model-receipt-pipeline.sh` runs a non-regression
  path from BOM fixture to report projections.
- The recipe writes every generated file under one explicit `--out-dir`.
- The recipe refuses to overwrite a populated output root unless `--overwrite`
  is passed.
- The recipe preserves the existing exit split: `0` clean, `1` Trust Basis
  regression, `2+` recipe/tool/input/runtime error.
- Tests cover non-regression, Trust Basis regression fixture behavior, and
  output-root safety.
- Docs make clear that Harness never interprets CycloneDX, model-card,
  dataset, graph, or receipt semantics.

## Not In Scope

P44 does not add:

- a CycloneDX parser in Harness,
- model-version or dataset-ref drift policy,
- an inventory-specific Trust Basis claim,
- SARIF projection,
- model-card rendering,
- CycloneDX validation,
- graph, vulnerability, license, or pedigree interpretation,
- a CycloneDX partnership or integration claim.
