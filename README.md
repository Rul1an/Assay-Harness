# Assay Harness

**Catch agent regressions before they merge.**

Compare baseline evidence against candidate evidence in every PR.
New denials, hash mismatches, or policy changes surface as structured
regression output — reviewable by humans and consumable by CI.

> **Version:** 0.2.0 | **Status:** active development

---

## The PR Gate Flow

```
baseline evidence (main)     candidate evidence (PR branch)
        │                              │
        └──────────┬───────────────────┘
                   │
          assay-harness compare
                   │
         ┌─────────┴──────────┐
         │  Regression Report  │
         │  ─ new denials?     │
         │  ─ hash mismatches? │
         │  ─ counter deltas?  │
         └─────────────────────┘
                   │
           exit 0 (ok) or exit 6 (regression)
```

### Try it now (no API key needed)

```bash
cd harness && npm install

# Compare two evidence files
npx tsx src/cli.ts compare \
  --baseline ../fixtures/valid.assay.ndjson \
  --candidate ../fixtures/failure.assay.ndjson

# Output:
# # Evidence Comparison Report
# **Status:** REGRESSION DETECTED
# **Summary:** REGRESSION: 1 new denial(s), ...
```

### What triggers a regression?

| Signal | Meaning | Exit code |
|---|---|---|
| New denial | A tool that was allowed is now denied | 6 |
| New event type | Unknown evidence category appeared | 6 |
| Hash mismatch | Same event at same seq has different content | 6 |
| Increased denied count | More actions blocked than baseline | 6 |

Removed denials, approval changes, and counter decreases are reported
as **changes** but do not fail the gate.

---

## Quick Start

### 0. Manage baselines

```bash
# Store current evidence as baseline
npx tsx src/cli.ts baseline update --from ../fixtures/valid.assay.ndjson

# Inspect baseline
npx tsx src/cli.ts baseline show
# → [baseline] events: 4
# →   - example.placeholder.harness.approval-interruption
# →   - example.placeholder.harness.policy-decision
# →   - ...
```

### 1. Policy evaluation

The policy engine is deterministic: same tool name, same decision, every time.
No transcript, no model reasoning, no volatile state.

```bash
npx tsx src/cli.ts policy --tool read_file
# → { "decision": "allow", ... }

npx tsx src/cli.ts policy --tool write_file
# → { "decision": "require_approval", ... }

npx tsx src/cli.ts policy --tool network_egress
# → { "decision": "deny", ... }   (exit 1)
```

### 2. Map fixtures to Assay evidence

```bash
python3 mapper/map_to_assay.py \
  fixtures/valid.harness.json \
  --output /tmp/valid.assay.ndjson \
  --import-time 2026-04-16T12:00:00Z \
  --overwrite

# Malformed fixtures are rejected with canonical codes
python3 mapper/map_to_assay.py \
  fixtures/malformed.harness.json \
  --output /tmp/malformed.ndjson \
  --import-time 2026-04-16T12:10:00Z \
  --overwrite
# → [REJECT_RAW_STATE] rejected key 'raw_run_state'
```

### 3. Verify evidence contracts

```bash
npx tsx src/cli.ts verify ../fixtures/valid.assay.ndjson --category all
# Checks: envelope fields, SHA-256 hashes, type prefixes, rejected keys
```

### 4. Generate CI outputs

```bash
# JUnit XML (denied actions become <failure> elements)
python3 ci/emit_junit.py fixtures/valid.assay.ndjson --output results/junit.xml

# SARIF 2.1.0 (uploads to GitHub Security tab)
python3 ci/emit_sarif.py fixtures/valid.assay.ndjson --output results/sarif.json
```

### 5. Export to OTel (experimental)

```bash
python3 ci/emit_otel.py fixtures/valid.assay.ndjson --output results/otel-export.json
# Produces OTLP-shaped JSON for integration with Jaeger, Grafana Tempo, etc.
```

See [docs/contracts/OTEL_EXPORT.md](docs/contracts/OTEL_EXPORT.md) for mapping rules
and stability caveats.

### 6. Run the Promptfoo receipt pipeline recipe

Promptfoo can produce AI eval outputs in CI; Assay compiles selected outcomes
into evidence receipts and Trust Basis artifacts; Harness gates/reports the
resulting Trust Basis diff.

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-promptfoo-receipt-pipeline.sh \
    --case nonregression \
    --out-dir /tmp/assay-promptfoo-receipt-pipeline \
    --overwrite
