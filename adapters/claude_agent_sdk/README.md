# Tiny Claude Agent SDK Policy-Decision Adapter

A minimal external-consumer adapter around the Claude Agent SDK's
`can_use_tool` per-call policy gate. It produces one
`assay.harness.policy-decision.v1` artifact per callback invocation, in
the shape the Assay mapper already consumes.

This adapter is deliberately tiny. It exists to prove the per-call
policy seam carries the fields decision-v1 needs.

## What it does

1. Wraps a consumer-supplied `decide(tool_name, tool_input) -> (decision, reason)`
   function in a `can_use_tool`-shaped async callback.
2. On each invocation: hashes `tool_input`, requires the SDK-provided
   `tool_use_id`, builds the artifact, calls the consumer's `emit` function.
3. Returns the matching `PermissionResultAllow | PermissionResultDeny`
   to the SDK so the run continues.

No pause. No resume. No policy engine bundled. The adapter is
permission-callback-shaped, not runtime-shaped.

## Acceptance criteria (phase 4, landed here)

- [x] Wraps `can_use_tool` callback with decision-v1 emission.
- [x] `tool_use_id` treated as required on the `can_use_tool` path per
      anthropics/claude-agent-sdk-python#844; missing or blank values are
      malformed rather than silently synthesized.
- [x] `decision_reason` surfaced for deny cases via
      `PermissionResultDeny.message`.
- [x] `context.agent_id` surfaces as optional `active_agent_ref`.
- [x] Five fixtures in `fixtures/claude_agent_sdk/` (valid allow,
      failure deny-with-reason, three malformed), all verified against
      the mapper.
- [x] Pure-unit tests for hashing, `tool_use_id` validation, and artifact shape.
- [x] Runtime roundtrip tests that exercise the real SDK types and
      pipe output through the mapper. Skipped when SDK is absent.

## Hard non-goals

This adapter deliberately does NOT:

- own or compute `policy_snapshot_hash`; it is caller-supplied
- integrate with the Assay policy engine
- emit pause / resume / continuation-anchor fields (wrong family)
- handle PreToolUse / PostToolUse / Stop hooks
- model MCP tool permission flows
- model subagent hierarchies beyond surfacing `context.agent_id`
- read or interpret settings.json permission rules
- handle `ClaudeAgentOptions.permission_mode` (acceptEdits,
  bypassPermissions, etc.) beyond what passes through the callback
- interpret `PermissionResultAllow.updated_input` (future extension,
  not in decision-v1)
- claim that one callback defines a universal contract

## `tool_use_id` posture

`ToolPermissionContext.tool_use_id` is typed `str | None` in Python, but
Anthropic clarified in
[`anthropics/claude-agent-sdk-python#844`](https://github.com/anthropics/claude-agent-sdk-python/issues/844)
that it is always populated on the `can_use_tool` control path. The Optional
typing exists for dataclass field-ordering compatibility, not normal callback
behavior.

The adapter therefore treats missing, empty, or whitespace-only `tool_use_id`
as malformed. It does not synthesize placeholder audit ids in the normal
evidence path.

## Running

A throwaway venv lives at `probes/claude_agent_sdk/.venv`:

```bash
./probes/claude_agent_sdk/.venv/bin/python -m adapters.claude_agent_sdk.run \
    --output /tmp/decision.json

python3 mapper/map_to_assay.py /tmp/decision.json \
    --output /tmp/decision.ndjson
```

The entry point does NOT invoke the Claude Code CLI. It simulates one
callback invocation with a constructed `ToolPermissionContext`. That
is enough to exercise the adapter without external dependencies.

## Running tests

Pure-unit tests (no SDK needed):

```bash
python3 -m unittest adapters.claude_agent_sdk.tests.test_evidence -v
```

Runtime roundtrip tests (need SDK):

```bash
./probes/claude_agent_sdk/.venv/bin/python -m unittest \
    adapters.claude_agent_sdk.tests.test_roundtrip -v
```

## File layout

```
adapters/claude_agent_sdk/
  __init__.py
  README.md                  # this file
  agent.py                   # build_can_use_tool_callback
  evidence.py                # artifact builder, hashing, validation
  run.py                     # entry point (simulated invocation)
  tests/
    __init__.py
    test_evidence.py         # pure-unit
    test_roundtrip.py        # runtime (skipped w/o SDK)

fixtures/claude_agent_sdk/
  valid.decision.claude_agent_sdk.json
  failure.decision.claude_agent_sdk.json
  malformed_raw_arguments.claude_agent_sdk.json
  malformed_missing_decision.claude_agent_sdk.json
  malformed_bad_framework.claude_agent_sdk.json
```

## Related docs

- `docs/outreach/CLAUDE_AGENT_SDK_PLAN.md` — lane strategy.
- `docs/outreach/CLAUDE_AGENT_SDK_PREP.md` — seam and artifact shape.
- `docs/outreach/CLAUDE_AGENT_SDK_MAPPER_SMOKECHECK.md` — mapper-fit findings.
- `probes/claude_agent_sdk/FINDINGS.md` — probe results plus the later
  #844 upstream clarification on required `tool_use_id`.
