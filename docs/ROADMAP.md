# Roadmap

> Last updated: 2026-05-26

## v0.6.0 — shipped

### Assay-Runner cross-runtime diff consumer + gate (Tier 3A + Tier 3C)
- Two new CLI verbs:
  `assay-harness runner cross-runtime report --diff <path>` (reviewer
  projection) and `assay-harness runner cross-runtime gate --diff <path>`
  (CI-blocking translation, exit 6 on added capability surface,
  3 on contract violation, 0 otherwise)
- Strict v0 clean-schema validation against
  `assay.runner.cross_runtime_diff.v0` produced upstream by
  `Rul1an/assay`. Harness is consumer-not-owner: the Runner side defines
  A1+B3+C1 canonicalisation, out-of-scope markers, and side-band SDK
  metadata semantics; Harness translates the regression signal into
  reviewer output and CI exit codes
- Tier 3B (archive-pair convenience wrapper that re-implements the
  Runner-side projector) remains deferred — would conflict with the
  consumer-not-owner stance

### Demo walkthrough + README pivot
- `docs/DEMO_RUNNER.md` end-to-end walkthrough covering all five
  Runner-aware verbs (`verify-runner`, `compare` in Runner-mode,
  `runner compare`, `runner cross-runtime report`, `runner cross-runtime
  gate`) with locally-generated synthetic fixtures
- `examples/runner/build-fixtures.mjs` generates `clean.tar.gz`,
  `regression.tar.gz`, `cross-runtime-diff-clean.json`, and
  `cross-runtime-diff-regression.json` on demand using the same in-file
  ustar+gzip writer pattern as the test suite
- README "Optional input: Assay-Runner measured-run archives" section
  rewritten with the five-verb table and a copy-pasted mini regression
  output block

## v0.5.0 — shipped

### Assay-Runner per-layer reviewer projection (Tier 2B)
- `assay-harness runner compare` extended with per-layer projection
  over `layers/kernel.ndjson`, `layers/policy.ndjson`, and
  `layers/sdk.ndjson` in each Runner archive
- Tier 2B is **explanatory only** — does not feed into the Tier 2A
  regression flag and adds no new gating semantics
- Per-layer summaries diff at the event-type histogram level. SDK layer
  additionally diffs distinct `tool` values (guaranteed by
  `assay.runner.sdk_event.v0`). SDK layer always carries the
  `self_reported_per_v0_contract` caveat
- `readRunnerArchiveFiles(filePath)` shared with Tier 1 so the
  size-limited gunzip + tar reader is not duplicated

## v0.4.0 — shipped

### Assay-Runner archive recognition + Tier 2A capability-surface diff
- Tier 1: `verify-runner` validates `.tar.gz` archives carrying an
  `assay.runner.archive_manifest.v0` manifest. Recognises archive
  shape, verifies the digest binding (`sha256:<64-hex>` per file),
  checks the `assay.runner.{capability_surface,observation_health,
  correlation_report}.v0` schema strings, and runs the honest-health
  gate against `ringbuf_drops`, `kernel_layer`, and
  `cgroup_correlation`
- Tier 2A: `compare` in Runner-mode diffs two archives' capability
  surfaces. Added entries on any of the five categories
  (`filesystem_paths`, `network_endpoints`, `process_execs`,
  `mcp_tools`, `policy_decisions`) trigger the regression signal;
  removed entries are reported but never blocking
- Prerequisite: both archives must pass Tier 1 (recognised, manifest
  valid, observation-health clean). If either side fails, Tier 2 is
  **not attempted** — the regression flag stays unset

## v0.3.2 — shipped