```

See [docs/PROMPTFOO_RECEIPT_PIPELINE.md](docs/PROMPTFOO_RECEIPT_PIPELINE.md)
for the artifact chain and boundary rules.

### 7. Run the OpenFeature decision receipt pipeline recipe

OpenFeature can surface runtime flag evaluation details; Assay compiles one
bounded boolean `EvaluationDetails` input path into decision receipts and Trust
Basis artifacts; Harness gates/reports the resulting Trust Basis diff.

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-openfeature-decision-receipt-pipeline.sh \
    --case nonregression \
    --out-dir /tmp/assay-openfeature-decision-receipt-pipeline \
    --overwrite
```

See [docs/OPENFEATURE_DECISION_RECEIPT_PIPELINE.md](docs/OPENFEATURE_DECISION_RECEIPT_PIPELINE.md)
for the artifact chain and boundary rules.

### 8. Run the CycloneDX ML-BOM model receipt pipeline recipe

CycloneDX ML-BOM can describe AI/ML inventory surfaces; Assay compiles one
selected `machine-learning-model` component into inventory receipts and Trust
Basis artifacts; Harness gates/reports the resulting Trust Basis diff.

```bash
ASSAY_BIN=/path/to/assay \
  demo/run-cyclonedx-mlbom-model-receipt-pipeline.sh \
    --case nonregression \
    --out-dir /tmp/assay-cyclonedx-mlbom-model-receipt-pipeline \
    --overwrite
```

See [docs/CYCLONEDX_MLBOM_MODEL_RECEIPT_PIPELINE.md](docs/CYCLONEDX_MLBOM_MODEL_RECEIPT_PIPELINE.md)
for the artifact chain and boundary rules.

### 9. Run the harness (requires OPENAI_API_KEY)

```bash
cd harness
export OPENAI_API_KEY=sk-...
npx tsx src/cli.ts run \
  --input "List files in /tmp and write a summary to /tmp/summary.txt" \
  --auto-approve
```

---

## CI Integration

The GitHub Actions workflow runs 8 jobs on every push and PR:

| Job | What it checks |
|---|---|
| TypeScript Check | `tsc --noEmit` passes |
| Contract Validation | Mapper produces golden NDJSON, malformed input rejected |
| Golden Contract Tests | 24 tests: envelope, hashing, NDJSON format, rejection |
| Hardening Tests | 27 tests: resume safety, policy determinism, MCP boundaries |
| Policy Validation | allow/deny/require_approval decisions are correct |
| Verify Evidence | Evidence files pass all contract categories |
| **Regression Gate** | **Baseline vs candidate compare — blocks on regressions** |
| Evidence Export | JUnit + SARIF generated, artifacts uploaded |

Evidence artifacts and SARIF reports are uploaded on every run, including
failures. The SARIF report appears in the GitHub Security tab.

---

## Demo Scenarios

Four concrete scenarios in `fixtures/scenarios/` show the key product flows:

| Scenario | What it demonstrates |
|---|---|
| `clean-baseline` | No regressions — compare exits 0 |
| `new-approval` | PR introduces new `require_approval` tool |
| `deny-regression` | Policy change causes new denial |
| `policy-drift-resume` | Resume with different policy snapshot hash |

Run all scenarios locally:

```bash
bash demo/run-scenarios.sh
```

See [docs/SCENARIOS.md](docs/SCENARIOS.md) for details on each scenario.

---

## Regression Classes

The `compare` command detects these regression dimensions:

```
New denials          — tool went from allowed → denied
Removed denials      — tool went from denied → allowed (change, not regression)
New approvals        — tool now requires approval
Removed approvals    — tool no longer requires approval
Event count delta    — more or fewer evidence events
New event types      — unknown event type appeared
Removed event types  — event type disappeared
Hash mismatches      — same event position, different content hash
Process counter delta — approval/denial/resume counts changed
```

Example compare output (markdown format):

```markdown
# Evidence Comparison Report

**Status:** REGRESSION DETECTED
**Summary:** REGRESSION: 1 new denial(s), event count delta: +0, 1 hash mismatch(es), 2 process counter change(s)

## New Denials

- `network_egress` (policy: harness-default-policy@1.0)

## Hash Mismatches

- seq 0 (`example.placeholder.harness.approval-interruption`)
  - baseline: `sha256:a1b2c3...`
  - candidate: `sha256:d4e5f6...`

## Process Summary Delta

| Counter | Baseline | Candidate | Delta |
|---------|----------|-----------|-------|
| denied_action_count | 0 | 1 | +1 |
| total_tool_calls | 3 | 3 | +0 |
```

---

## Stable Exit Codes

Every CLI command uses stable exit codes — safe for CI scripting:

| Code | Name | Meaning |
|---|---|---|
| 0 | success | No failures or regressions |
| 1 | policy_violation | Tool call denied by policy |
| 2 | config_error | Missing file or bad configuration |
| 3 | artifact_contract | Evidence fails contract validation |
| 4 | mapper_failure | Mapper rejected input |
| 5 | resume_error | Resume flow failed |
| 6 | regression | Baseline comparison found regressions |
| 7 | ci_formatter | JUnit/SARIF generation failed |

