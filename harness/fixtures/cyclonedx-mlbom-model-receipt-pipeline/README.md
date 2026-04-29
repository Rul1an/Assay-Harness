# CycloneDX ML-BOM Model Receipt Pipeline Fixtures

These are recipe-level inputs for P44. They are intentionally tiny and are not
the canonical CycloneDX ML-BOM shape contract.

- `baseline.cdx.json` is a CycloneDX BOM with one
  `machine-learning-model` component and bounded dataset/model-card refs.
- `candidate-nonregression.cdx.json` changes bounded inventory fields but
  still produces an Assay inventory receipt. This must not become a Trust
  Basis regression by itself.
- `candidate-trust-basis-regression-fixture.trust-basis.json` models the
  separate fixture-only case where the candidate Trust Basis has lost the
  external inventory receipt boundary.

Assay owns CycloneDX BOM parsing and receipt semantics. Harness uses these
files only to prove recipe orchestration and gate/report projection.

P44 stays model-component-only. These fixtures do not ask Harness to import or
interpret full model-card bodies, dataset bodies, dependency graphs,
vulnerabilities, licenses, pedigree, metrics, safety, or compliance posture.
