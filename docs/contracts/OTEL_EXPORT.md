# OTel Export — Experimental

> **Status: EXPERIMENTAL** — This format carries no stability guarantees.
> It may change or be removed without notice.

## Purpose

`ci/emit_otel.py` maps Assay evidence NDJSON to an OpenTelemetry-compatible
JSON structure (simplified OTLP JSON export). This enables future integration
with observability tooling (Jaeger, Grafana Tempo, etc.) without modifying the
canonical Assay evidence format.

## Usage

```bash
python3 ci/emit_otel.py fixtures/valid.assay.ndjson --output results/otel-export.json
```

No external dependencies required — stdlib only.

## Mapping Rules

### Evidence event type → OTel event name

| Evidence type suffix       | OTel event name                  |
|----------------------------|----------------------------------|
| `*.policy-decision`        | `assay.policy.decision`          |
| `*.approval-interruption`  | `assay.approval.interruption`    |
| `*.resumed-run`            | `assay.resume.completed`         |
| `*.process-summary`        | `assay.process.summary`          |

### Attribute mapping

| OTel event name                  | Attributes                                                    |
|----------------------------------|---------------------------------------------------------------|
| `assay.policy.decision`          | `assay.decision`, `assay.target_ref`, `assay.policy_id`       |
| `assay.approval.interruption`    | `assay.pause_reason`, `assay.resume_state_ref`                |
| `assay.resume.completed`         | `assay.resume_decision`, `assay.resume_state_ref`             |
| `assay.process.summary`          | `assay.summary.*` (one attribute per numeric counter)         |

All events also carry `assay.event_id` referencing the source evidence event.

### Trace and span structure

- One trace per evidence file, `traceId` derived from `assayrunid` via SHA-256
- One root span (`assay.harness.run`) covering min/max event timestamps
- `spanId` derived from `{assayrunid}:root` via SHA-256
- Resource attributes: `service.name=assay-harness`, `service.version=0.2.0`
- Scope: `assay-harness-evidence`

## What is NOT mapped

The following are explicitly excluded from the OTel export:

- **Transcripts** — agent conversation content is not exported
- **Raw state** — resume state blobs, argument hashes, content hashes
- **Session metadata** — PII flags, secrets flags, git refs
- **Assay envelope fields** — `assaycontenthash`, `assayseq`, `specversion`, etc.
- **Non-evidence data** — harness config, MCP manifests, policy definitions

These remain in the canonical Assay NDJSON only.

## Stability

This export format has **no contractual stability guarantee**. Specifically:

- Event names, attribute keys, and structure may change between versions
- The output is marked with `_experimental: true` and a warning string
- Downstream consumers must tolerate schema changes without notice
- This exporter does NOT replace the canonical NDJSON — it is a secondary view

## References

- [OpenTelemetry OTLP/JSON specification](https://opentelemetry.io/docs/specs/otlp/)
- [OTel Semantic Conventions for GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Assay Evidence Envelope contract](EVIDENCE_ENVELOPE.md)
