"""Emit SARIF 2.1.0 from Assay harness compare result JSON."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


SARIF_SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json"
SARIF_VERSION = "2.1.0"

RULES = {
    "HARNESS-C001": {
        "id": "HARNESS-C001",
        "name": "NewDenial",
        "shortDescription": {"text": "New policy denial in candidate"},
        "fullDescription": {"text": "A policy denial exists in the candidate that was not present in the baseline. This indicates a regression."},
        "defaultConfiguration": {"level": "error"},
        "properties": {"security-severity": "8.0"},
    },
    "HARNESS-C002": {
        "id": "HARNESS-C002",
        "name": "HashMismatch",
        "shortDescription": {"text": "Evidence hash mismatch between baseline and candidate"},
        "fullDescription": {"text": "An evidence event has a different hash in the candidate compared to the baseline, indicating the event content has changed."},
        "defaultConfiguration": {"level": "error"},
        "properties": {"security-severity": "7.0"},
    },
    "HARNESS-C003": {
        "id": "HARNESS-C003",
        "name": "NewEventType",
        "shortDescription": {"text": "New event type in candidate"},
        "fullDescription": {"text": "The candidate contains an event type that was not present in the baseline."},
        "defaultConfiguration": {"level": "warning"},
        "properties": {"security-severity": "4.0"},
    },
    "HARNESS-C004": {
        "id": "HARNESS-C004",
        "name": "ProcessCounterDrift",
        "shortDescription": {"text": "Process counter changed between baseline and candidate"},
        "fullDescription": {"text": "A process summary counter has drifted between the baseline and the candidate."},
        "defaultConfiguration": {"level": "note"},
    },
}


def _build_sarif(compare_result: dict[str, Any], tool_name: str) -> dict[str, Any]:
    results: list[dict[str, Any]] = []

    for denial in compare_result.get("new_denials", []):
        target = denial.get("target_ref", "unknown")
        policy = denial.get("policy_id", "unknown")
        results.append({
            "ruleId": "HARNESS-C001",
            "level": "error",
            "message": {"text": f"New denial: {target} (policy: {policy})"},
            "properties": {
                "target_ref": target,
                "policy_id": policy,
            },
        })

    for mismatch in compare_result.get("hash_mismatches", []):
        evt_type = mismatch.get("type", "unknown")
        seq = mismatch.get("assayseq", 0)
        results.append({
            "ruleId": "HARNESS-C002",
            "level": "error",
            "message": {
                "text": f"Hash mismatch on {evt_type} (seq {seq}): "
                        f"baseline={mismatch.get('baseline_hash', '?')} "
                        f"candidate={mismatch.get('candidate_hash', '?')}",
            },
            "properties": {
                "event_type": evt_type,
                "assayseq": seq,
                "baseline_hash": mismatch.get("baseline_hash"),
                "candidate_hash": mismatch.get("candidate_hash"),
            },
        })

    for evt_type in compare_result.get("new_event_types", []):
        results.append({
            "ruleId": "HARNESS-C003",
            "level": "warning",
            "message": {"text": f"New event type in candidate: {evt_type}"},
            "properties": {
                "event_type": evt_type,
            },
        })

    for delta in compare_result.get("process_summary_delta", []):
        field = delta.get("field", "unknown")
        results.append({
            "ruleId": "HARNESS-C004",
            "level": "note",
            "message": {
                "text": f"Process counter drift: {field} "
                        f"({delta.get('baseline', 0)} -> {delta.get('candidate', 0)}, "
                        f"delta={delta.get('delta', 0)})",
            },
            "properties": {
                "field": field,
                "baseline": delta.get("baseline", 0),
                "candidate": delta.get("candidate", 0),
                "delta": delta.get("delta", 0),
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
                    "id": f"{tool_name}/compare-regression/",
                },
            },
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Emit SARIF 2.1.0 from Assay harness compare result JSON."
    )
    parser.add_argument("input", type=Path, help="Compare result JSON file.")
    parser.add_argument("--output", type=Path, required=True, help="SARIF JSON output path.")
    parser.add_argument("--tool-name", default="assay-harness-compare", help="SARIF tool name.")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Input file not found: {args.input}", file=sys.stderr)
        return 2

    compare_result = json.loads(args.input.read_text(encoding="utf-8"))
    sarif = _build_sarif(compare_result, args.tool_name)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(sarif, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote SARIF ({len(sarif['runs'][0]['results'])} results) to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
