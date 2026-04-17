# Tiny Deep Agents Pause Adapter

A minimal external-consumer adapter around Deep Agents' approval-aware
interruption seam. It produces one `assay.harness.approval-interruption.v1`
pause artifact per paused run, in a shape the existing Assay mapper
already consumes.

This is a **tiny** adapter on purpose. It exists to prove that the native
Deep Agents pause seam carries the fields pause-v1 needs, and to pin down
the one correlation step (tool_call_id) that the runtime does not expose
directly at the interrupt boundary.

## What it does

1. Builds a minimal `create_deep_agent` flow with one approval-required
   tool via `HumanInTheLoopMiddleware(interrupt_on=...)`.
2. Invokes the agent. LangGraph `interrupt()` fires.
3. Reads the `HITLRequest` from the invoke result's `__interrupt__` key.
4. Reads the StateSnapshot via `agent.get_state(config)`.
5. **Correlates** `ActionRequest` entries to the originating tool_calls on
   the last AIMessage in the snapshot, to recover each `tool_call_id`.
6. Derives `continuation_anchor_ref` as a SHA-256 over the canonicalized
   snapshot `values`.
7. Writes one pause-v1 artifact (JSON) describing the pause.

No resume is performed. No NDJSON is written. That is the mapper's job.

## Acceptance criteria (phase B, landed here)

- [x] Real interrupt → pause-v1 artifact.
- [x] `tool_call_id` derived via correlation across two public surfaces.
- [x] `continuation_anchor_ref` from the public `agent.get_state` path.
- [x] `valid` + `failure` + three `malformed_*` fixtures in
      `fixtures/deepagents/`, all verified against `mapper/map_to_assay.py`.
- [x] Pure-unit tests for the correlation and artifact builder.
- [x] Roundtrip test that runs the real adapter and pipes the output
      through the mapper (skipped when `deepagents` is not installed).

## Hard non-goals

This adapter deliberately does NOT:

- emit a resumed / resume-decision artifact
- integrate with the Assay policy engine (it accepts a
  `policy_snapshot_hash` as an input, it does not compute one)
- hook into the CI regression gate
- model or handle subagent interrupts
- touch sandbox or shell policy
- carry outreach copy or public documentation beyond this README
- claim that the tiny sample defines a universal Deep Agents contract

If any of these are desired later, they belong in separate work with
their own scope card.

## The `tool_call_id` correlation (the one caveat)

Per the runtime probe at `probes/deepagents/FINDINGS.md`, the interrupt
payload (`HITLRequest.action_requests`) does not carry `tool_call_id`.
Each entry has `name`, `args`, and `description` only. The real
`tool_call_id` lives on the last AIMessage's `tool_calls[*].id` in the
graph state. The adapter reads both surfaces and correlates them by
`(name, args)` equality, falling back to first-by-name.

This is **adapter-derived**, not a native Deep Agents seam. If multiple
same-name tools are called in a single turn with identical arguments,
correlation falls back to order and may produce an ambiguous mapping.
That case is out of scope for this adapter; it is noted in FINDINGS.md
as a later question.

## Stability contract

`continuation_anchor_ref` is an **app-level fingerprint** over the
canonicalized StateSnapshot values. It is NOT a byte-stable identifier
across LangGraph or Deep Agents versions. Same stability posture as the
JS adapter side (see
[openai/openai-agents-js#1177](https://github.com/openai/openai-agents-js/issues/1177)).

## Running

A throwaway venv with `deepagents` already exists at
`probes/deepagents/.venv`:

```bash
./probes/deepagents/.venv/bin/python -m adapters.deepagents.run \
    --output /tmp/pause.json

./probes/deepagents/.venv/bin/python mapper/map_to_assay.py \
    /tmp/pause.json --output /tmp/pause.ndjson
```

## Running tests

Pure-unit tests (no runtime dependencies):

```bash
python3 -m unittest adapters.deepagents.tests.test_evidence -v
```

Roundtrip tests (need deepagents):

```bash
./probes/deepagents/.venv/bin/python -m unittest \
    adapters.deepagents.tests.test_roundtrip -v
```

## File layout

```
adapters/deepagents/
  __init__.py
  README.md                  # this file
  agent.py                   # create_deep_agent + fake model setup
  evidence.py                # correlation, hashing, artifact shaping
  run.py                     # entry point
  tests/
    __init__.py
    test_evidence.py         # pure-unit
    test_roundtrip.py        # runtime (skipped w/o deepagents)

fixtures/deepagents/
  valid.pause.deepagents.json
  failure.pause.deepagents.json
  malformed_raw_arguments.deepagents.json
  malformed_missing_anchor.deepagents.json
  malformed_empty_interruptions.deepagents.json
```

## Related docs

- `docs/outreach/DEEPAGENTS_PREP.md` — seam and artifact-shape prep.
- `docs/outreach/DEEPAGENTS_MAPPER_SMOKECHECK.md` — mapper fit findings.
- `docs/outreach/DEEPAGENTS_PROBE.md` — runtime probe scope.
- `probes/deepagents/FINDINGS.md` — probe results, including the
  `tool_call_id` correlation caveat.
