"""Entry point: run the agent to a pause and emit the pause-v1 artifact.

Usage:
    python3 -m adapters.deepagents.run --output /path/to/pause.json
    python3 -m adapters.deepagents.run --output - | jq .

Exit codes:
    0 — artifact written successfully
    2 — no interrupt fired (unexpected; the sample is engineered to pause)
    3 — correlation or artifact-build error

Scope guards (hard):
  - NO resume is performed here. The adapter stops at the pause.
  - NO writing to fixtures/ from this script; that is a separate commit.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage

from adapters.deepagents.agent import AGENT_NAME, build_agent
from adapters.deepagents.evidence import build_pause_artifact


# A harness-supplied placeholder. In a real integration this would come
# from the policy engine (same pattern as the JS adapter).
PLACEHOLDER_POLICY_SNAPSHOT_HASH = (
    "sha256:0000000000000000000000000000000000000000000000000000000000000000"
)


def _extract_interrupt_value(result: dict[str, Any]) -> dict[str, Any]:
    """Pull the HITLRequest dict out of the __interrupt__ key.

    The key holds a list of Interrupt objects; each has .value which is
    the HITLRequest (action_requests + review_configs). We only exercise
    a single-interrupt scenario here.
    """
    interrupts = result.get("__interrupt__")
    if not interrupts:
        raise RuntimeError("no interrupt in result; the adapter expected to pause")
    first = interrupts[0]
    value = first.value if hasattr(first, "value") else first["value"]
    if not isinstance(value, dict) or "action_requests" not in value:
        raise RuntimeError(f"unexpected interrupt value shape: {type(value).__name__}")
    return value


def _last_ai_tool_calls(snapshot_messages: list[Any]) -> list[dict[str, Any]]:
    """Extract the last AIMessage's tool_calls as plain dicts."""
    for msg in reversed(snapshot_messages):
        if isinstance(msg, AIMessage) and msg.tool_calls:
            return [dict(tc) for tc in msg.tool_calls]
    raise RuntimeError("no AIMessage with tool_calls found in state snapshot")


def run_to_pause_and_build_artifact() -> dict[str, Any]:
    """Execute the agent until it pauses and produce the pause-v1 artifact."""
    agent, config = build_agent()
    result = agent.invoke(
        {"messages": [{"role": "user", "content": "please run ls -la"}]},
        config=config,
    )
    hitl_value = _extract_interrupt_value(result)
    snapshot = agent.get_state(config)
    tool_calls = _last_ai_tool_calls(snapshot.values.get("messages", []))

    artifact = build_pause_artifact(
        action_requests=hitl_value["action_requests"],
        tool_calls_on_last_ai_message=tool_calls,
        state_values=snapshot.values,
        policy_snapshot_hash=PLACEHOLDER_POLICY_SNAPSHOT_HASH,
        active_agent_ref=AGENT_NAME,
    )
    return artifact


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Tiny Deep Agents Pause Adapter: run to pause, emit pause-v1 artifact.",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Write pause artifact JSON here. Use '-' for stdout.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Allow overwriting an existing file.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        artifact = run_to_pause_and_build_artifact()
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except ValueError as e:
        print(f"artifact build error: {e}", file=sys.stderr)
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
