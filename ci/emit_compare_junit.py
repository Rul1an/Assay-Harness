"""Emit JUnit XML from Assay harness compare result JSON."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom.minidom import parseString


SUITE_NAME = "assay-harness-compare"


def _build_junit(compare_result: dict[str, Any], suite_name: str) -> str:
    testsuites = Element("testsuites")
    testsuite = SubElement(testsuites, "testsuite", {
        "name": suite_name,
        "tests": "0",
        "failures": "0",
        "errors": "0",
    })

    cases: list[Element] = []
    failures = 0

    # --- Regression findings (failures) ---

    # New denials
    for denial in compare_result.get("new_denials", []):
        target = denial.get("target_ref", "unknown")
        policy = denial.get("policy_id", "unknown")
        tc = SubElement(testsuite, "testcase", {
            "name": f"new_denial:{target}",
            "classname": "assay.harness.compare.denial",
            "time": "0",
        })
        failures += 1
        fail = SubElement(tc, "failure", {
            "message": f"New denial: {target} (policy: {policy})",
            "type": "NewDenial",
        })
        fail.text = json.dumps(denial, indent=2)
        cases.append(tc)

    # Hash mismatches
    for mismatch in compare_result.get("hash_mismatches", []):
        evt_type = mismatch.get("type", "unknown")
        seq = mismatch.get("assayseq", 0)
        tc = SubElement(testsuite, "testcase", {
            "name": f"hash_mismatch:seq_{seq}:{evt_type}",
            "classname": "assay.harness.compare.hash",
            "time": "0",
        })
        failures += 1
        fail = SubElement(tc, "failure", {
            "message": (
                f"Hash mismatch on {evt_type} (seq {seq}): "
                f"baseline={mismatch.get('baseline_hash', '?')} "
                f"candidate={mismatch.get('candidate_hash', '?')}"
            ),
            "type": "HashMismatch",
        })
        fail.text = json.dumps(mismatch, indent=2)
        cases.append(tc)

    # New event types
    for evt_type in compare_result.get("new_event_types", []):
        tc = SubElement(testsuite, "testcase", {
            "name": f"new_event_type:{evt_type}",
            "classname": "assay.harness.compare.event_type",
            "time": "0",
        })
        failures += 1
        fail = SubElement(tc, "failure", {
            "message": f"New event type in candidate: {evt_type}",
            "type": "NewEventType",
        })
        fail.text = evt_type
        cases.append(tc)

    # Process summary delta -- increased denied counts are regressions
    for delta in compare_result.get("process_summary_delta", []):
        field = delta.get("field", "unknown")
        d = delta.get("delta", 0)
        is_regression = (
            "denied" in field.lower() and d > 0
        )
        tc = SubElement(testsuite, "testcase", {
            "name": f"counter_drift:{field}",
            "classname": "assay.harness.compare.counter",
            "time": "0",
        })
        if is_regression:
            failures += 1
            fail = SubElement(tc, "failure", {
                "message": (
                    f"Counter regression: {field} "
                    f"({delta.get('baseline', 0)} -> {delta.get('candidate', 0)}, "
                    f"delta={d})"
                ),
                "type": "CounterRegression",
            })
            fail.text = json.dumps(delta, indent=2)
        else:
            out = SubElement(tc, "system-out")
            out.text = (
                f"{field}: {delta.get('baseline', 0)} -> "
                f"{delta.get('candidate', 0)} (delta={d})"
            )
        cases.append(tc)

    # --- Non-regression changes (passing testcases) ---

    for denial in compare_result.get("removed_denials", []):
        target = denial.get("target_ref", "unknown")
        tc = SubElement(testsuite, "testcase", {
            "name": f"removed_denial:{target}",
            "classname": "assay.harness.compare.denial",
            "time": "0",
        })
        out = SubElement(tc, "system-out")
        out.text = json.dumps(denial, indent=2)
        cases.append(tc)

    for approval in compare_result.get("new_approvals", []):
        target = approval.get("target_ref", "unknown")
        tc = SubElement(testsuite, "testcase", {
            "name": f"new_approval:{target}",
            "classname": "assay.harness.compare.approval",
            "time": "0",
        })
        out = SubElement(tc, "system-out")
        out.text = json.dumps(approval, indent=2)
        cases.append(tc)

    for approval in compare_result.get("removed_approvals", []):
        target = approval.get("target_ref", "unknown")
        tc = SubElement(testsuite, "testcase", {
            "name": f"removed_approval:{target}",
            "classname": "assay.harness.compare.approval",
            "time": "0",
        })
        out = SubElement(tc, "system-out")
        out.text = json.dumps(approval, indent=2)
        cases.append(tc)

    for evt_type in compare_result.get("removed_event_types", []):
        tc = SubElement(testsuite, "testcase", {
            "name": f"removed_event_type:{evt_type}",
            "classname": "assay.harness.compare.event_type",
            "time": "0",
        })
        out = SubElement(tc, "system-out")
        out.text = evt_type
        cases.append(tc)

    # --- Summary testcase ---
    has_regressions = compare_result.get("has_regressions", False)
    summary_text = compare_result.get("summary", "")
    tc = SubElement(testsuite, "testcase", {
        "name": "summary",
        "classname": "assay.harness.compare.summary",
        "time": "0",
    })
    if has_regressions:
        failures += 1
        fail = SubElement(tc, "failure", {
            "message": summary_text or "Regressions detected",
            "type": "RegressionSummary",
        })
        fail.text = summary_text
    else:
        out = SubElement(tc, "system-out")
        out.text = summary_text or "No regressions"
    cases.append(tc)

    # Update suite counts
    testsuite.set("tests", str(len(cases)))
    testsuite.set("failures", str(failures))

    raw = tostring(testsuites, encoding="unicode")
    return parseString(raw).toprettyxml(indent="  ", encoding=None)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Emit JUnit XML from Assay harness compare result JSON."
    )
    parser.add_argument("input", type=Path, help="Compare result JSON file.")
    parser.add_argument("--output", type=Path, required=True, help="JUnit XML output path.")
    parser.add_argument("--suite-name", default=SUITE_NAME, help="Test suite name.")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Input file not found: {args.input}", file=sys.stderr)
        return 2

    compare_result = json.loads(args.input.read_text(encoding="utf-8"))
    xml_str = _build_junit(compare_result, args.suite_name)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(xml_str, encoding="utf-8")
    print(f"Wrote JUnit XML to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
