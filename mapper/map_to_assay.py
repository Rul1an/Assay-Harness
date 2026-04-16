"""Map a frozen harness approval-interruption artifact into Assay-shaped placeholder envelopes."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Optional


# --- Constants ---

PLACEHOLDER_EVENT_TYPE_PREFIX = "example.placeholder.harness"
PLACEHOLDER_SOURCE = "urn:example:assay:external:harness:approval-interruption"
PLACEHOLDER_PRODUCER = "assay-example"
PLACEHOLDER_PRODUCER_VERSION = "0.1.0"
PLACEHOLDER_GIT = "sample"
EXTERNAL_SCHEMA = "assay.harness.approval-interruption.v1"

REQUIRED_KEYS = (
    "schema",
    "framework",
    "surface",
    "pause_reason",
    "interruptions",
    "resume_state_ref",
    "timestamp",
)
OPTIONAL_TOP_LEVEL_KEYS = {
    "active_agent_ref",
    "metadata_ref",
    "policy_decisions",
    "resumed",
    "process_summary",
    "policy_snapshot_hash",
    "resume_nonce",
}
TOP_LEVEL_KEYS = set(REQUIRED_KEYS) | OPTIONAL_TOP_LEVEL_KEYS
ALLOWED_PAUSE_REASONS = {"tool_approval"}
ALLOWED_DECISIONS = {"allow", "deny", "require_approval"}
ALLOWED_RESUME_DECISIONS = {"approved", "rejected"}


# --- Validation helpers ---

def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"[REJECT_DUPLICATE_KEY] artifact: duplicate JSON key: {key}")
        result[key] = value
    return result


def _normalize_for_hash(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite floats are not valid in canonical JSON")
        if value.is_integer():
            return int(value)
        raise ValueError("non-integer floats are not valid in this sample's canonical JSON subset")
    if isinstance(value, dict):
        return {str(key): _normalize_for_hash(nested) for key, nested in value.items()}
    if isinstance(value, list):
        return [_normalize_for_hash(item) for item in value]
    if isinstance(value, tuple):
        return [_normalize_for_hash(item) for item in value]
    raise TypeError(f"unsupported canonical JSON value: {type(value).__name__}")


def _canonical_json(value: Any) -> str:
    normalized = _normalize_for_hash(value)
    return json.dumps(
        normalized,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    )


def _sha256(value: Any) -> str:
    return f"sha256:{hashlib.sha256(_canonical_json(value).encode('utf-8')).hexdigest()}"


def _compute_assay_content_hash(data: dict[str, Any], event_type: str) -> str:
    content_hash_input = {
        "specversion": "1.0",
        "type": event_type,
        "datacontenttype": "application/json",
        "data": data,
    }
    return _sha256(content_hash_input)


def _parse_rfc3339_utc(value: Optional[str]) -> str:
    if value is None:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    normalized = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"invalid RFC3339 timestamp: {value}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_non_empty_string(value: Any, label: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label}: {field} must be a non-empty string")
    return value


def _validate_sha256_ref(value: Any, label: str, field: str) -> str:
    s = _validate_non_empty_string(value, label, field)
    if not s.startswith("sha256:"):
        raise ValueError(
            f"[REJECT_BAD_STATE_REF] {label}: {field} must be a sha256: hash reference, got: {s[:40]}"
        )
    return s


# --- Interruption validation ---

INTERRUPTION_REQUIRED_KEYS = {"tool_name", "tool_call_id", "arguments_hash"}


def _validate_interruption(item: Any, label: str) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise ValueError(f"{label}: interruption must be an object")
    missing = [k for k in INTERRUPTION_REQUIRED_KEYS if k not in item]
    if missing:
        raise ValueError(f"{label}: missing required keys: {', '.join(missing)}")
    unknown = set(item) - INTERRUPTION_REQUIRED_KEYS
    if unknown:
        raise ValueError(f"{label}: unsupported keys: {', '.join(sorted(unknown))}")
    return {
        "tool_name": _validate_non_empty_string(item["tool_name"], label, "tool_name"),
        "tool_call_id": _validate_non_empty_string(item["tool_call_id"], label, "tool_call_id"),
        "arguments_hash": _validate_sha256_ref(item["arguments_hash"], label, "arguments_hash"),
    }


# --- Policy decision validation ---

POLICY_DECISION_REQUIRED_KEYS = {"decision", "policy_id", "action_kind", "target_ref", "timestamp"}
POLICY_DECISION_OPTIONAL_KEYS = {"rule_ref", "approval_required", "reason_code", "protocol_ref"}


def _validate_policy_decision(item: Any, label: str) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise ValueError(f"{label}: policy decision must be an object")
    missing = [k for k in POLICY_DECISION_REQUIRED_KEYS if k not in item]
    if missing:
        raise ValueError(f"{label}: missing required keys: {', '.join(missing)}")

    decision = _validate_non_empty_string(item["decision"], label, "decision")
    if decision not in ALLOWED_DECISIONS:
        raise ValueError(
            f"[REJECT_BAD_DECISION] {label}: decision must be one of: "
            f"{', '.join(sorted(ALLOWED_DECISIONS))}"
        )

    result = {
        "decision": decision,
        "policy_id": _validate_non_empty_string(item["policy_id"], label, "policy_id"),
        "action_kind": _validate_non_empty_string(item["action_kind"], label, "action_kind"),
        "target_ref": _validate_non_empty_string(item["target_ref"], label, "target_ref"),
        "timestamp": _parse_rfc3339_utc(str(item["timestamp"])),
    }
    if "rule_ref" in item and item["rule_ref"] is not None:
        result["rule_ref"] = _validate_non_empty_string(item["rule_ref"], label, "rule_ref")
    return result


# --- Resume validation ---

RESUMED_REQUIRED_KEYS = {"resume_state_ref", "resumed_at", "resume_decision", "resume_decision_ref"}
RESUMED_OPTIONAL_KEYS = {"policy_snapshot_hash", "resume_nonce", "resumed_from_artifact_hash"}


def _validate_resumed(item: Any, label: str) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise ValueError(f"{label}: resumed must be an object")
    missing = [k for k in RESUMED_REQUIRED_KEYS if k not in item]
    if missing:
        raise ValueError(f"{label}: missing required keys: {', '.join(missing)}")

    decision = _validate_non_empty_string(item["resume_decision"], label, "resume_decision")
    if decision not in ALLOWED_RESUME_DECISIONS:
        raise ValueError(
            f"[REJECT_BAD_RESUME_DECISION] {label}: resume_decision must be one of: "
            f"{', '.join(sorted(ALLOWED_RESUME_DECISIONS))}"
        )

    result = {
        "resume_state_ref": _validate_sha256_ref(item["resume_state_ref"], label, "resume_state_ref"),
        "resumed_at": _parse_rfc3339_utc(str(item["resumed_at"])),
        "resume_decision": decision,
        "resume_decision_ref": _validate_non_empty_string(item["resume_decision_ref"], label, "resume_decision_ref"),
    }
    if "policy_snapshot_hash" in item:
        result["policy_snapshot_hash"] = _validate_sha256_ref(
            item["policy_snapshot_hash"], label, "policy_snapshot_hash"
        )
    if "resume_nonce" in item:
        result["resume_nonce"] = _validate_non_empty_string(
            item["resume_nonce"], label, "resume_nonce"
        )
    if "resumed_from_artifact_hash" in item:
        result["resumed_from_artifact_hash"] = _validate_sha256_ref(
            item["resumed_from_artifact_hash"], label, "resumed_from_artifact_hash"
        )
    return result


# --- Process summary validation ---

PROCESS_SUMMARY_REQUIRED_KEYS = {
    "approval_count", "denied_action_count", "resume_count",
    "allowed_action_count", "total_tool_calls", "timestamp",
}


def _validate_process_summary(item: Any, label: str) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise ValueError(f"{label}: process_summary must be an object")
    missing = [k for k in PROCESS_SUMMARY_REQUIRED_KEYS if k not in item]
    if missing:
        raise ValueError(f"{label}: missing required keys: {', '.join(missing)}")

    result = {}
    for key in ("approval_count", "denied_action_count", "resume_count",
                "allowed_action_count", "total_tool_calls"):
        val = item[key]
        if not isinstance(val, int) or val < 0:
            raise ValueError(f"{label}: {key} must be a non-negative integer")
        result[key] = val
    result["timestamp"] = _parse_rfc3339_utc(str(item["timestamp"]))
    return result


# --- Top-level record validation ---

REJECTED_KEYS = {"raw_run_state", "history", "newItems", "lastResponseId", "session"}


def _normalized_record(record: dict[str, Any]) -> dict[str, Any]:
    # Reject raw state dumps
    for bad_key in REJECTED_KEYS:
        if bad_key in record:
            raise ValueError(
                f"[REJECT_RAW_STATE] artifact: contains rejected key '{bad_key}' — "
                f"raw runtime state must not appear in canonical harness evidence"
            )

    if record.get("schema") != EXTERNAL_SCHEMA:
        raise ValueError(
            f"[REJECT_SCHEMA] artifact: expected schema {EXTERNAL_SCHEMA}, got {record.get('schema')}"
        )
    if record.get("framework") != "openai_agents_sdk":
        raise ValueError("[REJECT_FRAMEWORK] artifact: framework must be openai_agents_sdk")
    if record.get("surface") != "tool_approval":
        raise ValueError("[REJECT_SURFACE] artifact: surface must be tool_approval")

    missing = [key for key in REQUIRED_KEYS if key not in record]
    if missing:
        raise ValueError(
            f"[REJECT_MISSING_KEY] artifact: missing required keys: {', '.join(missing)}"
        )

    pause_reason = _validate_non_empty_string(record["pause_reason"], "artifact", "pause_reason")
    if pause_reason not in ALLOWED_PAUSE_REASONS:
        raise ValueError(
            f"[REJECT_PAUSE_REASON] artifact: pause_reason must be one of: "
            f"{', '.join(sorted(ALLOWED_PAUSE_REASONS))}"
        )

    interruptions = record["interruptions"]
    if not isinstance(interruptions, list):
        raise ValueError("[REJECT_MISSING_INTERRUPTIONS] artifact: interruptions must be a list")
    if not interruptions:
        raise ValueError("[REJECT_EMPTY_INTERRUPTIONS] artifact: interruptions must be a non-empty list")

    normalized = {
        "schema": EXTERNAL_SCHEMA,
        "framework": "openai_agents_sdk",
        "surface": "tool_approval",
        "pause_reason": pause_reason,
        "interruptions": [
            _validate_interruption(item, f"artifact: interruptions[{i}]")
            for i, item in enumerate(interruptions)
        ],
        "resume_state_ref": _validate_sha256_ref(record["resume_state_ref"], "artifact", "resume_state_ref"),
        "timestamp": _parse_rfc3339_utc(str(record["timestamp"])),
    }

    if "active_agent_ref" in record:
        normalized["active_agent_ref"] = _validate_non_empty_string(
            record["active_agent_ref"], "artifact", "active_agent_ref"
        )

    if "policy_snapshot_hash" in record:
        normalized["policy_snapshot_hash"] = _validate_sha256_ref(
            record["policy_snapshot_hash"], "artifact", "policy_snapshot_hash"
        )

    if "resume_nonce" in record:
        normalized["resume_nonce"] = _validate_non_empty_string(
            record["resume_nonce"], "artifact", "resume_nonce"
        )

    if "policy_decisions" in record:
        decisions = record["policy_decisions"]
        if not isinstance(decisions, list):
            raise ValueError("artifact: policy_decisions must be a list")
        normalized["policy_decisions"] = [
            _validate_policy_decision(d, f"artifact: policy_decisions[{i}]")
            for i, d in enumerate(decisions)
        ]

    if "resumed" in record:
        normalized["resumed"] = _validate_resumed(record["resumed"], "artifact")

    if "process_summary" in record:
        normalized["process_summary"] = _validate_process_summary(
            record["process_summary"], "artifact"
        )

    return normalized


# --- Assay envelope builder ---

def _build_events(record: dict[str, Any], assay_run_id: str, import_time: str) -> list[dict[str, Any]]:
    normalized = _normalized_record(record)
    events: list[dict[str, Any]] = []
    seq = 0

    # Event 1: approval interruption
    interruption_data = {
        "external_system": "openai_agents_sdk",
        "external_surface": "tool-approval-interruption",
        "external_schema": EXTERNAL_SCHEMA,
        "observed_upstream_time": normalized["timestamp"],
        "observed": {
            "schema": normalized["schema"],
            "framework": normalized["framework"],
            "surface": normalized["surface"],
            "pause_reason": normalized["pause_reason"],
            "interruptions": normalized["interruptions"],
            "resume_state_ref": normalized["resume_state_ref"],
            "timestamp": normalized["timestamp"],
        },
    }
    if "active_agent_ref" in normalized:
        interruption_data["observed"]["active_agent_ref"] = normalized["active_agent_ref"]
    if "policy_snapshot_hash" in normalized:
        interruption_data["observed"]["policy_snapshot_hash"] = normalized["policy_snapshot_hash"]
    if "resume_nonce" in normalized:
        interruption_data["observed"]["resume_nonce"] = normalized["resume_nonce"]

    event_type = f"{PLACEHOLDER_EVENT_TYPE_PREFIX}.approval-interruption"
    events.append({
        "specversion": "1.0",
        "type": event_type,
        "source": PLACEHOLDER_SOURCE,
        "id": f"{assay_run_id}:{seq}",
        "time": import_time,
        "datacontenttype": "application/json",
        "assayrunid": assay_run_id,
        "assayseq": seq,
        "assayproducer": PLACEHOLDER_PRODUCER,
        "assayproducerversion": PLACEHOLDER_PRODUCER_VERSION,
        "assaygit": PLACEHOLDER_GIT,
        "assaypii": False,
        "assaysecrets": False,
        "assaycontenthash": _compute_assay_content_hash(interruption_data, event_type),
        "data": interruption_data,
    })
    seq += 1

    # Event 2+: policy decisions
    if "policy_decisions" in normalized:
        for pd in normalized["policy_decisions"]:
            pd_data = {
                "external_system": "openai_agents_sdk",
                "external_surface": "policy-decision",
                "external_schema": EXTERNAL_SCHEMA,
                "observed_upstream_time": pd["timestamp"],
                "observed": pd,
            }
            pd_type = f"{PLACEHOLDER_EVENT_TYPE_PREFIX}.policy-decision"
            events.append({
                "specversion": "1.0",
                "type": pd_type,
                "source": PLACEHOLDER_SOURCE,
                "id": f"{assay_run_id}:{seq}",
                "time": import_time,
                "datacontenttype": "application/json",
                "assayrunid": assay_run_id,
                "assayseq": seq,
                "assayproducer": PLACEHOLDER_PRODUCER,
                "assayproducerversion": PLACEHOLDER_PRODUCER_VERSION,
                "assaygit": PLACEHOLDER_GIT,
                "assaypii": False,
                "assaysecrets": False,
                "assaycontenthash": _compute_assay_content_hash(pd_data, pd_type),
                "data": pd_data,
            })
            seq += 1

    # Event: resumed run
    if "resumed" in normalized:
        resumed_data = {
            "external_system": "openai_agents_sdk",
            "external_surface": "resumed-run",
            "external_schema": EXTERNAL_SCHEMA,
            "observed_upstream_time": normalized["resumed"]["resumed_at"],
            "observed": normalized["resumed"],
        }
        resumed_type = f"{PLACEHOLDER_EVENT_TYPE_PREFIX}.resumed-run"
        events.append({
            "specversion": "1.0",
            "type": resumed_type,
            "source": PLACEHOLDER_SOURCE,
            "id": f"{assay_run_id}:{seq}",
            "time": import_time,
            "datacontenttype": "application/json",
            "assayrunid": assay_run_id,
            "assayseq": seq,
            "assayproducer": PLACEHOLDER_PRODUCER,
            "assayproducerversion": PLACEHOLDER_PRODUCER_VERSION,
            "assaygit": PLACEHOLDER_GIT,
            "assaypii": False,
            "assaysecrets": False,
            "assaycontenthash": _compute_assay_content_hash(resumed_data, resumed_type),
            "data": resumed_data,
        })
        seq += 1

    # Event: process summary
    if "process_summary" in normalized:
        summary_data = {
            "external_system": "openai_agents_sdk",
            "external_surface": "process-summary",
            "external_schema": EXTERNAL_SCHEMA,
            "observed_upstream_time": normalized["process_summary"]["timestamp"],
            "observed": normalized["process_summary"],
        }
        summary_type = f"{PLACEHOLDER_EVENT_TYPE_PREFIX}.process-summary"
        events.append({
            "specversion": "1.0",
            "type": summary_type,
            "source": PLACEHOLDER_SOURCE,
            "id": f"{assay_run_id}:{seq}",
            "time": import_time,
            "datacontenttype": "application/json",
            "assayrunid": assay_run_id,
            "assayseq": seq,
            "assayproducer": PLACEHOLDER_PRODUCER,
            "assayproducerversion": PLACEHOLDER_PRODUCER_VERSION,
            "assaygit": PLACEHOLDER_GIT,
            "assaypii": False,
            "assaysecrets": False,
            "assaycontenthash": _compute_assay_content_hash(summary_data, summary_type),
            "data": summary_data,
        })

    return events


# --- CLI ---

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Map one harness approval-interruption artifact into Assay-shaped placeholder envelopes."
    )
    parser.add_argument("input", type=Path, help="Harness artifact to read.")
    parser.add_argument(
        "--output", type=Path, required=True,
        help="Where to write placeholder Assay NDJSON output.",
    )
    parser.add_argument(
        "--import-time", default=None,
        help="RFC3339 UTC timestamp for the Assay envelope time field.",
    )
    parser.add_argument(
        "--assay-run-id", default=None,
        help="Optional Assay run id override. Defaults to import-harness-<stem>.",
    )
    parser.add_argument(
        "--overwrite", action="store_true",
        help="Allow overwriting the output file if it already exists.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.output.exists() and not args.overwrite:
        raise SystemExit(f"{args.output} already exists; pass --overwrite to replace it")

    try:
        with args.input.open("r", encoding="utf-8") as handle:
            record = json.load(handle, object_pairs_hook=_reject_duplicate_keys)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc

    if not isinstance(record, dict):
        raise SystemExit("artifact: top-level JSON value must be an object")

    try:
        import_time = _parse_rfc3339_utc(args.import_time)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    assay_run_id = args.assay_run_id or f"import-harness-{args.input.stem}"

    try:
        events = _build_events(record, assay_run_id, import_time)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        lines = [_canonical_json(event) for event in events]
        args.output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError as exc:
        raise SystemExit(str(exc)) from exc

    print(f"Mapped {len(events)} events to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
