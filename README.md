# Assay Harness

**Approval-aware, resumable harness for long-running tool agents, with Assay
as policy and evidence governance layer.**

> **Status:** main-only in-progress (P23 MVP)
> **Version:** 0.1.0

---

## What This Is

A harness layer that sits above existing agent runtimes and lets Assay govern:

- **deterministic policy decisions** (allow / deny / require_approval)
- **approval-aware pauses** with resumable continuation evidence
- **bounded protocol evidence** (tool calls, MCP interactions)
- **CI-consumable review artifacts** (JUnit XML, SARIF, evidence bundles)

## What This Is Not

- a new agent framework
- a transcript store
- an observability dashboard
- a full RunState importer

---

## Quick Start

### Policy evaluation (no API key needed)

```bash
cd harness && npm install

# Check what the policy says about a tool
npx tsx src/cli.ts policy --tool read_file
# → { "decision": "allow", ... }

npx tsx src/cli.ts policy --tool write_file
# → { "decision": "require_approval", ... }

npx tsx src/cli.ts policy --tool network_egress
# → { "decision": "deny", ... }
```

### Map fixtures to Assay evidence

```bash
# Map valid harness artifact to Assay NDJSON
python3 mapper/map_to_assay.py \
  fixtures/valid.harness.json \
  --output /tmp/valid.assay.ndjson \
  --import-time 2026-04-16T12:00:00Z \
  --overwrite

# Malformed fixture is correctly rejected
python3 mapper/map_to_assay.py \
  fixtures/malformed.harness.json \
  --output /tmp/malformed.ndjson \
  --import-time 2026-04-16T12:10:00Z \
  --overwrite
# → exits with error: rejected key 'raw_run_state'
```

### Generate CI outputs

```bash
# JUnit XML
python3 ci/emit_junit.py fixtures/valid.assay.ndjson --output results/junit.xml

# SARIF
python3 ci/emit_sarif.py fixtures/valid.assay.ndjson --output results/sarif.json
```

### Run the harness (requires OPENAI_API_KEY)

```bash
cd harness
export OPENAI_API_KEY=sk-...
npx tsx src/cli.ts run \
  --input "List files in /tmp and write a summary to /tmp/summary.txt" \
  --auto-approve
```

---

## Project Structure

```
Assay-Harness/
  docs/
    PLAN-P23-...md          # Design document and artifact contracts
  harness/                  # TypeScript — the runtime
    src/
      agent.ts              # Agent definition + tools
      policy.ts             # Deterministic policy engine
      harness.ts            # Pause/resume orchestrator
      evidence.ts           # Evidence capture + CloudEvents envelopes
      mcp.ts                # MCP tool lane
      cli.ts                # CLI entry point
    policy.yaml             # Default policy (allow/deny/require_approval)
  mapper/                   # Python — Assay evidence reduction
    map_to_assay.py         # Follows Assay example conventions
  fixtures/                 # Corpus
    valid.harness.json      # Paused approval artifact
    failure.harness.json    # Partial failure artifact
    malformed.harness.json  # Rejected (raw state, bad pause_reason)
    valid.assay.ndjson      # Mapped Assay evidence
    failure.assay.ndjson    # Mapped Assay evidence
    valid.mcp.harness.json  # MCP interaction fixture
  ci/                       # CI output generators
    emit_junit.py           # JUnit XML from evidence NDJSON
    emit_sarif.py           # SARIF 2.1.0 from evidence NDJSON
  .github/workflows/
    harness-ci.yml          # Contract validation + evidence export
```

---

## Policy Model

The policy engine evaluates tool calls deterministically:

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

Evaluation order: **deny > require_approval > allow > default deny**.

Policy uses only: tool name, tool category, target kind. No transcript,
model reasoning, or volatile state.

---

## Canonical Artifact Types

| Artifact | Purpose |
|---|---|
| Approval Interruption | Run paused for tool approval |
| Policy Decision | Deterministic allow/deny/require_approval |
| Denied Action | Runtime intent blocked by policy |
| Resumed Run | Same paused state was resumed |
| MCP Interaction | Bounded MCP tool call evidence |
| Process Summary | Trajectory-level governance counters |

All artifacts follow Assay conventions: CloudEvents envelope,
content-addressed hashing (SHA-256), NDJSON output.

---

## Evidence Boundaries

This harness explicitly does NOT claim:

- transcript truth
- session truth
- provider-chaining truth
- full RunState truth
- full MCP protocol truth

**Observed is not verified.** Runtime signals are evidence input, not
verification output.

---

## Relationship to Assay

This is a companion project to [Assay](https://github.com/Rul1an/assay).
It follows Assay's evidence conventions, policy model, and artifact
contract patterns. The mapper produces Assay-shaped NDJSON that can be
consumed by Assay's evidence tooling.

---

## License

MIT
