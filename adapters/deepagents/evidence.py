"""Pause-v1 artifact builder for the tiny Deep Agents adapter.

Core responsibilities:
  1. Correlate ActionRequest entries to originating tool_calls (Q1 caveat
     from the probe: HITLRequest.action_requests does NOT carry
     tool_call_id; it is reached via state snapshot message tool_calls).
  2. Derive continuation_anchor_ref as a content hash of the canonicalized
     StateSnapshot values (Q2 finding: public agent.get_state surface,
     app-level fingerprint, not byte-stable across LangGraph versions).
  3. Hash tool arguments (pause-v1 contract: raw args never in the artifact).

Scope guards (hard):
  - NO resumed artifact here. Pause-only.
  - NO policy engine integration. policy_snapshot_hash is accepted from
    the caller but never computed here.
  - NO subagent correlation logic.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


ARTIFACT_SCHEMA = "assay.harness.approval-interruption.v1"
FRAMEWORK_NAME = "langgraph_deepagents"
SURFACE = "tool_approval"
PAUSE_REASON = "tool_approval"


def _canonical_json(value: Any) -> str:
    """Stable JSON serialization: sorted keys, no whitespace, no NaN."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def _sha256(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_arguments(args: dict[str, Any]) -> str:
    """Bounded hash of tool arguments. Raw args NEVER enter the artifact."""
    return _sha256(_canonical_json(args))


def _message_to_stable_dict(msg: Any) -> dict[str, Any]:
    """Reduce a LangChain message to a stable, hashable dict subset.

    We do NOT use msg.model_dump() directly because it can carry
    provider-specific fields (usage metadata, response ids) that vary
    across runs without changing the semantic state. We keep only the
    fields that would matter for deciding whether two pauses are at the
    same logical point.
    """
    d = msg.model_dump() if hasattr(msg, "model_dump") else dict(msg)
    keep = {}
    for field in ("type", "content", "tool_calls", "tool_call_id", "name"):
        if field in d and d[field] is not None:
            keep[field] = d[field]
    return keep


def compute_continuation_anchor_ref(state_values: dict[str, Any]) -> str:
    """Derive continuation_anchor_ref from a StateSnapshot.values dict.

    This is an app-level fingerprint. It is explicitly NOT a byte-stable
    LangGraph-version identifier; see docs and README for the stability
    contract.
    """
    stable: dict[str, Any] = {}
    for key, value in state_values.items():
        if key == "messages" and isinstance(value, list):
            stable[key] = [_message_to_stable_dict(m) for m in value]
        else:
            stable[key] = value
    return _sha256(_canonical_json(stable))


def correlate_action_requests_to_tool_calls(
    action_requests: list[dict[str, Any]],
    tool_calls: list[dict[str, Any]],
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Match ActionRequest entries to originating tool_calls.

    Correlation rules (in order):
      1. Match by (name, args) equality. This is the strongest signal and
         handles the same-tool-called-twice case.
      2. Fall back to order-preserving match by name when args differ
         only in ordering.

    Raises ValueError if any ActionRequest cannot be paired.

    This function is the "adapter-derived correlation across two public
    surfaces" called out in FINDINGS.md Q1. It is an adapter concern, not
    a runtime feature of Deep Agents today.
    """
    remaining = list(tool_calls)
    pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for ar in action_requests:
        name = ar.get("name")
        args = ar.get("args", {})
        matched = None
        for i, tc in enumerate(remaining):
            if tc.get("name") == name and tc.get("args") == args:
                matched = remaining.pop(i)
                break
        if matched is None:
            # Fallback: first tool_call with matching name
            for i, tc in enumerate(remaining):
                if tc.get("name") == name:
                    matched = remaining.pop(i)
                    break
        if matched is None:
            raise ValueError(
                f"correlation failed: no tool_call matches ActionRequest name={name!r}"
            )
        if "id" not in matched or not matched["id"]:
            raise ValueError(
                f"correlation produced a tool_call without an id for name={name!r}"
            )
        pairs.append((ar, matched))
    return pairs


def build_pause_artifact(
    *,
    action_requests: list[dict[str, Any]],
    tool_calls_on_last_ai_message: list[dict[str, Any]],
    state_values: dict[str, Any],
    policy_snapshot_hash: str,
    active_agent_ref: str | None = None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    """Build a pause-v1 artifact from the pause-boundary inputs.

    The caller is responsible for having captured action_requests from the
    Interrupt.value at the pause, and for having read tool_calls from the
    last AIMessage on the StateSnapshot. This function does the
    correlation + hashing + artifact shaping.

    policy_snapshot_hash is accepted as a parameter; the adapter does not
    compute or own it. Resume-decision fields (resume_nonce,
    resumed_from_artifact_hash, decision outcome) are DELIBERATELY absent
    from pause-v1 per docs/outreach/DEEPAGENTS_PREP.md.
    """
    pairs = correlate_action_requests_to_tool_calls(
        action_requests, tool_calls_on_last_ai_message
    )

    interruptions = []
    for action_request, tool_call in pairs:
        interruptions.append(
            {
                "tool_name": action_request["name"],
                "tool_call_id": tool_call["id"],
                "arguments_hash": hash_arguments(action_request.get("args", {})),
            }
        )

    if not interruptions:
        raise ValueError(
            "pause artifact must contain at least one interruption "
            "(pause-v1 contract: empty interruptions is malformed)"
        )

    artifact: dict[str, Any] = {
        "schema": ARTIFACT_SCHEMA,
        "framework": FRAMEWORK_NAME,
        "surface": SURFACE,
        "pause_reason": PAUSE_REASON,
        "interruptions": interruptions,
        "continuation_anchor_ref": compute_continuation_anchor_ref(state_values),
        "policy_snapshot_hash": policy_snapshot_hash,
        "timestamp": timestamp or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if active_agent_ref:
        artifact["active_agent_ref"] = active_agent_ref
    return artifact
