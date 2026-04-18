# Paused Approval Pattern

A reusable Assay Harness pattern for capturing **one paused
human-in-the-loop approval** as a bounded, reviewable evidence
artifact.

This pattern is runtime-near, not runtime-abstract. It describes the
four moves any runtime integration must perform to produce a v1
pause-only artifact, and ships four helpers plus a strict validator.

## What this pattern is for

- approval interruption capture
- derived continuation anchor generation
- pause-only artifact emission
- reusable fixture support

## What this pattern is NOT for

- full OpenAI Agents SDK support (or any other runtime)
- full `RunResult` support
- session support
- history or `newItems` support
- provider-managed continuation support
- resumed decision artifacts
- UI or dashboard surfaces

See [`PLAN P23A`](../../docs/outreach/) for full scope framing.

## Hard positioning rule

The pattern stays smaller than the runtime that first motivated it.

> P23A v1 claims only bounded approval-interruption capture plus one
> derived continuation anchor from the same paused run. It does not
> claim transcript truth, session truth, provider-chaining truth,
> full serialized state truth, or complete runtime continuation
> semantics.

## The four moves

1. **Capture** one paused approval result.
2. **Extract** one bounded interruptions list.
3. **Derive** one continuation anchor from serialized paused state.
4. **Emit** one pause-only artifact.

Nothing else is required for v1.

## v1 canonical artifact shape

```jsonc
{
  "schema": "assay.harness.approval-interruption.v1",
  "framework": "openai_agents_sdk",
  "surface": "tool_approval",
  "pause_reason": "tool_approval",
  "interruptions": [
    {
      "tool_name": "write_file",
      "call_id_ref": "call_12345"
    }
  ],
  "resume_state_ref": "sha256:...",
  "timestamp": "2026-04-18T12:00:00Z"
}
```

Optional reviewer aids: `active_agent_ref`, `last_agent_ref`,
`metadata_ref`.

Interruption items carry **only** `tool_name` and `call_id_ref`.
Richer lane variants may add `arguments_hash` as a tolerated
extension; see `FIELD_PRESENCE.md`.

## Field boundaries

### `interruptions` — observed runtime surface

Must remain:

- bounded
- ordered
- reviewable
- specific to approval pause context

Must **not** become a full result dump, conversation transcript, or
runtime state export.

### `call_id_ref` — allowed when honestly obtainable

Must remain short, opaque, and anchor-only. Must **not** become a
broader call payload, argument/body truth, or a replay contract.

### `resume_state_ref` — harness-derived, NOT runtime-native

Always documented as:

- Assay-local / harness-local fingerprint
- derived from serialized paused state
- not a native runtime field

Must **not** become raw serialized state in the canonical artifact, a
promise of byte-stable compatibility across runtime versions, or a
dashboard / resolver URL.

## Forbidden in v1

Per `PLAN P23A` sections 5 and 11:

- raw serialized state inline
- transcript or history fields
- `newItems`
- session identifiers
- provider chaining fields
- resumed decision fields (`resumed`, `resume_decision`, etc.)
- `resume_nonce`
- `resumed_from_artifact_hash`

`validate_pause_artifact(...)` rejects each with an explicit
`REJECT_*` marker.

## Four reusable helpers

```python
from patterns.paused_approval import (
    capture_paused_approval,
    derive_resume_state_ref,
    emit_pause_artifact,
    validate_pause_artifact,
)

# 1. Capture: reduce raw interruption items to v1 bounded shape.
interruptions = capture_paused_approval(raw_interruption_items)

# 2. Derive: hash the runtime's serialized state to an app-level anchor.
anchor = derive_resume_state_ref(runtime_state.serialize_to_string())

# 3. Emit: build the v1 artifact.
artifact = emit_pause_artifact(
    framework="openai_agents_sdk",
    interruptions=interruptions,
    resume_state_ref=anchor,
    active_agent_ref="my-agent",    # optional
)

# 4. Validate: strict v1 contract check.
validate_pause_artifact(artifact)
```

The helpers work on plain dicts and strings so the pattern stays
runtime-agnostic. No SDK import inside the pattern package.

## File layout

```
patterns/paused_approval/
  README.md                 # this file
  FIELD_PRESENCE.md         # observed vs derived vs excluded
  __init__.py               # public exports of the four helpers
  capture.py                # capture_paused_approval(...)
  fingerprint.py            # derive_resume_state_ref(...)
  emit.py                   # emit_pause_artifact(...)
  validate.py               # validate_pause_artifact(...)
  fixtures/
    valid.paused.json
    failure.paused.json
    malformed_empty_interruptions.paused.json
    malformed_resumed_field.paused.json
    malformed_url_state_ref.paused.json
    malformed_raw_state_inline.paused.json
  tests/
    __init__.py
    test_helpers.py         # 32 pure-unit tests
    test_fixtures.py        # 8 corpus tests
```

## Tests

```bash
python3 -m unittest discover -s patterns -v
```

40 tests total, all pure-unit, no SDK or network dependencies.

## Location note

`PLAN P23A` suggests `harness/patterns/paused_approval/`, but
`harness/` in this repo is the TypeScript harness package. Python
pattern code lives at `patterns/paused_approval/` parallel to
`adapters/` and `mapper/` to avoid mixing Python into a TS package.

## Related docs

- `docs/outreach/OPENAI_AGENTS_JS` discussion thread ([#1177](https://github.com/openai/openai-agents-js/issues/1177))
  — the confirmed seam this pattern internalizes.
- `FIELD_PRESENCE.md` — observed vs derived vs excluded mapping.
- ADRs 002 and 003 — no transcript truth, MCP bounded evidence.
