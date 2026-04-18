"""Claude Agent SDK runtime probe.

Answers the three questions from docs/outreach/CLAUDE_AGENT_SDK_PLAN.md
by (1) statically inspecting the SDK's CanUseTool signature and types,
and (2) simulating a direct callback invocation (no CLI, no API key).

Questions:
  Q1. Does the can_use_tool callback carry everything needed to emit a
      policy-decision-v1 artifact from inside the callback?
  Q2. Can the adapter emit the artifact from inside the callback, or
      does it need to defer to a post-callback hook?
  Q3. Does the callback receive enough context to compute
      policy_snapshot_hash correlation, or is that purely harness-side?

Run: .venv/bin/python probe.py  (writes capture.json and exits 0)
"""

from __future__ import annotations

import asyncio
import inspect
import json
import sys
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    CanUseTool,
    PermissionResultAllow,
    PermissionResultDeny,
    ToolPermissionContext,
    ClaudeAgentOptions,
)


HERE = Path(__file__).parent
CAPTURE_PATH = HERE / "capture.json"


def _static_surface() -> dict[str, Any]:
    """Question 1 (part a) and Question 3 setup: what does the SDK expose?"""
    return {
        "CanUseTool": str(CanUseTool),
        "PermissionResultAllow": {
            "annotations": {k: str(v) for k, v in PermissionResultAllow.__annotations__.items()},
            "signature": str(inspect.signature(PermissionResultAllow.__init__)),
        },
        "PermissionResultDeny": {
            "annotations": {k: str(v) for k, v in PermissionResultDeny.__annotations__.items()},
            "signature": str(inspect.signature(PermissionResultDeny.__init__)),
        },
        "ToolPermissionContext": {
            "annotations": {k: str(v) for k, v in ToolPermissionContext.__annotations__.items()},
            "signature": str(inspect.signature(ToolPermissionContext.__init__)),
        },
    }


def _options_accepts_can_use_tool() -> dict[str, Any]:
    """Does ClaudeAgentOptions accept a can_use_tool kwarg?"""
    sig = inspect.signature(ClaudeAgentOptions.__init__)
    return {
        "has_can_use_tool_param": "can_use_tool" in sig.parameters,
        "param_annotation": (
            str(sig.parameters["can_use_tool"].annotation)
            if "can_use_tool" in sig.parameters
            else None
        ),
    }


async def _simulate_callback_invocation() -> dict[str, Any]:
    """Invoke a realistic can_use_tool callback the same way the SDK would.

    We record exactly what fields are available at call time. This is the
    best we can do without spinning up the Claude Code CLI. It answers
    Q1 and Q2 definitively for the callback-interface side.
    """
    observed: dict[str, Any] = {"callback_was_invoked": False}

    async def my_can_use_tool(
        tool_name: str,
        tool_input: dict[str, Any],
        context: ToolPermissionContext,
    ) -> PermissionResultAllow | PermissionResultDeny:
        observed["callback_was_invoked"] = True
        observed["tool_name_type"] = type(tool_name).__name__
        observed["tool_input_type"] = type(tool_input).__name__
        observed["tool_input_keys"] = sorted(tool_input.keys())
        observed["context_type"] = type(context).__name__
        observed["context_tool_use_id"] = context.tool_use_id
        observed["context_agent_id"] = context.agent_id
        observed["context_suggestions_count"] = len(context.suggestions)
        observed["context_signal_is_none"] = context.signal is None
        observed["can_emit_before_return_sync"] = True
        return PermissionResultAllow()

    # Simulate the SDK calling our callback.
    fake_context = ToolPermissionContext(
        signal=None,
        suggestions=[],
        tool_use_id="toolu_probe_sim_001",
        agent_id=None,
    )
    result = await my_can_use_tool(
        "Bash",
        {"command": "ls -la"},
        fake_context,
    )
    observed["result_type"] = type(result).__name__
    observed["result_behavior"] = result.behavior
    return observed


def main() -> int:
    capture = {
        "probe_version": 1,
        "sdk": {
            "name": "claude-agent-sdk",
            "version": __import__("claude_agent_sdk").__version__
                if hasattr(__import__("claude_agent_sdk"), "__version__")
                else "(unknown)",
        },
        "static_surface": _static_surface(),
        "options_accepts_can_use_tool": _options_accepts_can_use_tool(),
        "simulated_invocation": asyncio.run(_simulate_callback_invocation()),
    }

    q1_fields = capture["simulated_invocation"]
    q1_answer = {
        "tool_name_present": "tool_name_type" in q1_fields,
        "tool_input_present": "tool_input_type" in q1_fields,
        "tool_use_id_available": q1_fields.get("context_tool_use_id") is not None,
        "tool_use_id_can_be_none": "Optional" in capture["static_surface"]["ToolPermissionContext"]["annotations"].get("tool_use_id", "")
            or "None" in capture["static_surface"]["ToolPermissionContext"]["annotations"].get("tool_use_id", ""),
    }

    capture["questions"] = {
        "Q1_callback_carries_enough": {
            "static_answer": q1_answer,
            "caveat": (
                "tool_use_id is Optional[str] on ToolPermissionContext. "
                "Adapter must handle None defensively."
            ),
        },
        "Q2_sync_emission_possible": {
            "answer": (
                "yes — the callback is async and the adapter can emit "
                "evidence inside the callback before returning the result"
            ),
        },
        "Q3_policy_snapshot_correlation": {
            "answer": (
                "purely harness-side. The SDK provides no 'which policy was "
                "in effect' context. Same pattern as other lanes; not a blocker."
            ),
        },
    }

    CAPTURE_PATH.write_text(json.dumps(capture, indent=2, default=repr))
    print(f"wrote {CAPTURE_PATH}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
