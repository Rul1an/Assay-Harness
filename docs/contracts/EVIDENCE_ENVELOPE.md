# Evidence Envelope Contract

> **Version:** 0.2.0
> **Status:** frozen for semver

All Assay Harness evidence events follow the CloudEvents 1.0 envelope
format with Assay-specific extension attributes.

## Required Envelope Fields

Every NDJSON line MUST contain all 15 of these fields:

| Field | Type | Constraint |
|-------|------|------------|
| `specversion` | string | Must be `"1.0"` |
| `type` | string | Must start with `assay.harness.` (runtime) or `example.placeholder.harness.` (mapper) |
| `source` | string | URN format, must start with `urn:` |
| `id` | string | Format: `{runid}:{seq}` |
| `time` | string | RFC3339 UTC timestamp |
| `datacontenttype` | string | Must be `"application/json"` |
| `assayrunid` | string | Non-empty, consistent across all events in a run |
| `assayseq` | integer | Monotonically increasing from 0 |
| `assayproducer` | string | Producer identifier |
| `assayproducerversion` | string | Semver producer version |
| `assaygit` | string | Git ref or `"local"` / `"sample"` |
| `assaypii` | boolean | PII presence flag |
| `assaysecrets` | boolean | Secrets presence flag |
| `assaycontenthash` | string | Format: `sha256:{64 hex chars}` |
| `data` | object | Event-specific payload |

## Content Hash Computation

The `assaycontenthash` is computed from a canonical JSON serialization of:

```json
{
  "specversion": "1.0",
  "type": "<event type>",
  "datacontenttype": "application/json",
  "data": <event data>
}
```

Canonical JSON rules:
- Keys sorted alphabetically at every nesting level
- No whitespace between separators
- Strings use minimal escaping
- Numbers use minimal representation
- Arrays preserve order
- `null`, `true`, `false` are literal

The hash is `sha256:` followed by the lowercase hex SHA-256 digest of the
UTF-8 encoded canonical JSON string.

## NDJSON Format Rules

- One JSON object per line
- Keys alphabetically sorted in output (canonical form)
- No trailing whitespace on any line
- File ends with exactly one newline character
- No empty lines between events
- Events ordered by `assayseq`

## Event Types

### Runtime-produced (harness)

| Type | Purpose |
|------|---------|
| `assay.harness.policy-decision` | Tool call policy evaluation result |
| `assay.harness.approval-interruption` | Run paused for tool approval |
| `assay.harness.denied-action` | Tool call blocked by policy |
| `assay.harness.resumed-run` | Run resumed from paused state |
| `assay.harness.process-summary` | Trajectory-level governance counters |

### Mapper-produced (evidence reduction)

| Type | Purpose |
|------|---------|
| `example.placeholder.harness.approval-interruption` | Mapped approval evidence |
| `example.placeholder.harness.policy-decision` | Mapped policy decision |
| `example.placeholder.harness.resumed-run` | Mapped resume evidence |
| `example.placeholder.harness.process-summary` | Mapped process counters |

## What Is NOT In The Envelope

The following MUST NOT appear in canonical evidence:

- Raw serialized RunState
- Full transcript / history arrays
- Full newItems arrays
- Session state objects
- lastResponseId / previousResponseId
- Raw MCP payloads
- API keys or credentials
- Full tool argument values (use argument_hash instead)

## Stability Promise

This envelope contract is frozen at v0.2.0. Changes require:

- Major version bump for field removal or rename
- Minor version bump for new optional fields
- Patch version for documentation clarification only
- Golden tests must be updated before any change