See [docs/contracts/EXIT_CODES.md](docs/contracts/EXIT_CODES.md) for per-command behavior.

---

## Policy Model

```yaml
tools:
  allow:
    - read_file
    - list_directory
  deny:
    - network_egress
    - delete_file
  require_approval:
    - write_file
    - shell_exec
```

Evaluation order: **deny > require_approval > allow > default deny** (closed-by-default).

Policy uses only: tool name, tool category, target kind.
No transcript, model reasoning, or volatile state influences the decision.
See [ADR-001](docs/adr/ADR-001-DETERMINISTIC-POLICY.md).

---

## Evidence Boundaries

This harness explicitly does **not** claim:

- transcript truth
- session truth
- provider-chaining truth
- full RunState truth
- full MCP protocol truth

**Observed is not verified.** Runtime signals are evidence input, not
verification output. See [ADR-002](docs/adr/ADR-002-NO-TRANSCRIPT-TRUTH.md)
and [ADR-003](docs/adr/ADR-003-MCP-BOUNDED-EVIDENCE.md).

**`resume_state_ref` is an app-level fingerprint, not a portable wire hash.**
Per SDK guidance ([openai/openai-agents-js#1177](https://github.com/openai/openai-agents-js/issues/1177)),
`RunState.toString()` guarantees resumability via `fromString()` but does not
guarantee byte-stability across SDK versions. Consumers that need byte-stable
identity across SDK upgrades should derive their own anchor. See
[docs/FIELD_PRESENCE.md](docs/FIELD_PRESENCE.md) for the full seam documentation.

---

## Project Structure

```
Assay-Harness/
  harness/                    # TypeScript runtime
    src/
      cli.ts                  # CLI: run, verify, compare, policy
      policy.ts               # Deterministic policy engine
      harness.ts              # Pause/resume orchestrator
      evidence.ts             # CloudEvents envelopes + SHA-256 hashing
      compare.ts              # Baseline vs candidate regression detection
      agent.ts                # Agent definition + tools
      mcp.ts                  # MCP tool lane (bounded evidence)
    policy.yaml               # Default policy
  mapper/                     # Python evidence mapper
    map_to_assay.py           # Harness JSON → Assay NDJSON
  fixtures/                   # Test corpus
    valid.harness.json        # Approval interruption artifact
    failure.harness.json      # Partial failure artifact
    malformed.harness.json    # Rejected (raw state, bad pause_reason)
    valid.assay.ndjson        # Golden mapper output
    failure.assay.ndjson      # Golden mapper output
    valid.mcp.harness.json    # MCP interaction fixture
    scenarios/                # Demo scenario fixtures
      clean-baseline.*        # No-regression baseline
      new-approval.*          # New require_approval tool
      deny-regression.*       # Policy tightening
      policy-drift-resume.*   # Policy snapshot mismatch
  demo/
    run-scenarios.sh          # Run all demo scenarios locally
  tests/                      # Python test suites
    test_contracts.py         # 24 golden contract tests
    test_hardening.py         # 22 hardening tests
  ci/                         # CI output generators
    emit_junit.py             # Evidence → JUnit XML
    emit_sarif.py             # Evidence → SARIF 2.1.0
    emit_compare_junit.py     # Compare results → JUnit XML
    emit_compare_sarif.py     # Compare results → SARIF 2.1.0
    emit_otel.py              # Evidence → OTLP JSON (experimental)
  docs/
    contracts/                # Stable contracts
      EVIDENCE_ENVELOPE.md    # CloudEvents envelope spec
      EXIT_CODES.md           # CLI exit code contract
      REJECT_CODES.md         # Mapper rejection codes
      OTEL_EXPORT.md          # OTel export mapping (experimental)
    adr/                      # Architecture decisions
      ADR-001-*.md            # Deterministic policy
      ADR-002-*.md            # No transcript truth
      ADR-003-*.md            # MCP bounded evidence
    SCENARIOS.md              # Demo scenario documentation
    ROADMAP.md                # Now / next / later roadmap
  .github/workflows/
    harness-ci.yml            # 8-job CI pipeline (incl. regression gate)
    release.yml               # Tag-triggered release with attestations
    sbom.yml                  # Dependency submission on push to main
```

---

## Relationship to Assay

Companion project to [Assay](https://github.com/Rul1an/assay).
Follows Assay's evidence conventions, policy model, and artifact contract
patterns. The mapper produces Assay-shaped NDJSON consumable by Assay's
evidence tooling.

---

## License

MIT
