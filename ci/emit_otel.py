"""Emit experimental OTLP-shaped JSON from Assay harness evidence NDJSON.

WARNING: This export format is experimental and may change without notice.
It does NOT replace the canonical Assay NDJSON evidence format.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_EVENT_MAP = {
    "policy-decision": "assay.policy.decision",
    "approval-interruption": "assay.approval.interruption",
    "resumed-run": "assay.resume.completed",
    "process-summary": "assay.process.summary",
}


def _read_events(path: Path) -> list[dict[str, Any]]:
    events = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def _to_otel_attr(key: str, value: Any) -> dict[str, Any]:
    """Convert a key-value pair to an OTel attribute."""
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    return {"key": key, "value": {"stringValue": str(value)}}


def _time_to_nano(iso_time: str) -> str:
    """Convert ISO 8601 timestamp to nanoseconds since epoch."""
    dt = datetime.fromisoformat(iso_time.replace("Z", "+00:00"))
    epoch = int(dt.timestamp() * 1_000_000_000)
    return str(epoch)


def _derive_id(source: str, length: int) -> str:
    """Derive a hex ID from a string via SHA-256, truncated to length bytes."""
    h = hashlib.sha256(source.encode("utf-8")).hexdigest()
    return h[:length * 2]


def _extract_event_suffix(event_type: str) -> str | None:
    """Extract the trailing event kind from a dotted type string."""
    for suffix in _EVENT_MAP:
        if event_type.endswith(suffix):
            return suffix
    return None


def _map_attributes(suffix: str, observed: dict[str, Any]) -> list[dict[str, Any]]:
    """Map observed evidence data to OTel attributes based on event type."""
    attrs: list[dict[str, Any]] = []

    if suffix == "policy-decision":
        for field in ("decision", "target_ref", "policy_id"):
            if field in observed:
                attrs.append(_to_otel_attr(f"assay.{field}", observed[field]))

    elif suffix == "approval-interruption":
        for field in ("pause_reason", "resume_state_ref"):
            if field in observed:
                attrs.append(_to_otel_attr(f"assay.{field}", observed[field]))

    elif suffix == "resumed-run":
        for field in ("resume_decision", "resume_state_ref"):
            if field in observed:
                attrs.append(_to_otel_attr(f"assay.{field}", observed[field]))

    elif suffix == "process-summary":
        for key, value in observed.items():
            if isinstance(value, (int, float)):
                attrs.append(_to_otel_attr(f"assay.summary.{key}", value))

    return attrs


def _build_otel(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Build an OTLP-shaped JSON structure from evidence events."""
    # Derive traceId from assayrunid (first event, or fallback)
    run_id = "unknown"
    if events:
        run_id = events[0].get("assayrunid", "unknown")
    trace_id = _derive_id(run_id, 16)  # 32 hex chars

    # Collect timestamps for span boundaries
    timestamps: list[str] = []
    otel_events: list[dict[str, Any]] = []

    for event in events:
        event_type = event.get("type", "")
        suffix = _extract_event_suffix(event_type)
        if suffix is None:
            continue

        otel_name = _EVENT_MAP[suffix]
        data = event.get("data", {})
        observed = data.get("observed", {})
        event_time = event.get("time", "")
        event_id = event.get("id", "unknown")

        if event_time:
            timestamps.append(event_time)

        otel_event: dict[str, Any] = {
            "name": otel_name,
            "timeUnixNano": _time_to_nano(event_time) if event_time else "0",
            "attributes": _map_attributes(suffix, observed),
        }
        # Attach the source event id as a droppedAttributesCount-free reference
        otel_event["attributes"].append(
            _to_otel_attr("assay.event_id", event_id)
        )
        otel_events.append(otel_event)

    # Span timing
    if timestamps:
        start_nano = _time_to_nano(min(timestamps))
        end_nano = _time_to_nano(max(timestamps))
    else:
        start_nano = "0"
        end_nano = "0"

    span_id = _derive_id(f"{run_id}:root", 8)  # 16 hex chars

    return {
        "_experimental": True,
        "_warning": "This export format is experimental and may change without notice",
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": "assay-harness"}},
                        {"key": "service.version", "value": {"stringValue": "0.2.0"}},
                    ]
                },
                "scopeSpans": [
                    {
                        "scope": {"name": "assay-harness-evidence"},
                        "spans": [
                            {
                                "traceId": trace_id,
                                "spanId": span_id,
                                "name": "assay.harness.run",
                                "kind": 1,
                                "startTimeUnixNano": start_nano,
                                "endTimeUnixNano": end_nano,
                                "events": otel_events,
                            }
                        ],
                    }
                ],
            }
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Emit experimental OTLP-shaped JSON from Assay harness evidence NDJSON. "
            "This is a proof-of-concept exporter — the output format is not stable."
        )
    )
    parser.add_argument("input", type=Path, help="Evidence NDJSON file.")
    parser.add_argument("--output", type=Path, required=True, help="OTLP JSON output path.")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Input file not found: {args.input}", file=sys.stderr)
        return 2

    events = _read_events(args.input)
    otel = _build_otel(events)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(otel, indent=2) + "\n", encoding="utf-8")

    span_events = otel["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["events"]
    print(f"Wrote experimental OTLP JSON ({len(span_events)} events) to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
