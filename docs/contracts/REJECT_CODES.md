# Reject Codes — Canonical Mapper Rejection Classes

> **Version:** 0.2.0
> **Status:** frozen for semver

When the evidence mapper rejects an input artifact, it emits a structured
reject code. Downstream CI, docs, and tooling may depend on these codes.

## Reject Code Table

| Code | Class | Meaning |
|------|-------|---------|
| `REJECT_SCHEMA` | Schema mismatch | Expected schema not found or wrong value |
| `REJECT_FRAMEWORK` | Framework mismatch | Expected framework identifier not found |
| `REJECT_SURFACE` | Surface mismatch | Expected surface not found |
| `REJECT_MISSING_KEY` | Missing required key | A required top-level key is absent |
| `REJECT_PAUSE_REASON` | Invalid pause reason | pause_reason is not in allowed set |
| `REJECT_EMPTY_INTERRUPTIONS` | Empty interruptions | interruptions is present but empty |
| `REJECT_MISSING_INTERRUPTIONS` | Missing interruptions | interruptions key absent entirely |
| `REJECT_BAD_STATE_REF` | Invalid state reference | resume_state_ref is not a sha256: hash |
| `REJECT_RAW_STATE` | Raw state leaked | Forbidden keys (raw_run_state, history, newItems, etc.) present |
| `REJECT_BAD_TIMESTAMP` | Invalid timestamp | Timestamp not RFC3339 UTC |
| `REJECT_DUPLICATE_KEY` | Duplicate JSON key | Same key appears twice in JSON object |
| `REJECT_BAD_DECISION` | Invalid decision | Policy decision not in {allow, deny, require_approval} |
| `REJECT_BAD_RESUME_DECISION` | Invalid resume decision | Resume decision not in {approved, rejected} |
| `REJECT_INTERRUPTION_SHAPE` | Malformed interruption | Interruption object missing required fields |

## Output Format

Reject messages follow this pattern:

```
[REJECT_CODE] context: human-readable description
```

Example:
```
[REJECT_RAW_STATE] artifact: contains rejected key 'raw_run_state' — raw runtime state must not appear in canonical harness evidence
```

## Stability Promise

These reject codes are part of the v0.2.0 contract. New codes may be added
in minor versions, but existing codes will not be removed or renamed without
a major version bump.
