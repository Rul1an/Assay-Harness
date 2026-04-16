"""Emit SARIF 2.1.0 from Assay harness evidence NDJSON."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


SARIF_SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json"
SARIF_VERSION = "2.1.0"

RULES = {
    "HARNESS-D001": {
        "id": "HARNESS-D001",
        "name": "PolicyDenial",
        "shortDescription": {"text": "Tool call denied by policy"},
        "fullDescription": {"text": "A tool call was denied by the harness policy engine. The agent attempted an action that is not allowed."},
        "defaultConfiguration": {"level": "error"},
        "properties": {"security-severity": "7.0"},
    },
    "HARNESS-A001": {
        "id": "HARNESS-A001",
        "name": "ApprovalRequired",
        "shortDescription": {"text": "Tool call requires human approval"},
        "fullDescription": {"text": "A tool call was paused for human approval. The harness interrupted the agent run."},
        "defaultConfiguration": {"level": "warning"},
        "properties": {"security-severity": "5.0"},
    },
    "HARNESS-R001": {
        "id": "HARNESS-R001",
        "name": "RunResumed",
        "shortDescription": {"text": "Agent run resumed after approval"},
        "fullDescription": {"text": "The agent run was resumed from a previous approval interruption."},
        "defaultConfiguration": {"level": "note"},
    },
}


def _read_events(path: Path) -> list[dict[str, Any]]:
    events = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def _build_sarif(events: list[dict[str, Any]], tool_name: str) -> dict[str, Any]:
    results: list[dict[str, Any]] = []

    for event in events:
        event_type = event.get("type", "unknown")
        data = event.get("data", {})
        observed = data.get("observed", {})
        event_id = event.get("id", "unknown")

        if event_type.endswith("policy-decision"):
            decision = observed.get("decision", "unknown")
            target = observed.get("target_ref", "unknown")

            if decision == "deny":
                results.append({
                    "ruleId": "HARNESS-D001",
                    "level": "error",
                    "message": {"text": f"Policy denied tool call: {target}"},
                    "partialFingerprints": {"eventId": event_id},
                    "properties": {
                        "decision": decision,
                        "target_ref": target,
                        "policy_id": observed.get("policy_id", "unknown"),
                        "rule_ref": observed.get("rule_ref"),
                    },
                })
            elif decision == "require_approval":
                results.append({
                    "ruleId": "HARNESS-A001",
                    "level": "warning",
                    "message": {"text": f"Tool call requires approval: {target}"},
                    "partialFingerprints": {"eventId": event_id},
                    "properties": {
                        "decision": decision,
                        "target_ref": target,
                        "policy_id": observed.get("policy_id", "unknown"),
                    },
                })

        elif event_type.endswith("resumed-run"):
            resume_decision = observed.get("resume_decision", "unknown")
            results.append({
                "ruleId": "HARNESS-R001",
                "level": "note",
                "message": {"text": f"Run resumed with decision: {resume_decision}"},
                "partialFingerprints": {"eventId": event_id},
                "properties": {
                    "resume_decision": resume_decision,
                    "resume_state_ref": observed.get("resume_state_ref", "unknown"),
                },
            })

    return {
        "$schema": SARIF_SCHEMA,
        "version": SARIF_VERSION,
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": tool_name,
                        "version": "0.1.0",
                        "informationUri": "https://github.com/Rul1an/Assay-Harness",
                        "rules": list(RULES.values()),
                    },
                },
                "results": results,
                "automationDetails": {
                    "id": f"{tool_name}/harness-evidence/",
                },
            },
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Emit SARIF 2.1.0 from Assay harness evidence NDJSON."
    )
    parser.add_argument("input", type=Path, help="Evidence NDJSON file.")
    parser.add_argument("--output", type=Path, required=True, help="SARIF JSON output path.")
    parser.add_argument("--tool-name", default="assay-harness", help="SARIF tool name.")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Input file not found: {args.input}", file=sys.stderr)
        return 2

    events = _read_events(args.input)
    sarif = _build_sarif(events, args.tool_name)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(sarif, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote SARIF ({len(sarif['runs'][0]['results'])} results) to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
