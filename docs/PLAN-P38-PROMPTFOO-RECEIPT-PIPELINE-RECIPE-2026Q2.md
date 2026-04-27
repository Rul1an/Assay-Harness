# P38 — Promptfoo Receipt Pipeline Recipe

Status: implemented in the P38 recipe slice
Target repo: `Rul1an/Assay-Harness`
Depends on: Assay P31-P34, Assay Harness P35-P37

## One-Line Goal

Document and then prove the first recipe-level pipeline where Promptfoo
assertion output is compiled by Assay into Trust Basis artifacts and gated by
Assay Harness without Harness parsing Promptfoo or reimplementing Assay
semantics.

P38 is a recipe over existing contracts, not a new semantic layer.

## Why This Is Next

P37 locked the cross-repo contract:

```text
Trust Basis JSON -> assay.trust-basis.diff.v1 -> Harness gate/report
```

That is the right bridge, but it starts from Trust Basis fixtures. The next
product-relevant step is to show the real recipe above that bridge:

```text
Promptfoo CLI JSONL
  -> assay evidence import promptfoo-jsonl
  -> Assay evidence receipt bundle
  -> assay trust-basis generate
  -> assay trust-basis diff
  -> assay-harness trust-basis gate/report
```

P38 should not add new semantics. It should make the existing compiler/gate
path understandable, reproducible, and safe to copy into CI.

The recipe should be read as an adoption path over already-merged command
contracts, not as a new supported Promptfoo integration surface or partnership
claim.

## Stack Boundary

Assay owns artifact semantics:

- Promptfoo JSONL parsing
- receipt reduction
- evidence bundle writing and verification
- Trust Basis generation
- Trust Basis diff semantics

Assay Harness owns pipeline semantics:

- invoking the already-defined Assay CLI surfaces
- preserving raw Assay outputs as artifacts
- mapping Assay diff exit codes to Harness gate outcomes
- projecting the Assay diff into job-summary and JUnit reports

P38 must not blur that line.

## Recommended Shape

P38 should land as a small recipe slice first, not a new generic orchestrator.
The recipe must write every generated artifact under one explicit output root.
It must not leak implicit working-directory artifacts, rely on absolute local
paths, or silently overwrite existing outputs unless an explicit overwrite flag
is supplied.

Suggested command flow:

```bash
ASSAY_BIN=${ASSAY_BIN:-assay}

$ASSAY_BIN evidence import promptfoo-jsonl \
  --input baseline.results.jsonl \
  --bundle-out baseline.evidence.tar.gz \
  --source-artifact-ref baseline.results.jsonl \
  --run-id promptfoo_baseline

$ASSAY_BIN trust-basis generate \
  baseline.evidence.tar.gz \
  --out baseline.trust-basis.json

$ASSAY_BIN evidence import promptfoo-jsonl \
  --input candidate.results.jsonl \
  --bundle-out candidate.evidence.tar.gz \
  --source-artifact-ref candidate.results.jsonl \
  --run-id promptfoo_candidate

$ASSAY_BIN trust-basis generate \
  candidate.evidence.tar.gz \
  --out candidate.trust-basis.json

assay-harness trust-basis gate \
  --baseline baseline.trust-basis.json \
  --candidate candidate.trust-basis.json \
  --out trust-basis.diff.json \
  --assay-bin "$ASSAY_BIN"

assay-harness trust-basis report \
  --diff trust-basis.diff.json \
  --summary-out trust-basis-summary.md \
  --junit-out junit-trust-basis.xml
```

This is intentionally plain shell. A later slice may wrap it, but the first
recipe should keep each artifact boundary visible.

## Canonical Artifact Chain

P38 should name the role of each file mechanically:

- `baseline.results.jsonl` / `candidate.results.jsonl` are external input
  artifacts produced by Promptfoo.
- `baseline.evidence.tar.gz` / `candidate.evidence.tar.gz` are Assay-compiled
  evidence bundles.
