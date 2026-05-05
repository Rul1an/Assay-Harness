"""Policy-decision-v1 artifact builder for the tiny Claude Agent SDK adapter.

Core responsibilities:
  1. Hash tool_input (raw args never enter the artifact).
  2. Map SDK permission results to the decision-v1 outcome field.
  3. Treat missing tool_use_id as malformed for the can_use_tool path.
  4. Shape the artifact to pass mapper/map_to_assay.py validation for
     framework=claude_agent_sdk, surface=per_call_permission.

Scope guards (hard):
  - NO policy engine integration. policy_snapshot_hash is accepted from
    the caller, never computed here.
  - NO transcript, conversation history, or SDK-session capture.
  - NO hook system involvement (PreToolUse, PostToolUse, etc.).
  - NO subagent correlation logic beyond optional active_agent_ref
    from context.agent_id.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


ARTIFACT_SCHEMA = "assay.harness.policy-decision.v1"
FRAMEWORK_NAME = "claude_agent_sdk"
SURFACE = "per_call_permission"
ALLOWED_DECISIONS = ("allow", "deny")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def _sha256(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_tool_input(tool_input: dict[str, Any]) -> str:
    """Bounded hash of tool arguments. Raw args NEVER enter the artifact."""
    return _sha256(_canonical_json(tool_input))


def resolve_tool_use_id(raw: str | None) -> str:
    """Return the required can_use_tool tool_use_id.

    Anthropic clarified in anthropics/claude-agent-sdk-python#844 that
    tool_use_id is always populated on the can_use_tool control path.
    The Python Optional typing exists for dataclass field-ordering
    compatibility, not because normal can_use_tool callbacks omit it.
    """
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    raise ValueError("tool_use_id is required on the can_use_tool path")


def build_policy_decision_artifact(
    *,
    tool_name: str,
    tool_input: dict[str, Any],
    tool_use_id: str | None,
    decision: str,
    policy_snapshot_hash: str,
    decision_reason: str | None = None,
    active_agent_ref: str | None = None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    """Build a decision-v1 artifact from a can_use_tool invocation.

    policy_snapshot_hash is the consumer's harness-side identifier for
    the policy version in effect. The adapter does not compute it.

    decision_reason is optional but strongly encouraged when decision is
    deny, matching the SDK's PermissionResultDeny.message field.
    """
    if decision not in ALLOWED_DECISIONS:
        raise ValueError(
            f"decision must be one of {ALLOWED_DECISIONS}; got {decision!r}"
        )
    if not isinstance(tool_name, str) or not tool_name.strip():
        raise ValueError("tool_name must be a non-empty string")
    if not isinstance(policy_snapshot_hash, str) or not policy_snapshot_hash.startswith("sha256:"):
        raise ValueError("policy_snapshot_hash must be a sha256: reference")

    resolved_id = resolve_tool_use_id(tool_use_id)

    artifact: dict[str, Any] = {
        "schema": ARTIFACT_SCHEMA,
        "framework": FRAMEWORK_NAME,
        "surface": SURFACE,
        "decision": decision,
        "tool_name": tool_name,
        "tool_use_id": resolved_id,
        "arguments_hash": hash_tool_input(tool_input),
        "policy_snapshot_hash": policy_snapshot_hash,
        "timestamp": timestamp or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if decision_reason is not None:
        if not isinstance(decision_reason, str) or not decision_reason.strip():
            raise ValueError("decision_reason, if present, must be a non-empty string")
        artifact["decision_reason"] = decision_reason
    if active_agent_ref is not None:
        if not isinstance(active_agent_ref, str) or not active_agent_ref.strip():
            raise ValueError("active_agent_ref, if present, must be a non-empty string")
        artifact["active_agent_ref"] = active_agent_ref
    return artifact
