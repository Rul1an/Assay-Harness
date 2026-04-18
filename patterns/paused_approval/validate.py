"""Validate a v1 pause-only artifact against the pattern contract.

The validator is strict about v1 boundaries. It rejects any field in
the "not allowed in v1" list from PLAN P23A section 5, and requires
the minimum canonical fields.

Extensions beyond v1 (arguments_hash on interruption items,
policy_snapshot_hash at top level) are tolerated silently when present.
The pattern's minimum does not require them, but lane-specific richer
artifacts are allowed to carry them without breaking pattern validation.
"""

from __future__ import annotations

from typing import Any


SCHEMA = "assay.harness.approval-interruption.v1"
PAUSE_REASON = "tool_approval"
SURFACE = "tool_approval"

REQUIRED_TOP_LEVEL = (
    "schema",
    "framework",
    "surface",
    "pause_reason",
    "interruptions",
    "resume_state_ref",
    "timestamp",
)

OPTIONAL_REVIEWER_AIDS = {"active_agent_ref", "last_agent_ref", "metadata_ref"}

# Tolerated extensions beyond pattern v1. Not required by the pattern
# but allowed when richer lanes naturally carry them.
TOLERATED_EXTENSIONS_TOP_LEVEL = {
    "policy_snapshot_hash",
    "policy_decisions",
}
TOLERATED_EXTENSIONS_INTERRUPTION = {
    "arguments_hash",
}

# Hard forbidden per PLAN P23A section 5 and 11.
FORBIDDEN_TOP_LEVEL = {
    # Resumed / decision lifecycle
    "resumed",
    "resume_decision",
    "resume_decision_ref",
    "resume_nonce",
    "resumed_from_artifact_hash",
    "resumed_at",
    # Raw state / history / session
    "raw_run_state",
    "history",
    "newItems",
    "session",
    "conversation_id",
    "previousResponseId",
    # Process summaries belong to richer artifacts, not pause-only v1
    "process_summary",
}


class PauseArtifactValidationError(ValueError):
    """Raised when an artifact fails pause-v1 pattern validation."""


def _fail(msg: str) -> None:
    raise PauseArtifactValidationError(msg)


def _check_sha256_ref(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value.startswith("sha256:"):
        _fail(f"[REJECT_BAD_STATE_REF] {label} must be a sha256: reference")


def _check_non_empty_string(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value.strip():
        _fail(f"{label} must be a non-empty string")


def validate_pause_artifact(artifact: dict[str, Any]) -> dict[str, Any]:
    """Validate and return the artifact unchanged on success.

    Raises PauseArtifactValidationError on any violation, with a marker
    prefix that mirrors the mapper's rejection style for consistency.
    """
    if not isinstance(artifact, dict):
        _fail("[REJECT_TYPE] artifact must be a dict")

    # Forbidden fields first — surfacing these is the core v1 contract.
    for key in FORBIDDEN_TOP_LEVEL:
        if key in artifact:
            _fail(
                f"[REJECT_FORBIDDEN] pause-v1 artifact must not contain '{key}' — "
                f"see PLAN P23A section 5"
            )

    # Required fields
    missing = [k for k in REQUIRED_TOP_LEVEL if k not in artifact]
    if missing:
        _fail(f"[REJECT_MISSING_KEY] artifact: missing required keys: {', '.join(missing)}")

    if artifact["schema"] != SCHEMA:
        _fail(f"[REJECT_SCHEMA] artifact: expected schema {SCHEMA}, got {artifact['schema']!r}")

    _check_non_empty_string(artifact["framework"], "framework")

    if artifact["surface"] != SURFACE:
        _fail(f"[REJECT_SURFACE] artifact: surface must be {SURFACE!r}, got {artifact['surface']!r}")

    if artifact["pause_reason"] != PAUSE_REASON:
        _fail(
            f"[REJECT_PAUSE_REASON] artifact: pause_reason must be {PAUSE_REASON!r}, "
            f"got {artifact['pause_reason']!r}"
        )

    _check_non_empty_string(artifact["timestamp"], "timestamp")
    _check_sha256_ref(artifact["resume_state_ref"], "resume_state_ref")

    # resume_state_ref must not be a URL
    if artifact["resume_state_ref"].startswith("sha256:http"):
        _fail("[REJECT_BAD_STATE_REF] resume_state_ref must not be a URL")

    interruptions = artifact["interruptions"]
    if not isinstance(interruptions, list):
        _fail("[REJECT_TYPE] interruptions must be a list")
    if not interruptions:
        _fail("[REJECT_EMPTY_INTERRUPTIONS] interruptions must be a non-empty list")

    for idx, item in enumerate(interruptions):
        label = f"interruptions[{idx}]"
        if not isinstance(item, dict):
            _fail(f"[REJECT_TYPE] {label} must be a dict")
        _check_non_empty_string(item.get("tool_name"), f"{label}.tool_name")
        _check_non_empty_string(item.get("call_id_ref"), f"{label}.call_id_ref")

        # Reject unknown fields on interruption items, except tolerated extensions.
        allowed = {"tool_name", "call_id_ref"} | TOLERATED_EXTENSIONS_INTERRUPTION
        unknown = set(item) - allowed
        if unknown:
            _fail(
                f"[REJECT_UNKNOWN_KEY] {label} has unsupported keys: {', '.join(sorted(unknown))}"
            )

    # Reject unknown top-level fields
    allowed_top = (
        set(REQUIRED_TOP_LEVEL) | OPTIONAL_REVIEWER_AIDS | TOLERATED_EXTENSIONS_TOP_LEVEL
    )
    unknown_top = set(artifact) - allowed_top
    if unknown_top:
        _fail(
            f"[REJECT_UNKNOWN_KEY] artifact has unsupported top-level keys: "
            f"{', '.join(sorted(unknown_top))}"
        )

    # Optional reviewer aids must be non-empty strings if present
    for aid in OPTIONAL_REVIEWER_AIDS:
        if aid in artifact:
            _check_non_empty_string(artifact[aid], aid)

    # Tolerated extensions (if present) must still have sane shape
    if "policy_snapshot_hash" in artifact:
        _check_sha256_ref(artifact["policy_snapshot_hash"], "policy_snapshot_hash")

    return artifact
