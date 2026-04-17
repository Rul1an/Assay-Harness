# Deep Agents Runtime Probe (Phase A scope, internal)

> Probe, not adapter. Answers three runtime-side questions that only a real
> `create_deep_agent` + `HumanInTheLoopMiddleware` flow can answer.
> Not a shipped lane. Not a Discussion post. Not a resumed-artifact v2.

## Why a probe and not an adapter

After `ccc3af5` the Assay contract side is settled:

- pause-v1 shape absorbs cleanly through the mapper
- `framework` and anchor aliasing are parameterized and tested
- JS-SDK backward compat is intact
- contract drift on the Assay side is guarded by `test_deepagents_contract.py`

What remains unsettled is whether the native Deep Agents interruption
surface actually *carries* the fields pause-v1 assumes, without leaning
on post-resume information or LangGraph internals. That is a runtime
question, not a contract question, so we build the smallest thing that
can answer it honestly.

## The three questions (only these)

1. **Stable `tool_call_id`.** Does LangGraph's `interrupt` payload expose a
   call-level identifier at the pause point that is stable across the
   pause/resume boundary and can be mapped one-to-one onto our
   `tool_call_id` field without post-resume information?

2. **Reachable continuation anchor.** Is serialized graph state reachable
   at the pause, through a publicly documented surface, without reaching
   into checkpointer internals or private LangGraph modules? If only
   internals work, that is a finding, not a failure — but it must be
   recorded truthfully as "harness-derived, not native Deep Agents seam."

3. **Pre-resume emission.** Can the full pause artifact be constructed and
   written **before** resume is invoked, without any field silently
   depending on post-resume state (final call id, resolved arguments,
   finalized interrupt metadata)?

Any other question is out of scope for the probe.

## Acceptance criteria

The probe is done when, for each of the three questions, we have a written
answer in the findings section with one of:

- **yes, via <public surface>** — cite the LangGraph / Deep Agents docs or
  source location, no internals touched.
- **yes, but only via <internal surface>** — cite exactly which internal
  module or attribute was needed. Flag as a lane-shape consequence, not a
  probe failure.
- **no** — cite what broke and what would be needed. This is a legitimate
  probe outcome; it means the pause-v1 shape is not natively supported and
  the prep card needs a recut before any adapter work.

All three answers must be evidence-backed. A hunch is not an answer.

## Scope guards (hard)

The probe does NOT:

- build an `adapters/deepagents/` package directory
- wire into the existing Assay policy engine
- integrate with the CI regression gate
- add any new compare classes
- touch the mapper, fixtures, or contract tests
- create a resumed / resume-decision artifact
- spawn subagents
- configure persistent memory, checkpointers, or sessions beyond what is
  mechanically required to make one interrupt fire
- use LocalShellBackend, remote sandboxes, or any non-default backend
- produce outreach-ready copy, READMEs, or public documentation

If the probe starts needing any of the above to reach an answer, stop
and escalate. That means pause-v1 is leaning on something the probe
cannot answer in isolation, which is itself the finding.

## Probe deliverable (what actually gets written)

One throwaway directory at `probes/deepagents/` containing:

- `probe.py` — minimal script: define one approval-required tool via
  `HumanInTheLoopMiddleware(interrupt_on=...)`, invoke
  `create_deep_agent(...)` with one user turn that triggers the tool,
  catch the interrupt, print the raw payload structure.
- `capture.json` — one real interrupt payload captured from a run,
  structure only (no provider keys, no prompt text beyond what is
  necessary to trigger the tool).
- `FINDINGS.md` — answers to the three questions, each with a citation to
  a public docs URL, a source file in the installed `deepagents` /
  `langgraph` wheels, or an interrupt payload field.

No tests. No fixtures committed to `fixtures/`. No changes to `harness/`
or `mapper/`. The probe directory is a journal of evidence, not a
production lane.

## Dependencies needed

- `deepagents` (Python package from PyPI)
- `langgraph` (transitively, but useful to pin what version the probe ran
  against in `FINDINGS.md`)
- a model credential the probe can use for one turn; cheapest available
  OpenAI or Anthropic key is fine

The probe records exact installed versions of `deepagents` and `langgraph`
in `FINDINGS.md` so later runs can tell whether an answer still holds.

## Alertness list (the three risks worth watching during the probe)

1. **`tool_call_id` naming drift.** If the field does not exist under that
   name, do not coerce. Record the real name in the payload (`id`,
   `call_id`, `tool_use_id`, etc.) and flag in findings. Any future
   artifact contract uses whatever the runtime natively exposes, renamed
   at the adapter boundary if needed.

2. **Continuation-anchor via internals.** If the only way to get a
   serializable state snapshot is through `CompiledStateGraph._checkpointer`
   or similar private attributes, write it down exactly that way. Do not
   pretend a non-public surface is public. The artifact can still use a
   harness-derived anchor, but the lane framing must be honest.

3. **Post-resume field leakage.** Most subtle risk. If any pause-artifact
   field only gets its final value after `Command(resume=...)`, the
   pre-resume emission story is broken and pause-v1 needs to be recut or
   the probe needs to escalate to a split pause-pending / pause-final
   pattern.

## Stop conditions (circuit breakers)

Stop the probe immediately and escalate if any of the following happen:

- the minimum runnable setup needs more than one tool definition and one
  middleware config
- LangGraph docs point to multiple incompatible interrupt APIs and
  picking one materially changes the answer
- the model credential is non-trivial to obtain for the probe environment
- the first real interrupt payload contains fields that look like raw
  graph state (not a summary / reference), suggesting we would be
  capturing too much by default

Each of these is a signal the probe's own scope is wrong, not a bug to
work around.

## Out-of-scope questions (defer, do not answer here)

- Do multiple interrupts in one run share state cleanly?
- Does subagent delegation produce nested interrupts and how?
- How does `AsyncSubAgentMiddleware` behave at the pause boundary?
- What does persistent memory look like across resume?
- Can the probe's seam be combined with a sandbox policy lane?
- How does this compare to the JS SDK approach in
  [openai/openai-agents-js#1177](https://github.com/openai/openai-agents-js/issues/1177)?

Each of these is a real question. None of them belongs in this probe.

## Go / no-go checklist before starting the probe

- [ ] Prep card v2 (`DEEPAGENTS_PREP.md`) still reads as accurate.
- [ ] Mapper smoke-check findings (`DEEPAGENTS_MAPPER_SMOKECHECK.md`)
      still hold on current main.
- [ ] `probes/` directory is a throwaway location in this repo's layout;
      if the team prefers an external scratch repo, switch before
      starting.
- [ ] A model credential for one short probe run is available without
      expanding the project's secret footprint.
- [ ] Willing to treat "only reachable via internals" as a legitimate
      finding, not something to paper over.

## Post-probe decision tree

Once `FINDINGS.md` has three answers:

- **All three answers are green (yes, via public surface).** Proceed to
  adapter build (phase B). Prep card needs minimal updates.
- **One answer is "yes, but via internals."** Proceed, but recut the prep
  card to say the lane is harness-derived at that point, not native.
- **One answer is "no."** Do not build the adapter. Update prep card with
  the blocker, decide whether to escalate to upstream via Discussion,
  fall back to the JS-only lane, or wait for LangGraph surface changes.
- **Two or more answers are "no" or "internals only."** Pause-v1 as a
  concept does not cleanly fit Deep Agents. Recut the seam question
  from scratch before any further outreach or build.

## One-line summary

Smallest runnable Deep Agents flow that answers three questions about the
native interruption surface, produces one throwaway findings document,
and does not build an adapter.
