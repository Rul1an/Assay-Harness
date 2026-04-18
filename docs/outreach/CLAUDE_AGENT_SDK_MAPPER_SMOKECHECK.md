# Claude Agent SDK Mapper Smoke-Check (internal)

> Phase 2 spanningsproef on `mapper/map_to_assay.py`. Answers: can the
> existing mapper absorb a `policy-decision-v1` top-level artifact
> alongside `pause-v1`, without restructuring?
>
> Outcome: **yes, via schema-dispatch plus a parallel normalizer and
> event builder.** Backward compat with all existing pause-v1 fixtures
> is intact (61/61 tests pass). Phase 3 risk sits on the SDK runtime
> side.

## What was tested

Five synthetic fixtures and one full repo-test rerun:

1. **Native decision-v1 allow case** — `framework=claude_agent_sdk`,
   `surface=per_call_permission`, `decision=allow`, all required fields.
2. **Decision-v1 deny case with reason** — same but `decision=deny` and
   a `decision_reason` non-empty string.
3. **Malformed: bad framework** — `framework="evil_framework"`.
4. **Malformed: bad decision** — `decision="maybe"`.
5. **Malformed: raw arguments** — `arguments_hash` is a dict, not a hash ref.
6. **Malformed: missing tool_use_id** — required field omitted.

Plus the full existing test suite (61 tests across pause-v1 lanes).

## What happened

### Valid allow case

```
Mapped 1 events to /tmp/smoke-cas/out.ndjson
event type: example.placeholder.harness.policy-decision
external_system: claude_agent_sdk
external_schema: assay.harness.policy-decision.v1
decision: allow
tool_use_id: toolu_01ABC
```

One event out, framework preserved through the envelope, decision and
tool_use_id pass through cleanly.

### Valid deny case with reason

```
decision: deny
decision_reason: destructive shell command blocked by policy rule shell.destructive
active_agent_ref: assay-cas-adapter
```

Optional fields preserved as expected.

### Malformed cases (all rejected with explicit markers)

```
[REJECT_FRAMEWORK] artifact: framework must be one of: claude_agent_sdk, langgraph_deepagents, openai_agents_sdk
[REJECT_BAD_DECISION] artifact: decision must be one of: allow, deny; got maybe
arguments_hash must be a non-empty string                  (raw dict caught here)
[REJECT_MISSING_KEY] artifact: missing required keys: tool_use_id
```

### Backward compat

```
Ran 61 tests in 15.494s
OK
```

All pause-v1 contract tests still pass unchanged.

## What changed in the mapper

Three concrete additions, no restructuring:

- **Schema constants:** `PAUSE_SCHEMA`, `DECISION_SCHEMA`,
  `ALLOWED_SCHEMAS`. `EXTERNAL_SCHEMA` aliased to `PAUSE_SCHEMA` for
  backward compat with anything that imports the old name.
- **`_build_events` is now a dispatcher** that routes on the input's
  top-level `schema` field to either `_build_pause_events` (existing
  body, just renamed) or `_build_decision_events` (new).
- **`_normalized_decision_record` and `_build_decision_events`** validate
  and emit one `example.placeholder.harness.policy-decision` event per
  decision-v1 artifact. The event type matches the existing nested
  policy-decision event type, but the source artifact shape is
  top-level.

Allow-set additions:

- `ALLOWED_FRAMEWORKS` gained `claude_agent_sdk`.
- New `ALLOWED_DECISION_SURFACES = {per_call_permission}`.
- New `ALLOWED_POLICY_DECISION_OUTCOMES = {allow, deny}` (note: no
  `require_approval`; that value lives only on the harness policy
  engine side, not on a per-call gate).

## Non-findings (things that did NOT need changing)

- The CloudEvents envelope shape, `assaycontenthash` derivation, NDJSON
  serialization: framework- and schema-agnostic.
- The `REJECTED_KEYS` raw-state guard: works for both schemas.
- The `_validate_sha256_ref` and `_validate_non_empty_string` helpers:
  reused as-is.
- The pause-v1 normalizer and event builders: untouched (just renamed
  `_build_events` body to `_build_pause_events`).

## Contract design choices surfaced (worth logging)

**Output event type is `example.placeholder.harness.policy-decision`,
the same type used for nested policy decisions inside pause-v1
artifacts.** This is intentional: a policy decision is a policy
decision regardless of whether it arose during a pause flow or as a
standalone per-call gate. The `external_schema` field on the event data
distinguishes the two source artifact shapes when needed.

**Decision allow-set is `{allow, deny}` only.** The pause family allows
`require_approval` because pause-v1 represents a moment where the
decision is to defer to a human. The decision-v1 family represents a
moment where the decision has already been resolved by the consumer's
callback. There is no `require_approval` outcome at that surface, so
including it would be a category error.

**`policy_snapshot_hash` is required, not optional, on decision-v1.**
Same reasoning: at the per-call gate the consumer must know which
policy was in effect, otherwise the audit trail has a gap. On pause-v1
it is technically optional because some lanes (the original JS one
before our hardening) did not carry it. We tightened it here from the
start.

## Checklist update

From the prep card's go/no-go for phase 2:

- [x] Mapper extends with schema-dispatch rather than fork. Confirmed
      by the diff: one entry point, one new normalizer, one new event
      builder.
- [x] No restructuring of canonical-JSON or envelope code.
- [x] Backward compat intact: all 61 existing tests still green.
- [x] Five malformed cases all rejected with explicit markers.

## What this does NOT tell us

The mapper absorbs the artifact shape. It does **not** confirm:

- That `can_use_tool` actually carries `tool_use_id` and `tool_input`
  in the way the prep card assumes (verified by code inspection in
  phase 0, but not yet by a real callback invocation).
- That the callback is invoked synchronously from the SDK in a way
  the adapter can write evidence inside.
- That `policy_snapshot_hash` correlation works under retry,
  resubmission, or `updatedInput` flows.

Those are phase 3 (probe) questions. The mapper side is clean.

## One-line summary

Schema-dispatch plus a parallel normalizer and event builder lets the
mapper absorb decision-v1 alongside pause-v1 with zero restructuring;
phase 3 risk now sits exclusively on the Claude Agent SDK runtime side.
