# ADR-003: MCP evidence must remain bounded

> **Status:** accepted
> **Date:** 2026-04-16

## Context

MCP (Model Context Protocol) defines tools, lifecycle, capability negotiation,
and authorization. The harness integrates MCP tools via the Agents SDK.

## Decision

MCP evidence artifacts capture only:

- `server_ref` — which MCP server
- `tool_name` — which tool
- `decision` — policy evaluation result
- `timestamp` — when
- `argument_hash` — content-addressed hash of arguments (optional)
- `approval_ref` — reference to approval event (optional)

MCP evidence MUST NOT contain:

- Full MCP request/response payloads
- Server state or capability negotiation details
- Transport-level details (stdio vs HTTP)
- Authorization tokens or credentials
- Full tool argument values

## Consequences

- MCP lane stays small and reviewable
- No protocol-complete import obligation
- Authorization transport details stay out of evidence
- Adding new MCP evidence fields requires golden test updates
