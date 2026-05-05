# Claude Agent SDK Runtime Probe — Findings

> Evidence-backed answers to the three questions from
> `docs/outreach/CLAUDE_AGENT_SDK_PLAN.md`. Captured via `probe.py` using
> (1) static type inspection of the SDK surface and (2) a synthetic
> invocation of a realistic `can_use_tool` callback. No CLI invocation,
> no API key used.
>
> Raw capture: [`capture.json`](./capture.json).

## Environment

- `claude-agent-sdk` 0.1.63
- Python 3.14.3
- Transport: not invoked. Probe operates on types plus one direct
  `asyncio.run()` of the callback function with a constructed context.

## The seam as the SDK types describe it

```python
CanUseTool = Callable[
    [str, dict[str, Any], ToolPermissionContext],
    Awaitable[PermissionResultAllow | PermissionResultDeny],
]
```

Three inputs:

1. `tool_name: str`
2. `tool_input: dict[str, Any]` — the raw tool arguments. The adapter
   hashes, never stores.
3. `context: ToolPermissionContext` with fields:
   - `signal: Any | None`
   - `suggestions: list[PermissionUpdate]`
   - `tool_use_id: str | None`
   - `agent_id: str | None`

Two possible return types:

- `PermissionResultAllow(behavior="allow", updated_input=None, updated_permissions=None)`
- `PermissionResultDeny(behavior="deny", message="", interrupt=False)`

The callback is async. `ClaudeAgentOptions` accepts it as a
`can_use_tool` kwarg.

---

## Q1. Does the callback carry everything needed for a pause-v1-equivalent?

**Question**
Does `can_use_tool` carry everything needed to emit a
`policy-decision-v1` artifact from inside the callback, without
correlating against a separate event stream?

**Observed**
At call time the callback has direct access to:

- `tool_name` (str) — maps to artifact `tool_name`
- `tool_input` (dict) — hashed to artifact `arguments_hash`
- `context.tool_use_id` (Optional[str]) — maps to artifact `tool_use_id`
- `context.agent_id` (Optional[str]) — informational, maps to optional
  `active_agent_ref` when present
- return behaviour (allow | deny) — maps to artifact `decision`
- deny message — maps to artifact `decision_reason` when decision is deny

No correlation step against `ToolUseBlock` or `AIMessage` is needed.
This is a materially cleaner seam than Deep Agents.

**Usable for decision-v1?**
Yes.

**Original probe caveat**
`tool_use_id` is typed `str | None` on `ToolPermissionContext`. In the
synthetic invocation we explicitly passed a value, but the SDK types
permit None.

**2026-05-05 upstream clarification**
Anthropic answered
[`anthropics/claude-agent-sdk-python#844`](https://github.com/anthropics/claude-agent-sdk-python/issues/844)
and clarified that `tool_use_id` is never `None` on the `can_use_tool`
path. The wire schema requires it, and CLI send sites populate either
the real `toolu_...` id or a generated UUID for synthetic prompts. The
Python Optional typing exists for dataclass field-ordering compatibility.

Concrete adapter rule after #844: missing, empty, whitespace-only, or
whitespace-padded `tool_use_id` is malformed on the `can_use_tool` evidence
path. Record the exact SDK identifier or fail closed; do not synthesize or
rewrite audit ids.

---

## Q2. Can the adapter emit the artifact inside the callback?

**Question**
Can the adapter emit the artifact from inside the callback, or does
it need to defer to a post-callback hook?

**Observed**
The callback is `async` and returns
`Awaitable[PermissionResultAllow | PermissionResultDeny]`. The adapter
can run arbitrary async code, including file writes or network calls,
before returning. Synchronous emission inside the callback body is
fully supported by the type signature.

**Usable for decision-v1?**
Yes.

**If yes, under what caveat?**
One performance note: because the callback blocks tool execution until
it returns, heavy evidence emission (e.g. remote writes) will stall
the agent. The adapter should do canonical JSON hashing plus a
bounded-size local write, and defer any remote shipping to a separate
process. Not a contract issue, just an integration guideline for the
README.

---

## Q3. Does the callback carry policy-snapshot context?

**Question**
Does the callback receive enough context to compute
`policy_snapshot_hash` correlation, or is that purely harness-side?

**Observed**
The SDK provides no "which policy was in effect" context to the
callback. `ToolPermissionContext` does not carry any policy version,
config hash, or rule reference. The closest adjacent field is
`context.suggestions`, a list of `PermissionUpdate` objects, which is
about suggested *future* permission updates rather than the *current*
policy state.

**Usable for decision-v1?**
Yes. `policy_snapshot_hash` is purely harness-side, same pattern as
pause-v1 on the other lanes.

**If yes, under what caveat?**
No caveat. The harness closure that wraps the callback computes
`policy_snapshot_hash` from the policy YAML the consumer loaded, and
the adapter passes it through. The SDK's lack of involvement here is
correct: the SDK does not own the consumer's policy.

---

## Overall verdict

All three questions are green.

- **Q1: green.** `tool_use_id` is required on the `can_use_tool` path
  per #844; adapter rejects missing or rewritten values rather than
  synthesizing audit ids.
- **Q2: green.** Async callback, synchronous emission inside the body
  is fine.
- **Q3: green.** Harness-side concern, SDK correctly uninvolved.

No blocker. The `policy-decision-v1` shape from the prep card is
natively supportable through `can_use_tool` on the Claude Agent SDK
via public types.

## Implications for phase 4 (adapter)

1. Adapter exposes one function `build_can_use_tool_callback(policy,
   policy_snapshot_hash, emit_fn)` that returns a `CanUseTool`-typed
   closure. Consumers pass the closure to `ClaudeAgentOptions(can_use_tool=...)`.
2. Inside the closure, the adapter computes `arguments_hash`, records
   the decision, and calls `emit_fn(artifact_dict)`. The emit function
   is the consumer's evidence writer, typically writing JSON to disk
   or appending to a stream.
3. Missing, empty, whitespace-only, or whitespace-padded `tool_use_id`
   is malformed for the `can_use_tool` path. The adapter README
   documents this so consumers do not treat placeholder or rewritten ids
   as normal audit anchors.
4. No subagent correlation logic is needed for the first adapter.
   `context.agent_id` maps to `active_agent_ref` when present, and
   subagent hierarchies are a non-goal.

## Out-of-scope questions surfaced by the probe (do not answer here)

- Historical note: whether `tool_use_id` could arrive as None was
  answered in #844. It should not happen on the `can_use_tool` path.
- How does `updated_input` on `PermissionResultAllow` interact with the
  artifact's `arguments_hash`? If a consumer modifies the args before
  returning, should the hash reflect the original or the modified
  args? Probably both, as separate fields, but that is a pause-v2
  extension, not a phase 4 question.
- Does `PermissionResultDeny.interrupt=True` produce any observable
  follow-up event the adapter could correlate against?

All three deferred.

## One-line summary

The `can_use_tool` callback carries everything needed for
`policy-decision-v1` emission via public types. `tool_use_id` is
required on the `can_use_tool` path; missing or rewritten values are
malformed, not normal fallback cases.
