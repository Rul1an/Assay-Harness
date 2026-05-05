# Claude Agent SDK Outreach Prep (internal)

> Prep card for phase 1 of the lane scoped in
> [`CLAUDE_AGENT_SDK_PLAN.md`](./CLAUDE_AGENT_SDK_PLAN.md). No code in
> this file. Hard review gate before smoke-check, probe, or adapter.

## Target

- Repo: [`anthropics/claude-agent-sdk-python`](https://github.com/anthropics/claude-agent-sdk-python)
- Language: Python
- Channel: Issues only (Discussions disabled)
- Maintainer feedback loop: commit-driven, not prose-driven
- Star count at check time: ~6.4k

Why the Python repo and not the TypeScript one: higher star count,
larger issue volume, more visible maintainer activity per the plan's
grounding findings. The TS repo is a potential second lane later, not
the first move.

## Seam

**`can_use_tool` callback on `ClaudeAgentOptions`.** Per-call policy
gate invoked before a tool executes. Returns
`PermissionResultAllow | PermissionResultDeny`, with an optional
`reason`, and receives the tool name, input, and (since resolved issue
[#376](https://github.com/anthropics/claude-agent-sdk-python/issues/376))
the `tool_use_id`.

This is **not** a pause seam. It is a synchronous permission check. The
adapter emits one evidence artifact per callback invocation.

### Why this seam and not another

- **Not** `PreToolUse` hooks. Active friction around those
  ([#816](https://github.com/anthropics/claude-agent-sdk-python/issues/816),
  [#381](https://github.com/anthropics/claude-agent-sdk-python/issues/381)),
  and they are a Claude Code setting integration rather than an SDK
  primitive for external consumers.
- **Not** MCP tool permission flow. Separate subsystem, larger surface,
  historically buggy ([#320](https://github.com/anthropics/claude-agent-sdk-python/issues/320),
  [#448](https://github.com/anthropics/claude-agent-sdk-python/issues/448)).
- **Not** `AskUserQuestion` ([#327](https://github.com/anthropics/claude-agent-sdk-python/issues/327)).
  UX-shaped, not a governance seam.
- **Not** settings.json permission rules. CLI/filesystem-bound, not
  SDK-callable.

`can_use_tool` is the smallest stable, SDK-native, external-consumer
governance seam.

## Artifact shape

New top-level schema **`assay.harness.policy-decision.v1`**, parallel
to the existing `assay.harness.approval-interruption.v1` but for the
per-call-decision family rather than the pause family.

```jsonc
{
  "schema": "assay.harness.policy-decision.v1",
  "framework": "claude_agent_sdk",
  "surface": "per_call_permission",
  "decision": "allow",
  "tool_name": "Bash",
  "tool_use_id": "toolu_01...",
  "arguments_hash": "sha256:...",
  "decision_reason": "optional bounded string",
  "policy_snapshot_hash": "sha256:...",
  "timestamp": "2026-04-18T10:00:00Z",
  "active_agent_ref": "optional, informational only"
}
```

Notes:

- **One decision, one artifact, one event.** No interruptions array, no
  continuation anchor. That is the whole point of splitting this from
  pause-v1.
- **Raw tool input never enters the artifact.** Hash only, identical
  rule to pause-v1.
- **`tool_use_id` is the SDK's own id.** No adapter-side correlation
  step, unlike the Deep Agents lane. The SDK already carries it in the
  callback signature.
- **`decision` is strictly `allow | deny`.** No `require_approval`.
  That value only exists on our policy engine side; here the callback
  has already resolved the decision.
- **`decision_reason` is optional and bounded.** If present, stored as a
  non-empty string. If absent, omitted. Mirrors how `rule_ref` behaves
  in the existing policy-decision envelope.
- **`policy_snapshot_hash`** is harness-side, same semantics as the
  other lanes. The adapter accepts it as input, it does not compute it.

### Framework constant choice

Candidates: `claude_agent_sdk`, `anthropic_claude_agent_sdk`,
`claude_code_sdk`. Pick **`claude_agent_sdk`** because the package name
is `claude_agent_sdk`, the repo is `claude-agent-sdk-python`, and the
short form is unambiguous now that the Claude Code SDK rename has
landed.

## Non-goals (hard, repeated verbatim in README)

The adapter explicitly does not claim:

- transcript or conversation-history truth
- full `ClaudeAgentOptions` state truth
- hook system truth (`PreToolUse`, `PostToolUse`, `Stop`, etc.)
- MCP tool approval flow truth
- subagent-hierarchy truth (we do not model `parent_tool_use_id` chains)
- settings.json permission rules truth
- CLI `permission_mode` semantics (acceptEdits, bypassPermissions, etc.)
- long-running approval patterns
- AskUserQuestion or user-facing UX patterns
- any claim that one local callback invocation defines a universal
  contract

## Malformed rules (fixture boundary)

A policy-decision-v1 artifact is malformed when:

- `framework` is missing or not `claude_agent_sdk`
- `surface` is missing or not `per_call_permission`
- `decision` is missing or not one of `allow | deny`
- `tool_name`, `tool_use_id`, `arguments_hash`, or `timestamp` missing
- `arguments_hash` is not a valid `sha256:` reference (raw args
  sneaking in would fail here)
- `tool_use_id` is not a non-empty string
- `policy_snapshot_hash` is present but not a valid `sha256:` reference
- `decision_reason` is present but empty or non-string

These map onto existing mapper validators and do not require a new
regression class.

## Community anchor URLs

Use these for context in any internal documentation; cite only those
that are directly relevant when writing a post later. Do **not**
ground the first post on any of these as "the seam is unclear."

- [#376](https://github.com/anthropics/claude-agent-sdk-python/issues/376) closed — `tool_use_id` exposure on `can_use_tool`, the pattern that removes our Deep Agents correlation friction on this lane.
- [#844](https://github.com/anthropics/claude-agent-sdk-python/issues/844) closed — `tool_use_id` is required on the `can_use_tool` path; the Python Optional typing is compatibility-only.
- [#816](https://github.com/anthropics/claude-agent-sdk-python/issues/816) open — `permissionDecisionReason` not forwarded.
- [#381](https://github.com/anthropics/claude-agent-sdk-python/issues/381) open — `updatedInput` in `PreToolUse` without decision.
- [#469](https://github.com/anthropics/claude-agent-sdk-python/issues/469) open — control-protocol mismatch.

## File layout (proposed, phase 4)

```
adapters/claude_agent_sdk/
  __init__.py
  README.md
  agent.py                     # minimal can_use_tool wiring
  evidence.py                  # artifact builder, hashing, validation
  run.py                       # entry point
  tests/
    __init__.py
    test_evidence.py           # pure-unit
    test_roundtrip.py          # runtime, skipped without SDK

fixtures/claude_agent_sdk/
  valid.decision.claude_agent_sdk.json             # allow case
  failure.decision.claude_agent_sdk.json           # deny case with reason
  malformed_raw_arguments.claude_agent_sdk.json
  malformed_missing_decision.claude_agent_sdk.json
  malformed_bad_framework.claude_agent_sdk.json

mapper/
  map_to_assay.py              # extended to accept new top-level schema
```

## Open architectural questions (to resolve during smoke-check)

**Do we extend the existing mapper file or create a sibling?** The
cleanest path is extending `map_to_assay.py` with a schema-dispatch at
the top, routing pause-v1 and decision-v1 to different normalizers and
event builders. That keeps one entry point. A sibling module would
duplicate canonical-JSON and envelope-building logic.

**Do we reuse the existing `policy-decision` event type for output?**
The existing mapper emits
`example.placeholder.harness.policy-decision` events as *nested*
outputs inside an approval-interruption artifact. For the decision-v1
top-level artifact, the natural output is also a policy-decision
event. That gives us one event out per one decision in, with the same
event type. The only difference is the source artifact shape on the
input side.

Both are expected to resolve cleanly during smoke-check. Not a risk,
just a design choice worth naming before code.

## Go / no-go before phase 2 (smoke-check)

- [ ] Prep card reviewed.
- [ ] Seam still feels strictly smaller than the Deep Agents pause seam
      and not overlapping any of the four cited open issues.
- [ ] Artifact shape explicit, no hidden pause semantics.
- [ ] Framework constant `claude_agent_sdk` confirmed.
- [ ] Intent to extend `mapper/map_to_assay.py` rather than fork it.

## Go / no-go before phase 5 (post)

- [ ] Deep Agents lane has either a maintainer reply or is at
      14-day silence on [#2798](https://github.com/langchain-ai/deepagents/discussions/2798).
- [ ] Adapter is clean, roundtrip passes, fixtures exist.
- [ ] One concrete post angle chosen based on what the probe actually
      exposed, not pre-committed speculation from phase 0.
- [ ] Title matches repo norm (`Question:`, `feat:`, or `[Doc]`).
- [ ] Body includes a minimal runnable reproduction, not prose-only.

## One-line summary

Per-call policy gate via `can_use_tool`, new evidence family
`policy-decision.v1`, issue-only channel, commit-driven feedback loop,
adapter before post, post angle chosen after probe not before.
