# Roadmap

> Last updated: 2026-04-28

## Unreleased on main

### OpenFeature decision receipt pipeline recipe
- `demo/run-openfeature-decision-receipt-pipeline.sh` shows OpenFeature EvaluationDetails JSONL -> Assay receipts -> Trust Basis -> Harness gate/report
- P42 stays boolean EvaluationDetails only and does not add a decision-specific Trust Basis claim
- Recipe preserves the same 0 clean, 1 Trust Basis regression, 2+ recipe/tool/input error split
- Harness still does not parse OpenFeature JSONL or decision receipt payloads

## Now (v0.2.0) — shipped

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

## Next — adoption polish

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