- `baseline.trust-basis.json` / `candidate.trust-basis.json` are canonical
  Trust Basis artifacts.
- `trust-basis.diff.json` is the canonical `assay.trust-basis.diff.v1`
  contract artifact.
- `trust-basis-summary.md` and `junit-trust-basis.xml` are projections only.

Canonical outputs are the Trust Basis artifacts and raw
`assay.trust-basis.diff.v1` JSON. Markdown and JUnit must never become the
source of truth for gate semantics.

## Deliverables

P38 implementation adds:

1. A small documented recipe for the Promptfoo receipt pipeline.
2. A runnable demo script under `demo/` or `harness/scripts/` that uses
   `ASSAY_BIN` and writes all intermediate artifacts to a caller-provided
   output directory.
3. Tests for the recipe script that use fixture inputs and verify that:
   - evidence bundles are created,
   - Trust Basis JSON files are created,
   - the raw `assay.trust-basis.diff.v1` JSON is preserved,
   - Markdown and JUnit projections are created,
   - regression exit mapping is preserved.
4. Both a non-regression fixture path and a regression fixture path.
5. Upload-ready raw diff and projection files that a workflow can preserve as
   artifacts when it runs the recipe with an Assay binary.

## Fixture Strategy

P38 should avoid duplicating broad Promptfoo fixture truth inside Harness.

Preferred split:

- Assay keeps raw Promptfoo JSONL discovery/receipt fixtures.
- Harness keeps only recipe-level examples needed to prove orchestration.
- If Harness needs raw JSONL files for a local demo, they must be tiny,
  deterministic, and described as recipe inputs, not canonical Promptfoo shape
  truth.

The source of truth remains the Assay importer contract and the resulting
Trust Basis/diff artifacts.

## CI/Posture Rules

P38 should follow these rules:

- raw `assay.trust-basis.diff.v1` JSON is the canonical CI artifact,
- Markdown and JUnit are projections only,
- artifact preservation and upload are CI workflow responsibility, not recipe
  command semantics,
- no synthetic SARIF locations,
- no Promptfoo-specific gate policy in Harness,
- no metadata-fail policy,
- no model correctness or eval truth claims,
- no prompt, output, expected, vars, token, cost, or provider payload import
  into Harness artifacts.

P38 recipe exit behavior should preserve the existing P35/P34 split:

- `0` means no Trust Basis regressions,
- `1` means Trust Basis regressions are present,
- `2+` means recipe, configuration, tool, input, or runtime error.

P38 must not redefine claim comparison, metadata policy, or regression
classification.

## Failure Modes To Keep Explicit

The recipe should fail clearly when:

- `ASSAY_BIN` is missing or not executable,
- the Assay binary cannot answer the required command/help surface,
- Promptfoo JSONL import fails closed in Assay,
- Assay evidence bundle verification fails,
- Trust Basis generation fails,
- Trust Basis diff output does not match `assay.trust-basis.diff.v1`,
- Harness cannot write report projections.

It should not fail merely because metadata-only Trust Basis drift is present.

## Acceptance Criteria

P38 is done when:

- a reviewer can run one documented command/script and see the full artifact
  chain,
- every intermediate artifact has a visible path and role,
- every generated artifact lives under an explicit output directory,
- both non-regression and regression fixture paths are covered,
- Harness never parses Promptfoo JSONL or receipt payloads,
- the final gate/report behavior is delegated to P35/P36,
- tests cover both non-regression and regression paths,
- the docs clearly say that this is a recipe over existing contracts, not a new
  semantic layer.

## Non-Goals

P38 does not add:

- SARIF output for Trust Basis diffs,
- a new Trust Basis claim,
- a new Assay receipt schema,
- a Promptfoo parser in Harness,
- a generic workflow engine,
- baseline storage policy,
- cross-run trend analysis,
- public marketing copy.

## Next After P38

If P38 lands cleanly, the next likely slice is a public-facing technical note:

> From Promptfoo JSONL to Evidence Receipts

That note should only ship after the recipe is runnable on `main`.
