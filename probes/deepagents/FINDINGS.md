# Deep Agents Runtime Probe — Findings

> Evidence-backed answers to the three questions from
> `docs/outreach/DEEPAGENTS_PROBE.md`. Captured via `probe.py` against a
> minimal `create_deep_agent` + `HumanInTheLoopMiddleware` flow using a
> scripted fake model (no live API key used).
>
> Raw capture: [`capture.json`](./capture.json).

## Environment

- `deepagents` 0.5.3
- `langgraph` 1.1.6
- `langchain` 1.2.15
- `langchain-core` 1.2.31
- Python 3.14.3
- Checkpointer: `langgraph.checkpoint.memory.MemorySaver`
- Model: `FakeMessagesListChatModel` subclassed with a no-op `bind_tools`
  so the deepagents middleware stack can run without a real LLM

## How the probe worked

1. Scripted one `AIMessage` with a tool_call for the `execute` tool and a
   known id `call_probe_001`.
2. Built `create_deep_agent(model=fake, tools=[execute], interrupt_on={"execute": True}, checkpointer=MemorySaver())`.
3. Invoked with one user message. The middleware's `after_model` hook
   detected the approval-required tool call and fired LangGraph `interrupt()`.
4. Captured the return dict, the `StateSnapshot` from `agent.get_state(config)`,
   and the raw `Interrupt` object(s).
5. Resumed with `Command(resume={"decisions": [{"type": "approve"}]})` to
   confirm pre-resume emission is independent of post-resume information.

---

## Q1. Stable `tool_call_id` at the pause

**Question**
Does the LangGraph `interrupt` payload expose a call-level identifier at
the pause point, stable across the pause/resume boundary, that maps 1:1
onto our `tool_call_id` field without post-resume information?

**Observed**
The interrupt payload (the `value` passed to `interrupt(...)` and seen by
the external consumer) is a `HITLRequest`:

```jsonc
{
  "action_requests": [
    { "name": "execute", "args": { "command": "ls -la" },
      "description": "Tool execution requires approval\n\nTool: execute\nArgs: {'command': 'ls -la'}" }
  ],
  "review_configs": [
    { "action_name": "execute", "allowed_decisions": ["approve", "edit", "reject"] }
  ]
}
```

The `Interrupt` wrapper itself carries an `id`
(`25b3f7309309583fe23539d9d8b06338`). That is LangGraph's per-interrupt
identifier, derived from state hashing, **not** the model's tool_call id.

The real tool_call id (`call_probe_001`) is present in the graph state, at
`snapshot.values["messages"][-1].tool_calls[0]["id"]`. It is reachable via
the public `agent.get_state(config)` surface, but it is not in the
interrupt payload itself.

**Usable for pause-v1?**
Yes, but with a caveat that needs to be named.

**If yes, under what caveat?**
The pause-v1 adapter must source `tool_call_id` from the state snapshot's
last AIMessage, not from the interrupt payload. The correlation is:

- Pick the last `AIMessage` in `snapshot.values["messages"]`.
- For each `action_request` in `Interrupt.value["action_requests"]`, find
  the matching `tool_call` by `tool_call["name"] == action_request["name"]`
  (and by argument equality when multiple tools with the same name are
  interrupted in one turn).
- Extract `tool_call["id"]` as the `tool_call_id`.

This works today against the observed surfaces, but it is an
**inference step**, not a direct mapping. For the adapter boundary this
means:

- `tool_call_id` in the Deep Agents artifact is correctly understood as
  "the model's tool_call id", same as on the JS SDK side.
- The adapter code carries the correlation logic, not the runtime.
- If `HumanInTheLoopMiddleware` ever starts exposing `tool_call_id` in
  `ActionRequest` directly, the adapter becomes simpler; until then the
  inference step is the stable path.

This caveat is a legitimate topic for the later Discussion post if one is
made: "would it be reasonable for `ActionRequest` to include the
originating `tool_call_id` so external HITL consumers don't need to
correlate via state messages?"

---

## Q2. Reachable continuation anchor via public surface

**Question**
Is serialized graph state reachable at the pause through a publicly
documented surface, without reaching into checkpointer internals or
private LangGraph modules?

**Observed**
`agent.get_state(config)` returns a `StateSnapshot` (public LangGraph
API). The snapshot serializes to JSON cleanly (1746 bytes for the probe's
trivial case, via a best-effort `_obj_to_dict` walker). Fields of
interest on the snapshot:

