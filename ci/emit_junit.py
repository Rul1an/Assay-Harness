"""Emit JUnit XML from Assay harness evidence NDJSON."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom.minidom import parseString


def _read_events(path: Path) -> list[dict[str, Any]]:
    events = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def _build_junit(events: list[dict[str, Any]], suite_name: str) -> str:
    testsuites = Element("testsuites")
    testsuite = SubElement(testsuites, "testsuite", {
        "name": suite_name,
        "tests": str(len(events)),
        "failures": "0",
        "errors": "0",
    })

    failures = 0
    for event in events:
        event_type = event.get("type", "unknown")
        short_type = event_type.rsplit(".", 1)[-1]
        data = event.get("data", {})
        observed = data.get("observed", {})

        testcase = SubElement(testsuite, "testcase", {
            "name": f"{short_type}:{event.get('id', 'unknown')}",
            "classname": f"assay.harness.{short_type}",
            "time": "0",
        })

        # Policy decisions: denied actions are failures
        if event_type.endswith("policy-decision"):
            decision = observed.get("decision", "unknown")
            target = observed.get("target_ref", "unknown")
            if decision == "deny":
                failures += 1
                failure = SubElement(testcase, "failure", {
                    "message": f"Policy denied: {target}",
                    "type": "PolicyDenial",
                })
                failure.text = json.dumps(observed, indent=2)

        # Process summary: check for denied actions
        if event_type.endswith("process-summary"):
            denied = observed.get("denied_action_count", 0)
            if denied > 0:
                prop = SubElement(testcase, "system-out")
                prop.text = f"denied_action_count={denied}"

    testsuite.set("failures", str(failures))

    raw = tostring(testsuites, encoding="unicode")
    return parseString(raw).toprettyxml(indent="  ", encoding=None)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Emit JUnit XML from Assay harness evidence NDJSON."
    )
    parser.add_argument("input", type=Path, help="Evidence NDJSON file.")
    parser.add_argument("--output", type=Path, required=True, help="JUnit XML output path.")
    parser.add_argument("--suite-name", default="assay-harness", help="Test suite name.")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Input file not found: {args.input}", file=sys.stderr)
        return 2

    events = _read_events(args.input)
    xml_str = _build_junit(events, args.suite_name)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(xml_str, encoding="utf-8")
    print(f"Wrote JUnit XML ({len(events)} test cases) to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
