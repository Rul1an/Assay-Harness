"""Emit the v1 pause-only artifact.

Canonical shape per PLAN P23A section 5:
    required: schema, framework, surface, pause_reason, interruptions,
              resume_state_ref, timestamp
    optional (weak reviewer aids): active_agent_ref, last_agent_ref,
              metadata_ref

Interruption items per section 6 carry only tool_name + call_id_ref
plus optional weak reviewer aids.

Forbidden in v1: raw serialized state, transcript, newItems, session
ids, provider chaining, resumed decision fields, resume_nonce,
resumed_from_artifact_hash.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


SCHEMA = "assay.harness.approval-interruption.v1"
PAUSE_REASON = "tool_approval"
SURFACE = "tool_approval"
OPTIONAL_TOP_LEVEL_REVIEWER_AIDS = ("active_agent_ref", "last_agent_ref", "metadata_ref")


def emit_pause_artifact(
    *,
    framework: str,
    interruptions: list[dict[str, Any]],
    resume_state_ref: str,
    timestamp: str | None = None,
    active_agent_ref: str | None = None,
    last_agent_ref: str | None = None,
    metadata_ref: str | None = None,
) -> dict[str, Any]:
    """Build a v1 pause-only artifact.

    Callers typically produce `interruptions` via
    `capture.capture_paused_approval(...)` and `resume_state_ref` via
    `fingerprint.derive_resume_state_ref(...)`.
    """
    if not isinstance(framework, str) or not framework.strip():
        raise ValueError("framework must be a non-empty string")
    if not isinstance(resume_state_ref, str) or not resume_state_ref.startswith("sha256:"):
        raise ValueError("resume_state_ref must be a sha256: reference")
    if not isinstance(interruptions, list) or not interruptions:
        raise ValueError("interruptions must be a non-empty list")
    for idx, item in enumerate(interruptions):
        if not isinstance(item, dict):
            raise ValueError(f"interruptions[{idx}] must be a dict")
        if "tool_name" not in item or "call_id_ref" not in item:
            raise ValueError(
                f"interruptions[{idx}] must carry tool_name and call_id_ref"
            )

    artifact: dict[str, Any] = {
        "schema": SCHEMA,
        "framework": framework,
        "surface": SURFACE,
        "pause_reason": PAUSE_REASON,
        "interruptions": [
            {"tool_name": item["tool_name"], "call_id_ref": item["call_id_ref"]}
            for item in interruptions
        ],
        "resume_state_ref": resume_state_ref,
        "timestamp": timestamp or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    for name, value in (
        ("active_agent_ref", active_agent_ref),
        ("last_agent_ref", last_agent_ref),
        ("metadata_ref", metadata_ref),
    ):
        if value is not None:
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name}, if present, must be a non-empty string")
            artifact[name] = value
    return artifact
