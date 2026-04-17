# Deep Agents Mapper Smoke-Check (internal)

> Cheap spanningsproef on `mapper/map_to_assay.py` before phase A of the
> Deep Agents outreach. Answers the question: can the existing mapper
> absorb the proposed pause-v1 artifact without restructuring?
>
> Outcome: **yes, with three small string-level parameterizations.**
> No structural refactor needed. Prep card checklist item #4 is green.

## What was tested

Two synthetic fixtures were run through `mapper/map_to_assay.py`:

1. **Native Deep Agents shape** — `framework=langgraph_deepagents`,
   anchor field `continuation_anchor_ref`, pause-v1 only (no `resumed`,
   no `policy_decisions`, no `process_summary`).

2. **Same pause-v1 shape with JS-side names** — `framework=openai_agents_sdk`,
   anchor field `resume_state_ref`, otherwise identical. This isolates
   whether the shape fits, separately from whether the names fit.

## What happened

### Run 1: native Deep Agents shape

```
[REJECT_FRAMEWORK] artifact: framework must be openai_agents_sdk
```

Fails on the first hardcoded check at line 267. No further validation runs.

### Run 2: pause-v1 shape with JS-side names

```
Mapped 1 events to /tmp/smoke-deepagents/out.ndjson
```

Output: exactly one event, type `example.placeholder.harness.approval-interruption`.
All optional branches (`resumed`, `policy_decisions`, `process_summary`) are
silently skipped, which is exactly the pause-only behavior the prep card wants.

## Findings

The pause-v1 shape absorbs cleanly into the mapper's event-generation logic.
No new event types, no new regression classes, no structural refactor. The
delta between JS-SDK input and Deep Agents input is three string-level
parameterization points:

1. **Framework allow-set**
   - Current: `record.get("framework") != "openai_agents_sdk"` (hard reject).
   - Needed: `framework in {"openai_agents_sdk", "langgraph_deepagents"}`.
   - Scope: one conditional at line 267, one `REQUIRED_KEYS` reference.

2. **Anchor field name on input**
   - Current: `REQUIRED_KEYS` contains `"resume_state_ref"`, and
     `_normalized_record` reads `record["resume_state_ref"]` directly.
   - Needed: accept either `resume_state_ref` (JS-SDK input) or
     `continuation_anchor_ref` (Deep Agents input), normalize to a single
     internal field.
   - Scope: two call sites in `_normalized_record`.

3. **Output envelope `external_system`**
   - Current: `"external_system": "openai_agents_sdk"` hardcoded in four
     event builders (lines 348, 393, 422, 451).
   - Needed: derive from normalized input framework.
   - Scope: swap string literal for `normalized["framework"]` in four spots.

## Non-findings (things that do NOT need changing)

- `interruptions[]` validation works unchanged. The three required fields
  (`tool_name`, `tool_call_id`, `arguments_hash`) are framework-agnostic.
- `policy_snapshot_hash` as optional top-level validates cleanly.
- `active_agent_ref` as optional validates cleanly.
- Event envelope shape, `assaycontenthash` derivation, NDJSON serialization:
  all framework-agnostic.
- The `REJECTED_KEYS` guard (`raw_run_state`, `history`, `newItems`,
  `lastResponseId`, `session`) is already generic and covers both runtimes.
- Optional branches (`resumed`, `policy_decisions`, `process_summary`)
  correctly skip when absent, which is exactly what pause-v1 needs.

## Contract question surfaced (worth logging)

The mapper's current output envelope puts the anchor under
`observed.resume_state_ref`. If the Deep Agents adapter emits
`continuation_anchor_ref` as input, the mapper will normalize it to
`resume_state_ref` in the output NDJSON. That is a silent rename from the
input artifact's perspective.

Two defensible options:

- **(A) Accept the rename** on the grounds that the `observed.*` block is
  Assay-side internal representation, and `resume_state_ref` is the
  Assay-internal name per the prep card. The `continuation_anchor_ref`
  term lives on the adapter's emitted artifact, not in the evidence
  envelope.
- **(B) Preserve the input field name** in `observed.*` by tracking which
  alias the input used.

Recommendation: **(A)**. The prep card explicitly says "we still call this
`resume_state_ref` in Assay-side code for continuity with the JS adapter."
The mapper is Assay-side code. Option (A) is consistent with the prep card;
option (B) would expand the Assay-internal vocabulary unnecessarily.

## Checklist update

From the prep card's go/no-go checklist:

- [x] Existing Python mapper can absorb `framework=langgraph_deepagents`
      and the neutral `continuation_anchor_ref` field without restructuring.

Confirmed, with the three-point parameterization above.

Remaining open items on the checklist (all about elapsed time, interrupt
docs review, CLI thread status, field-name leak scan) are unchanged by
this smoke-check.

## What this does NOT tell us

The smoke-check confirms the mapper can absorb the pause-v1 shape. It does
**not** confirm that the shape is natively emitable from a real
`HumanInTheLoopMiddleware(interrupt_on=...)` flow in Deep Agents. That is
a separate question that only phase A (tiny adapter build) can answer.

Specifically still unverified:

- Does LangGraph `interrupt` expose a stable `call_id` at the pause point
  that maps one-to-one onto `tool_call_id`?
- Is the serialized graph state obtainable at the pause without touching
  checkpointer internals?
- Does emitting the artifact BEFORE resume work cleanly (no hidden
  dependency on post-resume fields)?

Those three are the real Phase A risk surface. The mapper side is clean.

## One-line summary

The mapper absorbs pause-v1 with three small string-level parameterizations
and no structural refactor, so prep-card checklist item #4 is green and
phase A risk sits where we expected it: on the Deep Agents runtime side,
not on the Assay contract side.
