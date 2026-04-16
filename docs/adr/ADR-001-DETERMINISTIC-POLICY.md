# ADR-001: Policy evaluation must remain deterministic

> **Status:** accepted
> **Date:** 2026-04-16

## Context

The harness policy engine evaluates tool calls against allow/deny/require_approval
rules. The evaluation must be reproducible across runs, machines, and CI environments.

## Decision

Policy evaluation inputs are contractually limited to:

- tool name (string)
- tool category (derived from name pattern)
- target kind (tool_call or mcp_call)

Policy evaluation MUST NOT use:

- full transcript or conversation history
- model reasoning or chain-of-thought
- volatile UI or session state
- runtime environment variables (beyond policy file path)
- timestamps or wall-clock time
- random values

Evaluation order is fixed: **deny > require_approval > allow > default deny**.

## Consequences

- Same policy file + same tool name = same decision, always
- Policy changes are versioned and visible in diffs
- No "smart" policy that reads context — that is a feature, not a limitation
- Adding new evaluation inputs requires a new ADR and golden test updates
