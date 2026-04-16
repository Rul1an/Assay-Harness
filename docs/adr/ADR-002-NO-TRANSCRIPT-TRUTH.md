# ADR-002: No transcript truth in canonical evidence

> **Status:** accepted
> **Date:** 2026-04-16

## Context

Agent runtimes produce rich output surfaces: history, newItems, sessions,
raw RunState, full MCP payloads, and more. It is tempting to capture all of
this as "evidence."

## Decision

Canonical harness evidence MUST NOT contain:

- Raw serialized RunState objects
- Full transcript / history arrays
- Full newItems arrays
- Session state objects
- lastResponseId / previousResponseId chains
- Full MCP protocol payloads
- Browser / UI state snapshots

Instead, evidence contains bounded artifacts:

- Policy decisions (allow/deny/require_approval per tool)
- Approval interruptions (tool_name, call_id, arguments_hash)
- Resume anchors (sha256 hash of serialized state, not the state itself)
- Process summaries (governance counters)

## Consequences

- Evidence files are small and reviewable
- No accidental PII or secret leakage from transcript dumps
- Assay does not inherit runtime semantics as truth
- Richer debugging requires separate observability tooling (OTel, etc.)
- "Observed is not verified" remains the core principle
