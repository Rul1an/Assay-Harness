# PLAN — P23 Approval-Aware Resumable Harness Evidence Lane (2026 Q2)

> **Status:** main-only in-progress
> **Version:** 0.1.0
> **Last Updated:** 2026-04-16

---

## Normative Framing

P23 v1 claims only bounded approval-interruption evidence, deterministic
policy decisions, and one resumable continuation anchor from the same paused
run. It does not claim transcript truth, session truth, provider-chaining
truth, full RunState truth, or protocol-complete runtime support.

---

## What This Is

A harness layer that sits above existing agent runtimes and lets Assay
govern:

- deterministic policy decisions (allow / deny / require_approval)
- approval-aware pauses with resumable continuation evidence
- bounded protocol evidence (tool calls, MCP interactions)
- CI-consumable review artifacts (JUnit XML, SARIF, evidence bundles)

## What This Is Not

- a new agent framework
- a transcript store
- an observability dashboard
- a full RunState importer
- a full-fidelity trace viewer

---

## MVP-1 Scope

### In Scope

1. One agent runtime adapter: OpenAI Agents SDK (Node.js)
2. One approval-required tool (`write_file`)
3. One pause/resume flow via interruptions + serialized state
4. One policy gate: allow / deny / require_approval
5. One evidence compiler producing Assay-shaped NDJSON
6. Output to: JSON evidence bundle, JUnit XML, SARIF
7. GitHub Actions PR gate

### Out of Scope

- sessions as lane-defining surface
- history as canonical artifact
- newItems as canonical artifact
- lastResponseId / previousResponseId chaining
- broad tracing import
- UI / dashboard
- multi-agent orchestration
- browser / state / snapshot truth

---

## Canonical Artifact Types

### 1. Approval Interruption Artifact

Purpose: record that a run paused for tool approval.

Required fields:
- `schema`
- `framework`
- `surface`
- `pause_reason` (must be `tool_approval`)
- `interruptions` (non-empty, ordered)
- `resume_state_ref` (Assay-derived, not raw SDK state)
- `timestamp`

Optional fields:
- `active_agent_ref`
- `metadata_ref`

Not included: raw serialized RunState, transcript history, full newItems.

### 2. Policy Decision Artifact

Required fields:
- `decision` (allow / deny / require_approval)
- `policy_id`
- `action_kind`
- `target_ref`
- `timestamp`

Optional fields:
- `rule_ref`
- `approval_required`
- `reason_code`
- `protocol_ref`

### 3. Denied Action Artifact

Required fields:
- `decision` (always `deny`)
- `action_kind`
- `target_ref`
- `timestamp`

### 4. Resumed Run Artifact

Required fields:
- `resume_state_ref`
- `resumed_at`
- `resume_decision_ref`

Optional fields:
- `result_ref`
- `active_agent_ref`

### 5. MCP Interaction Artifact (Phase 2)

Required fields:
- `server_ref`
- `tool_name`
- `decision`
- `timestamp`

Optional fields:
- `approval_ref`
- `call_id_ref`
- `argument_hash`

---

## Policy Model

### First Policy Set

```yaml
tools:
  allow:
    - read_file
    - list_directory
  deny:
    - network_egress
  require_approval:
    - write_file
    - shell_exec

mcp:
  allow:
    - "*.readonly"
  require_approval:
    - "*.mutating"
```

### Policy Properties

- deterministic
- versioned
- testable
- decoupled from runtime internals

### Policy Evaluation Input

Uses only: tool name, tool category, target kind, mutating vs readonly,
runtime surface.

Does not use: full transcript, model reasoning, volatile UI state.

---

## Event Flows

### Flow A — Allow

1. Agent requests tool call
2. Policy engine decides `allow`
3. Tool executes
4. Evidence compiler produces policy decision artifact

### Flow B — Require Approval

1. Agent requests sensitive tool call
2. Policy decides `require_approval`
3. Runtime returns interruptions + resumable state
4. Assay compiles approval interruption artifact
5. Reviewer approves or rejects
6. Harness resumes from same state
7. Assay compiles resumed run artifact

### Flow C — Deny

1. Agent requests tool call
2. Policy decides `deny`
3. Tool does not execute
4. Assay compiles denied action artifact

---

## Process Evidence Pack

Trajectory-level summary alongside per-event artifacts:

- `approval_count`
- `denied_action_count`
- `resume_count`
- `allowed_action_count`
- `policy_escalation_count`
- `total_tool_calls`

These are summary process metrics, not transcript truth.

---

## Fixture Corpus Design

### Valid

- One paused approval artifact with non-empty interruptions
- Bounded `resume_state_ref`
- Optional reviewer metadata

### Failure

- Valid paused approval artifact
- Missing optional reviewer fields
- No approve/reject outcome truth claim

### Malformed

- Missing interruptions
- Empty interruptions
- `pause_reason` != `tool_approval`
- Raw RunState inline
- Full history inline

---

## Implementation Phases

### Phase 0 — Scaffolding (this document)

### Phase 1 — Minimal runnable harness

One OpenAI Agents SDK agent, one approval-required tool, pause/resume
capture, policy engine.

### Phase 2 — Evidence reduction

Python mapper producing Assay-shaped NDJSON from harness captures.
Valid/failure/malformed corpus.

### Phase 3 — CI outputs

JUnit XML, SARIF, GitHub Actions workflow.

### Phase 4 — MCP lane

One MCP tool with policy gate and bounded evidence.

---

## Success Criteria

After MVP v1:

- one runnable approval-aware harness exists
- one live pause/resume flow is capture-backed
- policy gate works deterministically
- artifacts are reviewable and bounded
- JUnit/SARIF land in CI
- no broad transcript/session/state truth claim needed
