# Deep Agents Outreach Prep (internal, recut v2)

> Not for publication. Prep card for the second outreach target after
> [`openai/openai-agents-js#1177`](https://github.com/openai/openai-agents-js/issues/1177).
> No code, no post until reviewed.

## Target

- Repo: [`langchain-ai/deepagents`](https://github.com/langchain-ai/deepagents)
- Language: Python (our existing harness is TypeScript; the adapter is a separate lane)
- Channel: GitHub Discussions (enabled and active)
- Category: **Ideas**

Why this target, grounded:

- The repo self-describes as "the batteries-included agent harness."
- It has an explicit security posture and ships a scoped threat model at
  [`libs/deepagents/THREAT_MODEL.md`](https://github.com/langchain-ai/deepagents/blob/main/libs/deepagents/THREAT_MODEL.md).
  That vocabulary (trust boundary, scope, in-scope / out-of-scope) is
  something our framing can echo honestly, not mimic.
- Active security-adjacent discussion around tool and sandbox boundaries
  lives publicly in the Ideas category.

## Community anchors (verified URLs only)

These three show that our question category is legitimate without us
needing to ground on subagent correctness itself:

- [Discussion #2774 — Docs proposal: tool-boundary policy middleware example in security guidance](https://github.com/langchain-ai/deepagents/discussions/2774) (Ideas)
- [Discussion #1762 — How to do interrupts from SubAgent in a loop](https://github.com/langchain-ai/deepagents/discussions/1762) (Q&A)
- [Discussion #2777 — How to process interrupts inside a subagent](https://github.com/langchain-ai/deepagents/discussions/2777) (General)

Framing rule for the post: these show live seam pressure around policy
boundaries and interrupts. We do not ground our first seam on subagent
correctness itself.

The SDK team response on [openai/openai-agents-js#1177](https://github.com/openai/openai-agents-js/issues/1177)
is a quiet precedent that the question category is legitimate. We cite it
lightly for stability-contract context, not as support for the Deep Agents
seam itself.

## Exact seam

**Approval-aware action interruption, with a bounded continuation anchor.**

Specifically:

1. A tool flagged as approval-required via LangChain's
   `HumanInTheLoopMiddleware` (`interrupt_on={...}`) surfaces a LangGraph
   `interrupt`.
2. The consumer captures one bounded pause artifact: tool name, tool call
   id, a hash of the arguments, a policy decision, a policy snapshot hash,
   and a continuation anchor (a harness-local fingerprint derived from
   serialized graph state — see stability note below).

The resume decision (approved / rejected, nonce binding, resumed-from hash)
is deliberately **out of this first artifact**. It becomes a second,
separate artifact if and when upstream confirms this smaller seam is the
right one to lean on.

### Framing principle for the contract

We do **not** mirror the OpenAI Agents SDK artifact one-to-one onto Deep
Agents. The natural seams are related but not identical: Deep Agents HITL
runs via LangGraph interrupts and LangChain middleware, while the JS SDK
seam runs via `RunState` interruptions and resumable state.

> Keep the Deep Agents adapter portable with the existing Assay Harness
> evidence model where honest, but let the first contract follow the native
> Deep Agents interruption seam before cross-runtime normalization.

### Why not another seam

- **Not** sandbox / shell policy. Larger surface, coupled to
  `LocalShellBackend` vs `BaseSandbox` choices documented in their threat
  model. A good second seam, wrong first seam.
- **Not** subagent semantics. The community already shows real friction
  here (`#1762`, `#2777`). Too moving to anchor a first boundary claim on.
- **Not** persistent memory or checkpointing. LangGraph-native concerns
  outside our scope.
- **Not** broad middleware architecture. We observe it, we do not model it.

## Pause artifact v1 (the only artifact we propose in this first outreach)

```jsonc
{
  "schema": "assay.harness.approval-interruption.v1",
  "framework": "langgraph_deepagents",
  "surface": "tool_approval",
  "pause_reason": "tool_approval",
  "interruptions": [
    {
      "tool_name": "execute",
      "tool_call_id": "<interrupt call id>",
      "arguments_hash": "sha256:..."
    }
  ],
  "continuation_anchor_ref": "sha256:...",
  "policy_snapshot_hash": "sha256:...",
  "timestamp": "...",
  "active_agent_ref": "<optional, informational only>"
}
```

Notes:

- **Raw tool arguments are out of scope.** The canonical artifact contains
  only a hash of the arguments (`arguments_hash`), never the arguments
  themselves. This is a hard rule, not a preference.
- **`continuation_anchor_ref` is the public field name.** Internally we
  still call this `resume_state_ref` in Assay-side code for continuity with
  the JS adapter, but the outward contract uses the neutral
  "continuation anchor" language so it does not over-claim what the hash
  represents.
- **Stability contract, stated up front**: `continuation_anchor_ref` is an
  app-level fingerprint derived from serialized graph state. It is not a
  byte-stable cross-version identifier across LangGraph or Deep Agents
  releases. Same guidance we received on
  [openai/openai-agents-js#1177](https://github.com/openai/openai-agents-js/issues/1177).
- **`active_agent_ref` is explicitly optional and informational.** It is a
  reviewer aid, not a control-flow field. Subagent and handoff semantics
  are deliberately not carried through this field.

## Resume decision artifact (deferred)

Out of scope for the first post. If upstream confirms the pause seam is
intended, a second artifact can carry resume_decision, nonce binding, and
`resumed_from_artifact_hash`. That is a separate conversation and a
separate artifact schema.

## Non-goals (hard, repeat verbatim in README)

The Deep Agents adapter explicitly does not claim:

- transcript or conversation-history truth
- full LangGraph state truth
- full middleware state truth
- subagent execution semantics truth
- persistent memory truth
- checkpointer truth
- sandbox or shell policy truth
- resolved approval outcome inside the pause artifact
- any claim that one local run defines a universal contract

## Malformed rules (fixture boundary, pause artifact only)

A pause artifact is malformed when:

- `framework` is missing or not `langgraph_deepagents`
- `interruptions` is empty while `pause_reason == "tool_approval"`
- `continuation_anchor_ref` is present but is not a valid `sha256:` reference
- `policy_snapshot_hash` is missing or not a valid `sha256:` reference
- any interruption entry is missing `tool_name`, `tool_call_id`, or
  `arguments_hash`
- `arguments_hash` is anything other than a `sha256:` reference (i.e. raw
  arguments sneaking in would fail the contract)

These map onto existing compare classes, so no new regression classes are
needed.

## File layout (proposed, to build in phase A only after review)

```
Assay-Harness/
  harness/                                   # existing TS harness, untouched
  adapters/
    deepagents/                              # new, Python
      __init__.py
      README.md                              # scope, seam, non-goals, stability
      agent.py                               # tiny create_deep_agent setup
      approval_tool.py                       # one approval-required tool
      evidence.py                            # build pause artifact + NDJSON
      policy.yaml                            # shared shape with TS policy
      run.py                                 # entry point, writes evidence
      tests/
        test_adapter_contract.py
  fixtures/
    deepagents/
      valid.deepagents.json
      failure.deepagents.json
      malformed_missing_anchor.deepagents.json
      malformed_raw_arguments.deepagents.json
      malformed_empty_interruptions.deepagents.json
  mapper/
    map_to_assay.py                          # extend: accept framework=langgraph_deepagents
  docs/
    adapters/
      DEEPAGENTS.md                          # public doc for the adapter
```

The adapter emits NDJSON in the shape the existing `mapper/map_to_assay.py`
already understands, with the neutral `continuation_anchor_ref` field mapped
to the internal `resume_state_ref` on the Assay side.

## Tiny sample scope (phase A only after review)

One Python script that:

1. Defines one approval-required tool via
   `HumanInTheLoopMiddleware(interrupt_on=...)`.
2. Invokes `create_deep_agent(...)` with that middleware and one user turn
   that triggers the tool.
3. Catches the `interrupt` from LangGraph's graph invocation.
4. Builds the pause artifact (tool name, call id, args hash, continuation
   anchor, policy decision, policy snapshot hash).
5. Writes NDJSON in the shared Assay evidence shape.

What the sample does **not** do: subagent interrupts, remote sandboxes,
persistent memory, checkpointer persistence, streaming, Studio integration,
resolved approval lifecycle.

Scope guard: if the sample starts needing more than one file of Deep Agents
setup code to show the seam, we are modeling too much of their runtime and
should cut back.

## Draft Discussion post (v2)

**Title:** Minimal approval seam for external governance/evidence consumers

**Category:** Ideas

**Body:**

We built a tiny external-consumer harness around one approval-aware step in
Deep Agents, as an experiment in what the smallest reviewable governance
seam could look like.

We kept it intentionally small:

- one approval-required action
- one paused step
- one bounded continuation anchor
- one review artifact at the pause, nothing after it

We are not trying to model Deep Agents as a whole. We are not importing
transcript, full graph state, full middleware state, subagent semantics, or
persistent memory, and we do not claim one local run defines a universal
contract.

Concrete design choices on our side, so the question is grounded:

- Raw tool arguments never enter the artifact. We store only a bounded hash
  (`arguments_hash`).
- Our continuation anchor is an app-level fingerprint derived from
  serialized graph state, not a byte-stable cross-version identifier. We
  got the same stability guidance from the JS Agents SDK team on a parallel
  seam in [openai/openai-agents-js#1177](https://github.com/openai/openai-agents-js/issues/1177),
  for context on how we think about this.
- The first artifact captures the pause only. Resume decisions, nonces, and
  post-resume lifecycle are a separate concern and a separate artifact,
  deliberately outside this first question.

The full harness sketch lives at [Rul1an/Assay-Harness](https://github.com/Rul1an/Assay-Harness).

Question:

For that kind of external consumer, is **approval plus a bounded
continuation anchor at the pause** roughly the right minimal seam to lean
on in Deep Agents, or is there a thinner official seam you would rather
point us at? In particular, is `HumanInTheLoopMiddleware` plus a LangGraph
`interrupt` the intended stable surface for this kind of consumer, or is
there a preferred lower-level hook?

We are deliberately not asking about subagent interrupts, persistent
memory, or middleware architecture in this thread. Those are later
conversations. For this first move we just want to check whether the small
pause-only seam is legitimate.

Thanks for the harness, and for the scoped threat model at
[`libs/deepagents/THREAT_MODEL.md`](https://github.com/langchain-ai/deepagents/blob/main/libs/deepagents/THREAT_MODEL.md) —
both have been useful to think against.

## Reply guide

**Reply to:** seam clarifications, stability contract points, preferred
accessor guidance, official documentation pointers, scoped redirections to
a thinner hook.

**Do not reply to / do not escalate into:** subagent semantics, persistent
memory, checkpointer design, LangGraph internals, ACP / A2A, OAuth, broader
policy middleware architecture, comparisons between Deep Agents and other
harnesses, product feedback on the CLI.

If a reply widens the scope, answer the narrow part and silently hold the
rest for a later thread.

## Success / fallback criteria

**Success (land at least one):**

- Maintainer confirms `HumanInTheLoopMiddleware` interrupt is the intended
  seam for this kind of external consumer.
- Maintainer points to a thinner or more stable surface we had missed.
- Maintainer confirms that our continuation-anchor-as-fingerprint framing
  is compatible with their stability expectations.

**Soft success:**

- No maintainer reply but community engages and no one contradicts the
  seam framing. We keep the sample, publish the adapter with non-goals,
  do not escalate.

**Fallback (seam is wrong):**

- If a maintainer suggests the seam is not stable or not intended for
  external consumers, we pull back to the JS seam, add the feedback as a
  note in `FIELD_PRESENCE.md`, and do not build the adapter.

## Go / no-go checklist before phase A

- [ ] Prep card v2 reviewed and approved.
- [ ] Seam still feels small after 24h of distance.
- [ ] No hidden dependency on subagent or checkpointer semantics discovered
      while re-reading LangGraph interrupt docs.
- [ ] Existing Python mapper can absorb `framework=langgraph_deepagents`
      and the neutral `continuation_anchor_ref` field without restructuring.
- [ ] We are OK posting before the CLI team ships any competing approval
      UX changes (check `#2774` thread status at post time).
- [ ] No Assay-Harness-specific field name leaks into the public artifact
      (e.g. nothing called `resume_state_ref` in the outward schema).

## One-line summary

Approval plus a bounded continuation anchor at the pause, captured through
`HumanInTheLoopMiddleware` and LangGraph `interrupt`, with the resume
lifecycle deliberately deferred, the contract following the native Deep
Agents seam before cross-runtime normalization, and explicit non-goals
around state, subagents, memory and middleware.
