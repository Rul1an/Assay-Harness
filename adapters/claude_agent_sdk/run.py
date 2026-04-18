"""Entry point: simulate one can_use_tool invocation and write the artifact.

Usage:
    python3 -m adapters.claude_agent_sdk.run --output /path/to/decision.json
    python3 -m adapters.claude_agent_sdk.run --output - | jq .

This entry point does NOT spin up the Claude Code CLI or call the API.
It wires the adapter callback the same way the SDK would, invokes it
with a constructed context, and writes the artifact produced by
emit_fn. That is enough to validate end-to-end artifact shaping
without external dependencies.

Exit codes:
    0 — artifact written successfully
    2 — SDK not importable (can_use_tool callback cannot build result)
    3 — artifact-build error
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from adapters.claude_agent_sdk.agent import build_can_use_tool_callback


# Placeholder for the demo. In a real integration this would come from
# the policy engine the consumer runs alongside.
PLACEHOLDER_POLICY_SNAPSHOT_HASH = (
    "sha256:0000000000000000000000000000000000000000000000000000000000000000"
)


def demo_decide(tool_name: str, tool_input: dict[str, Any]) -> tuple[str, str | None]:
    """Trivial policy: deny destructive shell commands, allow everything else.

    Intentionally thin. The adapter is the point; the policy engine is
    out of scope.
    """
    if tool_name == "Bash":
        command = str(tool_input.get("command", ""))
        if "rm -rf" in command:
            return "deny", "destructive shell command blocked by demo policy"
    return "allow", None


async def _simulate_one_invocation() -> dict[str, Any]:
    """Invoke the adapter callback with a constructed SDK context."""
    from claude_agent_sdk import ToolPermissionContext

    captured: list[dict[str, Any]] = []
    callback = build_can_use_tool_callback(
        decide=demo_decide,
        policy_snapshot_hash=PLACEHOLDER_POLICY_SNAPSHOT_HASH,
        emit=captured.append,
    )

    ctx = ToolPermissionContext(
        signal=None,
        suggestions=[],
        tool_use_id="toolu_demo_001",
        agent_id=None,
    )
    await callback("Bash", {"command": "ls -la"}, ctx)

    if not captured:
        raise RuntimeError("adapter did not emit an artifact")
    return captured[0]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Tiny Claude Agent SDK Policy-Decision Adapter: simulate one "
            "can_use_tool invocation and emit the policy-decision-v1 artifact."
        ),
    )
    parser.add_argument("--output", required=True, help="Write artifact here, or '-' for stdout.")
    parser.add_argument("--overwrite", action="store_true", help="Allow overwriting an existing file.")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        artifact = asyncio.run(_simulate_one_invocation())
    except ImportError as e:
        print(f"claude-agent-sdk not available: {e}", file=sys.stderr)
        return 2
    except (ValueError, RuntimeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 3

    payload = json.dumps(artifact, indent=2, sort_keys=True)
    if args.output == "-":
        sys.stdout.write(payload + "\n")
        return 0

    out = Path(args.output)
    if out.exists() and not args.overwrite:
        print(f"{out} exists; pass --overwrite to replace", file=sys.stderr)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(payload + "\n")
    print(f"wrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
