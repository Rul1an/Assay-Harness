"""Build a can_use_tool callback wired to the decision-v1 artifact builder.

Usage:
    from claude_agent_sdk import ClaudeAgentOptions
    from adapters.claude_agent_sdk.agent import build_can_use_tool_callback

    options = ClaudeAgentOptions(
        can_use_tool=build_can_use_tool_callback(
            allow=lambda name, input: should_allow(name, input),
            policy_snapshot_hash="sha256:...",
            emit=lambda artifact: open("evidence.ndjson","a").write(json.dumps(artifact)+"\\n"),
        ),
    )

Scope guards (hard):
  - NO SDK install required to import this module. If claude-agent-sdk
    is not installed we gracefully fall back, so the adapter's pure-unit
    tests run anywhere.
  - NO hidden remote calls. The callback only computes a hash, builds
    an artifact, and calls the consumer's emit function.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from adapters.claude_agent_sdk.evidence import build_policy_decision_artifact


# Consumer-supplied decision function: pure, sync, returns (decision, reason).
DecisionFn = Callable[[str, dict[str, Any]], "tuple[str, str | None]"]

# Consumer-supplied emit function: receives the artifact, does what it wants.
# Typical implementation: append JSON line to a file, or push to a queue.
EmitFn = Callable[[dict[str, Any]], None]


def build_can_use_tool_callback(
    *,
    decide: DecisionFn,
    policy_snapshot_hash: str,
    emit: EmitFn,
) -> Callable[..., Awaitable[Any]]:
    """Return a coroutine compatible with ClaudeAgentOptions.can_use_tool.

    The returned callable has the SDK's CanUseTool shape:
        (tool_name, tool_input, context) -> Awaitable[PermissionResult*]

    We import PermissionResultAllow / PermissionResultDeny lazily so the
    module is importable without the SDK installed (for unit tests).
    """

    async def _can_use_tool(
        tool_name: str,
        tool_input: dict[str, Any],
        context: Any,  # ToolPermissionContext when SDK is present
    ) -> Any:
        # Lazy SDK import so this module is usable in SDK-less environments
        from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

        decision, reason = decide(tool_name, tool_input)
        tool_use_id = getattr(context, "tool_use_id", None)
        agent_id = getattr(context, "agent_id", None)

        artifact = build_policy_decision_artifact(
            tool_name=tool_name,
            tool_input=tool_input,
            tool_use_id=tool_use_id,
            decision=decision,
            policy_snapshot_hash=policy_snapshot_hash,
            decision_reason=reason,
            active_agent_ref=agent_id,
        )
        emit(artifact)

        if decision == "allow":
            return PermissionResultAllow()
        return PermissionResultDeny(message=reason or "denied by policy")

    return _can_use_tool