- `values` — the graph state including `messages`
- `next` — next nodes to run (`('HumanInTheLoopMiddleware.after_model',)`)
- `tasks` — includes the interrupt object as `tasks[0].interrupts[0]`
- `config`, `metadata` — checkpointer metadata

The checkpointer itself (`MemorySaver` here) is also public LangGraph API,
and other checkpointer implementations exist publicly (SQLite, Postgres,
Redis) all implementing `BaseCheckpointSaver`.

**Usable for pause-v1?**
Yes, via a public surface.

**If yes, under what caveat?**
Two small notes:

- The snapshot is a rich object. To produce a stable `continuation_anchor_ref`,
  the adapter must canonicalize before hashing (sort keys, stable
  serialization of LangChain message types). That is straightforward, but
  it is the adapter's responsibility, not the runtime's. The hash is
  therefore explicitly an app-level fingerprint, not a byte-stable
  LangGraph identifier across versions. Same stability contract as the JS
  SDK side (`openai/openai-agents-js#1177`).
- Requires a checkpointer to be configured. Without one, `agent.get_state()`
  has nothing to return for a thread. The adapter must require or provide
  a checkpointer.

---

## Q3. Pre-resume emission

**Question**
Can the full pause artifact be constructed and written **before**
`Command(resume=...)` is invoked, without any field silently depending on
post-resume state?

**Observed**
`agent.invoke(...)` returns normally when an interrupt fires; the returned
dict contains `__interrupt__` alongside `messages`. No exception is
raised. At that moment:

- The tool call is already present in state messages (captured by the
  probe: `tool_calls[0].id == "call_probe_001"`).
- The interrupt payload is available both via the return dict's
  `__interrupt__` key and via `snapshot.tasks[0].interrupts`.
- The snapshot is fully populated and serializable.
- `policy_snapshot_hash` and `resume_nonce` are harness-side constructs,
  unrelated to runtime timing.

The probe confirmed resume works (`Command(resume={"decisions": [{"type": "approve"}]})`)
and after resume the state moves forward. Emitting the pause artifact
before that call is straightforward.

**Usable for pause-v1?**
Yes.

**If yes, under what caveat?**
No caveat. All fields of pause-v1 are available at the pause boundary
before any resume call. The artifact does not leak post-resume state.

---

## Overall verdict

Two greens and one "yes but". Per the post-probe decision tree in
`DEEPAGENTS_PROBE.md`:

- Q1 is "yes, via public surface, but via an inference step across two
  public surfaces rather than a single payload field".
- Q2 is green.
- Q3 is green.

No blocker. The pause-v1 shape is natively supportable in Deep Agents via
public surfaces. The tool_call_id correlation caveat is real but is an
adapter-side concern, not a contract-side concern.

## Implications for phase B (if pursued)

1. The Deep Agents adapter owns the tool_call id correlation logic. This
   is a small, testable piece of code that reads the last AIMessage from
   the StateSnapshot and matches tool_calls to ActionRequests.
2. The adapter requires a checkpointer. Default suggestion: `MemorySaver`
   for in-process use, with docs noting that Postgres / SQLite
   checkpointers work the same way for persistent cases.
3. The `continuation_anchor_ref` is derived from canonicalized snapshot
   values, hashed the same way the JS adapter hashes serialized RunState.
   Stability contract is identical: app-level fingerprint, not byte-stable.
4. The Discussion post, if made, can cite a concrete correlation gap
   (no `tool_call_id` in `ActionRequest`) as the one question worth
   asking upstream, rather than a broad seam question.

## Out-of-scope questions surfaced by the probe (do not answer here)

- How does the interrupt payload change when multiple approval-required
  tools are called in one turn? The code path suggests one HITLRequest
  with multiple `action_requests`, but the probe only exercised one.
- Do subagent-originated interrupts appear in the parent's
  `snapshot.tasks` or only in the subagent's? Out of scope per the
  probe's scope guards.
- Does the `Interrupt.id` (LangGraph-internal) remain stable across SDK
  versions? Worth asking if we ever want to use it as a correlation anchor.

## One-line summary

Deep Agents pause-v1 is natively supportable today with no blockers, one
concrete "yes but" caveat (tool_call_id is sourced via state snapshot
correlation, not directly from the interrupt payload), and a legitimate
single-question follow-up for the upstream Discussion.
