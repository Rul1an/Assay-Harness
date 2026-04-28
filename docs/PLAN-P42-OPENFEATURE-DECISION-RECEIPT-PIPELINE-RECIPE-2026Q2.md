# P42 — OpenFeature Decision Receipt Pipeline Recipe

> **Status:** implemented in the P42 recipe slice
> **Target repo:** `Rul1an/Assay-Harness`
> **Depends on:** Assay P41, Assay Harness P35-P38
> **Last Updated:** 2026-04-28

---

## One-Line Goal

Prove the second receipt-family pipeline: OpenFeature boolean
`EvaluationDetails` outcomes are compiled by Assay into decision receipt
bundles and then gated/reported by Assay Harness without Harness parsing
OpenFeature or reimplementing Assay semantics.

P42 is a recipe over existing contracts, not a new semantic layer.

## Why This Is Next

P38 showed the first visible recipe:

```text
Promptfoo JSONL -> eval outcome receipts -> Trust Basis -> Harness gate/report
```

P41 added the Assay-side importer for bounded OpenFeature boolean
`EvaluationDetails` receipts. The next useful proof is not another upstream
message; it is a second runnable recipe:

```text
OpenFeature EvaluationDetails JSONL
  -> assay evidence import openfeature-details
  -> Assay decision receipt bundle
  -> assay trust-basis generate
  -> assay trust-basis diff
  -> assay-harness trust-basis gate/report
```

That keeps the bigger thesis implicit but visible: selected eval outcomes and
selected runtime decisions can both become portable evidence units.

## Stack Boundary

Assay owns artifact semantics:

- OpenFeature JSONL ingestion
- boolean `EvaluationDetails` receipt reduction
- evidence bundle writing and verification
- Trust Basis generation
- Trust Basis diff semantics

Assay Harness owns pipeline semantics:

- invoking the already-defined Assay CLI surfaces
- preserving raw Assay outputs as artifacts
- mapping Assay diff outcomes to Harness gate results
- projecting the Assay diff into Markdown and JUnit reports

P42 must not blur that line.

## OpenFeature v1 Boundary

P42 follows the P41 importer boundary:

- boolean `EvaluationDetails` only
- `target_kind = feature_flag`
- `reason` is a bounded string, not an Assay-owned enum
- `error_code` may be present
- `variant` may be present

P42 does not import:

- `error_message`
- flag metadata
- provider metadata
- evaluation context
- targeting keys
- targeting rules
- user identifiers
- provider configuration
- non-boolean flag value families

This keeps the recipe on the smallest honest runtime decision surface.

## Recommended Shape

The recipe should stay plain shell and write every generated artifact under one
explicit output root. It should not silently overwrite outputs unless an
explicit overwrite flag is supplied.

Suggested command flow:

```bash
"${ASSAY_BIN:-assay}" evidence import openfeature-details \
  --input baseline.openfeature-details.jsonl \
  --bundle-out baseline.evidence.tar.gz \
  --source-artifact-ref baseline.openfeature-details.jsonl \
  --run-id openfeature_baseline

"${ASSAY_BIN:-assay}" evidence verify baseline.evidence.tar.gz

"${ASSAY_BIN:-assay}" trust-basis generate \
  baseline.evidence.tar.gz \
  --out baseline.trust-basis.json

"${ASSAY_BIN:-assay}" evidence import openfeature-details \
  --input candidate.openfeature-details.jsonl \
  --bundle-out candidate.evidence.tar.gz \
  --source-artifact-ref candidate.openfeature-details.jsonl \
  --run-id openfeature_candidate

"${ASSAY_BIN:-assay}" evidence verify candidate.evidence.tar.gz

"${ASSAY_BIN:-assay}" trust-basis generate \
  candidate.evidence.tar.gz \
  --out candidate.trust-basis.json

assay-harness trust-basis gate \
  --baseline baseline.trust-basis.json \
  --candidate candidate.trust-basis.json \
  --out trust-basis.diff.json \
  --assay-bin "${ASSAY_BIN:-assay}"

assay-harness trust-basis report \
  --diff trust-basis.diff.json \
  --summary-out trust-basis-summary.md \
  --junit-out junit-trust-basis.xml
```

## Canonical Artifact Chain

P42 names the role of each file mechanically:

- `baseline.openfeature-details.jsonl` and
  `candidate.openfeature-details.jsonl` are external input artifacts.
- `baseline.evidence.tar.gz` and `candidate.evidence.tar.gz` are
  Assay-compiled evidence bundles.
- `baseline.trust-basis.json` and `candidate.trust-basis.json` are canonical
  Trust Basis artifacts.
- `trust-basis.diff.json` is the canonical `assay.trust-basis.diff.v1`
  contract artifact.
- `trust-basis-summary.md` and `junit-trust-basis.xml` are projections only.

Canonical outputs are the Trust Basis artifacts and raw
`assay.trust-basis.diff.v1` JSON. Markdown and JUnit must never become the
source of truth for gate semantics.

## Deliverables

P42 implementation adds:

1. A small documented recipe for the OpenFeature decision receipt pipeline.
2. A runnable demo script under `demo/`.
3. Tiny recipe-level OpenFeature JSONL fixtures.
4. A Trust Basis regression fixture that proves gate/report behavior without
   adding a decision-specific Trust Basis claim.
5. Tests for non-regression, regression, and output-root overwrite safety.

## Fixture Strategy

Assay keeps the importer contract and any richer OpenFeature discovery truth.
Harness keeps only tiny recipe inputs needed to prove orchestration.

The non-regression case imports both baseline and candidate OpenFeature JSONL
through Assay. The regression case intentionally uses a checked-in candidate
Trust Basis fixture so that it remains about Trust Basis boundary loss, not
about OpenFeature flag value correctness.

## Non-Goals

P42 does not add:

- a new Trust Basis claim
- an OpenFeature parser in Harness
- OpenFeature provider support
- metadata import
- SARIF
- a public two-wedge note
- a new upstream OpenFeature message

## Acceptance Criteria

P42 is done when:

- a reviewer can run one documented command/script and see the full artifact
  chain,
- every intermediate artifact has a visible path and role,
- every generated artifact lives under an explicit output directory,
- the non-regression path imports real OpenFeature JSONL through Assay,
- the regression fixture path produces a blocking Trust Basis diff,
- Harness never parses OpenFeature JSONL or decision receipt payloads,
- tests cover non-regression, regression, and overwrite safety,
- docs clearly say this is a recipe over existing contracts, not a new semantic
  layer.