### Assay v3.8.0 minimum, v3.9.0 compatibility proof
- Harness docs target Assay `v3.8.0` as the minimum exact tag for the current compatibility line
- `Harness CI` includes a manual release-binary compatibility job with `assay_version` input, defaulting to the latest proved Assay tag, currently `v3.9.0`
- The compatibility job runs Promptfoo, OpenFeature, and CycloneDX recipes against a downloaded Assay release binary and uploads raw diff JSON, Markdown, and JUnit artifacts
- This is release-truth and CI hardening only: no new Harness report semantics, Trust Basis semantics, or family-specific gate logic
- The release gate passed in [`Harness CI` run 25105149901](https://github.com/Rul1an/Assay-Harness/actions/runs/25105149901)
- The post-Assay-`v3.9.0` compatibility proof passed in [`Harness CI` run 25131209377](https://github.com/Rul1an/Assay-Harness/actions/runs/25131209377)

## v0.3.1 — shipped

### Assay v3.8.0 proof-before-release
- `v0.3.1` introduced the release-binary compatibility workflow and proved the
  three-family recipes against Assay `v3.8.0` before tagging

## v0.3.0 — shipped

### Three-family Trust Basis compatibility refresh
- Harness recipes and fixtures target the released Assay v3.7.0 Trust Basis surface: `assay.trust-basis.diff.v1`, Trust Card schema v5, and 10 frozen claims
- Gate/report behavior remains claim-family agnostic across eval, decision, and inventory receipt boundary claims
- See [P46 plan](PLAN-P46-THREE-FAMILY-TRUST-BASIS-COMPATIBILITY-REFRESH-2026Q2.md) for the refresh boundary
- See [Assay compatibility](ASSAY_COMPATIBILITY.md) for the exact compatibility boundary

### CycloneDX ML-BOM model receipt pipeline recipe
- `demo/run-cyclonedx-mlbom-model-receipt-pipeline.sh` shows CycloneDX ML-BOM JSON -> Assay model-component receipts -> Trust Basis -> Harness gate/report
- P44 stays one selected `machine-learning-model` component only; Assay v3.7.0 can expose the inventory receipt boundary claim
- Recipe preserves the same 0 clean, 1 Trust Basis regression, 2+ recipe/tool/input error split
- Harness still does not parse CycloneDX BOMs or inventory receipt payloads

### OpenFeature decision receipt pipeline recipe
- `demo/run-openfeature-decision-receipt-pipeline.sh` shows OpenFeature EvaluationDetails JSONL -> Assay receipts -> Trust Basis -> Harness gate/report
- P42 stays boolean EvaluationDetails only; Assay v3.7.0 can expose the decision receipt boundary claim
- Recipe preserves the same 0 clean, 1 Trust Basis regression, 2+ recipe/tool/input error split
- Harness still does not parse OpenFeature JSONL or decision receipt payloads

## v0.2.0 — shipped

What's already built and working.

### Compare-driven PR gate
- Baseline vs candidate regression detection
- 9 regression classes (new denials, hash mismatches, etc.)
- Exit code 6 on regression, 0 on clean
- Regression Gate CI job with job summary

### Contract freeze
- 24 golden contract tests (envelope, hashing, NDJSON ordering, rejection)
- 27 hardening tests (resume safety, policy determinism, MCP boundaries)
- 14 canonical reject codes
- 8 stable exit codes

### Resume hardening
- policy_snapshot_hash binding
- resume_nonce for approval binding
- Exact-once resume guard
- sha256-only state refs

### CI-native outputs
- JUnit XML from evidence and compare results
- SARIF 2.1.0 with GitHub Security upload
- Compare SARIF with 4 rule IDs
- Job summaries in PRs

### Trust Basis gate bridge
- `assay-harness trust-basis gate` delegates to `assay trust-basis diff`
- `assay-harness trust-basis report` projects `assay.trust-basis.diff.v1`
- Contract fixtures prove Harness consumes real Assay diff artifacts
- Raw Assay diff JSON remains canonical; Markdown/JUnit are projections

### Promptfoo receipt pipeline recipe
- `demo/run-promptfoo-receipt-pipeline.sh` shows Promptfoo JSONL -> Assay receipts -> Trust Basis -> Harness gate/report
- All generated artifacts live under one explicit output root
- Recipe preserves the P35/P34 split: 0 clean, 1 Trust Basis regression, 2+ recipe/tool/input error
- Harness still does not parse Promptfoo JSONL or receipt payloads

### GitHub provenance
- Release workflow with artifact attestations
- SBOM generation
- Dependabot with grouping
- CODEOWNERS, issue templates, PR template

### Baseline lifecycle
- `baseline update` — store evidence as baseline with metadata
- `baseline show` — inspect current baseline (event types, counts)
- `baseline path` — print baseline path for scripting
- Validation on update (reject invalid evidence)

### Demo scenarios
- 4 concrete scenario fixtures (clean, new-approval, deny-regression, policy-drift)
- Runner script (`demo/run-scenarios.sh`) for local exploration
- Documented regression examples (`docs/SCENARIOS.md`)

### JUnit from compare
- One testcase per regression finding
- Stable testcase names per category
- Regression = failure, change = pass

### Experimental
- OTel OTLP JSON exporter (experimental, no stability guarantee)

## Next — v0.7 candidates

### Runner contract drift detection (closes #65)
- Real `.tar.gz` smoke fixture from `Rul1an/assay` PR #1377 (Slice 3
  rerun, source commit `ee343650`) under
  `harness/fixtures/runner/slice3-arm-c-kernel-event-v0.tar.gz`
- Smoke test runs `validateRunnerArchive` + `checkHonestHealth`
  against the real upstream archive — catches Runner-side contract
  drift that synthetic fixtures cannot catch by construction
  (schema bumps, manifest field renames, digest-prefix regressions,
  new required files)
- See [`harness/fixtures/runner/PROVENANCE.md`](../harness/fixtures/runner/PROVENANCE.md)
  for the source commit and refresh policy

### Assay compatibility-line bump to v3.12.0 — done
- Current target: Assay `v3.8.0` minimum / `v3.12.0` proof
- The `Harness CI` release-binary compatibility job passed against the
  `v3.12.0` binary in
  [run 26543125840](https://github.com/Rul1an/Assay-Harness/actions/runs/26543125840)
  on 2026-05-27
- [`ASSAY_COMPATIBILITY.md`](ASSAY_COMPATIBILITY.md) and the workflow
  default were updated to record `v3.12.0` as the latest proved
  compatibility binary

### Optional access_mode-aware kernel-layer projection (Tier 2B)
- `Rul1an/assay#1362` froze `assay.runner.kernel_event.v0` with
  optional open metadata (`access_mode`, `operation_flags`, `status`,
  `return_value`)
- Tier 2B currently keeps the conservative count + event_type
  histogram view. A `read`/`write`/`create`/`truncate`/`append`
  histogram is a reviewer-UX upgrade with no new gating semantics
- Tier 2A regression signal stays the source of truth; this is
  explanatory-only as Tier 2B always is

### CLI clarity
- Better error messages for new users
- Install/quickstart simplification
- Per-branch baseline management

### More CI systems
- GitLab CI example
- Generic CI template (non-GitHub)

## Later — ecosystem expansion

### More agent runtimes
- Adapter pattern for non-OpenAI agent frameworks
- Runtime-agnostic evidence interface

### Broader MCP scenarios
- Multi-server evidence
- Gateway/proxy pattern support
- Authorization propagation evidence

### OTel maturation
- Move experimental exporter to stable if OTel GenAI conventions stabilize
- Evaluation event mapping

### Schema versioning
- Evidence envelope versioning strategy
- Migration tooling for contract changes
- Backward compatibility guarantees

## Will not do

- Transcript storage
- LLM-as-judge in core gate
- Dashboard / UI
- Full RunState import
- Policy based on model reasoning or volatile state
- Vendor-specific tracing
