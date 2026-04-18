"""Claude Agent SDK mapper contract tests.

Verifies that mapper/map_to_assay.py absorbs the policy-decision-v1
artifact shape (framework=claude_agent_sdk, surface=per_call_permission)
without structural changes to event output. See:
    docs/outreach/CLAUDE_AGENT_SDK_PREP.md             (seam and shape)
    docs/outreach/CLAUDE_AGENT_SDK_MAPPER_SMOKECHECK.md (fit findings)

Run with:
    python3 -m unittest tests.test_claude_agent_sdk_contract -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
MAPPER = REPO_ROOT / "mapper" / "map_to_assay.py"
FIX_DIR = REPO_ROOT / "fixtures" / "claude_agent_sdk"

VALID = FIX_DIR / "valid.decision.claude_agent_sdk.json"
FAILURE = FIX_DIR / "failure.decision.claude_agent_sdk.json"
MAL_RAW = FIX_DIR / "malformed_raw_arguments.claude_agent_sdk.json"
MAL_DEC = FIX_DIR / "malformed_missing_decision.claude_agent_sdk.json"
MAL_FW = FIX_DIR / "malformed_bad_framework.claude_agent_sdk.json"

IMPORT_TIME = "2026-04-18T12:00:00Z"


def _run_mapper(input_path: Path) -> tuple[int, str, list[dict]]:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "out.ndjson"
        result = subprocess.run(
            [
                sys.executable,
                str(MAPPER),
                str(input_path),
                "--output",
                str(out),
                "--import-time",
                IMPORT_TIME,
            ],
            capture_output=True,
            text=True,
        )
        events: list[dict] = []
        if out.exists():
            events = [
                json.loads(line) for line in out.read_text().splitlines() if line.strip()
            ]
        return result.returncode, result.stderr, events


class TestDecisionV1Allow(unittest.TestCase):
    def test_valid_allow_maps_to_one_event(self):
        exit_code, stderr, events = _run_mapper(VALID)
        self.assertEqual(exit_code, 0, f"mapper failed: {stderr}")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "example.placeholder.harness.policy-decision")

    def test_external_system_is_framework(self):
        _, _, events = _run_mapper(VALID)
        self.assertEqual(events[0]["data"]["external_system"], "claude_agent_sdk")

    def test_external_schema_is_decision_v1(self):
        _, _, events = _run_mapper(VALID)
        self.assertEqual(
            events[0]["data"]["external_schema"],
            "assay.harness.policy-decision.v1",
        )

    def test_observed_carries_decision_and_tool_use_id(self):
        _, _, events = _run_mapper(VALID)
        observed = events[0]["data"]["observed"]
        self.assertEqual(observed["decision"], "allow")
        self.assertEqual(observed["tool_use_id"], "toolu_01ABC123")
        self.assertEqual(observed["tool_name"], "Bash")

    def test_no_pause_fields_in_observed(self):
        """decision-v1 must not carry interruptions / continuation_anchor_ref / resume_*."""
        _, _, events = _run_mapper(VALID)
        observed = events[0]["data"]["observed"]
        for field in (
            "interruptions",
            "continuation_anchor_ref",
            "resume_state_ref",
            "resume_nonce",
            "resumed",
        ):
            self.assertNotIn(field, observed)


class TestDecisionV1Deny(unittest.TestCase):
    def test_failure_carries_decision_reason(self):
        exit_code, stderr, events = _run_mapper(FAILURE)
        self.assertEqual(exit_code, 0, f"mapper failed: {stderr}")
        observed = events[0]["data"]["observed"]
        self.assertEqual(observed["decision"], "deny")
        self.assertIn("decision_reason", observed)
        self.assertIn("destructive", observed["decision_reason"])


class TestMalformedRejected(unittest.TestCase):
    def test_raw_arguments_rejected(self):
        exit_code, stderr, _ = _run_mapper(MAL_RAW)
        self.assertNotEqual(exit_code, 0)
        self.assertIn("arguments_hash", stderr)

    def test_missing_decision_rejected(self):
        exit_code, stderr, _ = _run_mapper(MAL_DEC)
        self.assertNotEqual(exit_code, 0)
        self.assertIn("REJECT_MISSING_KEY", stderr)
        self.assertIn("decision", stderr)

    def test_bad_framework_rejected(self):
        exit_code, stderr, _ = _run_mapper(MAL_FW)
        self.assertNotEqual(exit_code, 0)
        self.assertIn("REJECT_FRAMEWORK", stderr)


class TestSchemaIsolation(unittest.TestCase):
    """Decision-v1 input must not produce pause-style envelopes, and vice versa."""

    def test_decision_v1_not_emitted_as_approval_interruption(self):
        _, _, events = _run_mapper(VALID)
        types = [e["type"] for e in events]
        self.assertNotIn("example.placeholder.harness.approval-interruption", types)

    def test_decision_v1_does_not_emit_resumed_or_summary(self):
        _, _, events = _run_mapper(VALID)
        types = [e["type"] for e in events]
        self.assertNotIn("example.placeholder.harness.resumed-run", types)
        self.assertNotIn("example.placeholder.harness.process-summary", types)


if __name__ == "__main__":
    unittest.main()
